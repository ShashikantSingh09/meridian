//! Everything the interface can ask of the core. A failure comes back as a
//! string error, so no provider or agent problem can take the shell down.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use agent_adapters::watch::Watcher;
use agent_adapters::{AgentInfo, AgentKind, AuthStatus, Sessions, StartRequest};
use ai_core::{ChatEvent, ChatRequest, Capabilities, Endpoint, Kind, LocalServer, Message, ModelInfo, ProviderDef};
use serde::Serialize;
use tauri::ipc::Channel;
use base64::Engine;
use screen::{Frame, Signal, WindowInfo};
use tauri::{AppHandle, Manager, State};
use tokio_util::sync::CancellationToken;

use crate::following::Following;
use crate::island::{self, Gate, Rect};
use crate::settings::{self, Settings};
use crate::secrets;

pub struct Core {
    pub settings: Mutex<Settings>,
    pub gate: Arc<Gate>,
    pub sessions: Sessions,
    pub chats: Mutex<HashMap<String, CancellationToken>>,
    /// The last capture, held in memory only until it is sent or discarded.
    pub frame: Mutex<Option<Frame>>,
    pub media: media::Controller,
}

fn stringify(err: impl std::fmt::Display) -> String {
    err.to_string()
}

// â”€â”€ Island â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[tauri::command]
pub fn island_set_rect(core: State<'_, Core>, rect: Rect) {
    *core.gate.rect.lock().unwrap() = rect;
}

#[tauri::command]
pub fn island_set_interactive(app: AppHandle, core: State<'_, Core>, on: bool) {
    if let Some(win) = app.get_webview_window(island::LABEL) {
        island::set_interactive(&win, &core.gate, on);
    }
}

// â”€â”€ About â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn open_logs(app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::process::Command::new("explorer.exe").arg(dir).spawn().map(|_| ()).map_err(|e| e.to_string())
}

