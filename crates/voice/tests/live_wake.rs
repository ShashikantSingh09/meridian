//! Opens the real microphone with the Windows recognizer. Say the phrase while it runs.
//!
//!     cargo test -p voice --test live_wake -- --ignored --nocapture
//!
//! WAKE_SECONDS sets how long it listens.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use voice::wake::{self, Listener};
use windows::core::{Interface, Ref, HSTRING};
use windows::Devices::Enumeration::DeviceInformation;
use windows::Foundation::TypedEventHandler;
use windows::Globalization::Language;
use windows::Media::Devices::{AudioDeviceRole, MediaDevice};
use windows::Media::SpeechRecognition::{
    ISpeechRecognitionConstraint, SpeechContinuousRecognitionCompletedEventArgs, SpeechContinuousRecognitionResultGeneratedEventArgs, SpeechRecognitionListConstraint,
    SpeechRecognitionQualityDegradingEventArgs, SpeechRecognizer, SpeechRecognizerStateChangedEventArgs,
};
use windows::System::UserProfile::GlobalizationPreferences;
use windows_collections::IIterable;

fn seconds() -> u64 {
    std::env::var("WAKE_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(6)
}

fn apartment() {
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED);
    }
}

fn device(role: AudioDeviceRole) -> String {
    MediaDevice::GetDefaultAudioCaptureId(role)
        .and_then(|id| DeviceInformation::CreateFromIdAsync(&id)?.join())
        .and_then(|info| info.Name())
        .map(|name| name.to_string())
        .unwrap_or_else(|err| format!("none: {err}"))
}

#[test]
#[ignore = "opens the real microphone"]
fn starts_and_reports_a_phrase() {
    apartment();
    let heard = Arc::new(Mutex::new(Vec::new()));
    let log = heard.clone();
    let listener = Listener::start(
        &["Hey Meridian".to_string(), "Okay Meridian".to_string()],
        move |h| {
            println!("heard [{}] {:?}", h.text, h.confidence);
            log.lock().unwrap().push(h.text);
        },
        || println!("Windows ended the session"),
    )
    .expect("the recognizer should start from an ordinary app");

    std::thread::sleep(Duration::from_secs(1));
    println!("while listening: another app on the microphone = {}", wake::others_on_microphone("voice"));
    println!("locked = {}, on battery = {}", wake::screen_locked(), wake::on_battery());
    std::thread::sleep(Duration::from_secs(seconds()));
    drop(listener);
    println!("heard {} phrases", heard.lock().unwrap().len());
}

/// Everything the recognizer reports, for when it hears nothing.
#[test]
#[ignore = "opens the real microphone"]
fn says_what_it_sees() {
    apartment();
    println!("default microphone: {}", device(AudioDeviceRole::Default));
    println!("communications microphone: {}", device(AudioDeviceRole::Communications));
    println!("user languages: {:?}", GlobalizationPreferences::Languages().unwrap().into_iter().map(|l| l.to_string()).collect::<Vec<_>>());

    let start = Instant::now();
    let at = move || format!("{:6.1}s", start.elapsed().as_secs_f32());
    let language = Language::CreateLanguage(&HSTRING::from(std::env::var("WAKE_LANGUAGE").unwrap_or_else(|_| "en-IN".into()))).unwrap();
    let recognizer = SpeechRecognizer::Create(&language).unwrap();
    println!("recognizer language: {}", recognizer.CurrentLanguage().unwrap().LanguageTag().unwrap());
    let phrases: IIterable<HSTRING> = vec![HSTRING::from("Hey Meridian"), HSTRING::from("Okay Meridian")].into();
    let constraint = SpeechRecognitionListConstraint::CreateWithTag(&phrases, &HSTRING::from("wake")).unwrap();
    recognizer.Constraints().unwrap().Append(&constraint.cast::<ISpeechRecognitionConstraint>().unwrap()).unwrap();
    println!("compiled: {:?}", recognizer.CompileConstraintsAsync().unwrap().join().unwrap().Status().unwrap());

    recognizer
        .StateChanged(&TypedEventHandler::new(move |_, args: Ref<SpeechRecognizerStateChangedEventArgs>| {
            println!("{} state {:?}", at(), args.as_ref().unwrap().State()?);
            Ok(())
        }))
        .unwrap();
    recognizer
        .RecognitionQualityDegrading(&TypedEventHandler::new(move |_, args: Ref<SpeechRecognitionQualityDegradingEventArgs>| {
            println!("{} audio problem {:?}", at(), args.as_ref().unwrap().Problem()?);
            Ok(())
        }))
        .unwrap();
    let session = recognizer.ContinuousRecognitionSession().unwrap();
    session.SetAutoStopSilenceTimeout(windows::Foundation::TimeSpan { Duration: 24 * 60 * 60 * 10_000_000 }).unwrap();
    session
        .ResultGenerated(&TypedEventHandler::new(move |_, args: Ref<SpeechContinuousRecognitionResultGeneratedEventArgs>| {
            let result = args.as_ref().unwrap().Result()?;
            println!("{} result [{}] status {:?} confidence {:?} raw {:.3}", at(), result.Text()?, result.Status()?, result.Confidence()?, result.RawConfidence()?);
            Ok(())
        }))
        .unwrap();
    session
        .Completed(&TypedEventHandler::new(move |_, args: Ref<SpeechContinuousRecognitionCompletedEventArgs>| {
            println!("{} session ended: {:?}", at(), args.as_ref().unwrap().Status()?);
            Ok(())
        }))
        .unwrap();
    session.StartAsync().unwrap().join().unwrap();
    println!("{} started", at());
    std::thread::sleep(Duration::from_secs(seconds()));
    let _ = session.CancelAsync().and_then(|stop| stop.join());
    std::thread::sleep(Duration::from_millis(300));
}

