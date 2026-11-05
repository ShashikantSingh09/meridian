//! The island window: placement, focus, and click-through. The window is one
//! fixed transparent rectangle that never resizes, so a morph can never flicker;
//! the visible island is drawn inside it. Only that shape takes the mouse.

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::settings::{Settings, Spot};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    COREWEBVIEW2_PERMISSION_STATE_DENY,
};
use webview2_com::PermissionRequestedEventHandler;
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
use windows::Win32::UI::Shell::{
    SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetForegroundWindow, GetSystemMetrics, GetWindowLongPtrW, SetForegroundWindow, SetWindowDisplayAffinity,
    SetWindowLongPtrW, ShowWindow, GWL_EXSTYLE, SM_SWAPBUTTON, SW_SHOWNOACTIVATE, WDA_EXCLUDEFROMCAPTURE, WDA_NONE, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

pub const LABEL: &str = "island";

/// Logical size of the fixed window. Matches tauri.conf.json.
const WINDOW_W: f64 = 860.0;
const WINDOW_H: f64 = 660.0;

/// Around the shape, so the flag is already off when a moving cursor arrives.
const HIT_MARGIN: f64 = 8.0;
/// Close to the shape the poll has to be frame-accurate. Anywhere else it only
/// has to catch the cursor crossing the band, even on a fast flick.
const NEAR: Duration = Duration::from_millis(16);
const FAR: Duration = Duration::from_millis(50);
const NEAR_BAND: f64 = 80.0;
/// Position and fullscreen state change rarely, and reading the window's
/// position crosses to the main thread, so neither happens at poll rate.
const SLOW_EVERY: u32 = 40;
/// The eyes follow the pointer smoothly, as they did in 0.5.1: where it is goes out up to 15 times a
/// second, and the styles glide the eyes there. Sent only when where they look moves by a whole
/// device pixel, since a smaller move cannot be seen. A still pointer costs nothing.
const GAZE_EVERY: Duration = Duration::from_millis(66);
const GAZE_STEP: f64 = 10.0;
const GAZE_RANGE: f64 = 900.0;
/// How far the eyes travel each way, in CSS pixels. Matches GAZE_REACH in the store.
const GAZE_REACH: (f64, f64) = (4.0, 3.0);
/// Floating, the island sits this far inside its window, so its shadow is not cut off. Matches the styles.
const FLOAT_INSET: f64 = 12.0;
/// The middle of the island stays this far from a side, so its widest compact form stays on screen.
const SIDE_KEEP: f64 = 230.0;
/// Dropped this close to the top of the screen, it becomes the notch again.
const SNAP: f64 = 40.0;
/// The island's height at rest.
const REST_H: f64 = 34.0;

/// The island in CSS pixels with the ratio that turns them into physical ones.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub dpr: f64,
}

impl Rect {
    /// Hit test in physical pixels, window-relative. Using the page's own ratio
    /// keeps this right even when WebView2's scale differs from the window's.
    pub fn contains(&self, px: f64, py: f64, margin: f64) -> bool {
        let m = margin * self.dpr;
        self.w > 0.0
            && px >= self.x * self.dpr - m
            && px <= (self.x + self.w) * self.dpr + m
            && py >= self.y * self.dpr - m
            && py <= (self.y + self.h) * self.dpr + m
    }
}

#[derive(Default)]
pub struct Gate {
    pub rect: Mutex<Rect>,
    ignoring: AtomicBool,
    interactive: AtomicBool,
    hovered: AtomicBool,
    /// The window to return to when the panel closes.
    previous: AtomicIsize,
    /// Window position in physical pixels, read at poll rate without a main-thread hop.
    origin: Mutex<(f64, f64)>,
    fullscreen: AtomicBool,
    user_hidden: AtomicBool,
    hidden: AtomicBool,
    /// The pointer and the window where a drag began, both in physical pixels.
    drag: Mutex<Option<((f64, f64), (f64, f64))>>,
    /// Where the window was before the panel moved it to fit on the screen.
    home: Mutex<Option<(f64, f64)>>,
    /// "top" for the notch, or floating and growing "down" or "up". Empty until placed, which is the notch.
    place: Mutex<&'static str>,
    /// The face is asleep, so its eyes do not follow the pointer.
    pub face_asleep: AtomicBool,
}

