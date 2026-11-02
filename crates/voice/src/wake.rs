//! Listens for a word in the user's own voice. It compares the microphone they chose against a few
//! recordings they made, here on this PC, so it works for any word in any language. Only the pattern
//! of those recordings is kept, never the sound, and what the microphone hears goes no further.
//! Words in English letters are also listened for by Windows' own speech engine, in `recognizer`.

use std::collections::{HashMap, VecDeque};

use rustpotter::{Rustpotter, RustpotterConfig, SampleFormat, VADMode, WakewordLoad, WakewordRef, WakewordRefBuildFromBuffers, WakewordSave};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS};

use crate::recognizer::{self, Recognized, Recognizer};
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
/// The comparison ignores loudness, so room noise scored the same as a real voice, some of it almost
/// silent. A word also has to have been at the level of a voice, for 360 ms of the last second. On
/// the reference machine a voice saying the name reached 16 to 33 of these readings, and noise 0 to 11.
const VOICE_LEVEL: f32 = 0.025;
const VOICED_NEEDED: usize = 12;
const VOICE_WINDOW: usize = 33;
/// A recording outside these limits is not the word. A 60 ms blip in a lesson matched any noise at all.
const SHORTEST_WORD_MS: usize = 300;
const LONGEST_WORD_MS: usize = 2500;
/// How much two recordings of one word have to resemble each other. On the reference machine true
/// pairs scored 0.41 to 0.51, and a bad lesson's recordings 0.2 or less.
const ALIKE: f32 = 0.3;

fn pattern_of(word: &str, recordings: &[&Vec<u8>]) -> Result<WakewordRef, VoiceError> {
    let samples: HashMap<String, Vec<u8>> = recordings.iter().enumerate().map(|(i, pcm)| (format!("{i}"), to_wav(pcm, SAMPLE_RATE))).collect();
    WakewordRef::new_from_sample_buffers(word.to_string(), None, None, samples, DETAIL).map_err(VoiceError::Service)
}

/// How alike two recordings are from 0 to 1, with the longer one squeezed to the length of the shorter.
fn likeness(a: &[Vec<f32>], b: &[Vec<f32>]) -> f32 {
    let frames = a.len().min(b.len()).max(1);
    let total: f32 = (0..frames)
        .map(|i| {
            let (x, y) = (&a[i * a.len() / frames], &b[i * b.len() / frames]);
            let dot: f32 = x.iter().zip(y).map(|(p, q)| p * q).sum();
            dot / (x.iter().map(|p| p * p).sum::<f32>() * y.iter().map(|q| q * q).sum::<f32>()).sqrt().max(f32::EPSILON)
        })
        .sum();
    total / frames as f32
}

/// The biggest group of recordings that are really the same word, by their place in the list.
pub fn same_word(recordings: &[Vec<u8>]) -> Result<Vec<usize>, VoiceError> {
    let usable = |pcm: &&Vec<u8>| (SHORTEST_WORD_MS..=LONGEST_WORD_MS).contains(&(pcm.len() * 1000 / 2 / SAMPLE_RATE as usize));
    let chosen: Vec<usize> = (0..recordings.len()).filter(|&i| usable(&&recordings[i])).collect();
    if chosen.is_empty() {
        return Ok(chosen);
    }
    let pattern = pattern_of("word", &chosen.iter().map(|&i| &recordings[i]).collect::<Vec<_>>())?;
    let features: Vec<&Vec<Vec<f32>>> = (0..chosen.len()).map(|i| &pattern.samples_features[&i.to_string()]).collect();
    let group = (0..chosen.len())
        .map(|i| (0..chosen.len()).filter(|&j| j == i || likeness(features[i], features[j]) >= ALIKE).collect::<Vec<_>>())
        .max_by_key(Vec::len)
        .unwrap_or_default();
    Ok(group.into_iter().map(|i| chosen[i]).collect())
}

/// Turns recordings of a word, as 16-bit mono sound, into the pattern that is kept in their place.
pub fn learn(word: &str, recordings: &[Vec<u8>]) -> Result<Vec<u8>, VoiceError> {
    pattern_of(word, &recordings.iter().collect::<Vec<_>>())?.save_to_buffer().map_err(VoiceError::Service)
}

/// Finds learned words in sound as it arrives, by the user's own recordings and, for words in
/// English letters, by Windows' own speech engine too. Either one hearing it is enough.
pub struct Spotter {
    detector: Rustpotter,
    waiting: Vec<i16>,
    /// Whether each recent piece of sound was as loud as a voice.
    voiced: VecDeque<bool>,
    recognizer: Option<Recognizer>,
}