// â”€â”€ Settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[tauri::command]
pub fn settings_get(core: State<'_, Core>) -> Settings {
    core.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn settings_save(app: AppHandle, core: State<'_, Core>, settings: Settings) -> Result<(), String> {
    let path = settings::path(&app).ok_or("No settings folder")?;
    settings::save(&path, &settings).map_err(stringify)?;
    let (monitor, align) = (settings.island_monitor.clone(), settings.island_align.clone());
    let previous = std::mem::replace(&mut *core.settings.lock().unwrap(), settings);
    if previous.island_monitor != monitor || previous.island_align != align {
        if let Some(win) = app.get_webview_window(island::LABEL) {
            island::place(&app, &win, &core.gate, &monitor, &align);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn monitors_list(app: AppHandle) -> Vec<String> {
    island::monitor_names(&app)
}

// â”€â”€ Providers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    id: &'static str,
    name: &'static str,
    kind: Kind,
    base_url: String,
    needs_key: bool,
    has_key: bool,
    capabilities: Capabilities,
}

fn base_url(core: &Core, def: &ProviderDef) -> String {
    let settings = core.settings.lock().unwrap();
    settings.provider_base_urls.get(def.id).cloned().unwrap_or_else(|| def.base_url.to_string())
}

/// Everything needed to call a provider. Local-only mode is enforced here, on
/// the resolved address, so no interface path can get around it.
fn resolve(core: &Core, id: &str) -> Result<(&'static ProviderDef, Endpoint), String> {
    let def = ai_core::find(id).ok_or_else(|| format!("Unknown provider {id}"))?;
    let url = base_url(core, def);
    if url.is_empty() {
        return Err(format!("{} has no endpoint set.", def.name));
    }
    if core.settings.lock().unwrap().local_only && !ai_core::is_loopback(&url) {
        return Err(format!("Local-only mode is on, so {} is blocked.", def.name));
    }
    Ok((def, Endpoint { base_url: url, api_key: secrets::get(id) }))
}

fn provider(core: &Core, id: &str) -> Result<Box<dyn ai_core::Provider>, String> {
    let (def, endpoint) = resolve(core, id)?;
    ai_core::client(def.protocol, endpoint).map_err(stringify)
}

#[tauri::command]
pub fn providers_list(core: State<'_, Core>) -> Vec<ProviderInfo> {
    ai_core::catalog()
        .iter()
        .map(|def| ProviderInfo {
            id: def.id,
            name: def.name,
            kind: def.kind,
            base_url: base_url(&core, def),
            needs_key: def.needs_key,
            has_key: secrets::get(def.id).is_some(),
            capabilities: def.capabilities,
        })
        .collect()
}

#[tauri::command]
pub fn provider_set_key(id: String, key: String) -> Result<(), String> {
    secrets::set(&id, key.trim())
}

#[tauri::command]
pub fn provider_clear_key(id: String) -> Result<(), String> {
    secrets::clear(&id)
}

#[tauri::command]
pub async fn provider_models(core: State<'_, Core>, id: String) -> Result<Vec<ModelInfo>, String> {
    provider(&core, &id)?.models().await.map_err(stringify)
}

#[tauri::command]
pub async fn provider_test(core: State<'_, Core>, id: String) -> Result<String, String> {
    ai_core::test_connection(provider(&core, &id)?.as_ref()).await.map_err(stringify)
}

#[tauri::command]
pub async fn providers_discover(core: State<'_, Core>) -> Result<Vec<LocalServer>, String> {
    let overrides = core.settings.lock().unwrap().provider_base_urls.clone();
    Ok(ai_core::discover(|id| overrides.get(id).cloned()).await)
}

#[tauri::command]
pub async fn chat_stream(
    core: State<'_, Core>,
    request_id: String,
    provider: String,
    model: String,
    messages: Vec<Message>,
    channel: Channel<ChatEvent>,
) -> Result<(), String> {
    let client = self::provider(&core, &provider)?;
    let cancel = CancellationToken::new();
    core.chats.lock().unwrap().insert(request_id.clone(), cancel.clone());
    let request = ChatRequest { model, messages };
    let mut sink = |event: ChatEvent| {
        let _ = channel.send(event);
    };
    ai_core::run_chat(client.as_ref(), &request, &mut sink, &cancel).await;
    core.chats.lock().unwrap().remove(&request_id);
    Ok(())
}

#[tauri::command]
pub fn chat_cancel(core: State<'_, Core>, request_id: String) {
    if let Some(token) = core.chats.lock().unwrap().get(&request_id) {
        token.cancel();
    }
}

// â”€â”€ Agents â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[tauri::command]
pub async fn agents_detect() -> Vec<AgentInfo> {
    agent_adapters::detect().await
}

#[tauri::command]
pub async fn agent_auth(agent: AgentKind) -> Option<AuthStatus> {
    agent_adapters::auth_status(agent).await
}

#[tauri::command]
pub fn agent_login(agent: AgentKind) -> Result<(), String> {
    agent_adapters::open_login(agent).map_err(stringify)
}

/// An empty folder of our own for general chat, so no project files or project
/// instructions are in reach.
#[tauri::command]
pub fn assistant_dir(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_local_data_dir().map_err(stringify)?.join("assistant");
    std::fs::create_dir_all(&dir).map_err(stringify)?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn session_start(core: State<'_, Core>, request: StartRequest) -> Result<String, String> {
    core.sessions.start(request).map_err(stringify)
}

#[tauri::command]
pub async fn session_send(core: State<'_, Core>, id: String, text: String, images: Vec<String>) -> Result<(), String> {
    core.sessions.send(&id, text, images).map_err(stringify)
}

#[tauri::command]
pub fn session_adopt(core: State<'_, Core>, earlier: agent_adapters::Earlier) -> Result<(), String> {
    core.sessions.adopt(earlier).map_err(stringify)
}

#[tauri::command]
pub async fn session_cancel(core: State<'_, Core>, id: String) -> Result<(), String> {
    core.sessions.cancel(&id).map_err(stringify)
}

#[tauri::command]
pub async fn session_answer(
    core: State<'_, Core>,
    following: State<'_, Following>,
    session_id: String,
    approval_id: String,
    allow: bool,
    answers: Option<crate::following::Answers>,
) -> Result<(), String> {
    if Watcher::owns(&session_id) {
        return following.answer(&session_id, &approval_id, allow, answers);
    }
    core.sessions.answer(&session_id, &approval_id, allow).map_err(stringify)
}

#[tauri::command]
pub fn media_action(core: State<'_, Core>, action: media::Action) {
    core.media.perform(action);
}

// â”€â”€ Screen â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    image: String,
    text: String,
    window: Option<WindowInfo>,
    signals: Vec<Signal>,
    width: u32,
    height: u32,
}

/// Everything shown in the preview. Nothing leaves this function except to the
/// webview: sharing is a separate step the user takes after seeing it.
fn prepared(frame: Frame, window: Option<WindowInfo>) -> Result<Capture, String> {
    let jpeg = screen::to_jpeg(&frame).map_err(stringify)?;
    let image = format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg));
    let text = screen::ocr(&frame).unwrap_or_default();
    let signals = screen::detect(&text);
    Ok(Capture { image, text, window, signals, width: frame.width, height: frame.height })
}

/// A capture copies the screen, so it holds whatever covers the target, and all of
/// that has to pass the exclusions. Checked last, to catch a window opened during the wait.
fn read_unless_excluded(window: &WindowInfo, target: &str, rules: &[String]) -> Result<Frame, String> {
    let whole_screen = target == "screen";
    let in_view = screen::windows_in_view(window.hwnd, whole_screen).map_err(stringify)?;
    if let Some(other) = in_view.iter().find(|w| screen::exclusion_reason(w, rules).is_some()) {
        // The process alone: its title is what may be private.
        let name = if other.process.is_empty() { "Another window" } else { other.process.as_str() };
        return Err(format!("{name} is in view, and it is excluded from capture."));
    }
    let frame = if whole_screen { screen::capture_screen_of(window.hwnd) } else { screen::capture_window(window.hwnd) };
    frame.map_err(stringify)
}

/// Pixels of the given window or its display, with the island kept out of them.
pub fn take_capture(app: &AppHandle, core: &Core, target: &str) -> Result<(Frame, WindowInfo), String> {
    let settings = core.settings.lock().unwrap().clone();
    if settings.screen_mode == "off" {
        return Err("Screen understanding is turned off in Desktop Awareness.".into());
    }
    let window = island::working_window(&core.gate).ok_or("There is no active window to capture.")?;
    if window.process.eq_ignore_ascii_case("meridian.exe") {
        return Err("Click the window you want to capture first.".into());
    }
    if let Some(rule) = screen::exclusion_reason(&window, &settings.screen_exclusions) {
        return Err(format!("This window is excluded from capture ({rule})."));
    }
    let win = app.get_webview_window(island::LABEL).ok_or("Island window missing")?;
    island::exclude_from_capture(&win, true);
    // The exclusion takes effect at the next composition.
    std::thread::sleep(std::time::Duration::from_millis(50));
    let frame = read_unless_excluded(&window, target, &settings.screen_exclusions);
    island::exclude_from_capture(&win, false);
    Ok((frame?, window))
}

#[tauri::command]
pub async fn screen_capture(app: AppHandle, core: State<'_, Core>, target: String) -> Result<Capture, String> {
    let (frame, window) = take_capture(&app, &core, &target)?;
    let keep = Frame { width: frame.width, height: frame.height, bgra: frame.bgra.clone() };
    *core.frame.lock().unwrap() = Some(keep);
    tauri::async_runtime::spawn_blocking(move || prepared(frame, Some(window))).await.map_err(stringify)?
}

/// Narrows the capture to a selected area, re-reading only that part.
#[tauri::command]
pub async fn screen_crop(core: State<'_, Core>, x: f64, y: f64, w: f64, h: f64) -> Result<Capture, String> {
    let part = {
        let frame = core.frame.lock().unwrap();
        let frame = frame.as_ref().ok_or("The capture has already been discarded.")?;
        screen::crop(frame, x, y, w, h).ok_or("That selection is too small.")?
    };
    tauri::async_runtime::spawn_blocking(move || prepared(part, None)).await.map_err(stringify)?
}

#[tauri::command]
pub fn screen_discard(core: State<'_, Core>) {
    *core.frame.lock().unwrap() = None;
}

#[tauri::command]
pub fn open_project(cwd: String) -> Result<(), String> {
    if !std::path::Path::new(&cwd).is_dir() {
        return Err("That folder no longer exists.".into());
    }
    std::process::Command::new("explorer").arg(&cwd).spawn().map(|_| ()).map_err(stringify)
}
