//! The terminal a Claude Code session runs in: finding its window, bringing it to the front, and
//! telling whether it is there already. The session's own process has no window, so the search
//! goes up through the processes that started it, nearest first. A window is only ever raised by
//! the command, which the interface calls from a click.

use std::path::Path;

use windows::core::BOOL;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GetForegroundWindow, GetWindow, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
    IsWindowVisible, SetForegroundWindow, ShowWindow, GW_OWNER, SW_RESTORE,
};

/// Where a process tree starts. Above these are the desktop and the system, never a terminal.
const TOPS: [&str; 4] = ["explorer.exe", "services.exe", "wininit.exe", "svchost.exe"];

/// One row of the process table.
pub struct ProcessEntry {
    pub pid: u32,
    pub parent: u32,
    pub exe: String,
}

/// A visible top-level window: its handle, the process that owns it, and its title.
type Window = (HWND, u32, String);

/// The process and the ones that started it, nearest first, stopping below a tree top, at a
/// parent that has gone, or where the chain loops back.
/// ponytail: a parent id Windows has since given to a newer process is taken as the parent. Compare start times if that ever picks a stranger.
fn chain(table: &[ProcessEntry], pid: u32) -> Vec<(u32, String)> {
    let mut found: Vec<(u32, String)> = Vec::new();
    let mut at = pid;
    while at != 0 && at != 4 && !found.iter().any(|(seen, _)| *seen == at) {
        let Some(entry) = table.iter().find(|entry| entry.pid == at) else { break };
        if TOPS.iter().any(|top| entry.exe.eq_ignore_ascii_case(top)) {
            break;
        }
        found.push((at, entry.exe.clone()));
        at = entry.parent;
    }
    found
}

fn processes() -> Vec<ProcessEntry> {
    let mut table = Vec::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return table };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
        while more {
            let name = &entry.szExeFile;
            let len = name.iter().position(|&c| c == 0).unwrap_or(name.len());
            table.push(ProcessEntry {
                pid: entry.th32ProcessID,
                parent: entry.th32ParentProcessID,
                exe: String::from_utf16_lossy(&name[..len]),
            });
            more = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }
    table
}

/// The session's process and its parents, nearest first, with each one's program name.
pub fn ancestors(pid: u32) -> Vec<(u32, String)> {
    chain(&processes(), pid)
}

/// The nearest process in the chain with a window. Where it has several, as an editor does, the
/// one whose title names the project's folder. `project` may be the folder's name or its path.
fn choose(windows: &[Window], chain: &[(u32, String)], project: Option<&str>) -> Option<HWND> {
    let folder = project.and_then(|p| Path::new(p).file_name()).map(|name| name.to_string_lossy().to_lowercase());
    chain.iter().find_map(|(pid, _)| {
        let mut theirs = windows.iter().filter(|(_, owner, _)| owner == pid).peekable();
        let first = theirs.peek()?.0;
        let named = folder.as_ref().and_then(|folder| theirs.find(|(.., title)| title.to_lowercase().contains(folder.as_str())));
        Some(named.map_or(first, |(hwnd, ..)| *hwnd))
    })
}

fn top_windows() -> Vec<Window> {
    unsafe extern "system" fn visit(hwnd: HWND, list: LPARAM) -> BOOL {
        let list = unsafe { &mut *(list.0 as *mut Vec<Window>) };
        let shown = unsafe { IsWindowVisible(hwnd) }.as_bool() && unsafe { GetWindow(hwnd, GW_OWNER) }.is_err();
        if shown {
            let mut owner = 0;
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut owner)) };
            let mut title = [0u16; 512];
            let len = unsafe { GetWindowTextW(hwnd, &mut title) }.max(0) as usize;
            list.push((hwnd, owner, String::from_utf16_lossy(&title[..len])));
        }
        true.into()
    }
    let mut list: Vec<Window> = Vec::new();
    let _ = unsafe { EnumWindows(Some(visit), LPARAM(&mut list as *mut Vec<Window> as isize)) };
    list
}

/// The window the session's terminal is in, if one can be found.
/// ponytail: a shell that Windows handed to Windows Terminal after it started has the terminal outside its chain, so none is found. Match the terminal's own tabs if that turns out common.
pub fn window_for(pid: u32, project_hint: Option<&str>) -> Option<HWND> {
    let chain = ancestors(pid);
    if chain.is_empty() {
        return None;
    }
    choose(&top_windows(), &chain, project_hint)
}

/// Restores a minimised window and brings it to the front. Windows only lets the app in front
/// do that, so this joins the input of whatever is in front for the moment it takes.
pub fn focus(hwnd: HWND) -> bool {
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let ours = GetCurrentThreadId();
        let front = GetWindowThreadProcessId(GetForegroundWindow(), None);
        let joined = front != 0 && front != ours && AttachThreadInput(ours, front, true).as_bool();
        let raised = SetForegroundWindow(hwnd).as_bool();
        let _ = BringWindowToTop(hwnd);
        if joined {
            let _ = AttachThreadInput(ours, front, false);
        }
        raised
    }
}

