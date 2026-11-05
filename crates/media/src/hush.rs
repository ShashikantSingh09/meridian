//! Quiets the room while the user talks to the assistant: mutes other apps' sound on the default
//! output, then gives back exactly what it took. Our own sound stays, and so do the system's
//! sounds, anything the user had muted already and, when asked, call apps.
//!
//! One thread owns every COM object and takes asks in order, so a quick on and off cannot cross.
//! What it mutes is written to a file first, so a crash can be undone at the next start.

use std::collections::HashMap;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::Duration;

use windows::core::Interface;
use windows::Win32::Foundation::{CloseHandle, S_OK};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, ISimpleAudioVolume,
    MMDeviceEnumerator,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};

/// Call apps, by how their executable's name starts, in lower case. Checked against the session's
/// process and its parents, because some, like the new Teams, play through a child process.
/// Webex also runs as `CiscoCollabHost` and `atmgr`, and Skype for Business as `lync`.
const CALLS: &[&str] = &["ms-teams", "teams", "zoom", "webex", "ciscocollabhost", "atmgr", "skype", "lync", "discord", "slack"];

/// One audio session, as far as choosing goes.
#[derive(Default)]
struct Seen {
    /// What Windows calls this session instance. It holds the process id, so it never names another.
    instance: String,
    system: bool,
    muted: bool,
    /// The session's process, then its parents, nearest first, with each executable's name in lower case.
    chain: Vec<(u32, String)>,
}

fn is_call(exe: &str) -> bool {
    CALLS.iter().any(|call| exe.starts_with(call))
}

/// The sessions to mute.
fn chosen(seen: &[Seen], leave_calls: bool, own_pid: u32) -> Vec<usize> {
    let ours = |s: &Seen| s.chain.iter().any(|(pid, _)| *pid == own_pid);
    let call = |s: &Seen| leave_calls && s.chain.iter().any(|(_, exe)| is_call(exe));
    (0..seen.len()).filter(|&i| !seen[i].system && !seen[i].muted && !ours(&seen[i]) && !call(&seen[i])).collect()
}

/// The sessions to unmute: only those it muted, and only while they are still muted.
fn to_unmute(seen: &[Seen], muted: &[String]) -> Vec<usize> {
    (0..seen.len()).filter(|&i| seen[i].muted && muted.contains(&seen[i].instance)).collect()
}

/// A process and its parents. A parent's id can be reused by a later process, which can make a loop.
// ponytail: a reused id that lands on ours makes a stranger look like ours, so it stays loud; add a creation-time check if that is ever seen.
fn chain(tree: &HashMap<u32, (u32, String)>, pid: u32) -> Vec<(u32, String)> {
    let mut out: Vec<(u32, String)> = Vec::new();
    let mut at = pid;
    while !out.iter().any(|(seen, _)| *seen == at) {
        let Some((parent, exe)) = tree.get(&at) else {
            out.push((at, String::new()));
            break;
        };
        out.push((at, exe.clone()));
        at = *parent;
    }
    out
}

/// The depth of nested asks, and what the outermost one muted.
#[derive(Default)]
struct Held {
    depth: u32,
    muted: Vec<String>,
}

impl Held {
    /// True for the outermost `on`, which is the one that quiets the room.
    fn enter(&mut self) -> bool {
        self.depth += 1;
        self.depth == 1
    }

    /// What to give back, once the last `off` arrives. An `off` with nothing on does nothing.
    fn leave(&mut self) -> Option<Vec<String>> {
        self.depth = self.depth.checked_sub(1)?;
        (self.depth == 0).then(|| std::mem::take(&mut self.muted))
    }

    /// Gives everything back whatever the depth.
    fn release(&mut self) -> Option<Vec<String>> {
        self.depth = self.depth.min(1);
        self.leave()
    }
}

/// Every process's parent and executable name.
fn tree() -> HashMap<u32, (u32, String)> {
    let mut out = HashMap::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
        while more {
            let name = &entry.szExeFile;
            let len = name.iter().position(|&c| c == 0).unwrap_or(name.len());
            out.insert(entry.th32ProcessID, (entry.th32ParentProcessID, String::from_utf16_lossy(&name[..len]).to_lowercase()));
            more = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }
    out
}

