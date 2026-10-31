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
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream, RandomAccessStreamReference};

const TITLE: &str = "Meridian Test Track";
/// The session tests publish the same track from one process, so they take turns.
static ONE_SESSION: Mutex<()> = Mutex::new(());

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
    let _turn = ONE_SESSION.lock().unwrap_or_else(|e| e.into_inner());
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
    let sends = Arc::new(Mutex::new(0));
    let (sink, count) = (state.clone(), sends.clone());
    let controller = media::watch(move |snapshot| {
        *sink.lock().unwrap() = snapshot;
        *count.lock().unwrap() += 1;
    });

    wait_for(|| find(&state).is_some(), "the session to appear");
    let before = *sends.lock().unwrap();
    controller.perform(Action::Refresh);
    wait_for(|| *sends.lock().unwrap() > before, "a refresh to send the state again");
    // Windows can publish the title before the artist, so a later update has to bring it.
    wait_for(|| find(&state).is_some_and(|t| t.artist == "Test Artist"), "the artist to be seen");
    let track = find(&state).unwrap();
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

/// Plays a stream far too quiet to hear, and checks the system meter picks it up.
#[test]
#[ignore = "opens an audio stream, at a level nobody can hear"]
fn hears_an_app_making_sound() {
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::*;

    let pid = std::process::id();
    assert!(!media::audible_now().contains(&pid));
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).unwrap();
        let device = devices.GetDefaultAudioEndpoint(eRender, eConsole).unwrap();
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None).unwrap();
        let format = client.GetMixFormat().unwrap();
        let channels = (*format).nChannels as usize;
        client.Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 2_000_000, 0, format, None).unwrap();
        let size = client.GetBufferSize().unwrap();
        let render: IAudioRenderClient = client.GetService().unwrap();
        client.Start().unwrap();

        let mut sign = 1.0_f32;
        let mut heard = false;
        let end = Instant::now() + Duration::from_secs(4);
        while !heard && Instant::now() < end {
            let free = size - client.GetCurrentPadding().unwrap();
            let buffer = render.GetBuffer(free).unwrap() as *mut f32;
            for i in 0..free as usize * channels {
                sign = -sign;
                *buffer.add(i) = sign * 0.0005;
            }
            render.ReleaseBuffer(free, 0).unwrap();
            std::thread::sleep(Duration::from_millis(40));
            heard = media::audible_now().contains(&pid);
        }
        client.Stop().unwrap();
        assert!(heard, "the meter never reported this process");
    }
}

/// A real picture, sent through Windows the way a player sends one. Set MERIDIAN_HOLD_SECS to
/// keep the session open and look at it in the running app.
#[test]
#[ignore = "publishes a system media session"]
fn reads_album_art() {
    let _turn = ONE_SESSION.lock().unwrap_or_else(|e| e.into_inner());
    // A 1 by 1 red PNG.
    const PNG: [u8; 69] = [
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0,
        0x90, 0x77, 0x53, 0xde, 0, 0, 0, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0, 0, 0x03, 0x01, 0x01, 0,
        0x18, 0xdd, 0x8d, 0xb0, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];
    let player = MediaPlayer::new().unwrap();
    player.CommandManager().unwrap().SetIsEnabled(false).unwrap();
    let controls = player.SystemMediaTransportControls().unwrap();
    controls.SetIsEnabled(true).unwrap();
    controls.SetIsPlayEnabled(true).unwrap();
    controls.SetIsPauseEnabled(true).unwrap();

    let stream = InMemoryRandomAccessStream::new().unwrap();
    let writer = DataWriter::CreateDataWriter(&stream).unwrap();
    writer.WriteBytes(&PNG).unwrap();
    writer.StoreAsync().unwrap().join().unwrap();
    writer.FlushAsync().unwrap().join().unwrap();
    writer.DetachStream().unwrap();
    stream.Seek(0).unwrap();

    let display = controls.DisplayUpdater().unwrap();
    display.SetType(MediaPlaybackType::Music).unwrap();
    display.MusicProperties().unwrap().SetTitle(&HSTRING::from(TITLE)).unwrap();
    display.SetThumbnail(&RandomAccessStreamReference::CreateFromStream(&stream).unwrap()).unwrap();
    display.Update().unwrap();
    controls.SetPlaybackStatus(MediaPlaybackStatus::Playing).unwrap();

    let state = Arc::new(Mutex::new(Snapshot::default()));
    let sink = state.clone();
    let _watching = media::watch(move |snapshot| *sink.lock().unwrap() = snapshot);
    wait_for(
        || state.lock().unwrap().current.as_ref().is_some_and(|t| t.title == TITLE && t.artwork.is_some()),
        "the artwork to arrive",
    );
    assert!(state.lock().unwrap().current.as_ref().unwrap().artwork.as_ref().unwrap().starts_with("data:image"));

    let hold = std::env::var("MERIDIAN_HOLD_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    std::thread::sleep(Duration::from_secs(hold));
}

/// Moves the volume by one step and straight back, which is too small to notice.
#[test]
#[ignore = "changes the system volume for a moment"]
fn hears_the_volume_change() {
    let heard = Arc::new(Mutex::new(Vec::new()));
    let sink = heard.clone();
    media::levels::watch(move |level| sink.lock().unwrap().push(level));
    std::thread::sleep(Duration::from_millis(600));

    let before = media::levels::volume_now().unwrap();
    let nudged = if before > 0.5 { before - 0.01 } else { before + 0.01 };
    media::levels::set_volume(nudged).unwrap();
    wait_for(|| !heard.lock().unwrap().is_empty(), "the change to be reported");
    media::levels::set_volume(before).unwrap();
    assert!(matches!(heard.lock().unwrap()[0], media::levels::Level::Volume { .. }));
}
