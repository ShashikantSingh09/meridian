//! Following the user's own Claude Code sessions. Turning this on changes a file
//! the user owns, so it happens only from the switch in Settings, and turning it
//! off removes exactly what was added.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use agent_adapters::watch::{self, Watcher, HOOK_PATH};
use agent_adapters::{running, AgentEvent, Envelope, SessionStatus};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::island;

/// Hooks name a fixed address, so the port and token outlive a restart. The hooks themselves are
/// taken out when the app quits and put back when it starts, so nothing else can answer on that
/// address while it is closed, and a new port always comes with a new token.
pub type Answers = serde_json::Map<String, serde_json::Value>;

const CHECK_RUNNING_EVERY: Duration = Duration::from_secs(2);

#[derive(Clone, Serialize, Deserialize)]
struct Address {
    port: u16,
    token: String,
    /// Whether following is on. The hooks are out of the settings file while the app is closed, so
    /// this is what remembers it. Files from before this was kept were only written while on.
    #[serde(default = "yes")]
    on: bool,
}

const fn yes() -> bool {
    true
}

pub struct Following {
    watcher: Mutex<Option<Watcher>>,
    resend: AtomicBool,
    /// Claude Code's settings file. None if there is no home folder to find it in.
    settings: Option<PathBuf>,
    address: PathBuf,
}

fn stringify(err: impl std::fmt::Display) -> String {
    err.to_string()
}

fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(stringify)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn claude_settings(app: &AppHandle) -> Option<PathBuf> {
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from);
    Some(dir.or_else(|| Some(app.path().home_dir().ok()?.join(".claude")))?.join("settings.json"))
}

impl Following {
    fn saved(&self) -> Option<Address> {
        serde_json::from_slice(&std::fs::read(&self.address).ok()?).ok()
    }

    fn save(&self, address: &Address) -> Result<(), String> {
        if let Some(dir) = self.address.parent() {
            std::fs::create_dir_all(dir).map_err(stringify)?;
        }
        std::fs::write(&self.address, serde_json::to_vec(address).map_err(stringify)?).map_err(stringify)
    }

    /// Listens on the saved port if it is free. Another app may have taken it, in
    /// which case a new one is picked, and the caller rewrites the hooks.
    async fn listen(&self, app: &AppHandle, address: &Address) -> Result<Watcher, String> {
        let dir = self.settings.as_ref().and_then(|s| s.parent()).map(PathBuf::from);
        let emit = |app: AppHandle| {
            let dir = dir.clone();
            move |mut envelope: Envelope| {
                // A hook does not name its process, and Claude Code's record of the session does.
                // ponytail: looked up once, when first heard. A record written after that first hook leaves it unknown.
                if let (AgentEvent::Watched { pid, .. }, Some(dir)) = (&mut envelope.event, &dir) {
                    *pid = running::pid_of(dir, &envelope.session_id, alive);
                }
                drop(app.emit_to(island::LABEL, "agent-event", envelope))
            }
        };
        match Watcher::start(address.port, address.token.clone(), emit(app.clone())).await {
            Ok(watcher) => Ok(watcher),
            Err(_) => Watcher::start(0, address.token.clone(), emit(app.clone())).await.map_err(stringify),
        }
    }

    async fn turn_on(&self, app: &AppHandle) -> Result<(), String> {
        let settings = self.settings.as_ref().ok_or("Could not find your Claude Code settings.")?;
        let mut address = match self.saved() {
            Some(address) => address,
            None => Address { port: 0, token: new_token()?, on: true },
        };
        let watcher = self.listen(app, &address).await?;
        // A new port is a new address. The old token may be known to whoever took the port.
        if address.port != 0 && watcher.port() != address.port {
            address.token = new_token()?;
            watcher.stop();
            let renewed = self.listen(app, &Address { port: 0, ..address.clone() }).await?;
            address.port = renewed.port();
            return self.adopt(renewed, address, settings);
        }
        address.port = watcher.port();
        address.on = true;
        self.adopt(watcher, address, settings)
    }

    /// Writes the hooks for a listening watcher, and keeps both.
    fn adopt(&self, watcher: Watcher, mut address: Address, settings: &std::path::Path) -> Result<(), String> {
        address.on = true;
        let url = format!("http://127.0.0.1:{}{HOOK_PATH}", address.port);
        if let Err(err) = watch::install(settings, &url, &address.token) {
            watcher.stop();
            return Err(err.to_string());
        }
        self.save(&address)?;
        if let Some(old) = self.watcher.lock().unwrap().replace(watcher) {
            old.stop();
        }
        Ok(())
    }

    fn turn_off(&self) -> Result<(), String> {
        self.withdraw();
        if let Some(mut address) = self.saved() {
            address.on = false;
            self.save(&address)?;
        }
        Ok(())
    }