/// How the island sits: the notch, or floating and growing down or up.
pub fn placement(gate: &Gate) -> &'static str {
    match *gate.place.lock().unwrap() {
        "" => "top",
        place => place,
    }
}

pub fn hwnd(win: &WebviewWindow) -> Option<HWND> {
    win.hwnd().ok().map(|h| HWND(h.0))
}

/// Keeps the island out of the app's own captures. Held only around a capture,
/// so the user's screenshot tools still see it.
pub fn exclude_from_capture(win: &WebviewWindow, on: bool) {
    let Some(hwnd) = hwnd(win) else { return };
    let affinity = if on { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE };
    let _ = unsafe { SetWindowDisplayAffinity(hwnd, affinity) };
}

/// The window the user was working in: under the panel if it is open.
pub fn working_window(gate: &Gate) -> Option<screen::WindowInfo> {
    if gate.interactive.load(Ordering::Relaxed) {
        return screen::window_at(gate.previous.load(Ordering::Relaxed));
    }
    screen::foreground()
}

/// The one writer of the window's extended style. Tauri's own setters rebuild
/// the whole style from their flags, which silently drops NOACTIVATE and
/// TOOLWINDOW, so click-through is set here rather than through them.
fn apply_style(win: &WebviewWindow, gate: &Gate) {
    let Some(hwnd) = hwnd(win) else { return };
    let through = WS_EX_TRANSPARENT.0 as isize;
    let noactivate = WS_EX_NOACTIVATE.0 as isize;
    unsafe {
        // LAYERED stays on. Taking it off and on again resets the window's surface,
        // which shows as a flicker each time the pointer crosses the island.
        let mut style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) | (WS_EX_TOOLWINDOW.0 | WS_EX_LAYERED.0) as isize;
        // Never takes focus from what the user is doing, unless the panel's
        // text fields need the keyboard.
        style = if gate.interactive.load(Ordering::Relaxed) { style & !noactivate } else { style | noactivate };
        style = if gate.ignoring.load(Ordering::Relaxed) { style | through } else { style & !through };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style);
    }
}

/// Sets the starting style: nothing takes the mouse until the island is drawn.
pub fn prepare(win: &WebviewWindow, gate: &Gate) {
    gate.ignoring.store(true, Ordering::Relaxed);
    apply_style(win, gate);
}

/// Lets the panel's text fields take the keyboard while it is open, and hands
/// focus back on close. If the user clicked another app to close it, that app
/// already has focus and keeps it.
pub fn set_interactive(win: &WebviewWindow, gate: &Gate, on: bool) {
    gate.interactive.store(on, Ordering::Relaxed);
    let mine = hwnd(win);
    let foreground = unsafe { GetForegroundWindow() };
    // A panel already open is asked again by a shortcut or a tab, and has become the foreground.
    if on && mine != Some(foreground) {
        gate.previous.store(foreground.0 as isize, Ordering::Relaxed);
    }
    apply_style(win, gate);
    if on {
        fit_on_screen(win, gate);
        let _ = win.set_focus();
    } else {
        back_home(win, gate);
    }
    if !on && mine == Some(foreground) {
        let previous = HWND(gate.previous.swap(0, Ordering::Relaxed) as *mut _);
        if !previous.is_invalid() {
            unsafe {
                let _ = SetForegroundWindow(previous);
            }
        }
    }
}

/// The webview may use the microphone, which the app opens only on a user's
/// click, and nothing else. Without this a request raises WebView2's own modal
/// prompt, and every other permission would be one prompt away.
pub fn restrict_permissions(win: &WebviewWindow) {
    let _ = win.with_webview(|webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            args.PermissionKind(&mut kind)?;
            let mic = kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE;
            args.SetState(if mic { COREWEBVIEW2_PERMISSION_STATE_ALLOW } else { COREWEBVIEW2_PERMISSION_STATE_DENY })
        }));
        let mut token = 0i64;
        let _ = core.add_PermissionRequested(&handler, &mut token);
    });
}

