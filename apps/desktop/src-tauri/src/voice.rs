//! The commands behind speaking and hearing. Keys stay in Windows Credential Manager and are used
//! only here, so the interface never holds one. Heard audio stays in memory for one turn at most.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use ::voice::local::{Ears, Engine, Speaker};
use ::voice::{cloud, packs, to_wav, windows_voice, VoiceError, VoiceInfo};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::{AppHandle, Manager, State};

use crate::commands::Core;
use crate::secrets;

const LOCAL_ONLY: &str = "Local-only mode is on, so nothing can go to a cloud voice.";
const NEEDS_DOWNLOAD: &str = "Hearing on this PC needs a download first. Open Settings, Voice.";
const NEEDS_ENGINE: &str = "Speech on this PC needs a small download first. Open Settings, Voice.";
/// Sent to the interface a piece at a time, so a cut-off stops within a moment.
const PIECE: usize = 4096;
/// Two minutes of 16 kHz audio is far more than one turn, and a limit on what is held.
const MOST_HEARD: usize = 2 * 60 * 16_000 * 2;

/// The voices a downloaded Kokoro model holds, in its own speaker order.
const KOKORO: [(&str, &str); 11] = [
    ("Default", "American"), ("Bella", "American"), ("Nicole", "American"), ("Sarah", "American"), ("Sky", "American"), ("Adam", "American"),
    ("Michael", "American"), ("Emma", "British"), ("Isabella", "British"), ("George", "British"), ("Lewis", "British"),
];

pub struct Voice {
    root: PathBuf,
    engine: Mutex<Option<Arc<Engine>>>,
    speaker: Mutex<Option<(String, Speaker)>>,
    ears: Mutex<Option<Ears>>,
    heard: Mutex<Vec<u8>>,
    /// Bumped to stop whatever is being said.
    turn: AtomicU64,
}

pub fn state(app: &tauri::App) -> Result<Voice, Box<dyn std::error::Error>> {
    let root = app.path().app_local_data_dir()?.join("speech");
    // Nothing has loaded the engine yet, so its files are free to go.
    packs::clear_old(&root);
    Ok(Voice {
        root,
        engine: Mutex::new(None),
        speaker: Mutex::new(None),
        ears: Mutex::new(None),
        heard: Mutex::new(Vec::new()),
        turn: AtomicU64::new(0),
    })
}

impl Voice {
    fn engine(&self) -> Result<Arc<Engine>, VoiceError> {
        let mut engine = self.engine.lock().unwrap();
        if engine.is_none() {
            let pack = packs::find("engine").filter(|pack| packs::installed(&self.root, pack)).ok_or_else(|| VoiceError::Engine(NEEDS_ENGINE.into()))?;
            *engine = Some(Engine::load(&packs::folder(&self.root, pack))?);
        }
        Ok(engine.clone().unwrap())
    }

    fn speak_locally(&self, provider: &str, sid: i32, text: &str) -> Result<(u32, Vec<u8>), VoiceError> {
        let pack = packs::find(provider).filter(|pack| packs::installed(&self.root, pack)).ok_or_else(|| VoiceError::Engine("Download this voice first, in Settings, Voice.".into()))?;
        let mut held = self.speaker.lock().unwrap();
        if held.as_ref().is_none_or(|(id, _)| id != provider) {
            let folder = packs::folder(&self.root, pack);
            let speaker = if provider == "kokoro" { Speaker::kokoro(self.engine()?, &folder)? } else { Speaker::piper(self.engine()?, &folder)? };
            *held = Some((provider.to_string(), speaker));
        }
        held.as_ref().unwrap().1.say(text, sid)
    }

    fn start_hearing(&self) -> Result<(), VoiceError> {
        let mut ears = self.ears.lock().unwrap();
        if let Some(ears) = ears.as_mut() {
            return ears.restart();
        }
        let pack = packs::find("hearing").filter(|pack| packs::installed(&self.root, pack)).ok_or_else(|| VoiceError::Engine(NEEDS_DOWNLOAD.into()))?;
        *ears = Some(Ears::new(self.engine()?, &packs::folder(&self.root, pack))?);
        Ok(())
    }
}

fn stringify(err: impl std::fmt::Display) -> String {
    err.to_string()
}

