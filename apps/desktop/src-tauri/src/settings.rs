//! User settings as one JSON file. A broken file is set aside, never fatal: the
//! app must always start.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub motion: String,
    pub ambient: bool,
    pub autostart: bool,
    pub default_provider: Option<String>,
    pub default_model: Option<String>,
    pub provider_base_urls: HashMap<String, String>,
    pub system_prompt: String,
    pub local_only: bool,
    /// "primary", or the name of a display.
    pub island_monitor: String,
    /// "left", "center" or "right" along the top of the display.
    pub island_align: String,
    /// Shrink to a sliver when idle, and come back on hover or activity.
    pub island_auto_hide: bool,
    pub show_clock: bool,
    /// Multiplies every spring. 1 is the designed speed.
    pub animation_speed: f64,
    pub agent_default_dir: Option<String>,
    /// "off", "ondemand" or "contextual".
    pub screen_mode: String,
    pub screen_interval_secs: u64,
    pub screen_exclusions: Vec<String>,
    /// Stops all contextual monitoring at once, whatever else is set.
    pub monitoring_paused: bool,
    pub media_enabled: bool,
    pub activity: activity::Preferences,
    pub google_client_id: String,
    pub microsoft_client_id: String,
    pub show_next_meeting: bool,
    pub sounds: bool,
    /// The welcome steps have been seen.
    pub onboarded: bool,
    /// Which face lives on the island. The interface falls back if it does not know it.
    pub face: String,
    /// Which voice speaks: "windows", a cloud service, or a downloaded voice.
    pub voice_provider: String,
    pub voice_id: Option<String>,
    /// "local", or the cloud service that hears.
    pub voice_hearing: String,
    pub voice_interrupt: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            motion: "system".into(),
            ambient: true,
            autostart: false,
            default_provider: None,
            default_model: None,
            provider_base_urls: HashMap::new(),
            system_prompt: String::new(),
            local_only: false,
            island_monitor: "primary".into(),
            island_align: "center".into(),
            island_auto_hide: false,
            show_clock: true,
            animation_speed: 1.0,
            agent_default_dir: None,
            screen_mode: "ondemand".into(),
            screen_interval_secs: 20,
            screen_exclusions: Vec::new(),
            monitoring_paused: false,
            media_enabled: true,
            activity: activity::Preferences::default(),
            google_client_id: String::new(),
            microsoft_client_id: String::new(),
            show_next_meeting: true,
            sounds: true,
            onboarded: false,
            face: "soft".into(),
            voice_provider: "windows".into(),
            voice_id: None,
            voice_hearing: "local".into(),
            voice_interrupt: true,
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
        let settings = Settings { motion: "reduced".into(), local_only: true, ..Settings::default() };
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
        std::fs::write(&path, r#"{"motion":"full","fromTheFuture":1}"#).unwrap();
        let settings = load(&path);
        assert_eq!(settings.motion, "full");
        assert!(settings.ambient);
    }
}