fn chosen_monitor(app: &AppHandle, win: &WebviewWindow, pref: &str) -> Option<Monitor> {
    let named = app.available_monitors().ok().and_then(|all| all.into_iter().find(|m| m.name().is_some_and(|n| n == pref)));
    // A display that was unplugged falls back to the primary one.
    named.or_else(|| app.primary_monitor().ok().flatten()).or_else(|| win.current_monitor().ok().flatten())
}

/// Puts the window at the top of the chosen display, inside its work area so a
/// taskbar moved to the top is respected. Sized from that display's scale, so
/// moving between displays keeps the same logical size.
/// A work area in physical pixels: left, top, width, height.
type Area = (f64, f64, f64, f64);

fn area_of(monitor: &Monitor) -> Area {
    let area = monitor.work_area();
    (area.position.x as f64, area.position.y as f64, area.size.width as f64, area.size.height as f64)
}

/// Where the window goes for a spot, and how the island sits in it. Physical pixels, for a window `size` big.
fn spot_position(spot: Spot, (ax, ay, aw, ah): Area, scale: f64, (w, h): (f64, f64)) -> (f64, f64, &'static str) {
    let keep = SIDE_KEEP * scale;
    let middle = if aw > 2.0 * keep { (ax + spot.x * aw).clamp(ax + keep, ax + aw - keep) } else { ax + aw / 2.0 };
    let x = middle - w / 2.0;
    if spot.y <= 0.0 {
        return (x, ay, "top");
    }
    let (inset, rest, snap) = (FLOAT_INSET * scale, REST_H * scale, SNAP * scale);
    let low = (ay + ah - inset).max(ay + snap + rest);
    if spot.up {
        let bottom = (ay + spot.y * ah).clamp(ay + snap + rest, low);
        (x, bottom + inset - h, "up")
    } else {
        let top = (ay + spot.y * ah).clamp(ay + snap, low - rest);
        (x, top - inset, "down")
    }
}

/// The spot an island dropped here makes: left, top, right and bottom on this work area, in physical pixels.
/// Near the top it is the notch again. Otherwise it floats, hanging from whichever edge keeps it growing
/// towards the middle of the screen.
fn spot_at((left, top, right, bottom): (f64, f64, f64, f64), (ax, ay, aw, ah): Area, scale: f64) -> Spot {
    let x = (((left + right) / 2.0 - ax) / aw).clamp(0.0, 1.0);
    if top - ay < SNAP * scale {
        return Spot { x, y: 0.0, up: false };
    }
    let up = (top + bottom) / 2.0 > ay + ah / 2.0;
    let edge = if up { bottom } else { top };
    Spot { x, y: ((edge - ay) / ah).clamp(0.0, 1.0), up }
}

/// The name a display's spot is kept under.
pub fn monitor_key(app: &AppHandle, win: &WebviewWindow, pref: &str) -> Option<String> {
    chosen_monitor(app, win, pref)?.name().cloned()
}

fn move_to(win: &WebviewWindow, gate: &Gate, (x, y): (f64, f64)) {
    let _ = win.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
    *gate.origin.lock().unwrap() = (x.round(), y.round());
}

pub fn place(app: &AppHandle, win: &WebviewWindow, gate: &Gate, settings: &Settings) {
    let Some(monitor) = chosen_monitor(app, win, &settings.island_monitor) else { return };
    let scale = monitor.scale_factor();
    let (w, h) = (WINDOW_W * scale, WINDOW_H * scale);
    let area = area_of(&monitor);
    let spot = monitor.name().and_then(|name| settings.island_spots.get(name)).copied();
    let (x, y, place) = match spot {
        Some(spot) => spot_position(spot, area, scale, (w, h)),
        None => {
            let x = match settings.island_align.as_str() {
                "left" => area.0,
                "right" => area.0 + area.2 - w.round(),
                _ => area.0 + ((area.2 - w.round()) / 2.0).trunc(),
            };
            (x, area.1, "top")
        }
    };
    let size = PhysicalSize::new(w.round() as u32, h.round() as u32);
    let _ = win.set_size(size);
    move_to(win, gate, (x, y));
    // Crossing into a display of another scale can resize the window.
    let _ = win.set_size(size);
    *gate.home.lock().unwrap() = None;
    if gate.interactive.load(Ordering::Relaxed) {
        fit_on_screen(win, gate);
    }
    apply_style(win, gate);
    *gate.place.lock().unwrap() = place;
    let _ = app.emit_to(LABEL, "island-placed", place);
}