/// What the real grammar makes of a real voice: every result, whether or not it would wake.
#[test]
#[ignore = "opens the real microphone"]
fn scores_a_real_voice() {
    apartment();
    println!("default microphone: {}", device(AudioDeviceRole::Default));
    let start = Instant::now();
    let at = move || format!("{:6.1}s", start.elapsed().as_secs_f32());
    let language = Language::CreateLanguage(&HSTRING::from("en-IN")).unwrap();
    let recognizer = SpeechRecognizer::Create(&language).unwrap();
    let phrases = wake::phrases(&["Hey Meridian".to_string(), "Meridian".to_string()]);
    assert!(wake::use_grammar(&recognizer, &phrases, "en-IN").unwrap(), "the recognizer refused the grammar");
    recognizer
        .StateChanged(&TypedEventHandler::new(move |_, args: Ref<SpeechRecognizerStateChangedEventArgs>| {
            println!("{} state {:?}", at(), args.as_ref().unwrap().State()?);
            Ok(())
        }))
        .unwrap();
    recognizer
        .RecognitionQualityDegrading(&TypedEventHandler::new(move |_, args: Ref<SpeechRecognitionQualityDegradingEventArgs>| {
            println!("{} audio problem {:?}", at(), args.as_ref().unwrap().Problem()?);
            Ok(())
        }))
        .unwrap();
    let session = recognizer.ContinuousRecognitionSession().unwrap();
    session.SetAutoStopSilenceTimeout(windows::Foundation::TimeSpan { Duration: 24 * 60 * 60 * 10_000_000 }).unwrap();
    session
        .ResultGenerated(&TypedEventHandler::new(move |_, args: Ref<SpeechContinuousRecognitionResultGeneratedEventArgs>| {
            let result = args.as_ref().unwrap().Result()?;
            let spoken_ms = (result.PhraseDuration()?.Duration / 10_000).max(0) as u64;
            let (confidence, raw) = (result.Confidence()?, result.RawConfidence()?);
            let wakes = ["sure", "balanced", "easily"].map(|easiness| wake::accepted(easiness, confidence, raw, spoken_ms));
            println!("{} result [{}] status {:?} confidence {:?} raw {raw:.4} {spoken_ms} ms, wakes sure/balanced/easily {wakes:?}", at(), result.Text()?, result.Status()?, confidence);
            Ok(())
        }))
        .unwrap();
    session
        .Completed(&TypedEventHandler::new(move |_, args: Ref<SpeechContinuousRecognitionCompletedEventArgs>| {
            println!("{} session ended: {:?}", at(), args.as_ref().unwrap().Status()?);
            Ok(())
        }))
        .unwrap();
    session.StartAsync().unwrap().join().unwrap();
    println!("{} started", at());
    std::thread::sleep(Duration::from_secs(seconds()));
    let _ = session.CancelAsync().and_then(|stop| stop.join());
    std::thread::sleep(Duration::from_millis(300));
}

