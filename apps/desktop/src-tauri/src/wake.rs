//! Keeps the wake word listener running only while it should. The microphone stays shut unless the
//! user turned this on, and it closes for each pause they chose. The microphone itself is opened by
//! the interface, which sends its sound here. What it hears is compared and dropped.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Manager, State};
use voice::wake::{self, Conditions, Spotter, Wanted};

use crate::commands::Core;
use crate::island;
use crate::notetaker::NoteTaker;

const TICK: Duration = Duration::from_secs(1);
/// Longer than this with no sound, and the microphone has gone away. The interface sends a piece every 100 ms.
const GONE_QUIET: Duration = Duration::from_millis(400);
/// How long the Test button keeps listening.
const TEST_FOR: Duration = Duration::from_secs(10);
const MOST_WORDS: usize = 8;
/// A lesson gives up after this many, and keeps this many of them that are alike.
const MOST_RECORDINGS: usize = 12;
const RECORDINGS_NEEDED: usize = 4;

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
    /// How much was said after the word before it was heard, which the conversation takes in first.
    after_ms: u64,
}

pub struct Wake {
    testing_until: Mutex<Option<Instant>>,
    status: Mutex<Status>,
    spotter: Mutex<Option<Spotter>>,
    sound: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    recordings: Mutex<Vec<Vec<u8>>>,
    /// Goes up whenever a word is learned or forgotten, so the spotter is built again.
    lessons: AtomicU64,
}

impl Default for Wake {
    fn default() -> Self {
        Self {
            testing_until: Mutex::new(None),
            status: Mutex::new(Status { state: "off", why: String::new() }),
            spotter: Mutex::new(None),
            sound: Mutex::new(None),
            recordings: Mutex::new(Vec::new()),
            lessons: AtomicU64::new(0),
        }
    }
}

/// Where a word's pattern lives. The name is written out in hex, because a word can be in any script.
fn pattern_file(app: &AppHandle, word: &str) -> Result<PathBuf, String> {
    let name: String = word.trim().to_lowercase().bytes().map(|byte| format!("{byte:02x}")).collect();
    Ok(app.path().app_local_data_dir().map_err(|err| err.to_string())?.join("wake").join(format!("{name}.rpw")))
}

#[tauri::command]
pub fn wake_status(wake: State<'_, Wake>) -> Status {
    wake.status.lock().unwrap().clone()
}

#[tauri::command]
pub fn wake_test(wake: State<'_, Wake>) {
    *wake.testing_until.lock().unwrap() = Some(Instant::now() + TEST_FOR);
}

/// Takes the next piece of what the microphone hears.
#[tauri::command]
pub async fn wake_audio(wake: State<'_, Wake>, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(pcm) = request.body() else { return Err("Expected audio.".into()) };
    if let Some(sound) = wake.sound.lock().unwrap().as_ref() {
        let _ = sound.send(pcm.clone());
    }
    Ok(())
}

/// Which of these words it has learned.
#[tauri::command]
pub fn wake_taught(app: AppHandle, words: Vec<String>) -> Vec<String> {
    words.into_iter().filter(|word| pattern_file(&app, word).is_ok_and(|file| file.exists())).collect()
}

/// Takes one recording of a word, and says how many so far are really the word, and whether the
/// lesson can go on. The sound stays in memory until the lesson ends.
#[tauri::command]
pub async fn wake_teach_sample(wake: State<'_, Wake>, request: Request<'_>) -> Result<(usize, bool), String> {
    let InvokeBody::Raw(pcm) = request.body() else { return Err("Expected audio.".into()) };
    let mut recordings = wake.recordings.lock().unwrap();
    recordings.push(pcm.clone());
    let good = wake::same_word(&recordings).map_err(|err| err.to_string())?.len();
    Ok((good, recordings.len() < MOST_RECORDINGS))
}

