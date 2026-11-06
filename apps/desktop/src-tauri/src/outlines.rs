//! The outlines Fill this form draws over the form: a window of its own over the form's window, that
//! the mouse goes straight through and that never takes the keyboard. Green for a box Meridian filled,
//! amber for one that is the user's or needs them, blue for the box being filled now.
//!
//! Pointing at a box says where its value came from. The window cannot see the mouse, so while the
//! outlines show, the cursor's place is read every 100 ms, as the island reads it: no hook. The page
//! has no access to the app's commands it would need; the core draws on it with `draw`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetWindowLongPtrW, GetWindowRect, SetWindowLongPtrW, ShowWindow, GWL_EXSTYLE, SW_HIDE, SW_SHOWNOACTIVATE,
    WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

pub const LABEL: &str = "outlines";
const HOVER_EVERY: Duration = Duration::from_millis(100);

/// One box's outline, in screen pixels.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Outline {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    /// "ok", "need" or "now".
    pub look: &'static str,
    /// The mark at the box's end: "ai" for Written by AI, "mail" for from mail, "lock" or "need".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<(&'static str, String)>,
    /// What pointing at it says: a title and a line.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tip: Option<(String, String)>,
}

struct Shown {
    hwnd: isize,
    corner: (i32, i32),
    outlines: Vec<Outline>,
    hover: Option<usize>,
}

static SHOWN: Mutex<Option<Shown>> = Mutex::new(None);
static POLLING: AtomicBool = AtomicBool::new(false);

fn rect_of(hwnd: isize) -> Option<RECT> {
    let mut rect = RECT::default();
    unsafe { GetWindowRect(HWND(hwnd as *mut _), &mut rect) }.ok()?;
    (rect.right > rect.left && rect.bottom > rect.top).then_some(rect)
}

/// The boxes from the window's corner, in physical pixels. The page divides by its own ratio.
fn script(corner: (i32, i32), outlines: &[Outline]) -> String {
    let moved: Vec<Outline> = outlines.iter().map(|o| Outline { x: o.x - corner.0, y: o.y - corner.1, ..o.clone() }).collect();
    format!("window.draw && window.draw({})", serde_json::to_string(&moved).unwrap_or_else(|_| "[]".into()))
}

fn shown_window(win: &WebviewWindow, show: bool) {
    if let Some(hwnd) = crate::island::hwnd(win) {
        unsafe {
            let _ = ShowWindow(hwnd, if show { SW_SHOWNOACTIVATE } else { SW_HIDE });
        }
    }
}

/// The window is made the first time it is needed. The page may still be loading then, so it is
/// drawn again once it has.
fn window(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(win) = app.get_webview_window(LABEL) {
        return Some(win);
    }
    // WebView2 shares one browser among all of an app's windows, so the island's switches go here too.
    let args = app.config().app.windows.iter().find_map(|w| w.additional_browser_args.clone());
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("outlines.html".into()))
        .title("Meridian outlines")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .visible(false)
        .on_page_load(|win, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let drawn = SHOWN.lock().unwrap().as_ref().map(|shown| script(shown.corner, &shown.outlines));
                if let Some(drawn) = drawn {
                    let _ = win.eval(drawn);
                }
            }
        });
    if let Some(args) = args {
        builder = builder.additional_browser_args(&args);
    }
    let win = builder.build().ok()?;
    // Through for the mouse, never for the keyboard, and not in Alt+Tab.
    if let Some(hwnd) = crate::island::hwnd(&win) {
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) | (WS_EX_TRANSPARENT.0 | WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0 | WS_EX_LAYERED.0) as isize;
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style);
        }
    }
    Some(win)
}

/// Draws the outlines over the window `hwnd`. The same outlines again change nothing.
pub fn draw(app: &AppHandle, hwnd: isize, outlines: Vec<Outline>) {
    let Some(rect) = rect_of(hwnd) else { return hide(app) };
    let corner = (rect.left, rect.top);
    {
        let mut shown = SHOWN.lock().unwrap();
        if shown.as_ref().is_some_and(|s| s.hwnd == hwnd && s.corner == corner && s.outlines == outlines) {
            return;
        }
        *shown = Some(Shown { hwnd, corner, outlines: outlines.clone(), hover: None });
    }
    let Some(win) = window(app) else { return };
    let _ = win.set_position(PhysicalPosition::new(rect.left, rect.top));
    let _ = win.set_size(PhysicalSize::new((rect.right - rect.left) as u32, (rect.bottom - rect.top) as u32));
    let _ = win.eval(script(corner, &outlines));
    shown_window(&win, true);
    follow(app);
}

pub fn hide(app: &AppHandle) {
    if SHOWN.lock().unwrap().take().is_none() {
        return;
    }
    if let Some(win) = app.get_webview_window(LABEL) {
        shown_window(&win, false);
        let _ = win.eval("window.draw && window.draw([])");
    }
}

/// The box under the pointer, by its place in the list.
fn under(outlines: &[Outline], x: i32, y: i32) -> Option<usize> {
    outlines.iter().position(|o| o.tip.is_some() && x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h)
}

/// Reads where the pointer is while the outlines show, and ends when they go.
fn follow(app: &AppHandle) {
    if POLLING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(HOVER_EVERY);
        let mut p = POINT::default();
        let read = unsafe { GetCursorPos(&mut p) }.is_ok();
        let changed = {
            let mut guard = SHOWN.lock().unwrap();
            let Some(shown) = guard.as_mut() else {
                // Under the lock, so outlines drawn just now start a new reader.
                POLLING.store(false, Ordering::SeqCst);
                return;
            };
            let over = if read { under(&shown.outlines, p.x, p.y) } else { shown.hover };
            (over != shown.hover).then(|| {
                shown.hover = over;
                over
            })
        };
        // Told outside the lock, so the window's own thread is never kept waiting on it.
        if let (Some(over), Some(win)) = (changed, app.get_webview_window(LABEL)) {
            let _ = win.eval(format!("window.hover && window.hover({})", over.map_or_else(|| "null".to_string(), |i| i.to_string())));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outline(x: i32, tip: bool) -> Outline {
        Outline { x, y: 100, w: 200, h: 26, look: "ok", tag: None, tip: tip.then(|| ("From Your details · Phone".into(), "Put in by Meridian.".into())) }
    }

    #[test]
    fn the_page_gets_boxes_from_the_windows_corner() {
        let said = script((50, 40), &[outline(250, true)]);
        assert!(said.starts_with("window.draw && window.draw(["));
        assert!(said.contains(r#""x":200,"y":60"#), "{said}");
        assert!(said.contains("From Your details · Phone"));
    }

    #[test]
    fn pointing_finds_the_box_under_it_and_only_one_with_something_to_say() {
        let boxes = [outline(0, false), outline(300, true)];
        assert_eq!(under(&boxes, 310, 110), Some(1));
        assert_eq!(under(&boxes, 10, 110), None, "nothing to say about it");
        assert_eq!(under(&boxes, 310, 130), None, "below the box");
    }
}
