//! Notes of a call, from Record to a finished note. A click is the only way one starts, and the
//! island shows it for as long as it runs.
//!
//! The page sends the microphone here and `media` brings the PC's sound, each to a file of its own.
//! When recording stops, both go to the hearing service and come back as words, which become the
//! note. The audio is deleted once that is safe. If it fails the audio stays, so nothing is lost.

use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use agent_adapters::once;
use ai_core::{ChatEvent, ChatRequest, Message, Role};
use chrono::{Local, TimeZone};
use media::loopback::{Loopback, RATE};
use notes::{apply_summary, build, summary_request, Line, Note, Speaker, Status, Store, Word, MIC_FILE, SUMMARY_INSTRUCTIONS, SYSTEM_FILE};
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;
use voice::cloud::{self, TimedWord};
use voice::to_wav;

use crate::commands::Core;
use crate::links::refuse_if_local;
use crate::{island, voice as hearing};

/// A recording left running by mistake should not run all night.
const LONGEST_RECORDING: Duration = Duration::from_secs(4 * 60 * 60);
/** After this long with nobody speaking on either side, a recording offers to stop. */
const QUIET_FOR: Duration = Duration::from_secs(15 * 60);
/** How long that offer waits for Keep recording before it stops. */
const QUIET_GRACE: Duration = Duration::from_secs(30);
/** A peak this loud, on either side, is someone speaking. The same as VOICED_LEVEL, as a fraction. */
const VOICED_PEAK: f32 = VOICED_LEVEL as f32 / 32768.0;

/** Keep recording was pressed, so the quiet so far no longer counts. */
static KEEP_GOING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[derive(Debug, PartialEq)]
enum Quiet {
    Fine,
    /** Stops in this many seconds unless someone speaks or Keep recording is pressed. */
    Warn(u64),
    Stop,
}

/** What a recording that has been quiet this long should do. */
fn quiet_step(quiet_for: Duration) -> Quiet {
    if quiet_for >= QUIET_FOR + QUIET_GRACE {
        Quiet::Stop
    } else if quiet_for >= QUIET_FOR {
        Quiet::Warn((QUIET_FOR + QUIET_GRACE - quiet_for).as_secs().max(1))
    } else {
        Quiet::Fine
    }
}
const LOOK_EVERY: Duration = Duration::from_millis(250);
/// The microphone arrives every 100 ms, so this far behind means it has stopped.
const MIC_GONE_SAMPLES: u64 = RATE as u64 * 2;
/// Under this much sound on a side, nobody spoke there, so it is not sent to be paid for.
const VOICED_SECONDS: usize = 1;
const VOICED_LEVEL: i32 = 300;
const SUMMARY_MODEL: &str = "sonnet";
const MOST_SUMMARY_USD: &str = "2";
const SUMMARY_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const MOST_NOTES_LISTED: usize = 10;
const MOST_NOTE_CHARS: usize = 30_000;
const NEEDS_SERVICE: &str = "Notes need ElevenLabs or Deepgram. Change it in Settings, Voice.";

/// One recording being written to its file.
struct Side {
    file: BufWriter<File>,
    samples: u64,
    /// The loudest sound since the meters last looked.
    peak: i32,
}

impl Side {
    fn open(path: PathBuf) -> std::io::Result<Self> {
        Ok(Self { file: BufWriter::new(File::create(path)?), samples: 0, peak: 0 })
    }

    fn write(&mut self, samples: &[i16]) {
        for sample in samples {
            let _ = self.file.write_all(&sample.to_le_bytes());
            self.peak = self.peak.max(i32::from(*sample).abs());
        }
        self.samples += samples.len() as u64;
    }

    fn silence(&mut self, samples: u64) {
        self.write(&vec![0; samples as usize]);
    }

    fn take_peak(&mut self) -> f32 {
        std::mem::take(&mut self.peak) as f32 / 32768.0
    }
}

fn samples_since(began: Instant) -> u64 {
    (began.elapsed().as_secs_f64() * f64::from(RATE)) as u64
}

