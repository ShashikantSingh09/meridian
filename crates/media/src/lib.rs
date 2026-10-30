//! Media through the system media transport controls, which any well-behaved
//! player publishes: Spotify, browsers, VLC, Media Player and others. Nothing here
//! knows about one service. Only what a player exposes can be read or controlled,
//! and each control's availability comes from the player itself.
//!
//! One thread owns the WinRT objects and sleeps until the system reports a
//! change, so an idle media module costs nothing.

use std::sync::mpsc::{self, Receiver, Sender};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use windows::core::Result;
use windows::Foundation::TypedEventHandler;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::DataReader;

const ARTWORK_LIMIT: u32 = 2 * 1024 * 1024;
/// One tick of .NET-style time span, in 100 ns units.
const TICKS_PER_MS: i64 = 10_000;

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
}

enum Wake {
    Changed,
    Do(Action),
}

/// A readable name from a player's app id.
pub fn app_name(id: &str) -> String {
    let lower = id.to_lowercase();
    const KNOWN: &[(&str, &str)] = &[
        ("spotify", "Spotify"),
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
    let base = id.rsplit(['\\', '!']).next().unwrap_or(id);
    base.trim_end_matches(".exe").trim_end_matches(".EXE").to_string()
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

fn read(session: &Session, with_artwork: bool) -> Result<Track> {
    let id = session.SourceAppUserModelId()?.to_string();
    let props = session.TryGetMediaPropertiesAsync()?.join()?;
    let info = session.GetPlaybackInfo()?;
    let controls = info.Controls()?;
    let timeline = session.GetTimelineProperties()?;
    let position = timeline.Position().map(|p| p.Duration).unwrap_or(0);
    let end = timeline.EndTime().map(|p| p.Duration).unwrap_or(0);
    Ok(Track {
        app: app_name(&id),
        session: id,
        title: props.Title()?.to_string(),
        artist: props.Artist()?.to_string(),
        album: props.AlbumTitle()?.to_string(),
        playing: info.PlaybackStatus()? == Status::Playing,
        position_ms: ms(position).or(if end > 0 { Some(0) } else { None }),
        duration_ms: ms(end),
        can_toggle: controls.IsPlayPauseToggleEnabled()? || controls.IsPlayEnabled()? || controls.IsPauseEnabled()?,
        can_next: controls.IsNextEnabled()?,
        can_previous: controls.IsPreviousEnabled()?,
        can_seek: controls.IsPlaybackPositionEnabled()?,
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

/// The user's pick if it still exists, then a playing session, then what
/// Windows calls current.
fn chosen(manager: &Manager, pick: Option<&str>) -> Option<Session> {
    let sessions = all_sessions(manager).ok()?;
    let by_id = |s: &&Session| s.SourceAppUserModelId().map(|id| id.to_string()).ok().as_deref() == pick;
    if let Some(found) = sessions.iter().find(by_id) {
        return Some(found.clone());
    }
    let playing = |s: &&Session| s.GetPlaybackInfo().and_then(|i| i.PlaybackStatus()).is_ok_and(|st| st == Status::Playing);
    sessions.iter().find(playing).cloned().or_else(|| manager.GetCurrentSession().ok())
}

fn snapshot(manager: &Manager, pick: Option<&str>) -> Snapshot {
    let sessions = all_sessions(manager).unwrap_or_default();
    let list = sessions.iter().filter_map(|s| read(s, false).ok()).collect();
    let current = chosen(manager, pick).and_then(|s| read(&s, true).ok());
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
        Action::Select { .. } => Ok(()),
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
        let _ = wake.send(Wake::Changed);
        Ok(())
    }))?;
    let wake = tx.clone();
    manager.CurrentSessionChanged(&TypedEventHandler::new(move |_, _| {
        let _ = wake.send(Wake::Changed);
        Ok(())
    }))?;
    Ok(())
}

/// Registers for changes on one session. The handlers live as long as it does.
fn listen_session(session: &Session, tx: &Sender<Wake>) -> Result<()> {
    let wake = tx.clone();
    session.MediaPropertiesChanged(&TypedEventHandler::new(move |_, _| {
        let _ = wake.send(Wake::Changed);
        Ok(())
    }))?;
    let wake = tx.clone();
    session.PlaybackInfoChanged(&TypedEventHandler::new(move |_, _| {
        let _ = wake.send(Wake::Changed);
        Ok(())
    }))?;
    Ok(())
}

fn run(rx: Receiver<Wake>, tx: Sender<Wake>, on_change: impl Fn(Snapshot)) -> Result<()> {
    let manager = Manager::RequestAsync()?.join()?;
    listen(&manager, &tx)?;
    let mut pick: Option<String> = None;
    let mut last = Snapshot::default();
    let mut watched: Vec<String> = Vec::new();
    let _ = tx.send(Wake::Changed);

    while let Ok(first) = rx.recv() {
        let mut wake = Some(first);
        // Players send bursts of events for one change.
        std::thread::sleep(Duration::from_millis(120));
        loop {
            match wake.take() {
                Some(Wake::Do(action)) => perform(&manager, &mut pick, action),
                Some(Wake::Changed) => {}
                None => break,
            }
            wake = rx.try_recv().ok();
        }
        for session in all_sessions(&manager).unwrap_or_default() {
            let id = session.SourceAppUserModelId().map(|i| i.to_string()).unwrap_or_default();
            if !watched.contains(&id) && listen_session(&session, &tx).is_ok() {
                watched.push(id);
            }
        }
        let now = snapshot(&manager, pick.as_deref());
        if now != last {
            on_change(now.clone());
            last = now;
        }
    }
    Ok(())
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
