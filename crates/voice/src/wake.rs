//! Listens for a word in the user's own voice. It compares the microphone they chose against a few
//! recordings they made, here on this PC, so it works for any word in any language. Only the pattern
//! of those recordings is kept, never the sound, and what the microphone hears goes no further.

use std::collections::HashMap;

use rustpotter::{Rustpotter, RustpotterConfig, SampleFormat, WakewordLoad, WakewordRef, WakewordRefBuildFromBuffers, WakewordSave};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS};

use crate::{to_wav, VoiceError};

const MICROPHONE_USERS: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
/// The interface runs in this, so its use of the microphone is ours.
const OUR_WEBVIEW: &str = "msedgewebview2";
const SAMPLE_RATE: u32 = 16_000;
/// How much of each moment of sound is compared, which is the size rustpotter's own tools use.
const DETAIL: u16 = 16;

/// How close to the recordings a word has to be: "sure", "balanced" or "easily". A real voice scored
/// about 0.55 before the silence came out of its recordings, and a sentence that only sounded close
/// scored 0.54.
fn closeness(easiness: &str) -> f32 {
    match easiness {
        "sure" => 0.58,
        "easily" => 0.46,
        _ => 0.5,
    }
}

/// How far a word can stretch against a recording, because nobody says it the same way twice.
const STRETCH: u16 = 8;
/// Moments in a row that have to match, which a voice's few strong ones can meet.
const MATCHES_NEEDED: usize = 3;
/// The quick first look, which only saves work. A real voice scored as low as 0.22 on it.
const FIRST_LOOK: f32 = 0.12;

/// Turns recordings of a word, as 16-bit mono sound, into the pattern that is kept in their place.
pub fn learn(word: &str, recordings: &[Vec<u8>]) -> Result<Vec<u8>, VoiceError> {
    let samples: HashMap<String, Vec<u8>> = recordings.iter().enumerate().map(|(i, pcm)| (format!("{i}.wav"), to_wav(pcm, SAMPLE_RATE))).collect();
    WakewordRef::new_from_sample_buffers(word.to_string(), None, None, samples, DETAIL).and_then(|pattern| pattern.save_to_buffer()).map_err(VoiceError::Service)
}

/// Finds learned words in sound as it arrives.
pub struct Spotter {
    detector: Rustpotter,
    waiting: Vec<i16>,
}

impl Spotter {
    /// `learned` pairs each word with its pattern from `learn`.
    pub fn new(easiness: &str, learned: &[(String, Vec<u8>)]) -> Result<Self, VoiceError> {
        let mut config = RustpotterConfig::default();
        config.fmt.sample_rate = SAMPLE_RATE as usize;
        config.fmt.sample_format = SampleFormat::I16;
        config.detector.threshold = closeness(easiness);
        config.detector.avg_threshold = FIRST_LOOK;
        // As soon as it is sure, because a command can follow straight on from the name.
        config.detector.eager = true;
        config.detector.band_size = STRETCH;
        config.detector.min_scores = MATCHES_NEEDED;
        let mut detector = Rustpotter::new(&config).map_err(VoiceError::Service)?;
        for (word, pattern) in learned {
            let pattern = WakewordRef::load_from_buffer(pattern).map_err(VoiceError::Service)?;
            detector.add_wakeword_ref(word, pattern).map_err(VoiceError::Service)?;
        }
        Ok(Self { detector, waiting: Vec::new() })
    }

    /// Takes 16-bit mono sound, in pieces of any size, and says which word it found, if one.
    pub fn hear(&mut self, pcm: &[u8]) -> Option<String> {
        self.waiting.extend(pcm.chunks_exact(2).map(|sample| i16::from_le_bytes([sample[0], sample[1]])));
        let frame = self.detector.get_samples_per_frame();
        let mut found = None;
        while self.waiting.len() >= frame {
            let piece: Vec<i16> = self.waiting.drain(..frame).collect();
            found = self.detector.process_samples(piece).map(|hit| hit.name).or(found);
        }
        found
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Conditions {
    pub enabled: bool,
    /// Pause all monitoring, the one switch that stops everything.
    pub monitoring_paused: bool,
    pub has_words: bool,
    /// The Test button is waiting, which works with the switch off.
    pub testing: bool,
    pub charger_only: bool,
    pub on_battery: bool,
    pub pause_when_locked: bool,
    pub locked: bool,
    pub pause_during_calls: bool,
    pub others_on_microphone: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wanted {
    Off,
    Listening,
    /// With the reason shown in Settings.
    Paused(&'static str),
}

/// Whether the microphone should be open for wake words right now.
pub fn wanted(c: &Conditions) -> Wanted {
    if !c.has_words || !(c.enabled || c.testing) {
        return Wanted::Off;
    }
    if c.monitoring_paused {
        return Wanted::Paused("Paused with all monitoring.");
    }
    if c.pause_when_locked && c.locked {
        return Wanted::Paused("Paused while the screen is locked.");
    }
    if c.pause_during_calls && c.others_on_microphone {
        return Wanted::Paused("Paused while another app is using the microphone.");
    }
    if c.charger_only && c.on_battery {
        return Wanted::Paused("Paused until this PC is on its charger.");
    }
    Wanted::Listening
}

/// The secure desktop, which is what a locked screen is, cannot be opened from an ordinary session.
pub fn screen_locked() -> bool {
    match unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) } {
        Ok(desktop) => {
            let _ = unsafe { CloseDesktop(desktop) };
            false
        }
        Err(_) => true,
    }
}

pub fn on_battery() -> bool {
    let mut status = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut status) }.is_ok() && status.ACLineStatus == 0
}

