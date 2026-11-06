//! User settings as one JSON file. A broken file is set aside, never fatal: the
//! app must always start.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WakeWord {
    pub text: String,
    pub on: bool,
}

/// An app or site, as the user answered the first time Meridian filled in it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    /// The app's process name or the site's address, like slack.exe or mail.google.com.
    pub id: String,
    pub name: String,
    /// "allowed", "ask" for every time, or "never".
    pub fill: String,
    /// Finish this for me may work here too. It needs its own yes, per app.
    #[serde(default)]
    pub finish: bool,
    /// A bank, tax or government site. It asks every time, whatever else is set.
    #[serde(default)]
    pub always_ask: bool,
}

/// What a fill may take values from. The page itself and what the user just said are always used.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Sources {
    /// Put in by Meridian from Your details, never sent to the AI.
    pub details: bool,
    pub knowledge: bool,
    /// Gmail and Calendar, only when the user asks.
    pub mail: bool,
    pub notes: bool,
    /// Files the user names, read on this PC.
    pub files: bool,
    /// Only when the user says "from my clipboard".
    pub clipboard: bool,
    /// A picture of the window. Off: Write here reads the window's text only.
    pub picture: bool,
}

impl Default for Sources {
    fn default() -> Self {
        Self { details: true, knowledge: true, mail: true, notes: true, files: true, clipboard: true, picture: false }
    }
}

/// Write here, Fill this form and Finish this for me. Only kept here so far: the fill engine reads them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Fill {
    /// Write here and Fill this form. Off until turned on.
    pub on: bool,
    /// "ctrl-alt-f", or "off" to start them only by voice or from the island.
    pub key: String,
    /// Write here and Fill this form on the island, when the pointer is on it.
    pub buttons: bool,
    /// The engine that decides what goes where. It never sees Your details.
    pub ai: String,
    /// Finish this for me. Experimental, and off until turned on with its own switch.
    pub finish: bool,
    /// Finish this for me runs on the user's Claude plan through Claude Code, and nothing else.
    pub finish_ai: String,
    pub places: Vec<Place>,
    pub sources: Sources,
}

impl Default for Fill {
    fn default() -> Self {
        Self {
            on: false,
            key: "ctrl-alt-f".into(),
            buttons: true,
            ai: "claude-code".into(),
            finish: false,
            finish_ai: "claude-code".into(),
            places: Vec::new(),
            sources: Sources::default(),
        }
    }
}

/// The cards at the top of My Day, and the morning line on the island. Each kind can be turned off.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MyDay {
    /// People waiting 2 days or more on a reply.
    pub replies: bool,
    /// Renewals and free trials, from receipts in Gmail.
    pub renewals: bool,
    /// Trips on the calendar with nothing booked.
    pub trips: bool,
    /// One line on the island, the first time the PC is used after 6 am.
    pub summary: bool,
}

impl Default for MyDay {
    fn default() -> Self {
        Self { replies: true, renewals: true, trips: true, summary: true }
    }
}