fn cloud_key(core: &Core, provider: &str) -> Result<String, String> {
    if core.settings.lock().unwrap().local_only {
        return Err(LOCAL_ONLY.into());
    }
    secrets::get(provider).ok_or_else(|| format!("Add your {provider} key first, in Settings, Voice."))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackStatus {
    #[serde(flatten)]
    pack: packs::Pack,
    installed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    packs: Vec<PackStatus>,
    keys: Vec<String>,
}

#[tauri::command]
pub fn voice_status(voice: State<'_, Voice>) -> VoiceStatus {
    VoiceStatus {
        packs: packs::PACKS.iter().map(|pack| PackStatus { pack: *pack, installed: packs::installed(&voice.root, pack) }).collect(),
        keys: ["elevenlabs", "openai", "cartesia", "deepgram"].iter().filter(|p| secrets::get(p).is_some()).map(|p| p.to_string()).collect(),
    }
}

#[tauri::command]
pub async fn voice_list(core: State<'_, Core>, provider: String) -> Result<Vec<VoiceInfo>, String> {
    let named = |list: &[(&str, &str)]| list.iter().enumerate().map(|(i, (name, note))| VoiceInfo { id: i.to_string(), name: (*name).into(), note: (*note).into() }).collect();
    match provider.as_str() {
        "windows" => Ok(tauri::async_runtime::spawn_blocking(windows_voice::voices).await.map_err(stringify)?),
        "kokoro" => Ok(named(&KOKORO)),
        "piper-amy" => Ok(named(&[("Amy", "American")])),
        "piper-alan" => Ok(named(&[("Alan", "British")])),
        _ => {
            // The fixed lists need no key, so a voice can be chosen before one is saved.
            let key = if matches!(provider.as_str(), "openai" | "deepgram") { String::new() } else { cloud_key(&core, &provider)? };
            cloud::voices(&provider, &key).await.map_err(stringify)
        }
    }
}

#[tauri::command]
pub fn voice_key_set(provider: String, key: String) -> Result<(), String> {
    secrets::set(&provider, key.trim())
}

#[tauri::command]
pub fn voice_key_clear(provider: String) -> Result<(), String> {
    secrets::clear(&provider)
}

/// Fetches a pack, and the engine with it. `on` is told how many bytes have arrived in all.
#[tauri::command]
pub async fn voice_download(app: AppHandle, id: String, on: Channel<u64>) -> Result<(), String> {
    let voice = app.state::<Voice>();
    let root = voice.root.clone();
    let pack = packs::find(&id).ok_or("That is not a download.")?;
    let mut before = 0;
    // Asking for a pack that is here still fetches an engine that is not.
    for needed in [packs::find("engine").filter(|engine| engine.id != pack.id), Some(pack)].into_iter().flatten().filter(|needed| !packs::installed(&root, needed)) {
        packs::download(&root, needed, |bytes| drop(on.send(before + bytes))).await.map_err(stringify)?;
        before += needed.bytes;
    }
    Ok(())
}

#[tauri::command]
pub fn voice_remove(voice: State<'_, Voice>, id: String) -> Result<(), String> {
    let pack = packs::find(&id).ok_or("That is not a download.")?;
    *voice.speaker.lock().unwrap() = None;
    *voice.ears.lock().unwrap() = None;
    if pack.id == "engine" {
        *voice.engine.lock().unwrap() = None;
    }
    packs::remove(&voice.root, pack).map_err(stringify)
}

/// The first thing sent is the sample rate. Everything after it is 16-bit audio.
fn send_all(on: &Channel<InvokeResponseBody>, voice: &Voice, turn: u64, rate: u32, pcm: &[u8]) {
    let _ = on.send(InvokeResponseBody::Raw(rate.to_le_bytes().to_vec()));
    for piece in pcm.chunks(PIECE) {
        if voice.turn.load(Ordering::Relaxed) != turn || on.send(InvokeResponseBody::Raw(piece.to_vec())).is_err() {
            return;
        }
    }
}

#[tauri::command]
pub async fn voice_speak(app: AppHandle, text: String, provider: Option<String>, voice_id: Option<String>, on: Channel<InvokeResponseBody>) -> Result<(), String> {
    speak(&app, text, provider, voice_id, &on).await?;
    // This call can end before the audio has crossed over, so an empty last message says it has.
    let _ = on.send(InvokeResponseBody::Raw(Vec::new()));
    Ok(())
}

async fn speak(app: &AppHandle, text: String, provider: Option<String>, voice_id: Option<String>, on: &Channel<InvokeResponseBody>) -> Result<(), String> {
    let (voice, core) = (app.state::<Voice>(), app.state::<Core>());
    let turn = voice.turn.load(Ordering::Relaxed);
    let settings = core.settings.lock().unwrap().clone();
    let provider = provider.unwrap_or(settings.voice_provider.clone());
    let chosen = voice_id.or(settings.voice_id.clone());

    if !matches!(provider.as_str(), "windows" | "kokoro" | "piper-amy" | "piper-alan") {
        let key = cloud_key(&core, &provider)?;
        let id = match chosen {
            Some(id) => id,
            None => cloud::voices(&provider, &key).await.map_err(stringify)?.first().map(|v| v.id.clone()).ok_or("This account has no voices.")?,
        };
        let _ = on.send(InvokeResponseBody::Raw(cloud::RATE.to_le_bytes().to_vec()));
        return cloud::speak(&provider, &key, &id, &text, |bytes| voice.turn.load(Ordering::Relaxed) == turn && on.send(InvokeResponseBody::Raw(bytes.to_vec())).is_ok()).await.map_err(stringify);
    }

    let worker = app.clone();
    let made = tauri::async_runtime::spawn_blocking(move || {
        if provider == "windows" {
            return windows_voice::speak(chosen.as_deref(), &text);
        }
        let sid = chosen.and_then(|id| id.parse().ok()).unwrap_or(0);
        worker.state::<Voice>().speak_locally(&provider, sid, &text)
    })
    .await
    .map_err(stringify)?
    .map_err(stringify)?;
    send_all(on, &voice, turn, made.0, &made.1);
    Ok(())
}

#[tauri::command]
pub fn voice_stop(voice: State<'_, Voice>) {
    voice.turn.fetch_add(1, Ordering::Relaxed);
}

#[tauri::command]
pub async fn voice_hear_start(app: AppHandle) -> Result<(), String> {
    let core = app.state::<Core>();
    let hearing = core.settings.lock().unwrap().voice_hearing.clone();
    app.state::<Voice>().heard.lock().unwrap().clear();
    if hearing != "local" {
        // Better to say so now than after the user has spoken a whole turn.
        return cloud_key(&core, &hearing).map(drop);
    }
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || worker.state::<Voice>().start_hearing()).await.map_err(stringify)?.map_err(stringify)
}