/// The panel is far bigger than the island, so where the island sits it may not fit. It moves onto the
/// screen while open, and back when it closes.
fn fit_on_screen(win: &WebviewWindow, gate: &Gate) {
    let Ok(Some(monitor)) = win.current_monitor() else { return };
    let scale = monitor.scale_factor();
    let (ax, ay, aw, ah) = area_of(&monitor);
    let (w, h) = (WINDOW_W * scale, WINDOW_H * scale);
    let at = *gate.origin.lock().unwrap();
    let fitted = (at.0.clamp(ax, (ax + aw - w).max(ax)), at.1.clamp(ay, (ay + ah - h).max(ay)));
    if fitted != at {
        gate.home.lock().unwrap().get_or_insert(at);
        move_to(win, gate, fitted);
    }
}

fn back_home(win: &WebviewWindow, gate: &Gate) {
    let home = gate.home.lock().unwrap().take();
    if let Some(home) = home {
        move_to(win, gate, home);
    }
}

/// From a press on the island that moved: the window follows the pointer until `end_drag`.
pub fn start_drag(gate: &Gate) {
    if let Some(at) = cursor() {
        *gate.drag.lock().unwrap() = Some((at, *gate.origin.lock().unwrap()));
    }
}

/// Whether the main mouse button is still down, which a left-handed setup swaps.
fn holding() -> bool {
    let key = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0 { VK_RBUTTON } else { VK_LBUTTON };
    (unsafe { GetAsyncKeyState(i32::from(key.0)) } as u16 & 0x8000) != 0
}

/// Ends a drag: the spot is kept for that display, a drag onto another display makes that the island's
/// display, and the island settles there. Safe to call when nothing is being dragged.
pub fn finish_drag(app: &AppHandle, win: &WebviewWindow, gate: &Gate) {
    let Some((display, spot)) = end_drag(app, gate) else { return };
    let core = app.state::<crate::commands::Core>();
    let primary = app.primary_monitor().ok().flatten().and_then(|monitor| monitor.name().cloned());
    let settings = {
        let mut settings = core.settings.lock().unwrap();
        settings.island_monitor = if primary.as_deref() == Some(display.as_str()) { "primary".into() } else { display.clone() };
        settings.island_spots.insert(display, spot);
        settings.clone()
    };
    if let Some(path) = crate::settings::path(app) {
        let _ = crate::settings::save(&path, &settings);
    }
    place(app, win, gate, &settings);
    let _ = app.emit_to(LABEL, "settings-changed", settings);
}

/// Where the island was let go, as a display's name and the spot it makes there.
fn end_drag(app: &AppHandle, gate: &Gate) -> Option<(String, Spot)> {
    gate.drag.lock().unwrap().take()?;
    let (origin, rect) = (*gate.origin.lock().unwrap(), *gate.rect.lock().unwrap());
    let (left, top) = (origin.0 + rect.x * rect.dpr, origin.1 + rect.y * rect.dpr);
    let (right, bottom) = (left + rect.w * rect.dpr, top + rect.h * rect.dpr);
    let (mx, my) = ((left + right) / 2.0, (top + bottom) / 2.0);
    let monitor = app.available_monitors().ok()?.into_iter().find(|m| {
        let (p, s) = (m.position(), m.size());
        (p.x as f64..p.x as f64 + s.width as f64).contains(&mx) && (p.y as f64..p.y as f64 + s.height as f64).contains(&my)
    })?;
    Some((monitor.name()?.clone(), spot_at((left, top, right, bottom), area_of(&monitor), monitor.scale_factor())))
}

pub fn monitor_names(app: &AppHandle) -> Vec<String> {
    let all = app.available_monitors().unwrap_or_default();
    all.iter().filter_map(|m| m.name().cloned()).collect()
}