struct Recording {
    id: String,
    began: Instant,
    mic: Arc<Mutex<Side>>,
    system: Arc<Mutex<Side>>,
    /// Stops the PC's sound when dropped.
    _loopback: Loopback,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NotesState {
    notes: Vec<Note>,
    /// The note being recorded.
    recording: Option<String>,
    /// Notes whose transcript or summary is being written.
    working: Vec<String>,
}

#[derive(Serialize, Clone)]
struct Levels {
    you: f32,
    others: f32,
}

#[derive(Serialize, Clone)]
struct Failed {
    id: String,
    title: String,
    why: String,
}

pub struct NoteTaker {
    store: Store,
    notes: Mutex<Vec<Note>>,
    recording: Mutex<Option<Recording>>,
    working: Mutex<Vec<String>>,
}

pub fn state(app: &tauri::App) -> tauri::Result<NoteTaker> {
    let store = Store::new(app.path().app_local_data_dir()?.join("Notes"));
    let notes = Mutex::new(store.load());
    Ok(NoteTaker { store, notes, recording: Mutex::new(None), working: Mutex::default() })
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |time| time.as_millis() as i64)
}

fn tell(app: &AppHandle) {
    let _ = app.emit_to(island::LABEL, "notes-changed", ());
}

impl NoteTaker {
    pub fn is_recording(&self) -> bool {
        self.recording.lock().unwrap().is_some()
    }

    fn find(&self, id: &str) -> Option<Note> {
        self.notes.lock().unwrap().iter().find(|note| note.id == id).cloned()
    }

    /// Changes a note as it is now, because it may have been renamed in the meantime.
    fn change(&self, app: &AppHandle, id: &str, change: impl FnOnce(&mut Note)) -> Result<(), String> {
        let note = {
            let mut notes = self.notes.lock().unwrap();
            let note = notes.iter_mut().find(|note| note.id == id).ok_or("That note is gone.")?;
            change(note);
            note.clone()
        };
        self.store.save(&note).map_err(|err| err.to_string())?;
        tell(app);
        Ok(())
    }

    fn set_working(&self, app: &AppHandle, id: &str, working: bool) {
        let mut list = self.working.lock().unwrap();
        list.retain(|other| other != id);
        if working {
            list.push(id.to_string());
        }
        drop(list);
        tell(app);
    }

    fn state(&self) -> NotesState {
        NotesState {
            notes: self.notes.lock().unwrap().clone(),
            recording: self.recording.lock().unwrap().as_ref().map(|recording| recording.id.clone()),
            working: self.working.lock().unwrap().clone(),
        }
    }

    /// What the assistant is given when asked about a call: what there is, and the best match in full.
    pub fn about(&self, words: &str) -> String {
        let notes: Vec<Note> = self.notes.lock().unwrap().iter().filter(|note| note.status == Status::Ready).cloned().collect();
        let Some(latest) = notes.first() else { return "There are no notes yet.".to_string() };
        let wanted: Vec<String> = words.to_lowercase().split_whitespace().filter(|word| word.chars().count() > 2).map(String::from).collect();
        let hits = |note: &Note| {
            let text = format!("{}\n{}\n{}", note.title, note.summary.as_deref().unwrap_or_default(), note.transcript()).to_lowercase();
            wanted.iter().map(|word| text.matches(word.as_str()).count()).sum::<usize>()
        };
        let best = notes.iter().max_by_key(|note| hits(note)).filter(|note| hits(note) > 0).unwrap_or(latest);
        let listed: Vec<String> = notes.iter().take(MOST_NOTES_LISTED).map(|note| format!("- {}, {}", note.title, date_of(note))).collect();
        let full: String = best.markdown(&date_of(best)).chars().take(MOST_NOTE_CHARS).collect();
        format!("Recent calls:\n{}\n\nThe closest match:\n\n{full}", listed.join("\n"))
    }
}

fn date_of(note: &Note) -> String {
    Local.timestamp_millis_opt(note.started_at).single().map_or_else(String::new, |time| time.format("%A %-d %B %Y").to_string())
}

