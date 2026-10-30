//! The island window: placement, focus, and click-through. The window is one
//! fixed transparent rectangle that never resizes, so a morph can never flicker;
//! the visible island is drawn inside it. Only that shape takes the mouse.

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    COREWEBVIEW2_PERMISSION_STATE_DENY,
};
use webview2_com::PermissionRequestedEventHandler;
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::UI::Shell::{
    SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetForegroundWindow, GetWindowLongPtrW, SetForegroundWindow, SetWindowDisplayAffinity,
    SetWindowLongPtrW, ShowWindow, GWL_EXSTYLE, SW_SHOWNOACTIVATE, WDA_EXCLUDEFROMCAPTURE, WDA_NONE, WS_EX_LAYERED,
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

/// The island in CSS pixels with the ratio that turns them into physical ones.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub r: f64,
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
    let through = (WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0) as isize;
    let noactivate = WS_EX_NOACTIVATE.0 as isize;
    unsafe {
        let mut style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) | WS_EX_TOOLWINDOW.0 as isize;
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
    if on {
        gate.previous.store(foreground.0 as isize, Ordering::Relaxed);
    }
    apply_style(win, gate);
    if on {
        let _ = win.set_focus();
    } else if mine == Some(foreground) {
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
pub fn place(app: &AppHandle, win: &WebviewWindow, gate: &Gate, pref: &str, align: &str) {
    let Some(monitor) = chosen_monitor(app, win, pref) else { return };
    let scale = monitor.scale_factor();
    let (w, h) = ((WINDOW_W * scale).round() as u32, (WINDOW_H * scale).round() as u32);
    let area = monitor.work_area();
    let x = match align {
        "left" => area.position.x,
        "right" => area.position.x + area.size.width as i32 - w as i32,
        _ => area.position.x + (area.size.width as i32 - w as i32) / 2,
    };
    let _ = win.set_size(PhysicalSize::new(w, h));
    let _ = win.set_position(PhysicalPosition::new(x, area.position.y));
    // Crossing into a display of another scale can resize the window.
    let _ = win.set_size(PhysicalSize::new(w, h));
    *gate.origin.lock().unwrap() = (x as f64, area.position.y as f64);
    apply_style(win, gate);
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

pub fn spawn_poll(app: AppHandle, gate: Arc<Gate>) {
    std::thread::spawn(move || {
        let Some(win) = app.get_webview_window(LABEL) else { return };
        let mut tick = 0u32;
        let mut displays = display_signature(&app);
        loop {
            if tick % SLOW_EVERY == 0 {
                gate.fullscreen.store(fullscreen_in_front(), Ordering::Relaxed);
                sync_visibility(&win, &gate);
                let now = display_signature(&app);
                if now != displays {
                    displays = now;
                    let settings = app.state::<crate::commands::Core>().settings.lock().unwrap().clone();
                    place(&app, &win, &gate, &settings.island_monitor, &settings.island_align);
                }
            }
            tick = tick.wrapping_add(1);

            let Some((cx, cy)) = cursor() else {
                std::thread::sleep(FAR);
                continue;
            };
            let origin = *gate.origin.lock().unwrap();
            let (x, y) = (cx - origin.0, cy - origin.1);
            let rect = *gate.rect.lock().unwrap();
            let on_island = rect.contains(x, y, HIT_MARGIN);
            apply_click_through(&win, &gate, on_island);
            if gate.hovered.swap(on_island, Ordering::Relaxed) != on_island {
                let _ = app.emit_to(LABEL, "island-hover", on_island);
            }
            std::thread::sleep(if rect.contains(x, y, NEAR_BAND) { NEAR } else { FAR });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECT: Rect = Rect { x: 100.0, y: 10.0, w: 200.0, h: 30.0, r: 15.0, dpr: 1.5 };

    #[test]
    fn hit_test_works_in_physical_pixels() {
        assert!(RECT.contains(200.0 * 1.5, 25.0 * 1.5, 0.0));
        assert!(!RECT.contains(500.0, 25.0 * 1.5, 0.0));
    }

    #[test]
    fn the_margin_is_scaled_too() {
        assert!(RECT.contains(95.0 * 1.5, 25.0 * 1.5, 8.0));
        assert!(!RECT.contains(95.0 * 1.5, 25.0 * 1.5, 0.0));
    }

    #[test]
    fn an_undrawn_island_takes_no_clicks() {
        assert!(!Rect::default().contains(0.0, 0.0, 8.0));
    }
}
