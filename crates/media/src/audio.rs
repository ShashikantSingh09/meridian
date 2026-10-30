//! Knowing a player is playing from the sound it makes. Some players never publish to the
//! system media controls, and with some the controls are wrong: when JioSaavn's second
//! session starts playing, Windows drops that session from its list and keeps the idle one.
//! Windows also lists every app with an open audio stream and how loud it is, and that
//! cannot be wrong. Only the apps named in `PLAYERS` are reported, so a game or a call
//! never shows as music, and the title of that app's window is all that is read from it.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use windows::core::{Interface, Result, BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
use windows::Win32::Media::Audio::{
    eRender, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
    MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible};

use crate::Track;

/// Peak level below which a stream counts as silent.
const SILENCE: f32 = 0.000_1;
/// A quiet moment inside a song should not make the player vanish.
const HOLD: Duration = Duration::from_secs(8);

/// Executable name, what to call it, and what it adds to the end of its window title.
const PLAYERS: &[(&str, &str, &str)] = &[
    ("saavn", "JioSaavn", "JioSaavn"),
    ("spotify", "Spotify", "Spotify Premium"),
    ("applemusic", "Apple Music", "Apple Music"),
    ("amazon music", "Amazon Music", "Amazon Music"),
    ("deezer", "Deezer", "Deezer"),
    ("tidal", "TIDAL", "TIDAL"),
    ("wynk", "Wynk Music", "Wynk Music"),
    ("gaana", "Gaana", "Gaana"),
    ("youtube music", "YouTube Music", "YouTube Music"),
    ("vlc", "VLC", " - VLC media player"),
    ("itunes", "iTunes", "iTunes"),
    ("winamp", "Winamp", " - Winamp"),
    ("foobar2000", "foobar2000", " [foobar2000]"),
    ("aimp", "AIMP", ""),
    ("musicbee", "MusicBee", " - MusicBee"),
    ("mediamonkey", "MediaMonkey", " - MediaMonkey"),
    ("wmplayer", "Windows Media Player", " - Windows Media Player"),
    ("potplayermini64", "PotPlayer", " - PotPlayer"),
    ("potplayermini", "PotPlayer", " - PotPlayer"),
    ("mpc-hc64", "MPC-HC", " - MPC-HC"),
    ("mpc-hc", "MPC-HC", " - MPC-HC"),
    ("mpc-be64", "MPC-BE", " - MPC-BE"),
    ("audacious", "Audacious", " - Audacious"),
    ("strawberry", "Strawberry", ""),
    ("clementine", "Clementine", ""),
];

fn known(exe: &str) -> Option<&'static (&'static str, &'static str, &'static str)> {
    PLAYERS.iter().find(|(name, ..)| name.eq_ignore_ascii_case(exe))
}

/// Splits a player's window title into a title and an artist, when it holds both.
pub(crate) fn parse_title(window: &str, suffix: &str) -> (String, String) {
    let text = window.trim().strip_suffix(suffix).unwrap_or(window.trim()).trim();
    match text.split_once(" - ") {
        Some((artist, title)) => (title.trim().to_string(), artist.trim().to_string()),
        None => (text.to_string(), String::new()),
    }
}

/// Every app making sound on any output right now, by process id.
fn audible() -> Result<Vec<u32>> {
    let mut out = Vec::new();
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let devices = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
        for d in 0..devices.GetCount()? {
            let manager: IAudioSessionManager2 = devices.Item(d)?.Activate(CLSCTX_ALL, None)?;
            let sessions = manager.GetSessionEnumerator()?;
            for s in 0..sessions.GetCount()? {
                let control = sessions.GetSession(s)?;
                let loud = control.GetState().is_ok_and(|state| state == AudioSessionStateActive)
                    && control.cast::<IAudioMeterInformation>().and_then(|m| m.GetPeakValue()).is_ok_and(|peak| peak > SILENCE);
                if loud {
                    out.push(control.cast::<IAudioSessionControl2>()?.GetProcessId()?);
                }
            }
        }
    }
    Ok(out)
}

fn exe_name(pid: u32) -> Option<String> {
    let mut buffer = [0u16; 512];
    let mut len = buffer.len() as u32;
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let done = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut len);
        let _ = CloseHandle(process);
        done.ok()?;
    }
    let path = String::from_utf16_lossy(&buffer[..len as usize]);
    let file = path.rsplit('\\').next()?;
    Some(file.rsplit_once('.').map_or(file, |(stem, _)| stem).to_string())
}

fn window_title(pid: u32) -> Option<String> {
    struct Search {
        pid: u32,
        title: Option<String>,
    }
    unsafe extern "system" fn visit(window: HWND, search: LPARAM) -> BOOL {
        let search = unsafe { &mut *(search.0 as *mut Search) };
        let mut owner = 0;
        unsafe { GetWindowThreadProcessId(window, Some(&mut owner)) };
        if owner != search.pid || !unsafe { IsWindowVisible(window) }.as_bool() {
            return true.into();
        }
        let mut buffer = [0u16; 512];
        let len = unsafe { GetWindowTextW(window, &mut buffer) } as usize;
        if len == 0 {
            return true.into();
        }
        search.title = Some(String::from_utf16_lossy(&buffer[..len]));
        false.into()
    }
    let mut search = Search { pid, title: None };
    // Stopping early reports an error, which here only means the window was found.
    let _ = unsafe { EnumWindows(Some(visit), LPARAM(&mut search as *mut Search as isize)) };
    search.title
}

/// A player that was heard, and whether that was just now rather than a moment ago.
pub(crate) struct Heard {
    pub track: Track,
    pub now: bool,
}

/// Remembers when each player was last heard.
#[derive(Default)]
pub(crate) struct Ears {
    heard: HashMap<u32, Instant>,
}

impl Ears {
    pub(crate) fn players(&mut self) -> Vec<Heard> {
        let now = Instant::now();
        for pid in audible().unwrap_or_default() {
            if exe_name(pid).is_some_and(|exe| known(&exe).is_some()) {
                self.heard.insert(pid, now);
            }
        }
        self.heard.retain(|_, at| now.duration_since(*at) < HOLD);
        self.heard
            .iter()
            .filter_map(|(&pid, &at)| {
                let exe = exe_name(pid)?;
                let (_, app, suffix) = known(&exe)?;
                let (title, artist) = window_title(pid).map(|w| parse_title(&w, suffix)).unwrap_or_default();
                let track = Track {
                    session: exe,
                    app: (*app).to_string(),
                    title,
                    artist,
                    album: String::new(),
                    playing: true,
                    position_ms: None,
                    duration_ms: None,
                    can_toggle: false,
                    can_next: false,
                    can_previous: false,
                    can_seek: false,
                    artwork: None,
                };
                Some(Heard { track, now: at == now })
            })
            .collect()
    }
}

/// Process ids making sound now, for the live test.
pub fn audible_now() -> Vec<u32> {
    audible().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_title_out_of_a_window_name() {
        assert_eq!(parse_title("Nina Simone - Sinnerman - VLC media player", " - VLC media player"), ("Sinnerman".into(), "Nina Simone".into()));
        assert_eq!(parse_title("sinnerman.mp3 - VLC media player", " - VLC media player"), ("sinnerman.mp3".into(), String::new()));
        assert_eq!(parse_title("iTunes", "iTunes"), (String::new(), String::new()));
    }

    #[test]
    fn only_named_players_count_as_music() {
        assert_eq!(known("VLC").map(|p| p.1), Some("VLC"));
        assert!(known("Discord").is_none());
        assert!(known("game").is_none());
    }
}