/// Every second of the file that holds sound.
fn voiced(pcm: &[u8]) -> bool {
    let loud = pcm.chunks(RATE as usize * 2).filter(|second| second.chunks_exact(2).any(|sample| i32::from(i16::from_le_bytes([sample[0], sample[1]])).abs() > VOICED_LEVEL));
    loud.count() >= VOICED_SECONDS
}

async fn words_of(service: &str, key: &str, pcm: Vec<u8>, speakers: bool) -> Result<Vec<Word>, String> {
    let timed = cloud::transcribe_words(service, key, to_wav(&pcm, RATE), speakers).await.map_err(|err| err.to_string())?;
    Ok(timed.into_iter().map(|TimedWord { text, start, end, speaker }| Word { text, start, end, speaker }).collect())
}

/// Sends what was recorded to be written down, and builds the lines from what comes back.
async fn transcribe(app: &AppHandle, id: &str) -> Result<(Vec<Speaker>, Vec<Line>), String> {
    let core = app.state::<Core>();
    let service = core.settings.lock().unwrap().voice_hearing.clone();
    if service == "local" {
        return Err(NEEDS_SERVICE.to_string());
    }
    let key = hearing::cloud_key(&core, &service)?;
    let folder = app.state::<NoteTaker>().store.folder_of(id);
    let read = |name: &str| fs::read(folder.join(name)).unwrap_or_default();
    let (mic, system) = (read(MIC_FILE), read(SYSTEM_FILE));
    let (you_spoke, others_spoke) = (voiced(&mic), voiced(&system));
    // With nobody on the PC's sound this may be people round one PC, so the voices are told apart here too.
    let (mine, theirs) = tokio::join!(
        async {
            if you_spoke { words_of(&service, &key, mic, !others_spoke).await } else { Ok(Vec::new()) }
        },
        async {
            if others_spoke { words_of(&service, &key, system, true).await } else { Ok(Vec::new()) }
        },
    );
    Ok(build(&mine?, &theirs?, "You"))
}

/// Turns a finished recording into a note. The page takes over from `note-written`.
async fn write_up(app: AppHandle, id: String) {
    let taker = app.state::<NoteTaker>();
    taker.set_working(&app, &id, true);
    match transcribe(&app, &id).await {
        Ok((speakers, lines)) => {
            let saved = taker.change(&app, &id, |note| {
                note.speakers = speakers;
                note.lines = lines;
                note.status = Status::Ready;
                note.error = None;
            });
            taker.set_working(&app, &id, false);
            // Only with the transcript safely on disk.
            if saved.is_ok() {
                taker.store.remove_audio(&id);
                let _ = app.emit_to(island::LABEL, "note-written", &id);
            }
        }
        Err(why) => {
            let _ = taker.change(&app, &id, |note| {
                note.status = Status::Failed;
                note.error = Some(why.clone());
            });
            taker.set_working(&app, &id, false);
            let title = taker.find(&id).map(|note| note.title).unwrap_or_default();
            let _ = app.emit_to(island::LABEL, "note-failed", Failed { id, title, why });
        }
    }
}

/// Ends a recording, from the Stop button, the time limit or pausing all monitoring.
pub fn stop(app: &AppHandle) {
    let taker = app.state::<NoteTaker>();
    let Some(recording) = taker.recording.lock().unwrap().take() else { return };
    let Recording { id, mic, system, _loopback, .. } = recording;
    drop(_loopback);
    let _ = mic.lock().unwrap().file.flush();
    let _ = system.lock().unwrap().file.flush();
    let _ = taker.change(app, &id, |note| {
        note.ended_at = Some(now_ms());
        note.status = Status::Writing;
    });
    tauri::async_runtime::spawn(write_up(app.clone(), id));
}