    /// Takes the hooks out and stops listening, leaving following on for the next start. Runs when
    /// the app quits, so a closed app leaves no address in Claude Code's settings for anything else to take.
    pub fn withdraw(&self) {
        if let Some(settings) = &self.settings {
            if watch::installed(settings) {
                let _ = watch::uninstall(settings);
            }
        }
        if let Some(watcher) = self.watcher.lock().unwrap().take() {
            watcher.stop();
        }
    }

    fn hears(&self, session_id: &str) -> bool {
        self.watcher.lock().unwrap().as_ref().is_some_and(|w| w.hears(session_id))
    }

    fn on(&self) -> bool {
        self.settings.as_deref().is_some_and(watch::installed) || self.saved().is_some_and(|address| address.on)
    }

    pub fn answer(&self, session_id: &str, approval_id: &str, allow: bool, answers: Option<Answers>) -> Result<(), String> {
        let answered = self.watcher.lock().unwrap().as_ref().is_some_and(|w| w.answer(session_id, approval_id, allow, answers));
        answered.then_some(()).ok_or_else(|| "That request has already been answered in the terminal.".into())
    }
}

pub fn state(app: &tauri::App) -> Result<Following, Box<dyn std::error::Error>> {
    Ok(Following {
        watcher: Mutex::new(None),
        resend: AtomicBool::new(false),
        settings: claude_settings(app.handle()),
        address: app.path().app_config_dir()?.join("following.json"),
    })
}

/// True if the process is still running. A record can outlive a crash.
fn alive(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
        let mut code = 0;
        let read = GetExitCodeProcess(process, &mut code);
        let _ = CloseHandle(process);
        read.is_ok() && code == STILL_ACTIVE.0 as u32
    }
}

/// Shows Claude Code at work in any terminal, whether or not following is on. Hooks tell more and
/// can be answered, so a session they report is left to them. This has to exist beside them
/// because Claude Code reads hooks when it starts: a running session never picks them up.
pub fn watch_running(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let following = app.state::<Following>();
        let Some(dir) = following.settings.as_ref().and_then(|s| s.parent()).map(PathBuf::from) else { return };
        let send = |session_id: &str, event: AgentEvent| {
            let _ = app.emit_to(island::LABEL, "agent-event", Envelope { session_id: session_id.to_string(), event });
        };
        let mut shown: HashMap<String, Option<String>> = HashMap::new();
        loop {
            if following.resend.swap(false, Ordering::Relaxed) {
                shown.clear();
            }
            let busy = running::busy(&dir, alive);
            for session in &busy {
                let id = &session.session;
                if following.hears(id) {
                    shown.remove(id);
                    continue;
                }
                let before = shown.get(id);
                if before.is_none() {
                    send(id, AgentEvent::Watched { agent: "Claude Code".into(), cwd: session.cwd.clone(), title: session.title.clone(), pid: Some(session.pid) });
                    send(id, AgentEvent::status(SessionStatus::Running));
                }
                if before.is_none_or(|known| *known != session.activity) {
                    if let Some(label) = &session.activity {
                        send(id, AgentEvent::Activity { label: label.clone() });
                    }
                }
                shown.insert(id.clone(), session.activity.clone());
            }
            shown.retain(|id, _| {
                let still = busy.iter().any(|session| session.session == *id);
                if !still {
                    send(id, AgentEvent::status(SessionStatus::Completed));
                }
                still
            });
            std::thread::sleep(CHECK_RUNNING_EVERY);
        }
    });
}

/// Hooks stay in place between runs, so a running app has to answer them.
pub fn resume(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let following = app.state::<Following>();
        if following.on() {
            if let Err(err) = following.turn_on(&app).await {
                eprintln!("could not follow Claude Code: {err}");
            }
        }
    });
}

/// The first look happens before the interface is listening, so it asks once it is.
#[tauri::command]
pub fn running_refresh(following: State<'_, Following>) {
    following.resend.store(true, Ordering::Relaxed);
}

/// What turning following on or off would change. Writes nothing.
#[tauri::command]
pub fn watch_preview(following: State<'_, Following>, on: bool) -> Result<watch::SettingsChange, String> {
    let settings = following.settings.as_ref().ok_or("Could not find your Claude Code settings.")?;
    let port = following.saved().map_or(0, |address| address.port);
    let url = format!("http://127.0.0.1:{port}{HOOK_PATH}");
    watch::preview(settings, on.then_some(url.as_str())).map_err(stringify)
}

#[tauri::command]
pub fn watch_status(following: State<'_, Following>) -> bool {
    following.on()
}

#[tauri::command]
pub async fn watch_set(app: AppHandle, following: State<'_, Following>, on: bool) -> Result<(), String> {
    if on {
        following.turn_on(&app).await
    } else {
        following.turn_off()
    }
}