/// True when the window in front belongs to the session's process or one of its parents.
/// ponytail: any window of that terminal counts, so another tab or editor window of the same app does too.
pub fn in_front(pid: u32) -> bool {
    let mut owner = 0;
    unsafe {
        let front = GetForegroundWindow();
        if front.is_invalid() {
            return false;
        }
        GetWindowThreadProcessId(front, Some(&mut owner));
    }
    owner != 0 && ancestors(pid).iter().any(|(each, _)| *each == owner)
}

/// Brings the session's terminal to the front. False when no window for it was found.
#[tauri::command]
pub fn terminal_focus(pid: u32, project: Option<String>) -> Result<bool, String> {
    let Some(hwnd) = window_for(pid, project.as_deref()) else { return Ok(false) };
    if focus(hwnd) {
        Ok(true)
    } else {
        Err("Windows would not bring that terminal to the front.".into())
    }
}

#[tauri::command]
pub fn terminal_in_front(pid: u32) -> bool {
    in_front(pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(rows: &[(u32, u32, &str)]) -> Vec<ProcessEntry> {
        rows.iter().map(|&(pid, parent, exe)| ProcessEntry { pid, parent, exe: exe.into() }).collect()
    }

    fn pids(found: &[(u32, String)]) -> Vec<u32> {
        found.iter().map(|(pid, _)| *pid).collect()
    }

    #[test]
    fn the_walk_goes_up_to_the_desktop_and_no_further() {
        let processes = table(&[
            (900, 1, "wininit.exe"),
            (800, 900, "services.exe"),
            (700, 0, "Explorer.EXE"),
            (300, 700, "WindowsTerminal.exe"),
            (200, 300, "pwsh.exe"),
            (100, 200, "claude.exe"),
            (50, 800, "svchost.exe"),
            (40, 50, "ShellHost.exe"),
        ]);
        let found = chain(&processes, 100);
        assert_eq!(pids(&found), [100, 200, 300]);
        assert_eq!(found[2].1, "WindowsTerminal.exe");
        assert_eq!(pids(&chain(&processes, 40)), [40], "a service is a top too");
        assert!(chain(&processes, 700).is_empty(), "the desktop itself is never the terminal");
    }

    #[test]
    fn the_walk_stops_at_a_loop_a_missing_parent_and_the_system() {
        let looped = table(&[(1, 3, "a.exe"), (2, 1, "b.exe"), (3, 2, "c.exe")]);
        assert_eq!(pids(&chain(&looped, 2)), [2, 1, 3]);
        let itself = table(&[(5, 5, "a.exe")]);
        assert_eq!(pids(&chain(&itself, 5)), [5]);

        let orphan = table(&[(10, 77, "node.exe"), (11, 10, "claude.exe")]);
        assert_eq!(pids(&chain(&orphan, 11)), [11, 10]);
        assert!(chain(&orphan, 99).is_empty(), "a process that has gone has no chain");

        let system = table(&[(4, 0, "System"), (0, 0, "[System Process]"), (20, 4, "smss.exe")]);
        assert_eq!(pids(&chain(&system, 20)), [20]);
        assert!(chain(&system, 4).is_empty());
        assert!(chain(&system, 0).is_empty());
    }

    fn hwnd(n: usize) -> HWND {
        HWND(n as *mut _)
    }

    fn window(n: usize, owner: u32, title: &str) -> Window {
        (hwnd(n), owner, title.into())
    }

    fn of(pids: &[u32]) -> Vec<(u32, String)> {
        pids.iter().map(|&pid| (pid, String::new())).collect()
    }

    #[test]
    fn the_nearest_process_with_a_window_wins() {
        let windows = [window(1, 500, "Code"), window(2, 300, "Windows PowerShell"), window(3, 999, "shop")];
        assert_eq!(choose(&windows, &of(&[100, 200, 300, 500]), Some("shop")), Some(hwnd(2)));
        assert_eq!(choose(&windows, &of(&[100, 500]), None), Some(hwnd(1)));
        assert_eq!(choose(&windows, &of(&[100, 200]), Some("shop")), None, "a stranger's window is never picked");
        assert_eq!(choose(&windows, &[], None), None);
    }

    #[test]
    fn among_one_processes_windows_the_project_name_wins() {
        let windows = [
            window(1, 500, "notes.md - blog - Visual Studio Code"),
            window(2, 500, "cart.ts - Shop - Visual Studio Code"),
            window(3, 500, ""),
        ];
        let editor = of(&[100, 200, 500]);
        assert_eq!(choose(&windows, &editor, Some("shop")), Some(hwnd(2)));
        assert_eq!(choose(&windows, &editor, Some("G:\\Work\\shop")), Some(hwnd(2)), "a path counts by its folder");
        assert_eq!(choose(&windows, &editor, Some("elsewhere")), Some(hwnd(1)), "no match falls back to the first");
        assert_eq!(choose(&windows, &editor, None), Some(hwnd(1)));
        assert_eq!(choose(&windows, &editor, Some("C:\\")), Some(hwnd(1)), "a drive names no folder");
    }
}