/// What Windows says is using the microphone at this moment, as the names it keeps for apps.
fn microphone_users() -> Vec<String> {
    let Ok(store) = windows_registry::CURRENT_USER.open(MICROPHONE_USERS) else { return Vec::new() };
    let in_use = |key: &windows_registry::Key| key.get_u64("LastUsedTimeStop").is_ok_and(|stop| stop == 0);
    let mut users = Vec::new();
    let names = store.keys().map(|keys| keys.collect::<Vec<_>>()).unwrap_or_default();
    for name in names {
        let Ok(key) = store.open(&name) else { continue };
        if name != "NonPackaged" {
            if in_use(&key) {
                users.push(name);
            }
            continue;
        }
        let names = key.keys().map(|keys| keys.collect::<Vec<_>>()).unwrap_or_default();
        users.extend(names.into_iter().filter(|app| key.open(app).is_ok_and(|app| in_use(&app))));
    }
    users
}

fn is_ours(user: &str, this_app: &str) -> bool {
    let user = user.to_ascii_lowercase();
    user.contains(OUR_WEBVIEW) || user.contains(this_app)
}

/// Is some other app using the microphone? `this_app` is this program's file name.
pub fn others_on_microphone(this_app: &str) -> bool {
    microphone_users().iter().any(|user| !is_ours(user, &this_app.to_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A made-up word: tones that rise or fall, with gaps, which is enough to tell two apart.
    fn word(rising: bool, seed: f32) -> Vec<u8> {
        let mut pcm = Vec::new();
        for i in 0..14_000 {
            let t = i as f32 / 16_000.0;
            let sweep = if rising { 300.0 + 900.0 * t } else { 1500.0 - 900.0 * t };
            let swell = ((t * 9.0 + seed * 0.02).sin()).abs();
            let sample = ((t * sweep * std::f32::consts::TAU).sin() * 0.35 + (t * sweep * 2.3 * std::f32::consts::TAU).sin() * 0.25) * swell;
            pcm.extend_from_slice(&((sample * 28_000.0) as i16).to_le_bytes());
        }
        pcm
    }

    fn silence(seconds: usize) -> Vec<u8> {
        vec![0; seconds * 32_000]
    }

    #[test]
    fn finds_a_learned_word_in_pieces_of_any_size_and_nothing_else() {
        let pattern = learn("hey mira", &[word(true, 0.0), word(true, 1.0), word(true, 2.0)]).unwrap();
        let mut spotter = Spotter::new("balanced", &[("hey mira".to_string(), pattern)]).unwrap();
        let mut heard = |pcm: &[u8]| pcm.chunks(3_200).filter_map(|piece| spotter.hear(piece)).collect::<Vec<_>>();
        assert!(heard(&silence(2)).is_empty(), "silence");
        assert!(heard(&word(false, 0.0)).is_empty(), "another word");
        assert!(heard(&silence(2)).is_empty());
        let mut sound = word(true, 0.5);
        sound.extend(silence(2));
        assert_eq!(heard(&sound), ["hey mira"]);
    }

    #[test]
    fn a_word_can_be_in_any_language() {
        let pattern = learn("सुनो मीरा", &[word(true, 0.0), word(true, 1.0)]).unwrap();
        assert!(Spotter::new("sure", &[("सुनो मीरा".to_string(), pattern)]).is_ok());
    }

    #[test]
    fn how_easily_it_wakes_changes_how_close_it_must_be() {
        assert!(closeness("sure") > closeness("balanced") && closeness("balanced") > closeness("easily"));
        assert_eq!(closeness("anything else"), closeness("balanced"));
    }

    const ON: Conditions = Conditions {
        enabled: true,
        monitoring_paused: false,
        has_words: true,
        testing: false,
        charger_only: false,
        on_battery: false,
        pause_when_locked: true,
        locked: false,
        pause_during_calls: true,
        others_on_microphone: false,
    };

    #[test]
    fn the_microphone_stays_shut_unless_it_was_asked_for() {
        assert_eq!(wanted(&Conditions::default()), Wanted::Off);
        assert_eq!(wanted(&Conditions { enabled: false, ..ON }), Wanted::Off);
        assert_eq!(wanted(&Conditions { has_words: false, ..ON }), Wanted::Off);
        assert_eq!(wanted(&ON), Wanted::Listening);
    }

    #[test]
    fn the_test_button_works_with_the_switch_off_but_needs_a_word() {
        assert_eq!(wanted(&Conditions { enabled: false, testing: true, ..ON }), Wanted::Listening);
        assert_eq!(wanted(&Conditions { enabled: false, testing: true, has_words: false, ..ON }), Wanted::Off);
    }

    #[test]
    fn each_pause_closes_the_microphone_and_says_why() {
        for paused in [
            Conditions { monitoring_paused: true, ..ON },
            Conditions { locked: true, ..ON },
            Conditions { others_on_microphone: true, ..ON },
            Conditions { charger_only: true, on_battery: true, ..ON },
        ] {
            assert!(matches!(wanted(&paused), Wanted::Paused(why) if !why.is_empty()), "{paused:?}");
        }
    }

    #[test]
    fn a_pause_that_was_turned_off_does_not_apply() {
        assert_eq!(wanted(&Conditions { locked: true, pause_when_locked: false, ..ON }), Wanted::Listening);
        assert_eq!(wanted(&Conditions { others_on_microphone: true, pause_during_calls: false, ..ON }), Wanted::Listening);
        assert_eq!(wanted(&Conditions { on_battery: true, ..ON }), Wanted::Listening);
    }

    #[test]
    fn our_own_use_of_the_microphone_is_not_a_call() {
        assert!(is_ours("C:#Users#me#AppData#Local#Meridian#meridian.exe", "meridian.exe"));
        assert!(!is_ours("C:#Program Files#Zoom#Zoom.exe", "meridian.exe"));
    }
}