/// The sessions on the default output, with a handle to each one's mute.
fn sessions() -> windows::core::Result<(Vec<Seen>, Vec<ISimpleAudioVolume>)> {
    let tree = tree();
    let (mut seen, mut volumes) = (Vec::new(), Vec::new());
    unsafe {
        let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let manager: IAudioSessionManager2 = devices.GetDefaultAudioEndpoint(eRender, eConsole)?.Activate(CLSCTX_ALL, None)?;
        let list = manager.GetSessionEnumerator()?;
        for i in 0..list.GetCount()? {
            let Ok(control) = list.GetSession(i).and_then(|c| c.cast::<IAudioSessionControl2>()) else { continue };
            let (Ok(volume), Ok(raw)) = (control.cast::<ISimpleAudioVolume>(), control.GetSessionInstanceIdentifier()) else { continue };
            let instance = raw.to_string().unwrap_or_default();
            CoTaskMemFree(Some(raw.0 as *const _));
            // A session with no name could not be found again to give back.
            if instance.is_empty() {
                continue;
            }
            seen.push(Seen {
                instance,
                system: control.IsSystemSoundsSession() == S_OK,
                // Unreadable counts as muted, so it is left alone.
                muted: volume.GetMute().map_or(true, |m| m.as_bool()),
                chain: chain(&tree, control.GetProcessId().unwrap_or(0)),
            });
            volumes.push(volume);
        }
    }
    Ok((seen, volumes))
}

/// Written whole or not at all, since a half-written list could not be read back.
fn save(crash_file: &Path, muted: &[String]) -> std::io::Result<()> {
    if let Some(dir) = crash_file.parent() {
        fs::create_dir_all(dir)?;
    }
    let part = crash_file.with_extension("part");
    fs::write(&part, serde_json::to_string(muted)?)?;
    fs::rename(part, crash_file)
}

/// Mutes the chosen sessions and says which ones took. The list is written before anything is
/// muted, so a crash part way still leaves a record.
fn quiet(crash_file: &Path, leave_calls: bool, own_pid: u32) -> Result<Vec<String>, Box<dyn Error>> {
    let (seen, volumes) = sessions()?;
    let picked = chosen(&seen, leave_calls, own_pid);
    // With no record, a crash would leave the sound off for good, so nothing is muted.
    save(crash_file, &picked.iter().map(|&i| seen[i].instance.clone()).collect::<Vec<_>>())?;
    Ok(picked.into_iter().filter(|&i| unsafe { volumes[i].SetMute(true, std::ptr::null()) }.is_ok()).map(|i| seen[i].instance.clone()).collect())
}

/// Unmutes what it muted, then forgets the record. If the sessions cannot be read the record stays,
/// for the next start to try.
// ponytail: an app restarted while muted gets a new instance and Windows may keep it muted; match on the app's session identifier too if that is reported.
fn give_back(crash_file: &Path, muted: &[String]) {
    match sessions() {
        Ok((seen, volumes)) => {
            for i in to_unmute(&seen, muted) {
                let _ = unsafe { volumes[i].SetMute(false, std::ptr::null()) };
            }
            let _ = fs::remove_file(crash_file);
        }
        Err(err) => eprintln!("could not give the sound back: {err}"),
    }
}

/// Unmutes what a previous run left muted, from its record, then deletes the record.
fn restore_left_over(crash_file: &Path) {
    let Ok(text) = fs::read_to_string(crash_file) else { return };
    give_back(crash_file, &serde_json::from_str::<Vec<String>>(&text).unwrap_or_default());
}

enum Ask {
    On { leave_calls: bool, own_pid: u32 },
    Off,
    Release(Sender<()>),
}

fn work(rx: Receiver<Ask>, crash_file: PathBuf) {
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    // First, so a new record is never written before the old one is dealt with.
    restore_left_over(&crash_file);
    let mut held = Held::default();
    for ask in rx {
        match ask {
            Ask::On { leave_calls, own_pid } => {
                if held.enter() {
                    held.muted = quiet(&crash_file, leave_calls, own_pid).unwrap_or_else(|err| {
                        eprintln!("could not quiet the room: {err}");
                        Vec::new()
                    });
                }
            }
            Ask::Off => {
                if let Some(muted) = held.leave() {
                    give_back(&crash_file, &muted);
                }
            }
            Ask::Release(done) => {
                if let Some(muted) = held.release() {
                    give_back(&crash_file, &muted);
                }
                let _ = done.send(());
            }
        }
    }
}

/// Quiets other apps while the user talks. Each `on` needs an `off`, and only the outermost pair
/// mutes and unmutes. Starting it first gives back whatever a crashed run left muted.
pub struct Hush(Sender<Ask>);