/// How loud each microphone is twice a second, to find the one that carries a voice.
#[test]
#[ignore = "opens the real microphone"]
fn says_how_loud_each_microphone_is() {
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::Endpoints::{IAudioEndpointVolume, IAudioMeterInformation};
    use windows::Win32::Media::Audio::{eCapture, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_SHAREMODE_SHARED, DEVICE_STATE_ACTIVE};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL, STGM_READ};

    apartment();
    println!("default microphone: {}", device(AudioDeviceRole::Default));
    println!("communications microphone: {}", device(AudioDeviceRole::Communications));
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).unwrap();
        let devices = enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE).unwrap();
        let mut open = Vec::new();
        for d in 0..devices.GetCount().unwrap() {
            let device = devices.Item(d).unwrap();
            let name = device.OpenPropertyStore(STGM_READ).unwrap().GetValue(&PKEY_Device_FriendlyName).unwrap().to_string();
            let volume: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None).unwrap();
            println!("{name}: volume {:.0}%, muted {}", volume.GetMasterVolumeLevelScalar().unwrap() * 100.0, volume.GetMute().unwrap().as_bool());
            let client: IAudioClient = device.Activate(CLSCTX_ALL, None).unwrap();
            let format = client.GetMixFormat().unwrap();
            let shape = format.read_unaligned();
            println!("  {} channels at {} Hz, {} bits", { shape.nChannels }, { shape.nSamplesPerSec }, { shape.wBitsPerSample });
            client.Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 10_000_000, 0, format, None).unwrap();
            client.Start().unwrap();
            let meter: IAudioMeterInformation = device.Activate(CLSCTX_ALL, None).unwrap();
            open.push((name, client, meter));
        }
        for tick in 0..seconds() * 2 {
            std::thread::sleep(Duration::from_millis(500));
            let levels: Vec<String> = open.iter().map(|(name, _, meter)| format!("{:.12} {:.3}", name, meter.GetPeakValue().unwrap())).collect();
            println!("{:5.1}s {}", tick as f32 / 2.0, levels.join("   "));
        }
    }
}

/// Follows a voice from the microphone to the recognizer, twice a second: the device meter, the audio
/// before Windows' effects, what an ordinary app gets, and what a speech stream gets.
#[test]
#[ignore = "opens the real microphone"]
fn follows_a_voice_through_windows() {
    use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
    use windows::Win32::Media::Audio::{
        eCapture, eConsole, AudioCategory_Other, AudioCategory_Speech, AudioClientProperties, IAudioCaptureClient, IAudioClient2, IMMDeviceEnumerator, MMDeviceEnumerator,
        AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMOPTIONS_NONE, AUDCLNT_STREAMOPTIONS_RAW,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

    apartment();
    let start = Instant::now();
    let listener = Listener::start(
        &["Hey Meridian".to_string(), "Meridian".to_string()],
        move |h| println!("{:6.1}s HEARD [{}] {:?} raw {:.4} {} ms", start.elapsed().as_secs_f32(), h.text, h.confidence, h.raw, h.spoken_ms),
        || println!("Windows ended the session"),
    )
    .unwrap();
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).unwrap();
        let device = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole).unwrap();
        let meter: IAudioMeterInformation = device.Activate(CLSCTX_ALL, None).unwrap();
        let mut streams = Vec::new();
        for (name, category, options) in [("raw", AudioCategory_Other, AUDCLNT_STREAMOPTIONS_RAW), ("ordinary", AudioCategory_Other, AUDCLNT_STREAMOPTIONS_NONE), ("speech", AudioCategory_Speech, AUDCLNT_STREAMOPTIONS_NONE)] {
            let client: IAudioClient2 = device.Activate(CLSCTX_ALL, None).unwrap();
            client.SetClientProperties(&AudioClientProperties { cbSize: size_of::<AudioClientProperties>() as u32, bIsOffload: false.into(), eCategory: category, Options: options }).unwrap();
            let format = client.GetMixFormat().unwrap();
            let channels = format.read_unaligned().nChannels as usize;
            client.Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 10_000_000, 0, format, None).unwrap();
            let capture: IAudioCaptureClient = client.GetService().unwrap();
            client.Start().unwrap();
            streams.push((name, client, capture, channels));
        }
        for tick in 0..seconds() * 2 {
            let mut loudest = [0_f32; 3];
            let mut metered = 0_f32;
            let end = Instant::now() + Duration::from_millis(500);
            while Instant::now() < end {
                std::thread::sleep(Duration::from_millis(20));
                metered = metered.max(meter.GetPeakValue().unwrap());
                for (at, (_, _, capture, channels)) in streams.iter().enumerate() {
                    while capture.GetNextPacketSize().unwrap() > 0 {
                        let (mut data, mut frames, mut flags) = (std::ptr::null_mut(), 0_u32, 0_u32);
                        capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None).unwrap();
                        for sample in std::slice::from_raw_parts(data as *const f32, frames as usize * channels) {
                            loudest[at] = loudest[at].max(sample.abs());
                        }
                        capture.ReleaseBuffer(frames).unwrap();
                    }
                }
            }
            println!("{:5.1}s meter {metered:.4} raw {:.4} ordinary {:.4} speech {:.4}", tick as f32 / 2.0, loudest[0], loudest[1], loudest[2]);
        }
        for (_, client, _, _) in &streams {
            client.Stop().unwrap();
        }
    }
    drop(listener);
}