/// Where the island was dragged to on one display, as shares of the display's work area.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Spot {
    /// The middle of the island, from the left.
    pub x: f64,
    /// The edge it hangs from. 0 is the top of the screen, as the notch. Otherwise it floats, and this
    /// is its top edge, or its bottom edge when `up` is set.
    pub y: f64,
    /// It floats in the lower half, so it grows upwards.
    pub up: bool,
}

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
    /// Where the island was dragged to, by display name. A display with none uses `island_align`.
    pub island_spots: HashMap<String, Spot>,
    /// Shrink to a sliver when idle, and come back on hover or activity.
    pub island_auto_hide: bool,
    pub show_clock: bool,
    /// A laptop's charge beside the clock.
    pub show_battery: bool,
    /// A ring by the clock for how much of the Claude plan is used. Off unless turned on.
    pub show_usage: bool,
    /// Whether to look for new versions by itself. None until the user has been asked.
    pub update_checks: Option<bool>,
    /// The version the user last saw What's new for.
    pub last_seen_version: Option<String>,
    /// Other apps go quiet while the user talks to the assistant.
    pub hush_while_talking: bool,
    /// Calls keep their sound while the room goes quiet.
    pub hush_leave_calls: bool,
    /// A recording nobody speaks in for 15 minutes offers to stop.
    pub stop_quiet_calls: bool,
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
    /// Writes the summary as soon as a call's transcript is done.
    pub notes_summary: bool,
    pub voice_interrupt: bool,
    /// What the assistant is called, and how it should come across.
    pub assistant_name: String,
    pub assistant_personality: String,
    /// The microphone and output chosen for conversations. None follows Windows.
    pub voice_microphone: Option<String>,
    pub voice_output: Option<String>,
    pub theme: String,
    /// "theme", "windows" or "time".
    pub theme_use: String,
    pub theme_dark: String,
    pub theme_light: String,
    /// From clear to tinted, 0 to 100.
    pub glass: u8,
    pub custom_themes: Vec<serde_json::Value>,
    pub assistant_calls_you: String,
    /// "calm", "cheerful", "direct", "playful" or "own".
    pub assistant_style: String,
    /// A few things to ask, under Home's ask box.
    pub home_suggestions: bool,
    /// Keeps the microphone open for wake words, heard only on this PC. Off until turned on.
    pub wake_enabled: bool,
    pub wake_words: Vec<WakeWord>,
    /// "sure", "balanced" or "easily".
    pub wake_sensitivity: String,
    /// "turn" for one question, or "conversation" to keep talking.
    pub wake_after: String,
    /// "always" or "charger".
    pub wake_listen: String,
    pub wake_pause_calls: bool,
    pub wake_pause_locked: bool,
    pub fill: Fill,
    /// What Knowledge learns from, and when it updates. Every source is off until turned on.
    pub knowledge: ::knowledge::Preferences,
    /// Which cards My Day shows, and the morning line on the island.
    pub my_day: MyDay,
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
            island_spots: HashMap::new(),
            island_auto_hide: false,
            show_clock: true,
            show_battery: true,
            show_usage: false,
            update_checks: None,
            last_seen_version: None,
            hush_while_talking: true,
            hush_leave_calls: true,
            stop_quiet_calls: true,
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
            notes_summary: true,
            voice_interrupt: true,
            assistant_name: "Meridian".into(),
            assistant_personality: String::new(),
            voice_microphone: None,
            voice_output: None,
            theme: "midnight".into(),
            theme_use: "theme".into(),
            theme_dark: "midnight".into(),
            theme_light: "daylight".into(),
            glass: 58,
            custom_themes: Vec::new(),
            assistant_calls_you: String::new(),
            assistant_style: "calm".into(),
            home_suggestions: true,
            wake_enabled: false,
            wake_words: vec![WakeWord { text: "Hey Meridian".into(), on: true }, WakeWord { text: "Okay Meridian".into(), on: false }],
            wake_sensitivity: "balanced".into(),
            wake_after: "turn".into(),
            wake_listen: "always".into(),
            wake_pause_calls: true,
            wake_pause_locked: true,
            fill: Fill::default(),
            knowledge: ::knowledge::Preferences::default(),
            my_day: MyDay::default(),
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

/// Writes through a temporary file so a crash cannot leave half a file. Your details are saved this way too.
pub fn save(path: &Path, settings: &impl Serialize) -> std::io::Result<()> {
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

    #[test]
    fn filling_starts_off_with_ctrl_alt_f_and_no_picture_of_the_window() {
        let fill = Settings::default().fill;
        assert!(!fill.on && !fill.finish);
        assert_eq!(fill.key, "ctrl-alt-f");
        assert_eq!(fill.finish_ai, "claude-code");
        assert!(fill.places.is_empty());
        assert!(fill.sources.details && fill.sources.knowledge && !fill.sources.picture);
    }

    #[test]
    fn a_settings_file_from_before_filling_gets_the_fill_defaults() {
        let path = scratch("before-fill");
        std::fs::write(&path, r#"{"motion":"full","fill":{"on":true,"places":[{"id":"slack.exe","name":"Slack","fill":"allowed"}]}}"#).unwrap();
        let fill = load(&path).fill;
        assert!(fill.on && fill.buttons);
        assert_eq!(fill.places[0].name, "Slack");
        assert!(!fill.places[0].finish && !fill.places[0].always_ask);
        assert!(!fill.sources.picture);
    }
}
