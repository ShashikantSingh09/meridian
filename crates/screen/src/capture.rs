//! Reads pixels the way they are shown. Coordinates are physical pixels: the app
//! is per-monitor DPI aware.

use serde::Serialize;
use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, FALSE, HWND, LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, GetMonitorInfoW,
    MonitorFromWindow, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS,
    MONITORINFO, MONITOR_DEFAULTTONEAREST, SRCCOPY,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
};

use crate::ScreenError;

pub struct Frame {
    pub width: u32,
    pub height: u32,
    /// Top-down, 4 bytes per pixel, alpha opaque.
    pub bgra: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    #[serde(skip)]
    pub hwnd: isize,
    pub title: String,
    /// Executable name, such as code.exe.
    pub process: String,
    pub class: String,
}

fn process_name(hwnd: HWND) -> String {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    let Ok(process) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else {
        return String::new();
    };
    let mut buffer = [0u16; 1024];
    let mut size = buffer.len() as u32;
    let found = unsafe {
        QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut size)
    };
    let _ = unsafe { CloseHandle(process) };
    if found.is_err() {
        return String::new();
    }
    let path = String::from_utf16_lossy(&buffer[..size as usize]);
    path.rsplit('\\').next().unwrap_or_default().to_string()
}

fn describe(hwnd: HWND) -> WindowInfo {
    let mut title = [0u16; 512];
    let title_len = unsafe { GetWindowTextW(hwnd, &mut title) }.max(0) as usize;
    let mut class = [0u16; 256];
    let class_len = unsafe { GetClassNameW(hwnd, &mut class) }.max(0) as usize;
    WindowInfo {
        hwnd: hwnd.0 as isize,
        title: String::from_utf16_lossy(&title[..title_len]),
        process: process_name(hwnd),
        class: String::from_utf16_lossy(&class[..class_len]),
    }
}

/// The window in front, or None when there is nothing to describe.
pub fn foreground() -> Option<WindowInfo> {
    let hwnd = unsafe { GetForegroundWindow() };
    (!hwnd.is_invalid()).then(|| describe(hwnd))
}

/// A window by handle, for "the window you were in before the panel opened".
pub fn window_at(hwnd: isize) -> Option<WindowInfo> {
    let hwnd = HWND(hwnd as *mut _);
    (!hwnd.is_invalid() && unsafe { IsWindowVisible(hwnd) }.as_bool()).then(|| describe(hwnd))
}

fn grab(left: i32, top: i32, width: i32, height: i32) -> Result<Frame, ScreenError> {
    if width <= 0 || height <= 0 {
        return Err(ScreenError::Capture("The window has no visible area.".into()));
    }
    unsafe {
        let screen = GetDC(None);
        let memory = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        let previous = SelectObject(memory, bitmap.into());
        let copied = BitBlt(memory, 0, 0, width, height, Some(screen), left, top, SRCCOPY | CAPTUREBLT);

        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // Negative asks for top-down rows.
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bgra = vec![0u8; width as usize * height as usize * 4];
        let rows = GetDIBits(
            memory,
            bitmap,
            0,
            height as u32,
            Some(bgra.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        );

        SelectObject(memory, previous);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);

        copied?;
        if rows == 0 {
            return Err(ScreenError::Capture("The screen could not be read.".into()));
        }
        bgra.chunks_exact_mut(4).for_each(|pixel| pixel[3] = 255);
        Ok(Frame { width: width as u32, height: height as u32, bgra })
    }
}

/// Captures a window as it appears, which includes anything overlapping it,
/// and so captures only what the user can actually see.
pub fn capture_window(hwnd: isize) -> Result<Frame, ScreenError> {
    let hwnd = HWND(hwnd as *mut _);
    if unsafe { IsIconic(hwnd) }.as_bool() {
        return Err(ScreenError::Capture("That window is minimized.".into()));
    }
    let rect = frame_bounds(hwnd)?;
    grab(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top)
}

/// Captures the whole display a window is on.
pub fn capture_screen_of(hwnd: isize) -> Result<Frame, ScreenError> {
    let r = monitor_bounds(HWND(hwnd as *mut _))?;
    grab(r.left, r.top, r.right - r.left, r.bottom - r.top)
}

/// The extended bounds leave out the invisible resize border and shadow.
fn frame_bounds(hwnd: HWND) -> windows::core::Result<RECT> {
    let mut rect = RECT::default();
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut _,
            std::mem::size_of::<RECT>() as u32,
        )?;
    }
    Ok(rect)
}

fn monitor_bounds(hwnd: HWND) -> Result<RECT, ScreenError> {
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
        return Err(ScreenError::Capture("The display could not be read.".into()));
    }
    Ok(info.rcMonitor)
}

