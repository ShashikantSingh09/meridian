//! Media through the system media transport controls, which any well-behaved
//! player publishes: Spotify, browsers, VLC, Media Player and others. Nothing here
//! knows about one service. Only what a player exposes can be read or controlled,
//! and each control's availability comes from the player itself.
//!
//! One thread owns the WinRT objects and sleeps until the system reports a change,
//! waking every few seconds to catch players that change without saying so, and to
//! listen for the few that publish nothing at all. See `audio`.

mod audio;
pub use audio::audible_now;

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use windows::core::{Result, HSTRING};
use windows::ApplicationModel::AppInfo;
use windows::Foundation::TypedEventHandler;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionMediaProperties as Properties,
    GlobalSystemMediaTransportControlsSessionPlaybackControls as Controls,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::DataReader;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

const ARTWORK_LIMIT: u32 = 2 * 1024 * 1024;
/// One tick of .NET-style time span, in 100 ns units.
const TICKS_PER_MS: i64 = 10_000;
/// How often to look again when nothing has reported a change.
const HEARTBEAT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    /// The player's own id, used to select it.
    pub session: String,
    pub app: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub playing: bool,
    pub position_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub can_toggle: bool,
    pub can_next: bool,
    pub can_previous: bool,
    pub can_seek: bool,
    pub artwork: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Snapshot {
    pub current: Option<Track>,
    pub sessions: Vec<Track>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Action {
    Toggle,
    Next,
    Previous,
    Seek { position_ms: u64 },
    /// Follow this player instead of the one Windows considers current.
    Select { session: String },
    /// Send the current state again, for an interface that has just started listening.
    Refresh,
}

enum Wake {
    Changed,
    /// Sessions came or went, so the listeners need redoing.
    Sessions,
    Do(Action),
}

/// A readable name from a player's app id.
pub fn app_name(id: &str) -> String {
    let lower = id.to_lowercase();
    const KNOWN: &[(&str, &str)] = &[
        ("spotify", "Spotify"),
        ("saavn", "JioSaavn"),
        ("chrome", "Chrome"),
        ("msedge", "Edge"),
        ("firefox", "Firefox"),
        ("308046b0af4a39cb", "Firefox"),
        ("brave", "Brave"),
        ("opera", "Opera"),
        ("vivaldi", "Vivaldi"),
        ("vlc", "VLC"),
        ("zunemusic", "Media Player"),
        ("zunevideo", "Movies & TV"),
        ("applemusic", "Apple Music"),
        ("itunes", "iTunes"),
        ("foobar", "foobar2000"),
        ("winamp", "Winamp"),
        ("deezer", "Deezer"),
        ("tidal", "TIDAL"),
    ];
    if let Some((_, name)) = KNOWN.iter().find(|(needle, _)| lower.contains(needle)) {
        return (*name).to_string();
    }
    // A Store app is Publisher.Name_hash!Entry, and the entry is usually just "App".
    if let Some((package, _)) = id.split_once('!') {
        let name = package.split('_').next().unwrap_or(package);
        return name.rsplit('.').next().unwrap_or(name).to_string();
    }
    let base = id.rsplit('\\').next().unwrap_or(id);
    base.trim_end_matches(".exe").trim_end_matches(".EXE").to_string()
}

/// What Windows calls a Store app, so a player nobody listed still gets its real name.
fn display_name(id: &str) -> String {
    static NAMES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    let mut names = NAMES.get_or_init(Mutex::default).lock().unwrap_or_else(|e| e.into_inner());
    names
        .entry(id.to_string())
        .or_insert_with(|| {
            let store = || AppInfo::GetFromAppUserModelId(&HSTRING::from(id))?.DisplayInfo()?.DisplayName();
            store().ok().map(|n| n.to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| app_name(id))
        })
        .clone()
}

fn ms(ticks: i64) -> Option<u64> {
    (ticks > 0).then_some((ticks / TICKS_PER_MS) as u64)
}

fn artwork(session: &Session) -> Option<String> {
    let props = session.TryGetMediaPropertiesAsync().ok()?.join().ok()?;
    let stream = props.Thumbnail().ok()?.OpenReadAsync().ok()?.join().ok()?;
    let size = stream.Size().ok()?.min(ARTWORK_LIMIT as u64) as u32;
    if size == 0 {
        return None;
    }
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).ok()?).ok()?;
    reader.LoadAsync(size).ok()?.join().ok()?;
    let mut bytes = vec![0u8; size as usize];
    reader.ReadBytes(&mut bytes).ok()?;
    let kind = stream.ContentType().map(|t| t.to_string()).unwrap_or_default();
    let kind = if kind.is_empty() { "image/jpeg".to_string() } else { kind };
    Some(format!("data:{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Only the app and its status are required. A player that will not say what is on
/// still has to show as playing.
fn read(session: &Session, with_artwork: bool) -> Result<Track> {
    let id = session.SourceAppUserModelId()?.to_string();
    let info = session.GetPlaybackInfo()?;
    let props = session.TryGetMediaPropertiesAsync().and_then(|op| op.join()).ok();
    let text = |get: fn(&Properties) -> Result<HSTRING>| props.as_ref().and_then(|p| get(p).ok()).map(|s| s.to_string()).unwrap_or_default();
    let controls = info.Controls().ok();
    let can = |get: fn(&Controls) -> Result<bool>| controls.as_ref().and_then(|c| get(c).ok()).unwrap_or(false);
    let timeline = session.GetTimelineProperties().ok();
    let position = timeline.as_ref().and_then(|t| t.Position().ok()).map_or(0, |p| p.Duration);
    let end = timeline.as_ref().and_then(|t| t.EndTime().ok()).map_or(0, |p| p.Duration);
    Ok(Track {
        app: display_name(&id),
        session: id,
        title: text(Properties::Title),
        artist: text(Properties::Artist),
        album: text(Properties::AlbumTitle),
        playing: info.PlaybackStatus()? == Status::Playing,
        position_ms: ms(position).or(if end > 0 { Some(0) } else { None }),
        duration_ms: ms(end),
        can_toggle: can(Controls::IsPlayPauseToggleEnabled) || can(Controls::IsPlayEnabled) || can(Controls::IsPauseEnabled),
        can_next: can(Controls::IsNextEnabled),
        can_previous: can(Controls::IsPreviousEnabled),
        can_seek: can(Controls::IsPlaybackPositionEnabled),
        artwork: if with_artwork { artwork(session) } else { None },
    })
}

fn all_sessions(manager: &Manager) -> Result<Vec<Session>> {
    let sessions = manager.GetSessions()?;
    let mut out = Vec::new();
    for i in 0..sessions.Size()? {
        out.push(sessions.GetAt(i)?);
    }
    Ok(out)
}

/// What decides which session is shown, best first: making sound, the user's pick, paused
/// over one that never started, one that says what is on, then what Windows calls current.
/// Sound beats the pick so that a player chosen yesterday cannot hide the one playing now.
/// The title matters because one of JioSaavn's two sessions refuses to give details.
fn rank(status: Option<Status>, id: Option<&str>, pick: Option<&str>, titled: bool, current: Option<&str>) -> (bool, bool, bool, bool, bool) {
    (status == Some(Status::Playing), id.is_some() && id == pick, status == Some(Status::Paused), titled, id.is_some() && id == current)
}

fn chosen(manager: &Manager, pick: Option<&str>) -> Option<Session> {
    let current = manager.GetCurrentSession().and_then(|s| s.SourceAppUserModelId()).ok().map(|i| i.to_string());
    all_sessions(manager).ok()?.into_iter().max_by_key(|s| {
        let id = s.SourceAppUserModelId().ok().map(|i| i.to_string());
        let status = s.GetPlaybackInfo().and_then(|i| i.PlaybackStatus()).ok();
        let titled = s.TryGetMediaPropertiesAsync().and_then(|op| op.join()).and_then(|p| p.Title()).is_ok_and(|t| !t.is_empty());
        rank(status, id.as_deref(), pick, titled, current.as_deref())
    })
}

/// One row per app, because one app can hold several sessions: JioSaavn keeps two.
fn add(list: &mut Vec<Track>, track: Track) {
    let worth = |t: &Track| (t.playing, !t.title.is_empty());
    match list.iter_mut().find(|t| t.session == track.session) {
        Some(kept) if worth(&track) > worth(kept) => *kept = track,
        Some(_) => {}
        None => list.push(track),
    }
}

/// Sound outranks what a player reports. One Windows calls paused or idle is playing if
/// it can be heard this moment, and one it does not list at all is added. Only a sound
/// heard just now counts against a pause, so that pausing takes effect at once.
fn apply_heard(list: &mut Vec<Track>, heard: Vec<audio::Heard>) {
    for audio::Heard { track, now } in heard {
        let exe = track.session.to_lowercase();
        match list.iter_mut().find(|t| t.session.to_lowercase().contains(&exe)) {
            Some(known) => {
                known.playing |= now;
                if known.title.is_empty() {
                    known.title = track.title;
                    known.artist = track.artist;
                }
            }
            None => list.push(track),
        }
    }
}

fn snapshot(manager: &Manager, pick: Option<&str>, ears: &mut audio::Ears) -> Snapshot {
    let mut list = Vec::new();
    for track in all_sessions(manager).unwrap_or_default().iter().filter_map(|s| read(s, false).ok()) {
        add(&mut list, track);
    }
    apply_heard(&mut list, ears.players());
    let shown = chosen(manager, pick).and_then(|s| read(&s, true).ok());
    let playing = list.iter().find(|t| t.playing).cloned();
    let current = match (shown, playing) {
        (Some(shown), _) if shown.playing => Some(shown),
        (Some(shown), Some(best)) if shown.session == best.session => Some(Track { artwork: shown.artwork, ..best }),
        (shown, best) => best.or(shown),
    };
    Snapshot { current, sessions: list }
}

fn perform(manager: &Manager, pick: &mut Option<String>, action: Action) {
    if let Action::Select { session } = &action {
        *pick = Some(session.clone());
        return;
    }
    let Some(session) = chosen(manager, pick.as_deref()) else { return };
    // Each call reports whether the player accepted it. A refusal changes nothing.
    let _ = match action {
        Action::Toggle => session.TryTogglePlayPauseAsync().map(|_| ()),
        Action::Next => session.TrySkipNextAsync().map(|_| ()),
        Action::Previous => session.TrySkipPreviousAsync().map(|_| ()),
        Action::Seek { position_ms } => {
            session.TryChangePlaybackPositionAsync(position_ms as i64 * TICKS_PER_MS).map(|_| ())
        }
        Action::Select { .. } | Action::Refresh => Ok(()),
    };
}

/// Sends controls to the watcher thread. Dropping it ends the thread.
#[derive(Clone)]
pub struct Controller(Sender<Wake>);

impl Controller {
    pub fn perform(&self, action: Action) {
        let _ = self.0.send(Wake::Do(action));
    }
}

fn listen(manager: &Manager, tx: &Sender<Wake>) -> Result<()> {
    let wake = tx.clone();
    manager.SessionsChanged(&TypedEventHandler::new(move |_, _| {
        let _ = wake.send(Wake::Sessions);
        Ok(())
    }))?;
    let wake = tx.clone();
    manager.CurrentSessionChanged(&TypedEventHandler::new(move |_, _| {
        let _ = wake.send(Wake::Changed);
        Ok(())
    }))?;
    Ok(())
}

/// Listening to one session. Ends when dropped.
struct Listener {
    session: Session,
    properties: i64,
    playback: i64,
}

impl Drop for Listener {
    fn drop(&mut self) {
        let _ = self.session.RemoveMediaPropertiesChanged(self.properties);
        let _ = self.session.RemovePlaybackInfoChanged(self.playback);
    }
}

fn listen_session(session: &Session, tx: &Sender<Wake>) -> Result<Listener> {
    let wake = tx.clone();
    let properties = session.MediaPropertiesChanged(&TypedEventHandler::new(move |_, _| {
        let _ = wake.send(Wake::Changed);
        Ok(())
    }))?;
    let wake = tx.clone();
    let playback = session.PlaybackInfoChanged(&TypedEventHandler::new(move |_, _| {
        let _ = wake.send(Wake::Changed);
        Ok(())
    }))?;
    Ok(Listener { session: session.clone(), properties, playback })
}

fn run(rx: Receiver<Wake>, tx: Sender<Wake>, on_change: impl Fn(Snapshot)) -> Result<()> {
    // Audio devices are COM, and this thread never pumps messages.
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let manager = Manager::RequestAsync()?.join()?;
    listen(&manager, &tx)?;
    let mut pick: Option<String> = None;
    let mut last = Snapshot::default();
    // Held only so they stay alive.
    let mut _listeners: Vec<Listener> = Vec::new();
    let mut ears = audio::Ears::default();
    let _ = tx.send(Wake::Sessions);

    loop {
        let mut wake = match rx.recv_timeout(HEARTBEAT) {
            Ok(first) => {
                // Players send bursts of events for one change.
                std::thread::sleep(Duration::from_millis(120));
                Some(first)
            }
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => return Ok(()),
        };
        let mut sessions_changed = false;
        let mut resend = false;
        while let Some(event) = wake.take() {
            match event {
                Wake::Do(Action::Refresh) => resend = true,
                Wake::Do(action) => perform(&manager, &mut pick, action),
                Wake::Sessions => sessions_changed = true,
                Wake::Changed => {}
            }
            wake = rx.try_recv().ok();
        }
        // By session, never by app id: one app can hold several, and only one of them plays.
        if sessions_changed {
            _listeners = all_sessions(&manager).unwrap_or_default().iter().filter_map(|s| listen_session(s, &tx).ok()).collect();
        }
        let now = snapshot(&manager, pick.as_deref(), &mut ears);
        if now != last || resend {
            on_change(now.clone());
            last = now;
        }
    }
}

/// Starts watching. `on_change` runs on the watcher's thread whenever what is
/// playing changes. If the system offers no media controls this simply never fires.
pub fn watch(on_change: impl Fn(Snapshot) + Send + 'static) -> Controller {
    let (tx, rx) = mpsc::channel();
    let keep = tx.clone();
    std::thread::spawn(move || {
        if let Err(err) = run(rx, keep, on_change) {
            eprintln!("media controls unavailable: {err}");
        }
    });
    Controller(tx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_common_players_and_cleans_the_rest() {
        assert_eq!(app_name("Spotify.exe"), "Spotify");
        assert_eq!(app_name("MSEdge"), "Edge");
        assert_eq!(app_name("308046B0AF4A39CB"), "Firefox");
        assert_eq!(app_name("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "Media Player");
        assert_eq!(app_name("C:\\Tools\\player.exe"), "player");
        assert_eq!(app_name("Saavn.SaavnMusicRadio_ax02tpqam95xr!App"), "JioSaavn");
        assert_eq!(app_name("Some.NewPlayer_abc123!App"), "NewPlayer");
    }

    #[test]
    fn sound_decides_what_is_shown() {
        let pick = Some("old");
        let best = |a, b| rank(Some(a), Some("old"), pick, true, None).max(rank(Some(b), Some("new"), pick, true, None));
        assert_eq!(best(Status::Paused, Status::Playing), rank(Some(Status::Playing), Some("new"), pick, true, None), "a pick cannot hide what is playing");
        assert_eq!(best(Status::Paused, Status::Opened), rank(Some(Status::Paused), Some("old"), pick, true, None), "with no sound the pick stays");
        let idle = rank(Some(Status::Opened), Some("saavn"), None, true, None);
        assert!(rank(Some(Status::Paused), Some("saavn"), None, false, None) > idle, "a paused session beats one that never started");
        let silent = rank(Some(Status::Paused), Some("saavn"), None, false, None);
        assert!(rank(Some(Status::Paused), Some("saavn"), None, true, None) > silent, "of two paused sessions, the one that says what is on");
    }

    fn track(session: &str, title: &str, playing: bool) -> Track {
        Track {
            session: session.into(),
            app: "Player".into(),
            title: title.into(),
            artist: String::new(),
            album: String::new(),
            playing,
            position_ms: None,
            duration_ms: None,
            can_toggle: false,
            can_next: false,
            can_previous: false,
            can_seek: false,
            artwork: None,
        }
    }

    #[test]
    fn sound_outranks_what_a_player_reports() {
        let store = "Saavn.SaavnMusicRadio_ax02tpqam95xr!App";
        let mut list = vec![track(store, "", false)];
        apply_heard(&mut list, vec![audio::Heard { track: track("Saavn", "", true), now: true }]);
        assert!(list[0].playing, "Windows said paused, but it can be heard");
        assert_eq!(list.len(), 1);

        let mut list = vec![track(store, "Song", false)];
        apply_heard(&mut list, vec![audio::Heard { track: track("Saavn", "", true), now: false }]);
        assert!(!list[0].playing, "a pause takes effect without waiting out the hold");

        let mut list = Vec::new();
        apply_heard(&mut list, vec![audio::Heard { track: track("vlc", "Song", true), now: false }]);
        assert_eq!(list.len(), 1, "a player Windows never lists is still shown");
    }

    #[test]
    fn one_app_with_two_sessions_is_one_row() {
        let track = |title: &str, playing| track("saavn", title, playing);
        let mut list = Vec::new();
        add(&mut list, track("", false));
        add(&mut list, track("Song", true));
        add(&mut list, track("", false));
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "Song");
    }

    #[test]
    fn a_zero_timeline_means_unknown_not_zero() {
        assert_eq!(ms(0), None);
        assert_eq!(ms(25_000_000), Some(2500));
    }

    #[test]
    fn parses_the_actions_the_interface_sends() {
        let seek: Action = serde_json::from_str(r#"{"action":"seek","positionMs":1500}"#).unwrap();
        assert!(matches!(seek, Action::Seek { position_ms: 1500 }));
        let select: Action = serde_json::from_str(r#"{"action":"select","session":"Spotify.exe"}"#).unwrap();
        assert!(matches!(select, Action::Select { session } if session == "Spotify.exe"));
    }
}