/// Takes 100 ms of microphone, and returns the words heard so far, where hearing can do that.
#[tauri::command]
pub async fn voice_hear(app: AppHandle, request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(pcm) = request.body() else { return Err("Expected audio.".into()) };
    let pcm = pcm.clone();
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let voice = worker.state::<Voice>();
        if let Some(ears) = voice.ears.lock().unwrap().as_mut().filter(|_| worker.state::<Core>().settings.lock().unwrap().voice_hearing == "local") {
            return ears.accept(&pcm).map_err(stringify);
        }
        let mut heard = voice.heard.lock().unwrap();
        if heard.len() < MOST_HEARD {
            heard.extend_from_slice(&pcm);
        }
        Ok(String::new())
    })
    .await
    .map_err(stringify)?
}

#[tauri::command]
pub async fn voice_hear_end(app: AppHandle) -> Result<String, String> {
    let core = app.state::<Core>();
    let hearing = core.settings.lock().unwrap().voice_hearing.clone();
    if hearing == "local" {
        let worker = app.clone();
        return tauri::async_runtime::spawn_blocking(move || match worker.state::<Voice>().ears.lock().unwrap().as_mut() {
            Some(ears) => ears.finish().map_err(stringify),
            None => Ok(String::new()),
        })
        .await
        .map_err(stringify)?;
    }
    let key = cloud_key(&core, &hearing)?;
    let pcm = std::mem::take(&mut *app.state::<Voice>().heard.lock().unwrap());
    cloud::transcribe(&hearing, &key, to_wav(&pcm, 16_000)).await.map_err(stringify)
}