fn overlaps(a: &RECT, b: &RECT) -> bool {
    a.left.max(b.left) < a.right.min(b.right) && a.top.max(b.top) < a.bottom.min(b.bottom)
}

/// Cloaked windows report as visible but are not drawn: another virtual desktop,
/// or a suspended Store app.
fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked = 0u32;
    let read = unsafe {
        DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, std::mem::size_of::<u32>() as u32)
    };
    read.is_ok() && cloaked != 0
}

struct InView {
    area: RECT,
    stop_at: Option<HWND>,
    stopped: bool,
    found: Vec<WindowInfo>,
}

unsafe extern "system" fn visit(hwnd: HWND, state: LPARAM) -> BOOL {
    let search = unsafe { &mut *(state.0 as *mut InView) };
    if search.stop_at == Some(hwnd) {
        search.stopped = true;
        return FALSE;
    }
    let drawn = unsafe { IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() } && !is_cloaked(hwnd);
    // Bounds nobody can read count as overlapping, because this list guards a refusal.
    if drawn && frame_bounds(hwnd).map_or(true, |bounds| overlaps(&bounds, &search.area)) {
        search.found.push(describe(hwnd));
    }
    TRUE
}

/// Every window a capture could show besides its target. A window capture stops at
/// the target, because the list runs front to back and only what is in front can show.
// ponytail: a whole-screen capture lists the whole display, so a password manager
// covered by other windows blocks it too. Subtract the windows above each one if
// that turns out too strict.
pub fn windows_in_view(hwnd: isize, whole_screen: bool) -> Result<Vec<WindowInfo>, ScreenError> {
    let target = HWND(hwnd as *mut _);
    let (area, stop_at) = if whole_screen { (monitor_bounds(target)?, None) } else { (frame_bounds(target)?, Some(target)) };
    let mut search = InView { area, stop_at, stopped: false, found: Vec::new() };
    let listed = unsafe { EnumWindows(Some(visit), LPARAM(&mut search as *mut InView as isize)) };
    // Stopping early reads as a failure. A real one must refuse, not pass an empty list.
    if !search.stopped {
        listed?;
    }
    Ok(search.found)
}

/// A part of a frame, as fractions of its size so it survives preview scaling.
pub fn crop(frame: &Frame, x: f64, y: f64, w: f64, h: f64) -> Option<Frame> {
    let unit = |v: f64| v.clamp(0.0, 1.0);
    let left = (unit(x) * frame.width as f64) as usize;
    let top = (unit(y) * frame.height as f64) as usize;
    let width = ((unit(x + w) * frame.width as f64) as usize).saturating_sub(left);
    let height = ((unit(y + h) * frame.height as f64) as usize).saturating_sub(top);
    if width < 8 || height < 8 {
        return None;
    }
    let stride = frame.width as usize * 4;
    let mut bgra = Vec::with_capacity(width * height * 4);
    for row in top..top + height {
        let start = row * stride + left * 4;
        bgra.extend_from_slice(&frame.bgra[start..start + width * 4]);
    }
    Some(Frame { width: width as u32, height: height as u32, bgra })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(width: u32, height: u32) -> Frame {
        let mut bgra = Vec::new();
        for y in 0..height {
            for x in 0..width {
                bgra.extend_from_slice(&[x as u8, y as u8, 0, 255]);
            }
        }
        Frame { width, height, bgra }
    }

    #[test]
    fn only_a_shared_area_counts_as_overlapping() {
        let area = RECT { left: 0, top: 0, right: 100, bottom: 100 };
        assert!(overlaps(&area, &RECT { left: 99, top: 99, right: 200, bottom: 200 }));
        assert!(!overlaps(&area, &RECT { left: 100, top: 0, right: 200, bottom: 100 }), "touching edges");
        assert!(!overlaps(&area, &RECT { left: 50, top: 50, right: 50, bottom: 50 }), "no size");
    }

    #[test]
    fn crop_takes_the_right_pixels() {
        let frame = gradient(100, 100);
        let part = crop(&frame, 0.5, 0.25, 0.2, 0.5).unwrap();
        assert_eq!((part.width, part.height), (20, 50));
        assert_eq!(&part.bgra[..2], &[50, 25]);
    }

    #[test]
    fn crop_never_reads_outside_the_frame() {
        let frame = gradient(40, 40);
        let part = crop(&frame, 0.9, 0.9, 5.0, 5.0);
        assert!(part.is_none() || part.unwrap().bgra.len() <= frame.bgra.len());
    }

    #[test]
    fn a_tiny_selection_is_refused() {
        assert!(crop(&gradient(100, 100), 0.5, 0.5, 0.01, 0.01).is_none());
    }
}
