//! Publishes a silent media session of its own and checks that the watcher sees it
//! and that controls reach it. No sound plays.
//!
//!     cargo test -p media --test live_session -- --ignored

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use media::{Action, Snapshot, Track};
use windows::core::HSTRING;
use windows::Foundation::TypedEventHandler;
use windows::Media::Playback::MediaPlayer;
use windows::Media::{MediaPlaybackStatus, MediaPlaybackType, SystemMediaTransportControlsButton};

const TITLE: &str = "Meridian Test Track";

fn find(state: &Mutex<Snapshot>) -> Option<Track> {
    state.lock().unwrap().sessions.iter().find(|t| t.title == TITLE).cloned()
}

fn wait_for(mut check: impl FnMut() -> bool, what: &str) {
    let end = Instant::now() + Duration::from_secs(8);
    while !check() {
        assert!(Instant::now() < end, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
#[ignore = "publishes a system media session"]
fn sees_a_session_and_controls_it() {
    let player = MediaPlayer::new().unwrap();
    player.CommandManager().unwrap().SetIsEnabled(false).unwrap();
    let controls = player.SystemMediaTransportControls().unwrap();
    controls.SetIsEnabled(true).unwrap();
    controls.SetIsPlayEnabled(true).unwrap();
    controls.SetIsPauseEnabled(true).unwrap();
    controls.SetIsNextEnabled(true).unwrap();

    let display = controls.DisplayUpdater().unwrap();
    display.SetType(MediaPlaybackType::Music).unwrap();
    let music = display.MusicProperties().unwrap();
    music.SetTitle(&HSTRING::from(TITLE)).unwrap();
    music.SetArtist(&HSTRING::from("Test Artist")).unwrap();
    display.Update().unwrap();
    controls.SetPlaybackStatus(MediaPlaybackStatus::Playing).unwrap();

    let pressed: Arc<Mutex<Vec<SystemMediaTransportControlsButton>>> = Arc::default();
    let log = pressed.clone();
    controls
        .ButtonPressed(&TypedEventHandler::new(move |_, args: windows::core::Ref<windows::Media::SystemMediaTransportControlsButtonPressedEventArgs>| {
            if let Some(args) = args.as_ref() {
                log.lock().unwrap().push(args.Button()?);
            }
            Ok(())
        }))
        .unwrap();

    let state = Arc::new(Mutex::new(Snapshot::default()));
    let sink = state.clone();
    let controller = media::watch(move |snapshot| *sink.lock().unwrap() = snapshot);

    wait_for(|| find(&state).is_some(), "the session to appear");
    let track = find(&state).unwrap();
    assert_eq!(track.artist, "Test Artist");
    assert!(track.playing);
    assert!(track.can_next);
    assert!(!track.can_previous, "previous was never enabled");

    controller.perform(Action::Select { session: track.session.clone() });
    controller.perform(Action::Next);
    wait_for(|| pressed.lock().unwrap().contains(&SystemMediaTransportControlsButton::Next), "Next to arrive");

    controller.perform(Action::Toggle);
    wait_for(|| pressed.lock().unwrap().len() >= 2, "Toggle to arrive");

    controls.SetPlaybackStatus(MediaPlaybackStatus::Paused).unwrap();
    wait_for(|| find(&state).is_some_and(|t| !t.playing), "the pause to be seen");
}
