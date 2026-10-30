//! The island window: placement, focus, and click-through. The window is one
//! fixed transparent rectangle that never resizes, so a morph can never flicker;
//! the visible island is drawn inside it. Only that shape takes the mouse.

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow};
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
    GetCursorPos, GetForegroundWindow, GetWindowLongPtrW, SetForegroundWindow, SetWindowLongPtrW, GWL_EXSTYLE,
    WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

pub const LABEL: &str = "island";

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
}

pub fn hwnd(win: &WebviewWindow) -> Option<HWND> {
    win.hwnd().ok().map(|h| HWND(h.0))
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

/// Top centre of the primary display.
pub fn place(app: &AppHandle, win: &WebviewWindow) {
    let monitor = app.primary_monitor().ok().flatten().or_else(|| win.current_monitor().ok().flatten());
    let (Some(monitor), Ok(size)) = (monitor, win.outer_size()) else { return };
    let x = monitor.position().x + (monitor.size().width as i32 - size.width as i32) / 2;
    let _ = win.set_position(PhysicalPosition::new(x, monitor.position().y));
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
        let mut hidden = false;
        let mut origin = (0.0, 0.0);
        loop {
            if tick % SLOW_EVERY == 0 {
                if let Ok(position) = win.outer_position() {
                    origin = (position.x as f64, position.y as f64);
                }
                let should_hide = fullscreen_in_front();
                if should_hide != hidden {
                    hidden = should_hide;
                    let _ = if hidden { win.hide() } else { win.show() };
                    apply_style(&win, &gate);
                }
            }
            tick = tick.wrapping_add(1);

            let Some((cx, cy)) = cursor() else {
                std::thread::sleep(FAR);
                continue;
            };
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