/// Changes when a display is plugged in, removed, rearranged or rescaled.
fn display_signature(app: &AppHandle) -> String {
    let all = app.available_monitors().unwrap_or_default();
    let parts: Vec<String> = all
        .iter()
        .map(|m| format!("{:?}{:?}{:?}{}", m.name(), m.position(), m.size(), m.scale_factor()))
        .collect();
    parts.join("|")
}

/// The user's choice and a fullscreen app can both hide the island.
fn sync_visibility(win: &WebviewWindow, gate: &Gate) {
    let want = gate.fullscreen.load(Ordering::Relaxed) || gate.user_hidden.load(Ordering::Relaxed);
    if gate.hidden.swap(want, Ordering::Relaxed) != want {
        let _ = if want { win.hide() } else { Ok(show_quietly(win)) };
        apply_style(win, gate);
    }
}

/// Shows the window without taking focus from whatever the user is doing.
/// Tauri's `show()` activates the window and rebuilds its style.
pub fn show_quietly(win: &WebviewWindow) {
    if let Some(hwnd) = hwnd(win) {
        let _ = unsafe { ShowWindow(hwnd, SW_SHOWNOACTIVATE) };
    }
}

pub fn set_user_hidden(win: &WebviewWindow, gate: &Gate, hidden: bool) {
    gate.user_hidden.store(hidden, Ordering::Relaxed);
    sync_visibility(win, gate);
}

pub fn user_hidden(gate: &Gate) -> bool {
    gate.user_hidden.load(Ordering::Relaxed)
}

fn cursor() -> Option<(f64, f64)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x as f64, p.y as f64))
}

/// Something fullscreen is in front: a game, a video, a presentation.
fn fullscreen_in_front() -> bool {
    matches!(
        unsafe { SHQueryUserNotificationState() },
        Ok(QUNS_BUSY | QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE)
    )
}

fn apply_click_through(win: &WebviewWindow, gate: &Gate, accept: bool) {
    if gate.ignoring.swap(!accept, Ordering::Relaxed) == accept {
        apply_style(win, gate);
    }
}

/// Where the pointer is from the island, as -1 to 1 each way.
fn gaze(rect: &Rect, x: f64, y: f64) -> (f64, f64) {
    let reach = GAZE_RANGE * rect.dpr;
    let side = (x - (rect.x + rect.w / 2.0) * rect.dpr) / reach;
    ((side).clamp(-1.0, 1.0), (y / reach).clamp(-1.0, 1.0))
}

/// Dragged, the face leans the way the island moves: a degree for every 125 CSS pixels a second, up to 6.
const LEAN_PX_PER_DEGREE: f64 = 125.0;
const LEAN_MOST: f64 = 6.0;

fn lean_for(css_px_per_second: f64) -> i32 {
    (css_px_per_second / LEAN_PX_PER_DEGREE).clamp(-LEAN_MOST, LEAN_MOST).round() as i32
}

/// Where the eyes would look, in whole device pixels. Only a change here is worth a repaint.
fn gaze_target(rect: &Rect, x: f64, y: f64) -> (f64, f64) {
    let (gx, gy) = gaze(rect, x, y);
    ((gx * GAZE_REACH.0 * rect.dpr).round(), (gy * GAZE_REACH.1 * rect.dpr).round())
}