/// Ends a lesson. With a word it learns it, and without one it drops what was recorded.
#[tauri::command]
pub async fn wake_teach_end(app: AppHandle, wake: State<'_, Wake>, word: Option<String>) -> Result<(), String> {
    let recordings = std::mem::take(&mut *wake.recordings.lock().unwrap());
    let Some(word) = word else { return Ok(()) };
    let good: Vec<Vec<u8>> = wake::same_word(&recordings).map_err(|err| err.to_string())?.into_iter().map(|i| recordings[i].clone()).collect();
    if good.len() < RECORDINGS_NEEDED {
        return Err("Those did not sound like the same word. Try again somewhere quieter, close to the microphone.".to_string());
    }
    let pattern = wake::learn(word.trim(), &good).map_err(|err| err.to_string())?;
    let file = pattern_file(&app, &word)?;
    if let Some(folder) = file.parent() {
        std::fs::create_dir_all(folder).map_err(|err| err.to_string())?;
    }
    std::fs::write(file, pattern).map_err(|err| err.to_string())?;
    wake.lessons.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn wake_forget(app: AppHandle, wake: State<'_, Wake>, word: String) -> Result<(), String> {
    match std::fs::remove_file(pattern_file(&app, &word)?) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => return Err(err.to_string()),
        _ => {}
    }
    wake.lessons.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

/// What the spotter was built from. When this changes it has to be built again.
#[derive(PartialEq)]
struct Asked {
    words: Vec<String>,
    easiness: String,
    lessons: u64,
}

fn build(app: &AppHandle, asked: &Asked) -> Result<Spotter, String> {
    let mut learned = Vec::new();
    for word in &asked.words {
        learned.push((word.clone(), std::fs::read(pattern_file(app, word)?).map_err(|err| err.to_string())?));
    }
    let (spotter, problem) = Spotter::new(&asked.easiness, &learned).map_err(|err| err.to_string())?.with_windows_speech(&asked.words, &asked.easiness);
    if let Some(problem) = problem {
        eprintln!("wake words: Windows speech is not listening, only the recordings are: {problem}");
    }
    Ok(spotter)
}

/// Sound is checked here, in the order it came, so a slow moment never holds up the interface.
fn listen(app: AppHandle, sound: mpsc::Receiver<Vec<u8>>) {
    let mut flowing = false;
    loop {
        let pcm = match sound.recv_timeout(GONE_QUIET) {
            Ok(pcm) => pcm,
            // The interface sends sound all the time it listens, so a gap means the microphone went to a
            // conversation or closed, and half a word from before it must not finish as a call later.
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if std::mem::take(&mut flowing) {
                    if let Some(spotter) = app.state::<Wake>().spotter.lock().unwrap().as_mut() {
                        spotter.settle();
                    }
                }
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        };
        flowing = true;
        let wake = app.state::<Wake>();
        let found = wake.spotter.lock().unwrap().as_mut().and_then(|spotter| spotter.hear(&pcm));
        if let Some(heard) = found {
            let test = wake.testing_until.lock().unwrap().take().is_some();
            let _ = app.emit_to(island::LABEL, "wake-heard", WakeHeard { word: heard.word, test, after_ms: heard.after_ms });
        }
    }
}

pub fn spawn(app: AppHandle) {
    let this_app = std::env::current_exe().ok().and_then(|path| path.file_name().map(|name| name.to_string_lossy().into_owned())).unwrap_or_default();
    let (sound, heard) = mpsc::channel();
    *app.state::<Wake>().sound.lock().unwrap() = Some(sound);
    let ears = app.clone();
    std::thread::spawn(move || listen(ears, heard));
    std::thread::spawn(move || {
        let mut built: Option<Asked> = None;
        let mut failed: Option<String> = None;
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
            let chosen: Vec<String> = settings.wake_words.iter().filter(|word| word.on && !word.text.trim().is_empty()).map(|word| word.text.trim().to_string()).take(MOST_WORDS).collect();
            let words: Vec<String> = chosen.iter().filter(|word| pattern_file(&app, word).is_ok_and(|file| file.exists())).cloned().collect();
            // The system is only asked about while this is on, so a user who never turns it on pays nothing.
            let active = settings.wake_enabled || testing;
            let wants = wake::wanted(&Conditions {
                enabled: settings.wake_enabled,
                monitoring_paused: settings.monitoring_paused,
                has_words: !words.is_empty(),
                testing,
                charger_only: settings.wake_listen == "charger",
                on_battery: active && wake::on_battery(),
                pause_when_locked: settings.wake_pause_locked,
                locked: active && wake::screen_locked(),
                pause_during_calls: settings.wake_pause_calls,
                others_on_microphone: active && wake::others_on_microphone(&this_app),
                recording_notes: app.state::<NoteTaker>().is_recording(),
            });

            let asked = Asked { words, easiness: settings.wake_sensitivity.clone(), lessons: state.lessons.load(Ordering::Relaxed) };
            if wants != Wanted::Listening {
                *state.spotter.lock().unwrap() = None;
                built = None;
                failed = None;
            } else if built.as_ref() != Some(&asked) {
                match build(&app, &asked) {
                    Ok(spotter) => {
                        *state.spotter.lock().unwrap() = Some(spotter);
                        built = Some(asked);
                        failed = None;
                    }
                    Err(why) => failed = Some(why),
                }
            }

            let now = match (wants, &failed) {
                (Wanted::Off, _) if settings.wake_enabled && !chosen.is_empty() => Status { state: "off", why: "Teach it your voice to start listening.".to_string() },
                (Wanted::Off, _) => Status { state: "off", why: String::new() },
                (Wanted::Paused(why), _) => Status { state: "paused", why: why.to_string() },
                (Wanted::Listening, Some(why)) => Status { state: "failed", why: why.clone() },
                (Wanted::Listening, None) => Status { state: "listening", why: String::new() },
            };
            let mut shown = state.status.lock().unwrap();
            if *shown != now {
                *shown = now.clone();
                let _ = app.emit_to(island::LABEL, "wake-state", now);
            }
        }
    });
}
