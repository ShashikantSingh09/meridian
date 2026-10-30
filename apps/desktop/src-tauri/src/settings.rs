//! User settings as one JSON file. A broken file is set aside, never fatal: the
//! app must always start.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: String,
    pub motion: String,
    pub ambient: bool,
    pub autostart: bool,
    pub default_provider: Option<String>,
    pub default_model: Option<String>,
    pub provider_base_urls: HashMap<String, String>,
    pub system_prompt: String,
    pub local_only: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            motion: "system".into(),
            ambient: true,
            autostart: false,
            default_provider: None,
            default_model: None,
            provider_base_urls: HashMap::new(),
            system_prompt: String::new(),
            local_only: false,
        }
    }
}

pub fn path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join("settings.json"))
}

pub fn load(path: &Path) -> Settings {
    let Ok(bytes) = std::fs::read(path) else { return Settings::default() };
    serde_json::from_slice(&bytes).unwrap_or_else(|_| {
        let _ = std::fs::rename(path, path.with_extension("json.bad"));
        Settings::default()
    })
}

/// Writes through a temporary file so a crash cannot leave half a settings file.
pub fn save(path: &Path, settings: &Settings) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(settings)?)?;
    std::fs::rename(temporary, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("meridian-test-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("settings.json")
    }

    #[test]
    fn round_trips() {
        let path = scratch("round");
        let settings = Settings { theme: "dark".into(), local_only: true, ..Settings::default() };
        save(&path, &settings).unwrap();
        assert_eq!(load(&path), settings);
    }

    #[test]
    fn missing_file_gives_defaults() {
        assert_eq!(load(&scratch("missing").with_file_name("absent.json")), Settings::default());
    }

    #[test]
    fn corrupt_file_is_set_aside() {
        let path = scratch("corrupt");
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(load(&path), Settings::default());
        assert!(path.with_extension("json.bad").exists());
    }

    #[test]
    fn unknown_and_missing_fields_are_tolerated() {
        let path = scratch("partial");
        std::fs::write(&path, r#"{"theme":"light","fromTheFuture":1}"#).unwrap();
        let settings = load(&path);
        assert_eq!(settings.theme, "light");
        assert!(settings.ambient);
    }
}