/// Sets the slider to where it already is, which proves the call without changing anything.
#[test]
#[ignore = "touches the Windows microphone slider"]
fn sets_the_slider() {
    apartment();
    let microphone = wake::DefaultMicrophone::open().unwrap();
    let before = microphone.percent().unwrap();
    println!("{}: {before}%, muted {}", microphone.name, microphone.muted().unwrap());
    assert!(!microphone.muted().unwrap(), "setting the slider unmutes, so this needs a microphone that is not muted");
    microphone.set_percent(before).unwrap();
    assert_eq!(microphone.percent().unwrap(), before);
}

/// The Windows default microphone's slider and level over time, to catch anything moving the slider.
/// Opens no stream of its own, so the level reads 0 unless something else has the microphone open.
#[test]
#[ignore = "opens the real microphone"]
fn watches_the_default_microphone() {
    use windows::Win32::Media::Audio::Endpoints::{IAudioEndpointVolume, IAudioMeterInformation};
    use windows::Win32::Media::Audio::{eCapture, eConsole, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

    apartment();
    println!("default microphone: {}", device(AudioDeviceRole::Default));
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).unwrap();
        let device = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole).unwrap();
        let volume: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None).unwrap();
        let meter: IAudioMeterInformation = device.Activate(CLSCTX_ALL, None).unwrap();
        for tick in 0..seconds() * 2 {
            std::thread::sleep(Duration::from_millis(500));
            println!("{:5.1}s slider {:.1}% peak {:.3}", tick as f32 / 2.0, volume.GetMasterVolumeLevelScalar().unwrap() * 100.0, meter.GetPeakValue().unwrap());
        }
    }
}

/// Which microphone the recognizer really opens, read from the sessions Windows lists on each one.
#[test]
#[ignore = "opens the real microphone"]
fn says_which_microphone_it_uses() {
    use windows::core::PCWSTR;
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::{eCapture, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL, STGM_READ};

    apartment();
    let listener = Listener::start(&["Hey Meridian".to_string()], |_| {}, || {}).unwrap();
    std::thread::sleep(Duration::from_secs(2));
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).unwrap();
        let devices = enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE).unwrap();
        for d in 0..devices.GetCount().unwrap() {
            let device = devices.Item(d).unwrap();
            let name = device.OpenPropertyStore(STGM_READ).unwrap().GetValue(&PKEY_Device_FriendlyName).unwrap().to_string();
            let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None).unwrap();
            let sessions = manager.GetSessionEnumerator().unwrap();
            let mut users = Vec::new();
            for s in 0..sessions.GetCount().unwrap() {
                let control = sessions.GetSession(s).unwrap();
                let state = control.GetState().unwrap();
                let pid = control.cast::<IAudioSessionControl2>().unwrap().GetProcessId().unwrap_or(0);
                users.push(format!("pid {pid} state {}", state.0));
            }
            println!("{name}: {users:?}");
        }
        let _ = PCWSTR::null();
    }
    drop(listener);
}

/// The grammar that finds a name inside a sentence has to compile here, or it falls back to exact phrases.
#[test]
#[ignore = "uses the Windows recognizer"]
fn the_grammar_compiles_on_this_pc() {
    apartment();
    let language = Language::CreateLanguage(&HSTRING::from("en-IN")).unwrap();
    let recognizer = SpeechRecognizer::Create(&language).unwrap();
    let phrases = wake::phrases(&["Hey Meridian".to_string()]);
    println!("{} phrases: {phrases:?}", phrases.len());
    assert!(wake::use_grammar(&recognizer, &phrases, "en-IN").unwrap(), "the recognizer refused the grammar");
}
