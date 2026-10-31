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