impl Hush {
    /// `crash_file` is where the record of what is muted lives.
    pub fn new(crash_file: PathBuf) -> Self {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || work(rx, crash_file));
        Self(tx)
    }

    /// Mutes other apps, except those of the process `own_pid` and its children and, with
    /// `leave_calls`, call apps. A nested `on` only counts.
    pub fn on(&self, leave_calls: bool, own_pid: u32) {
        let _ = self.0.send(Ask::On { leave_calls, own_pid });
    }

    pub fn off(&self) {
        let _ = self.0.send(Ask::Off);
    }

    /// Gives everything back whatever the count, waiting up to a second. For quitting.
    pub fn release(&self) {
        let (tx, rx) = mpsc::channel();
        if self.0.send(Ask::Release(tx)).is_ok() {
            let _ = rx.recv_timeout(Duration::from_secs(1));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(instance: &str, chain: &[(u32, &str)]) -> Seen {
        Seen { instance: instance.into(), chain: chain.iter().map(|(pid, exe)| (*pid, exe.to_string())).collect(), ..Seen::default() }
    }

    const OURS: u32 = 100;

    fn names(seen: &[Seen], picked: Vec<usize>) -> Vec<&str> {
        picked.into_iter().map(|i| seen[i].instance.as_str()).collect()
    }

    #[test]
    fn mutes_only_other_apps() {
        let seen = vec![
            session("spotify", &[(5, "spotify.exe"), (4, "explorer.exe")]),
            Seen { system: true, ..session("system", &[(0, "")]) },
            session("us", &[(OURS, "meridian.exe")]),
            session("our webview", &[(9, "msedgewebview2.exe"), (8, "msedgewebview2.exe"), (OURS, "meridian.exe")]),
            Seen { muted: true, ..session("muted by the user", &[(6, "vlc.exe")]) },
            session("teams", &[(7, "msedgewebview2.exe"), (3, "ms-teams.exe")]),
            session("zoom", &[(2, "zoom.exe")]),
        ];
        assert_eq!(names(&seen, chosen(&seen, true, OURS)), ["spotify"]);
        assert_eq!(names(&seen, chosen(&seen, false, OURS)), ["spotify", "teams", "zoom"], "calls are muted unless asked");
    }

    #[test]
    fn every_call_app_is_left_when_asked() {
        for exe in ["ms-teams.exe", "teams.exe", "zoom.exe", "webex.exe", "ciscocollabhost.exe", "skype.exe", "discord.exe", "discordptb.exe", "slack.exe"] {
            assert!(chosen(&[session("call", &[(1, exe)])], true, OURS).is_empty(), "{exe}");
        }
        assert!(!is_call("spotify.exe"));
    }

    #[test]
    fn gives_back_only_what_it_muted_and_is_still_muted() {
        let muted = vec!["spotify".to_string(), "chrome".to_string()];
        let seen = vec![
            Seen { muted: true, ..session("spotify", &[]) },
            Seen { muted: false, ..session("chrome", &[]) },
            Seen { muted: true, ..session("muted by the user", &[]) },
        ];
        assert_eq!(names(&seen, to_unmute(&seen, &muted)), ["spotify"]);
        assert!(to_unmute(&seen, &[]).is_empty());
    }

    #[test]
    fn only_the_outermost_pair_counts() {
        let mut held = Held::default();
        assert_eq!(held.leave(), None, "an off with nothing on does nothing");
        assert!(held.enter());
        held.muted = vec!["spotify".into()];
        assert!(!held.enter(), "a nested on mutes nothing more");
        assert_eq!(held.leave(), None, "the inner off gives nothing back");
        assert_eq!(held.leave(), Some(vec!["spotify".into()]));
        assert_eq!(held.leave(), None);
        assert!(held.enter(), "it can start again");
    }

    #[test]
    fn release_gives_back_at_any_depth() {
        let mut held = Held::default();
        assert_eq!(held.release(), None);
        held.enter();
        held.enter();
        held.muted = vec!["spotify".into()];
        assert_eq!(held.release(), Some(vec!["spotify".into()]));
        assert_eq!(held.depth, 0);
    }

    #[test]
    fn a_parent_loop_ends() {
        let tree = HashMap::from([(1, (2, "a.exe".to_string())), (2, (1, "b.exe".to_string()))]);
        assert_eq!(chain(&tree, 1).len(), 2);
        assert_eq!(chain(&tree, 7), [(7, String::new())], "a process that is gone is still itself");
    }

    #[test]
    fn the_record_reads_back() {
        let file = std::env::temp_dir().join(format!("hush-test-{}.json", std::process::id()));
        save(&file, &["a".into(), "b".into()]).unwrap();
        let back: Vec<String> = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(back, ["a", "b"]);
        let _ = fs::remove_file(file);
    }
}