pub fn spawn_poll(app: AppHandle, gate: Arc<Gate>) {
    std::thread::spawn(move || {
        let Some(win) = app.get_webview_window(LABEL) else { return };
        let mut tick = 0u32;
        let mut displays = display_signature(&app);
        let mut gazed = (0.0, 0.0, Instant::now());
        let mut looked = (0.0, 0.0);
        // While dragged: the last pointer x, when, the smoothed speed in CSS pixels a second, and the lean sent.
        let mut swing: Option<(f64, Instant, f64, i32)> = None;
        loop {
            if tick % SLOW_EVERY == 0 {
                gate.fullscreen.store(fullscreen_in_front(), Ordering::Relaxed);
                sync_visibility(&win, &gate);
                let now = display_signature(&app);
                if now != displays {
                    displays = now;
                    let settings = app.state::<crate::commands::Core>().settings.lock().unwrap().clone();
                    place(&app, &win, &gate, &settings);
                }
            }
            tick = tick.wrapping_add(1);

            let Some((cx, cy)) = cursor() else {
                std::thread::sleep(FAR);
                continue;
            };
            // Being dragged: the window follows the pointer, and keeps the mouse so the release arrives.
            let dragging = *gate.drag.lock().unwrap();
            if let Some((from, start)) = dragging {
                // A release the page never reported still ends it.
                if !holding() {
                    finish_drag(&app, &win, &gate);
                    continue;
                }
                let now = Instant::now();
                let (last_x, at, speed, sent) = swing.unwrap_or((cx, now, 0.0, 0));
                let dt = now.duration_since(at).as_secs_f64();
                let speed = if dt > 0.0 { speed + ((cx - last_x) / dt / gate.rect.lock().unwrap().dpr - speed) * 0.35 } else { speed };
                let lean = lean_for(speed);
                if lean != sent {
                    let _ = app.emit_to(LABEL, "island-lean", lean);
                }
                swing = Some((cx, now, speed, lean));
                let to = (start.0 + cx - from.0, start.1 + cy - from.1);
                if (to.0.round(), to.1.round()) != *gate.origin.lock().unwrap() {
                    move_to(&win, &gate, to);
                }
                apply_click_through(&win, &gate, true);
                std::thread::sleep(NEAR);
                continue;
            }
            // Let go: upright again.
            if swing.take().is_some_and(|(_, _, _, sent)| sent != 0) {
                let _ = app.emit_to(LABEL, "island-lean", 0);
            }
            let origin = *gate.origin.lock().unwrap();
            let (x, y) = (cx - origin.0, cy - origin.1);
            let rect = *gate.rect.lock().unwrap();
            let on_island = rect.contains(x, y, HIT_MARGIN);
            apply_click_through(&win, &gate, on_island);
            if gate.hovered.swap(on_island, Ordering::Relaxed) != on_island {
                let _ = app.emit_to(LABEL, "island-hover", on_island);
            }
            // Nobody sees the eyes while the window is hidden or the face sleeps.
            let watching = !gate.hidden.load(Ordering::Relaxed) && !gate.face_asleep.load(Ordering::Relaxed);
            if watching
                && (x - gazed.0).abs() + (y - gazed.1).abs() > GAZE_STEP * rect.dpr
                && gazed.2.elapsed() >= GAZE_EVERY
                && gaze_target(&rect, x, y) != looked
            {
                gazed = (x, y, Instant::now());
                looked = gaze_target(&rect, x, y);
                let _ = app.emit_to(LABEL, "island-gaze", gaze(&rect, x, y));
            }
            std::thread::sleep(if rect.contains(x, y, NEAR_BAND) { NEAR } else { FAR });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECT: Rect = Rect { x: 100.0, y: 10.0, w: 200.0, h: 30.0, dpr: 1.5 };

    #[test]
    fn hit_test_works_in_physical_pixels() {
        assert!(RECT.contains(200.0 * 1.5, 25.0 * 1.5, 0.0));
        assert!(!RECT.contains(500.0, 25.0 * 1.5, 0.0));
    }

    #[test]
    fn a_drag_leans_with_its_speed_up_to_six_degrees() {
        assert_eq!(lean_for(0.0), 0);
        assert_eq!(lean_for(50.0), 0);
        assert_eq!(lean_for(250.0), 2);
        assert_eq!(lean_for(-250.0), -2);
        assert_eq!(lean_for(10_000.0), 6);
        assert_eq!(lean_for(-10_000.0), -6);
    }

    #[test]
    fn the_eyes_follow_the_pointer_anywhere_in_whole_device_pixels() {
        let at = |x: f64| gaze_target(&RECT, x, 300.0);
        let middle = 200.0 * 1.5;
        // Less than a device pixel of travel is not a move.
        assert_eq!(at(middle), at(middle + 30.0));
        // A pointer far to the side turns the eyes all the way: 4 CSS pixels, 6 device pixels here.
        assert_eq!(at(middle + 5000.0).0, 6.0);
        assert_eq!(at(middle - 5000.0).0, -6.0);
        // Halfway out, halfway round.
        assert_eq!(at(middle + 450.0 * 1.5).0, 3.0);
    }

    #[test]
    fn the_margin_is_scaled_too() {
        assert!(RECT.contains(95.0 * 1.5, 25.0 * 1.5, 8.0));
        assert!(!RECT.contains(95.0 * 1.5, 25.0 * 1.5, 0.0));
    }

    #[test]
    fn the_gaze_is_measured_from_the_middle_of_the_island_and_stays_in_range() {
        assert_eq!(gaze(&RECT, 200.0 * 1.5, 0.0), (0.0, 0.0));
        let (side, down) = gaze(&RECT, 1_000_000.0, 1_000_000.0);
        assert_eq!((side, down), (1.0, 1.0));
        assert!(gaze(&RECT, 0.0, 0.0).0 < 0.0);
    }

    #[test]
    fn an_undrawn_island_takes_no_clicks() {
        assert!(!Rect::default().contains(0.0, 0.0, 8.0));
    }

    /// A 1920 by 1032 work area at 1.25, which is a common laptop.
    const AREA: Area = (0.0, 0.0, 1920.0, 1032.0);
    const SCALE: f64 = 1.25;
    const WINDOW: (f64, f64) = (WINDOW_W * SCALE, WINDOW_H * SCALE);

    #[test]
    fn let_go_near_the_top_it_is_the_notch_again() {
        let spot = spot_at((800.0, 20.0, 985.0, 62.0), AREA, SCALE);
        assert_eq!((spot.y, spot.up), (0.0, false));
        let (x, y, place) = spot_position(spot, AREA, SCALE, WINDOW);
        assert_eq!((y, place), (0.0, "top"));
        assert!((x + WINDOW.0 / 2.0 - 892.5).abs() < 0.01, "its middle stays where it was let go");
    }

    #[test]
    fn floating_it_grows_towards_the_middle_of_the_screen() {
        let high = spot_at((800.0, 300.0, 985.0, 342.0), AREA, SCALE);
        assert!(!high.up);
        let (_, y, place) = spot_position(high, AREA, SCALE, WINDOW);
        assert_eq!(place, "down");
        assert!((y + FLOAT_INSET * SCALE - 300.0).abs() < 0.01, "its top edge stays put");

        let low = spot_at((800.0, 900.0, 985.0, 942.0), AREA, SCALE);
        assert!(low.up);
        let (_, y, place) = spot_position(low, AREA, SCALE, WINDOW);
        assert_eq!(place, "up");
        assert!((y + WINDOW.1 - FLOAT_INSET * SCALE - 942.0).abs() < 0.01, "its bottom edge stays put");
    }

    #[test]
    fn it_stays_on_the_screen_whatever_was_kept() {
        for spot in [Spot { x: 0.0, y: 0.5, up: false }, Spot { x: 1.0, y: 1.0, up: true }, Spot { x: -3.0, y: 9.0, up: false }] {
            let (x, y, place) = spot_position(spot, AREA, SCALE, WINDOW);
            let middle = x + WINDOW.0 / 2.0;
            assert!(middle >= SIDE_KEEP * SCALE - 0.01 && middle <= AREA.2 - SIDE_KEEP * SCALE + 0.01, "{spot:?}");
            let (top, bottom) = match place {
                "up" => (y + WINDOW.1 - FLOAT_INSET * SCALE - REST_H * SCALE, y + WINDOW.1 - FLOAT_INSET * SCALE),
                _ => (y + FLOAT_INSET * SCALE, y + FLOAT_INSET * SCALE + REST_H * SCALE),
            };
            assert!(top >= 0.0 && bottom <= AREA.3, "{spot:?} rests on screen, from {top} to {bottom}");
        }
    }

    #[test]
    fn a_second_display_is_measured_from_its_own_corner() {
        let right: Area = (1920.0, 0.0, 2560.0, 1400.0);
        let spot = spot_at((3000.0, 1200.0, 3185.0, 1242.0), right, 1.0);
        assert!(spot.up && (spot.x - (3092.5 - 1920.0) / 2560.0).abs() < 1e-9);
        let (x, _, _) = spot_position(spot, right, 1.0, (WINDOW_W, WINDOW_H));
        assert!((x + WINDOW_W / 2.0 - 3092.5).abs() < 0.01);
    }
}