/// Keeps both files safe on disk and the meters moving, for as long as the recording lasts. Pausing
/// all monitoring ends it, whichever way it was paused.
fn watch(app: AppHandle, id: String) {
    std::thread::spawn(move || {
    let (mut voiced_at, mut warned) = (Instant::now(), false);
    KEEP_GOING.store(false, std::sync::atomic::Ordering::Relaxed);
    loop {
        std::thread::sleep(LOOK_EVERY);
        let taker = app.state::<NoteTaker>();
        let guard = taker.recording.lock().unwrap();
        let Some(recording) = guard.as_ref().filter(|recording| recording.id == id) else { return };
        let levels = {
            let (mut mic, mut system) = (recording.mic.lock().unwrap(), recording.system.lock().unwrap());
            let behind = samples_since(recording.began).saturating_sub(mic.samples);
            if behind >= MIC_GONE_SAMPLES {
                mic.silence(behind);
            }
            let _ = mic.file.flush();
            let _ = system.file.flush();
            Levels { you: mic.take_peak(), others: system.take_peak() }
        };
        let core = app.state::<Core>();
        let (paused, stop_quiet) = {
            let settings = core.settings.lock().unwrap();
            (settings.monitoring_paused, settings.stop_quiet_calls)
        };
        let over = recording.began.elapsed() >= LONGEST_RECORDING || paused;
        drop(guard);
        if levels.you > VOICED_PEAK || levels.others > VOICED_PEAK || KEEP_GOING.swap(false, std::sync::atomic::Ordering::Relaxed) {
            voiced_at = Instant::now();
        }
        let _ = app.emit_to(island::LABEL, "note-levels", levels);
        if over {
            stop(&app);
            return;
        }
        match if stop_quiet { quiet_step(voiced_at.elapsed()) } else { Quiet::Fine } {
            Quiet::Fine if warned => {
                warned = false;
                let _ = app.emit_to(island::LABEL, "note-quiet", 0u64);
            }
            Quiet::Fine => {}
            Quiet::Warn(left) => {
                warned = true;
                let _ = app.emit_to(island::LABEL, "note-quiet", left);
            }
            Quiet::Stop => {
                stop(&app);
                let _ = app.emit_to(island::LABEL, "note-stopped-quiet", &id);
                return;
            }
        }
    }
    });
}

