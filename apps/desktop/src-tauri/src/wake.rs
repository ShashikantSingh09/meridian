//! Keeps the wake word listener open only while it should be. The microphone stays shut unless the
//! user turned this on, and it closes for a conversation and for each pause they chose.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use voice::wake::{self, Conditions, Heard, Listener, Wanted};

use crate::commands::Core;
use crate::island;

const TICK: Duration = Duration::from_secs(1);
/// How long the Test button keeps listening.
const TEST_FOR: Duration = Duration::from_secs(10);
/// Before trying again after the microphone failed.
const RETRY_AFTER: Duration = Duration::from_secs(15);
const MOST_WORDS: usize = 8;

#[derive(Clone, PartialEq, Serialize)]
pub struct Status {
    /// "off", "listening", "paused" or "failed".
    state: &'static str,
    why: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WakeHeard {
    word: String,
    test: bool,
    /// How long the whole utterance took, so the interface can tell a name from a name and a command.
    spoken_ms: u64,
}

pub struct Wake {
    talking: AtomicBool,
    testing_until: Mutex<Option<Instant>>,
    status: Mutex<Status>,
}

impl Default for Wake {
    fn default() -> Self {
        Self { talking: AtomicBool::new(false), testing_until: Mutex::new(None), status: Mutex::new(Status { state: "off", why: String::new() }) }
    }
}

#[tauri::command]
pub fn wake_status(wake: State<'_, Wake>) -> Status {
    wake.status.lock().unwrap().clone()
}

/// A conversation holds the microphone, so listening for a name waits until it ends.
#[tauri::command]
pub fn wake_talking(wake: State<'_, Wake>, on: bool) {
    wake.talking.store(on, Ordering::Relaxed);
}

#[tauri::command]
pub fn wake_test(wake: State<'_, Wake>) {
    *wake.testing_until.lock().unwrap() = Some(Instant::now() + TEST_FOR);
}

/// What the listener was opened with. When this changes it has to start again.
#[derive(PartialEq)]
struct Asked {
    words: Vec<String>,
    easiness: String,
}

fn open(app: &AppHandle, asked: &Asked, ended: mpsc::Sender<()>) -> Result<Listener, String> {
    let handle = app.clone();
    let easiness = asked.easiness.clone();
    let phrases = wake::phrases(&asked.words);
    let heard = move |heard: Heard| {
        let Some(word) = wake::phrase_in(&heard.text, &phrases).filter(|_| wake::accepted(&easiness, heard.confidence, heard.raw, heard.spoken_ms)) else { return };
        let test = handle.state::<Wake>().testing_until.lock().unwrap().take().is_some();
        let _ = handle.emit_to(island::LABEL, "wake-heard", WakeHeard { word, test, spoken_ms: heard.spoken_ms });
    };
    Listener::start(&asked.words, heard, move || {
        let _ = ended.send(());
    })
    .map_err(|err| err.to_string())
}

pub fn spawn(app: AppHandle) {
    let this_app = std::env::current_exe().ok().and_then(|path| path.file_name().map(|name| name.to_string_lossy().into_owned())).unwrap_or_default();
    std::thread::spawn(move || {
        // The recognizer is a Windows Runtime object, and its events arrive on other threads.
        let _ = unsafe { windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED) };
        let (ended, stopped) = mpsc::channel();
        let mut listening: Option<(Asked, Listener)> = None;
        let mut failed: Option<(Instant, String)> = None;
        loop {
            std::thread::sleep(TICK);
            let settings = app.state::<Core>().settings.lock().unwrap().clone();
            let state = app.state::<Wake>();
            let testing = {
                let mut until = state.testing_until.lock().unwrap();
                if until.is_some_and(|end| end <= Instant::now()) {
                    *until = None;
                }
                until.is_some()
            };
            let words: Vec<String> = settings.wake_words.iter().filter(|word| word.on).filter_map(|word| wake::clean(&word.text)).take(MOST_WORDS).collect();
            // The system is only asked about while this is on, so a user who never turns it on pays nothing.
            let active = settings.wake_enabled || testing;
            let wants = wake::wanted(&Conditions {
                enabled: settings.wake_enabled,
                monitoring_paused: settings.monitoring_paused,
                has_words: !words.is_empty(),
                testing,
                talking: state.talking.load(Ordering::Relaxed),
                charger_only: settings.wake_listen == "charger",
                on_battery: active && wake::on_battery(),
                pause_when_locked: settings.wake_pause_locked,
                locked: active && wake::screen_locked(),
                pause_during_calls: settings.wake_pause_calls,
                others_on_microphone: active && wake::others_on_microphone(&this_app),
            });

            if stopped.try_recv().is_ok() && listening.is_some() {
                listening = None;
                failed = Some((Instant::now(), "The microphone stopped. Trying again shortly.".to_string()));
            }
            let asked = Asked { words, easiness: settings.wake_sensitivity.clone() };
            if wants != Wanted::Listening || listening.as_ref().is_some_and(|(open, _)| *open != asked) {
                listening = None;
                while stopped.try_recv().is_ok() {}
            }
            if wants != Wanted::Listening {
                failed = None;
            } else if listening.is_none() && failed.as_ref().is_none_or(|(at, _)| at.elapsed() >= RETRY_AFTER) {
                match open(&app, &asked, ended.clone()) {
                    Ok(listener) => {
                        listening = Some((asked, listener));
                        failed = None;
                    }
                    Err(why) => failed = Some((Instant::now(), why)),
                }
            }

            let now = match (wants, &listening, &failed) {
                (Wanted::Off, ..) => Status { state: "off", why: String::new() },
                (Wanted::Paused(why), ..) => Status { state: "paused", why: why.to_string() },
                (Wanted::Listening, Some(_), _) => Status { state: "listening", why: String::new() },
                (Wanted::Listening, None, Some((_, why))) => Status { state: "failed", why: why.clone() },
                (Wanted::Listening, None, None) => Status { state: "off", why: String::new() },
            };
            let mut shown = state.status.lock().unwrap();
            if *shown != now {
                *shown = now.clone();
                let _ = app.emit_to(island::LABEL, "wake-state", now);
            }
        }
    });
}