impl Spotter {
    /// `learned` pairs each word with its pattern from `learn`.
    pub fn new(easiness: &str, learned: &[(String, Vec<u8>)]) -> Result<Self, VoiceError> {
        let mut config = RustpotterConfig::default();
        config.fmt.sample_rate = SAMPLE_RATE as usize;
        config.fmt.sample_format = SampleFormat::I16;
        config.detector.threshold = closeness(easiness);
        // As soon as it is sure, because a command can follow straight on from the name.
        config.detector.eager = true;
        config.detector.band_size = STRETCH;
        config.detector.min_scores = MATCHES_NEEDED;
        config.detector.vad_mode = Some(VADMode::Easy);
        let mut detector = Rustpotter::new(&config).map_err(VoiceError::Service)?;
        for (word, pattern) in learned {
            let pattern = WakewordRef::load_from_buffer(pattern).map_err(VoiceError::Service)?;
            detector.add_wakeword_ref(word, pattern).map_err(VoiceError::Service)?;
        }
        Ok(Self { detector, waiting: Vec::new(), voiced: VecDeque::new(), recognizer: None })
    }

    /// Adds Windows' own engine for those of `words` it can spell. A PC without English speech
    /// keeps listening by the recordings alone, and says why.
    pub fn with_windows_speech(mut self, words: &[String], easiness: &str) -> (Self, Option<String>) {
        match Recognizer::start(words, recognizer::cutoff(easiness)) {
            Ok(found) => {
                self.recognizer = found;
                (self, None)
            }
            Err(err) => (self, Some(err.to_string())),
        }
    }

    /// The microphone went away. What was said before it is not a call when it comes back.
    pub fn settle(&mut self) {
        self.detector.reset();
        self.waiting.clear();
        self.voiced.clear();
        if let Some(recognizer) = &self.recognizer {
            recognizer.settle();
        }
    }

    /// Takes 16-bit mono sound, in pieces of any size, and says which word it found, if one.
    pub fn hear(&mut self, pcm: &[u8]) -> Option<Recognized> {
        let recognized = self.recognizer.as_ref().and_then(|recognizer| recognizer.hear(pcm));
        self.waiting.extend(pcm.chunks_exact(2).map(|sample| i16::from_le_bytes([sample[0], sample[1]])));
        let frame = self.detector.get_samples_per_frame();
        let mut found = None;
        while self.waiting.len() >= frame {
            let piece: Vec<i16> = self.waiting.drain(..frame).collect();
            let power = piece.iter().map(|&sample| (sample as f32 / 32768.0).powi(2)).sum::<f32>() / frame as f32;
            self.voiced.push_back(power.sqrt() >= VOICE_LEVEL);
            if self.voiced.len() > VOICE_WINDOW {
                self.voiced.pop_front();
            }
            let hit = self.detector.process_samples(piece);
            if self.voiced.iter().filter(|&&loud| loud).count() >= VOICED_NEEDED {
                found = hit.map(|hit| hit.name).or(found);
            }
        }
        // The recordings find a word as it ends, so nothing has been said after it yet.
        recognized.or(found.map(|word| Recognized { word, after_ms: 0 }))
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
    /// A call is being recorded, which has the microphone.
    pub recording_notes: bool,
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
    if c.recording_notes {
        return Wanted::Paused("Paused while a call is recording.");
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
        let mut heard = |pcm: &[u8]| pcm.chunks(3_200).filter_map(|piece| spotter.hear(piece).map(|found| found.word)).collect::<Vec<_>>();
        assert!(heard(&silence(2)).is_empty(), "silence");
        assert!(heard(&word(false, 0.0)).is_empty(), "another word");
        assert!(heard(&silence(2)).is_empty());
        let mut sound = word(true, 0.5);
        sound.extend(silence(2));
        assert_eq!(heard(&sound), ["hey mira"]);
    }

    #[test]
    fn a_shape_that_matches_is_not_enough_without_the_loudness_of_a_voice() {
        let pattern = learn("hey mira", &[word(true, 0.0), word(true, 1.0), word(true, 2.0)]).unwrap();
        let mut spotter = Spotter::new("balanced", &[("hey mira".to_string(), pattern)]).unwrap();
        let faint: Vec<u8> = word(true, 0.5).chunks_exact(2).flat_map(|s| (i16::from_le_bytes([s[0], s[1]]) / 100).to_le_bytes()).collect();
        let mut sound = faint;
        sound.extend(silence(2));
        assert!(sound.chunks(3_200).all(|piece| spotter.hear(piece).is_none()));
    }

    #[test]
    fn a_lesson_keeps_only_recordings_that_are_the_word() {
        let blip = word(true, 0.0)[..1_920].to_vec();
        let long: Vec<u8> = word(true, 0.0).repeat(5);
        let recordings = [blip, word(true, 0.0), word(false, 0.0), word(true, 1.0), long, word(true, 2.0)];
        assert_eq!(same_word(&recordings).unwrap(), [1, 3, 5]);
        assert!(same_word(&[]).unwrap().is_empty());
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
        recording_notes: false,
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
            Conditions { recording_notes: true, ..ON },
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
