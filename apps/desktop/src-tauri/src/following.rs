//! Following the user's own Claude Code sessions. Turning this on changes a file
//! the user owns, so it happens only from the switch in Settings, and turning it
//! off removes exactly what was added.

use std::path::PathBuf;
use std::sync::Mutex;

use agent_adapters::watch::{self, Watcher, HOOK_PATH};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::island;

/// Hooks name a fixed address, so the port and token outlive a restart.
#[derive(Clone, Serialize, Deserialize)]
struct Address {
    port: u16,
    token: String,
}

pub struct Following {
    watcher: Mutex<Option<Watcher>>,
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
        let emit = |app: AppHandle| move |envelope| drop(app.emit_to(island::LABEL, "agent-event", envelope));
        match Watcher::start(address.port, address.token.clone(), emit(app.clone())).await {
            Ok(watcher) => Ok(watcher),
            Err(_) => Watcher::start(0, address.token.clone(), emit(app.clone())).await.map_err(stringify),
        }
    }

    async fn turn_on(&self, app: &AppHandle) -> Result<(), String> {
        let settings = self.settings.as_ref().ok_or("Could not find your Claude Code settings.")?;
        let mut address = match self.saved() {
            Some(address) => address,
            None => Address { port: 0, token: new_token()? },
        };
        let watcher = self.listen(app, &address).await?;
        address.port = watcher.port();
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
        if let Some(settings) = &self.settings {
            watch::uninstall(settings).map_err(stringify)?;
        }
        if let Some(watcher) = self.watcher.lock().unwrap().take() {
            watcher.stop();
        }
        Ok(())
    }

    fn on(&self) -> bool {
        self.settings.as_deref().is_some_and(watch::installed)
    }

    pub fn answer(&self, session_id: &str, approval_id: &str, allow: bool) -> Result<(), String> {
        let answered = self.watcher.lock().unwrap().as_ref().is_some_and(|w| w.answer(session_id, approval_id, allow));
        answered.then_some(()).ok_or_else(|| "That request has already been answered in the terminal.".into())
    }
}

pub fn state(app: &tauri::App) -> Result<Following, Box<dyn std::error::Error>> {
    Ok(Following {
        watcher: Mutex::new(None),
        settings: claude_settings(app.handle()),
        address: app.path().app_config_dir()?.join("following.json"),
    })
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
