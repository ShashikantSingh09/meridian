//! The clipboard and the keyboard, for the paste and typing rungs. Keys go out only
//! after the user has let go of theirs, and the user's clipboard is put back.

use std::time::{Duration, Instant};

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData, GetClipboardSequenceNumber, OpenClipboard,
    RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, VIRTUAL_KEY, VK_A, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT, VK_V, VK_Z,
};
use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, HWND_MESSAGE, WINDOW_EX_STYLE, WINDOW_STYLE};

use crate::FillError;

const CF_UNICODETEXT: u32 = 13;

/// More than this on the clipboard, and the paste is refused rather than risk losing it.
const MAX_SAVED: usize = 64 * 1024 * 1024;

/// Bitmaps, metafiles, palettes, owner-drawn and private formats are handles, not
/// memory, so they cannot be copied and put back. Images still come back through
/// their DIB copy, which Windows offers beside the bitmap.
// ponytail: an app's live clipboard links (Office's "Link Source") come back as
// static copies. Delayed rendering would avoid that, if it turns out to matter.
fn copyable(format: u32) -> bool {
    !matches!(format, 2 | 3 | 9 | 14 | 128 | 130 | 131 | 142) && !(0x0200..=0x03FF).contains(&format)
}

/// UTF-16 with Windows line breaks and the closing zero, as CF_UNICODETEXT wants.
fn clipboard_text(text: &str) -> Vec<u8> {
    let lines = text.replace("\r\n", "\n").replace('\n', "\r\n");
    lines.encode_utf16().chain([0]).flat_map(u16::to_le_bytes).collect()
}

fn busy() -> FillError {
    FillError::Clipboard("The clipboard is busy, so nothing was pasted.".into())
}

/// A hidden window of Meridian's own to own the clipboard, as SetClipboardData asks.
struct Owner(HWND);

impl Owner {
    fn new() -> Result<Self, FillError> {
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                PCWSTR::null(),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                None,
                None,
            )
        }
        .map_err(|_| busy())?;
        Ok(Self(hwnd))
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        let _ = unsafe { DestroyWindow(self.0) };
    }
}

struct Open;

impl Open {
    fn new(owner: &Owner) -> Result<Self, FillError> {
        // Another app may hold it for a moment.
        for _ in 0..20 {
            if unsafe { OpenClipboard(Some(owner.0)) }.is_ok() {
                return Ok(Self);
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        Err(busy())
    }
}

impl Drop for Open {
    fn drop(&mut self) {
        let _ = unsafe { CloseClipboard() };
    }
}

type Saved = Vec<(u32, Vec<u8>)>;

/// Copies every format that is plain memory. The clipboard must be open.
fn save() -> Result<Saved, FillError> {
    let mut saved = Vec::new();
    let mut total = 0;
    let mut format = 0;
    loop {
        format = unsafe { EnumClipboardFormats(format) };
        if format == 0 {
            return Ok(saved);
        }
        if !copyable(format) {
            continue;
        }
        let Ok(handle) = (unsafe { GetClipboardData(format) }) else { continue };
        let memory = HGLOBAL(handle.0);
        let size = unsafe { GlobalSize(memory) };
        if size == 0 {
            continue;
        }
        total += size;
        if total > MAX_SAVED {
            return Err(FillError::Clipboard("Your clipboard holds too much to keep safe, so nothing was pasted.".into()));
        }
        let data = unsafe { GlobalLock(memory) };
        if data.is_null() {
            continue;
        }
        let bytes = unsafe { std::slice::from_raw_parts(data as *const u8, size) }.to_vec();
        let _ = unsafe { GlobalUnlock(memory) };
        saved.push((format, bytes));
    }
}

fn put(format: u32, bytes: &[u8]) -> bool {
    unsafe {
        let Ok(memory) = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)) else { return false };
        let data = GlobalLock(memory);
        if data.is_null() {
            let _ = GlobalFree(Some(memory));
            return false;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), data as *mut u8, bytes.len());
        let _ = GlobalUnlock(memory);
        // Once set, the memory belongs to Windows.
        if SetClipboardData(format, Some(HANDLE(memory.0))).is_err() {
            let _ = GlobalFree(Some(memory));
            return false;
        }
        true
    }
}

fn put_all(saved: &Saved) -> bool {
    unsafe { EmptyClipboard() }.is_ok() && saved.iter().all(|(format, bytes)| put(*format, bytes))
}

/// Meridian's text on the clipboard for one paste. Call [`Swap::restore`] on every path.
pub(super) struct Swap {
    owner: Owner,
    saved: Saved,
    sequence: u32,
}