/** Keep recording, from the island's offer to stop a quiet call. */
#[tauri::command]
pub fn notes_keep_going() {
    KEEP_GOING.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// The app is told what there is once it is listening, so nothing it should hear about is missed.
#[tauri::command]
pub fn notes_state(taker: State<'_, NoteTaker>) -> NotesState {
    taker.state()
}

/// Finishes anything left when the app last closed, however it closed.
#[tauri::command]
pub fn notes_resume(app: AppHandle, taker: State<'_, NoteTaker>) {
    let unfinished: Vec<String> = taker.notes.lock().unwrap().iter().filter(|note| matches!(note.status, Status::Recording | Status::Writing)).map(|note| note.id.clone()).collect();
    let (recording, working) = (taker.state().recording, taker.state().working);
    for id in unfinished.into_iter().filter(|id| recording.as_ref() != Some(id) && !working.contains(id)) {
        let gone = !taker.store.has_audio(&id);
        let _ = taker.change(&app, &id, |note| {
            note.ended_at.get_or_insert_with(now_ms);
            note.status = if gone { Status::Failed } else { Status::Writing };
            note.error = gone.then(|| "The recording of this call is gone.".to_string());
        });
        if !gone {
            tauri::async_runtime::spawn(write_up(app.clone(), id));
        }
    }
}

fn start(app: &AppHandle, core: &Core, taker: &NoteTaker) -> Result<String, String> {
    let settings = core.settings.lock().unwrap().clone();
    refuse_if_local(core)?;
    if settings.monitoring_paused {
        return Err("All monitoring is paused, so nothing can be recorded.".into());
    }
    if settings.voice_hearing == "local" {
        return Err(NEEDS_SERVICE.into());
    }
    hearing::cloud_key(core, &settings.voice_hearing)?;
    let mut slot = taker.recording.lock().unwrap();
    if slot.is_some() {
        return Err("A call is already recording.".into());
    }
    let note = Note::new(format!("Call · {}", Local::now().format("%-d %b, %-I:%M %P")), now_ms());
    taker.store.save(&note).map_err(|err| err.to_string())?;
    let folder = taker.store.folder_of(&note.id);
    let mic = Arc::new(Mutex::new(Side::open(folder.join(MIC_FILE)).map_err(|err| err.to_string())?));
    let system = Arc::new(Mutex::new(Side::open(folder.join(SYSTEM_FILE)).map_err(|err| err.to_string())?));
    let began = Instant::now();
    let sink = system.clone();
    let loopback = Loopback::start(began, move |samples| sink.lock().unwrap().write(samples));
    let id = note.id.clone();
    taker.notes.lock().unwrap().insert(0, note);
    *slot = Some(Recording { id: id.clone(), began, mic, system, _loopback: loopback });
    drop(slot);
    watch(app.clone(), id.clone());
    tell(app);
    Ok(id)
}

#[tauri::command]
pub fn notes_start(app: AppHandle, core: State<'_, Core>, taker: State<'_, NoteTaker>) -> Result<String, String> {
    start(&app, &core, &taker)
}

#[tauri::command]
pub fn notes_stop(app: AppHandle) {
    stop(&app);
}

/// Takes the next piece of the microphone. Sound before the first piece is filled in, so both
/// recordings start together.
#[tauri::command]
pub async fn note_audio(taker: State<'_, NoteTaker>, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(pcm) = request.body() else { return Err("Expected audio.".into()) };
    let recording = taker.recording.lock().unwrap();
    let Some(recording) = recording.as_ref() else { return Ok(()) };
    let mut mic = recording.mic.lock().unwrap();
    if mic.samples == 0 {
        mic.silence(samples_since(recording.began));
    }
    let samples: Vec<i16> = pcm.chunks_exact(2).map(|sample| i16::from_le_bytes([sample[0], sample[1]])).collect();
    mic.write(&samples);
    Ok(())
}

#[tauri::command]
pub fn notes_rename(app: AppHandle, taker: State<'_, NoteTaker>, id: String, title: String) -> Result<(), String> {
    taker.change(&app, &id, |note| note.rename(&title))
}

#[tauri::command]
pub fn notes_rename_speaker(app: AppHandle, taker: State<'_, NoteTaker>, id: String, speaker: String, name: String) -> Result<(), String> {
    taker.change(&app, &id, |note| note.rename_speaker(&speaker, &name))
}

#[tauri::command]
pub fn notes_toggle_todo(app: AppHandle, taker: State<'_, NoteTaker>, id: String, todo: String) -> Result<(), String> {
    taker.change(&app, &id, |note| note.toggle_todo(&todo))
}

#[tauri::command]
pub fn notes_delete(app: AppHandle, taker: State<'_, NoteTaker>, id: String) -> Result<(), String> {
    let state = taker.state();
    if state.recording.as_ref() == Some(&id) || state.working.contains(&id) {
        return Err("This note is still being written.".into());
    }
    let mut notes = taker.notes.lock().unwrap();
    if !notes.iter().any(|note| note.id == id) {
        return Err("That note is gone.".into());
    }
    taker.store.remove(&id).map_err(|err| err.to_string())?;
    notes.retain(|note| note.id != id);
    drop(notes);
    tell(&app);
    Ok(())
}

#[tauri::command]
pub fn notes_retry(app: AppHandle, taker: State<'_, NoteTaker>, id: String) -> Result<(), String> {
    if !taker.store.has_audio(&id) || taker.find(&id).is_none() {
        return Err("The recording of this call is gone.".into());
    }
    taker.change(&app, &id, |note| {
        note.status = Status::Writing;
        note.error = None;
    })?;
    tauri::async_runtime::spawn(write_up(app.clone(), id));
    Ok(())
}

/// Asks an AI model from Providers, the same way Chat does.
async fn ask_provider(core: &Core, provider: &str, model: String, request: String) -> Result<String, String> {
    let client = crate::commands::provider(core, provider)?;
    let message = |role, content: String| Message { role, content, images: Vec::new() };
    let chat = ChatRequest { model, messages: vec![message(Role::System, SUMMARY_INSTRUCTIONS.to_string()), message(Role::User, request)] };
    let (mut reply, mut failed) = (String::new(), None);
    let mut sink = |event: ChatEvent| match event {
        ChatEvent::Delta { text } => reply.push_str(&text),
        ChatEvent::Error { message, .. } => failed = Some(message),
        _ => {}
    };
    ai_core::run_chat(client.as_ref(), &chat, &mut sink, &CancellationToken::new()).await;
    failed.map_or(Ok(reply), Err)
}

/// Writes the summary with the engine Chat is on, which the page names.
#[tauri::command]
pub async fn notes_summarize(app: AppHandle, id: String, agent: Option<String>, provider: Option<String>, model: Option<String>) -> Result<(), String> {
    let taker = app.state::<NoteTaker>();
    let core = app.state::<Core>();
    let note = taker.find(&id).ok_or("That note is gone.")?;
    if note.lines.is_empty() {
        return Ok(());
    }
    let request = summary_request(&note);
    taker.set_working(&app, &id, true);
    let reply = match (agent.as_deref(), provider, model) {
        (Some("claude-code"), _, _) => match refuse_if_local(&core) {
            Ok(()) => once::ask(SUMMARY_INSTRUCTIONS, &request, SUMMARY_MODEL, MOST_SUMMARY_USD, SUMMARY_TIMEOUT).await,
            Err(why) => Err(why),
        },
        (Some(_), _, _) => Err("Codex cannot write summaries yet. Pick Claude Code or an AI model in Chat.".to_string()),
        (None, Some(provider), Some(model)) => ask_provider(&core, &provider, model, request).await,
        _ => Err("No AI is ready to write the summary.".to_string()),
    };
    taker.set_working(&app, &id, false);
    let reply = reply?;
    taker.change(&app, &id, |note| apply_summary(note, &reply))
}

#[tauri::command]
pub fn notes_markdown(taker: State<'_, NoteTaker>, id: String) -> Result<String, String> {
    let note = taker.find(&id).ok_or("That note is gone.")?;
    Ok(note.markdown(&date_of(&note)))
}

/// Saves where the user picks. The save dialog opens here, in the core, so the page never chooses
/// where a note is written. False when the dialog was closed without choosing.
#[tauri::command]
pub async fn notes_export(app: AppHandle, taker: State<'_, NoteTaker>, id: String, name: String) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    let note = taker.find(&id).ok_or("That note is gone.")?;
    let name: String = name.chars().filter(|c| c.is_alphanumeric() || " -".contains(*c)).collect();
    let name = if name.trim().is_empty() { "Notes".to_string() } else { name.trim().to_string() };
    let picker = app.clone();
    let chosen = tauri::async_runtime::spawn_blocking(move || picker.dialog().file().set_file_name(format!("{name}.md")).add_filter("Markdown", &["md"]).blocking_save_file())
        .await
        .map_err(|err| err.to_string())?;
    let Some(path) = chosen else { return Ok(false) };
    let path = path.into_path().map_err(|err| err.to_string())?;
    fs::write(path, note.markdown(&date_of(&note))).map_err(|err| err.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quiet_call_warns_then_stops() {
        assert_eq!(quiet_step(Duration::from_secs(60)), Quiet::Fine);
        assert_eq!(quiet_step(QUIET_FOR - Duration::from_secs(1)), Quiet::Fine);
        assert_eq!(quiet_step(QUIET_FOR), Quiet::Warn(30));
        assert_eq!(quiet_step(QUIET_FOR + Duration::from_secs(29)), Quiet::Warn(1));
        assert_eq!(quiet_step(QUIET_FOR + QUIET_GRACE), Quiet::Stop);
    }

    #[test]
    fn silence_and_a_click_are_not_someone_speaking() {
        assert!(!voiced(&[]));
        assert!(!voiced(&vec![0u8; RATE as usize * 4]));
        let mut click = vec![0u8; 400];
        click[100] = 0xFF;
        click[101] = 0x7F;
        assert!(voiced(&click), "any second with sound counts, because a short yes is still a word");
    }
}