pub(super) fn swap_in(text: &str) -> Result<Swap, FillError> {
    let owner = Owner::new()?;
    let open = Open::new(&owner)?;
    let saved = save()?;
    unsafe { EmptyClipboard() }.map_err(|_| busy())?;
    // These keep the paste out of Win+V history and cloud sync. Without them, nothing is pasted.
    let quiet = [
        w!("ExcludeClipboardContentFromMonitorProcessing"),
        w!("CanIncludeInClipboardHistory"),
        w!("CanUploadToCloudClipboard"),
    ];
    let mut ready = put(CF_UNICODETEXT, &clipboard_text(text));
    for name in quiet {
        let format = unsafe { RegisterClipboardFormatW(name) };
        ready &= format != 0 && put(format, &0u32.to_le_bytes());
    }
    if !ready {
        put_all(&saved);
        return Err(FillError::Clipboard("The clipboard could not be used, so nothing was pasted.".into()));
    }
    drop(open);
    let sequence = unsafe { GetClipboardSequenceNumber() };
    Ok(Swap { owner, saved, sequence })
}

impl Swap {
    /// Puts the user's clipboard back, unless they copied something new meanwhile.
    pub(super) fn restore(self) -> Result<(), FillError> {
        if unsafe { GetClipboardSequenceNumber() } != self.sequence {
            return Ok(());
        }
        let _open = Open::new(&self.owner)?;
        if put_all(&self.saved) {
            Ok(())
        } else {
            Err(FillError::Clipboard("The text went in, but part of your clipboard could not be put back.".into()))
        }
    }
}

fn key(vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

fn character(unit: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0), wScan: unit, dwFlags: KEYEVENTF_UNICODE | flags, time: 0, dwExtraInfo: 0 },
        },
    }
}

const DOWN: KEYBD_EVENT_FLAGS = KEYBD_EVENT_FLAGS(0);

fn ctrl(letter: VIRTUAL_KEY) -> [INPUT; 4] {
    [key(VK_CONTROL, DOWN), key(letter, DOWN), key(letter, KEYEVENTF_KEYUP), key(VK_CONTROL, KEYEVENTF_KEYUP)]
}

/// Windows says nothing when it drops keys bound for a window running as
/// administrator, so the read back after this is what tells.
fn send(inputs: &[INPUT]) -> Result<(), FillError> {
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err(FillError::Blocked("Windows did not take the keys, so nothing more was tried.".into()))
    }
}

const MODIFIERS: [VIRTUAL_KEY; 5] = [VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN];

/// Held keys mix into sent ones: the Ctrl Alt of Meridian's own hot key would turn
/// Ctrl+V into Ctrl+Alt+V. Reading key state is a poll, not a hook.
pub(super) fn keys_up() -> Result<(), FillError> {
    let deadline = Instant::now() + Duration::from_secs(3);
    while MODIFIERS.iter().any(|vk| unsafe { GetAsyncKeyState(vk.0 as i32) } < 0) {
        if Instant::now() > deadline {
            return Err(FillError::Blocked("Let go of Ctrl, Alt, Shift and the Windows key, then try again.".into()));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}

pub(super) fn paste_keys(replace: bool) -> Result<(), FillError> {
    if replace {
        send(&ctrl(VK_A))?;
    }
    send(&ctrl(VK_V))
}

pub(super) fn undo_keys() -> Result<(), FillError> {
    send(&ctrl(VK_Z))
}

/// Each UTF-16 unit as its own character, so Devanagari and emoji need no keyboard
/// layout. Control characters are refused: a typed newline is Enter.
pub(super) fn type_text(text: &str, replace: bool) -> Result<(), FillError> {
    if text.chars().any(char::is_control) {
        return Err(FillError::NeedsYou("Line breaks and tabs are never typed.".into()));
    }
    if replace {
        send(&ctrl(VK_A))?;
    }
    let keys: Vec<INPUT> =
        text.encode_utf16().flat_map(|unit| [character(unit, DOWN), character(unit, KEYEVENTF_KEYUP)]).collect();
    send(&keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_text_uses_windows_line_breaks_and_ends_in_zero() {
        let bytes = clipboard_text("a\nb\r\nक");
        let units: Vec<u16> = bytes.chunks(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        assert_eq!(units, [b'a' as u16, 13, 10, b'b' as u16, 13, 10, 0x0915, 0]);
    }

    #[test]
    fn handle_formats_are_not_copied() {
        assert!(copyable(CF_UNICODETEXT));
        assert!(copyable(8), "a DIB is plain memory");
        assert!(copyable(0xC0F1), "registered formats such as HTML are plain memory");
        assert!(!copyable(2), "a bitmap is a handle");
        assert!(!copyable(14), "a metafile is a handle");
        assert!(!copyable(0x0250), "private formats are the owner's");
    }
}
