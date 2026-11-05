//! Listens for a word in the user's own voice. It compares the microphone they chose against a few
//! recordings they made, here on this PC, so it works for any word in any language. Only the pattern
//! of those recordings is kept, never the sound, and what the microphone hears goes no further.
//! Words in English letters are also listened for by Windows' own speech engine, in `recognizer`.

use std::collections::{HashMap, HashSet, VecDeque};

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

/// How much clearer than its usual bar a detector has to be to wake on its own. The recordings
/// compare against the user's own voice, so their everyday speech comes close: a sentence that only
/// sounded like the name scored 0.54 against a bar of 0.5, and woke it. Windows' engine forces any
/// speech onto the words it listens for, and in 560 sentences without the name it went over 0.5
/// only for "Hey Marian".
const RECORDINGS_ALONE: f32 = 0.1;
const WINDOWS_ALONE: f32 = 0.2;
/// How close together the two have to hear the same word to agree. Windows answers a moment after
/// the word ends, and the recordings as it ends.
const AGREE_MS: u64 = 2000;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Source {
    Recordings,
    Windows,
}

/// One detector hearing a word clearly enough to count, and whether that woke the app. Only the
/// word and the numbers, never the sound, so a false wake can be traced to the detector behind it.
#[derive(Debug, Clone, PartialEq)]
pub struct Vote {
    pub by: &'static str,
    pub word: String,
    pub sure: f32,
    pub woke: bool,
}

/// Decides whether what the detectors heard is a call: one of them clearly sure, or both hearing the
/// same word close together. A word Windows does not listen for has only the recordings, which then
/// decide at their usual bar.
struct Judge {
    /// Each detector's bar to count at all, and to count on its own.
    recordings: (f32, f32),
    windows: (f32, f32),
    /// The words Windows listens for too, trimmed and lowercase.
    seconded: HashSet<String>,
    /// A word one detector heard, waiting for the other: by whom, when, and how much was said after it.
    waiting: Option<(Source, String, u64, u64)>,
    /// After a call, the other detector hearing the same word is not a second one.
    quiet_until: u64,
    votes: Vec<Vote>,
}

impl Judge {
    fn new(easiness: &str) -> Self {
        let (recordings, windows) = (closeness(easiness), recognizer::cutoff(easiness));
        Self {
            recordings: (recordings, recordings + RECORDINGS_ALONE),
            windows: (windows, windows + WINDOWS_ALONE),
            seconded: HashSet::new(),
            waiting: None,
            quiet_until: 0,
            votes: Vec::new(),
        }
    }

    /// What one detector heard at `at` ms into the sound. Gives the call, if this makes one.
    fn heard(&mut self, source: Source, found: Recognized, at: u64) -> Option<Recognized> {
        let (count, alone) = if source == Source::Recordings { self.recordings } else { self.windows };
        if found.sure < count || at < self.quiet_until {
            return None;
        }
        let only_one = source == Source::Recordings && !self.seconded.contains(&found.word.trim().to_lowercase());
        let mut vote = Vote { by: if source == Source::Recordings { "recordings" } else { "windows" }, word: found.word.clone(), sure: found.sure, woke: false };
        let agreed = self.waiting.as_ref().filter(|(by, word, when, _)| *by != source && *word == found.word && at.saturating_sub(*when) <= AGREE_MS).map(|(_, _, when, after)| after + (at - when));
        if only_one || found.sure >= alone || agreed.is_some() {
            self.waiting = None;
            self.quiet_until = at + AGREE_MS;
            // Windows knows how much was said after the word, the recordings do not.
            let after_ms = if source == Source::Windows { found.after_ms } else { agreed.unwrap_or(0) };
            vote.woke = true;
            self.votes.push(vote);
            return Some(Recognized { after_ms, ..found });
        }
        self.votes.push(vote);
        self.waiting = Some((source, found.word, at, found.after_ms));
        None
    }

    fn reset(&mut self) {
        self.waiting = None;
        self.quiet_until = 0;
    }
}

/// Finds learned words in sound as it arrives, by the user's own recordings and, for words in
/// English letters, by Windows' own speech engine too. One of them clearly sure is enough; otherwise
/// both have to hear it.
pub struct Spotter {
    detector: Rustpotter,
    waiting: Vec<i16>,
    /// Whether each recent piece of sound was as loud as a voice.
    voiced: VecDeque<bool>,
    recognizer: Option<Recognizer>,
    judge: Judge,
    /// How much sound has come in, in ms.
    heard_ms: u64,
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
        Ok(Self { detector, waiting: Vec::new(), voiced: VecDeque::new(), recognizer: None, judge: Judge::new(easiness), heard_ms: 0 })
    }

    /// Adds Windows' own engine for those of `words` it can spell. A PC without English speech
    /// keeps listening by the recordings alone, and says why.
    pub fn with_windows_speech(mut self, words: &[String], easiness: &str) -> (Self, Option<String>) {
        match Recognizer::start(words, recognizer::cutoff(easiness)) {
            Ok(found) => {
                if found.is_some() {
                    self.judge.seconded = words.iter().filter(|word| recognizer::spellable(word)).map(|word| word.trim().to_lowercase()).collect();
                }
                self.recognizer = found;
                (self, None)
            }
            Err(err) => (self, Some(err.to_string())),
        }
    }

    /// What the detectors counted since last asked.
    pub fn votes(&mut self) -> Vec<Vote> {
        std::mem::take(&mut self.judge.votes)
    }

    /// The microphone went away. What was said before it is not a call when it comes back.
    pub fn settle(&mut self) {
        self.detector.reset();
        self.waiting.clear();
        self.voiced.clear();
        self.judge.reset();
        if let Some(recognizer) = &self.recognizer {
            recognizer.settle();
        }
    }

    /// Takes 16-bit mono sound, in pieces of any size, and says which word it found, if one.
    pub fn hear(&mut self, pcm: &[u8]) -> Option<Recognized> {
        self.heard_ms += pcm.len() as u64 / 32;
        let recognized = self.recognizer.as_ref().and_then(|recognizer| recognizer.hear(pcm));
        let mut call = recognized.and_then(|found| self.judge.heard(Source::Windows, found, self.heard_ms));
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
                found = hit.map(|hit| (hit.name, hit.score)).or(found);
            }
        }
        // The recordings find a word as it ends, so nothing has been said after it yet.
        if let Some((word, sure)) = found {
            call = call.or(self.judge.heard(Source::Recordings, Recognized { word, after_ms: 0, sure }, self.heard_ms));
        }
        call
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

    fn judge() -> Judge {
        let mut judge = Judge::new("balanced");
        judge.seconded.insert("meridian".into());
        judge
    }

    fn found(word: &str, sure: f32, after_ms: u64) -> Recognized {
        Recognized { word: word.into(), after_ms, sure }
    }

    #[test]
    fn a_close_sentence_in_the_users_own_voice_is_not_a_call_on_its_own() {
        // 0.54 is what a sentence that only sounded like the name scored, and it woke the app.
        assert_eq!(judge().heard(Source::Recordings, found("Meridian", 0.54, 0), 1_000), None);
        // Windows forcing other speech onto the name, not sure enough to stand alone.
        assert_eq!(judge().heard(Source::Windows, found("Meridian", 0.55, 300), 1_000), None);
    }

    #[test]
    fn both_hearing_the_word_together_is_a_call() {
        let mut judge = judge();
        assert_eq!(judge.heard(Source::Recordings, found("Meridian", 0.54, 0), 1_000), None);
        let call = judge.heard(Source::Windows, found("Meridian", 0.55, 400), 1_600).expect("both heard it");
        assert_eq!(call.word, "Meridian");
        assert_eq!(call.after_ms, 400, "Windows knows what was said after it");
        // Either order.
        let mut judge = self::judge();
        assert_eq!(judge.heard(Source::Windows, found("Meridian", 0.55, 200), 1_000), None);
        assert_eq!(judge.heard(Source::Recordings, found("Meridian", 0.52, 0), 1_500).map(|c| c.after_ms), Some(700));
    }

    #[test]
    fn hearing_it_far_apart_or_as_different_words_is_not_agreeing() {
        let mut judge = judge();
        assert_eq!(judge.heard(Source::Recordings, found("Meridian", 0.54, 0), 1_000), None);
        assert_eq!(judge.heard(Source::Windows, found("Meridian", 0.55, 0), 1_000 + AGREE_MS + 1), None);
        let mut judge = self::judge();
        judge.seconded.insert("hey meridian".into());
        assert_eq!(judge.heard(Source::Recordings, found("Meridian", 0.54, 0), 1_000), None);
        assert_eq!(judge.heard(Source::Windows, found("Hey Meridian", 0.55, 0), 1_200), None);
        // The same detector twice is not a second opinion.
        let mut judge = self::judge();
        assert_eq!(judge.heard(Source::Recordings, found("Meridian", 0.54, 0), 1_000), None);
        assert_eq!(judge.heard(Source::Recordings, found("Meridian", 0.55, 0), 1_200), None);
    }

    #[test]
    fn one_detector_clearly_sure_is_enough() {
        assert!(judge().heard(Source::Windows, found("Meridian", 0.9, 300), 1_000).is_some());
        assert!(judge().heard(Source::Recordings, found("Meridian", 0.62, 0), 1_000).is_some());
    }

    #[test]
    fn below_its_bar_a_detector_is_not_heard_at_all() {
        let mut judge = judge();
        assert_eq!(judge.heard(Source::Recordings, found("Meridian", 0.47, 0), 1_000), None);
        assert_eq!(judge.heard(Source::Windows, found("Meridian", 0.55, 0), 1_200), None, "0.47 was not a vote");
    }

    #[test]
    fn a_word_windows_cannot_spell_has_only_the_recordings_to_go_by() {
        assert!(judge().heard(Source::Recordings, found("सुनो मीरा", 0.52, 0), 1_000).is_some());
    }

    #[test]
    fn what_counted_is_kept_with_whether_it_woke() {
        let mut judge = judge();
        judge.heard(Source::Recordings, found("Meridian", 0.54, 0), 1_000);
        judge.heard(Source::Recordings, found("Meridian", 0.3, 0), 1_100);
        judge.heard(Source::Windows, found("Meridian", 0.55, 0), 1_200);
        let votes: Vec<_> = judge.votes.iter().map(|v| (v.by, v.woke)).collect();
        assert_eq!(votes, [("recordings", false), ("windows", true)], "below the bar is not a vote");
    }

    #[test]
    fn one_word_wakes_it_once() {
        let mut judge = judge();
        assert!(judge.heard(Source::Windows, found("Meridian", 0.9, 300), 1_000).is_some());
        assert_eq!(judge.heard(Source::Recordings, found("Meridian", 0.62, 0), 1_300), None, "the same word, late");
        assert!(judge.heard(Source::Windows, found("Meridian", 0.9, 300), 1_000 + AGREE_MS + 500).is_some(), "said again later");
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

    /// Everyday speech and near misses, none of it saying a wake word.
    const WITHOUT_THE_NAME: &[&str] = &[
        "Let me check the calendar for tomorrow",
        "Hey Mary, did you see the game last night",
        "Hey Maria, come here for a second",
        "The meeting moved to three in the afternoon",
        "Can you send me the report by Friday",
        "I think the median price went up again",
        "America is a big country",
        "Miranda said she would call back later",
        "Meredith is running a little late today",
        "Merry Christmas and a happy new year",
        "Hey there, how are you doing",
        "Okay, let us get started then",
        "The train to Delhi leaves at seven",
        "Mandarin is hard to learn",
        "The material arrived this morning",
        "Hey Siri, what is the weather",
        "Okay Google, set a timer for ten minutes",
        "Remember to buy milk on the way home",
        "That was a really good movie",
        "My daughter wants to be a doctor",
        "We should paint the bedroom blue",
        "Hello, is anyone there",
        "Turn left at the next signal",
        "He is from the Indian army",
        "The radian is a unit of angle",
        "Maryland is on the east coast",
        "Hey man, nice to meet you",
        "Mary and Ann are coming to dinner",
        "I need a new pair of shoes",
        "The kids are playing in the garden",
        "Please close the door behind you",
        "What time does the shop open",
        "I will be there in five minutes",
        "The price of petrol went up again",
        "She sings beautifully",
        "Give me a minute, I am on a call",
        "Can you hear me now",
        "Hey, are you listening to me",
        "The deadline is next Monday",
        "Let us order some food",
        "The weather is lovely today",
        "Hey Marian, long time no see",
        "Is it a millennial thing",
        "Our sales went up in the Midwest region",
        "The Mercedes is parked outside",
        "My friend Arianne is visiting",
        "Hey Amanda, wait for me",
        "A merry band of travellers",
        "Meet me at the theatre at nine",
        "It is a very serious matter",
        "I love the smell of rain",
        "Where did I keep my phone",
        "The baby is finally asleep",
        "Did you finish your homework",
        "Hey Ron, pass me the salt",
        "The cricket match starts at two",
        "Please mute your microphone",
        "Thank you, that is all for today",
        "Mary had a little lamb",
        "The river runs along the meadow",
        "Make sure the oven is off",
        "The new update looks nice",
        "I could not hear what you said",
        "Hey everyone, welcome to the call",
        "Well, that is a long story",
        "Merry go round at the fair",
        "The camera in this room is broken",
        "Hand me the remote please",
        "Let me think about it for a moment",
        "I am going to the market",
    ];

    fn hex(word: &str) -> String {
        word.trim().to_lowercase().bytes().map(|byte| format!("{byte:02x}")).collect()
    }

    /// Counts false wakes in speech made by every Windows voice on this PC, none of it saying a wake
    /// word, through the words this user taught, each detector apart and with how sure it was. Reads
    /// the words from MERIDIAN_WAKE_WORDS ("Hey Meridian,Meridian") and their patterns from
    /// MERIDIAN_WAKE_DIR, the app's own wake folder. Plays nothing aloud and sends nothing anywhere.
    #[test]
    #[ignore = "uses this PC's voices, speech engine and taught words"]
    fn false_wakes_in_speech_without_the_name() {
        let dir = std::env::var("MERIDIAN_WAKE_DIR").expect("MERIDIAN_WAKE_DIR");
        let words: Vec<String> = std::env::var("MERIDIAN_WAKE_WORDS").expect("MERIDIAN_WAKE_WORDS").split(',').map(|w| w.trim().to_string()).collect();
        let mut config = RustpotterConfig::default();
        config.fmt.sample_rate = SAMPLE_RATE as usize;
        config.fmt.sample_format = SampleFormat::I16;
        config.detector.threshold = 0.3;
        config.detector.eager = true;
        config.detector.band_size = STRETCH;
        config.detector.min_scores = MATCHES_NEEDED;
        config.detector.vad_mode = Some(VADMode::Easy);
        let mut detector = Rustpotter::new(&config).unwrap();
        for word in &words {
            let pattern = WakewordRef::load_from_buffer(&std::fs::read(format!("{dir}/{}.rpw", hex(word))).unwrap()).unwrap();
            detector.add_wakeword_ref(word, pattern).unwrap();
        }
        let recognizer = Recognizer::start(&words, 0.0).unwrap().expect("an English recognizer");
        let voices = crate::windows_voice::voices();
        println!("voices: {}", voices.iter().map(|v| format!("{} ({})", v.name, v.note)).collect::<Vec<_>>().join(", "));
        let silence = vec![0u8; 32_000];

        let run = |pcm: &[u8], detector: &mut Rustpotter| {
            let (mut best, mut heard) = (None::<(String, f32)>, Vec::new());
            let mut voiced: VecDeque<bool> = VecDeque::new();
            let frame = detector.get_samples_per_frame();
            let samples: Vec<i16> = [silence.as_slice(), pcm, &silence, &silence].concat().chunks_exact(2).map(|s| i16::from_le_bytes([s[0], s[1]])).collect();
            for (n, piece) in samples.chunks(frame).enumerate() {
                if piece.len() < frame {
                    break;
                }
                let power = piece.iter().map(|&s| (s as f32 / 32768.0).powi(2)).sum::<f32>() / frame as f32;
                voiced.push_back(power.sqrt() >= VOICE_LEVEL);
                if voiced.len() > VOICE_WINDOW {
                    voiced.pop_front();
                }
                if let Some(hit) = detector.process_samples(piece.to_vec()) {
                    if voiced.iter().filter(|&&loud| loud).count() >= VOICED_NEEDED && best.as_ref().is_none_or(|(_, s)| hit.score > *s) {
                        best = Some((hit.name, hit.score));
                    }
                }
                let bytes: Vec<u8> = piece.iter().flat_map(|s| s.to_le_bytes()).collect();
                heard.extend(recognizer.hear(&bytes));
                // The engine keeps up with sound arriving in real time, not all at once.
                if n % 8 == 0 {
                    std::thread::sleep(std::time::Duration::from_millis(2));
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(300));
            heard.extend(recognizer.hear(&[]));
            detector.reset();
            (best, heard)
        };

        let (mut recordings_over, mut windows_over, mut total) = (Vec::new(), Vec::new(), 0);
        for voice in &voices {
            for sentence in WITHOUT_THE_NAME {
                let Ok((rate, pcm)) = crate::windows_voice::speak(Some(&voice.id), sentence) else { continue };
                if rate != SAMPLE_RATE {
                    continue;
                }
                total += 1;
                let (best, heard) = run(&pcm, &mut detector);
                if let Some((word, score)) = best {
                    recordings_over.push((score, word, voice.name.clone(), *sentence));
                }
                for r in heard {
                    windows_over.push((r.sure, r.word, voice.name.clone(), *sentence));
                }
            }
            // Each voice saying each word alone, so it is plain the engine hears the real thing.
            for word in &words {
                if let Ok((_, pcm)) = crate::windows_voice::speak(Some(&voice.id), word) {
                    let (_, heard) = run(&pcm, &mut detector);
                    println!("control, {} says {word:?}: windows heard {:?}", voice.name, heard.iter().map(|r| (r.word.as_str(), r.sure)).collect::<Vec<_>>());
                }
            }
        }
        recordings_over.sort_by(|a, b| b.0.total_cmp(&a.0));
        windows_over.sort_by(|a, b| b.0.total_cmp(&a.0));
        println!("\n{total} sentences without the name");
        println!("recordings, best score per sentence over 0.3 ({}):", recordings_over.len());
        for (score, word, voice, sentence) in recordings_over.iter().take(25) {
            println!("  {score:.3} {word:?} {voice}: {sentence}");
        }
        println!("windows speech, every recognition ({}):", windows_over.len());
        for (sure, word, voice, sentence) in windows_over.iter().take(40) {
            println!("  {sure:.3} {word:?} {voice}: {sentence}");
        }
    }

    #[test]
    fn our_own_use_of_the_microphone_is_not_a_call() {
        assert!(is_ours("C:#Users#me#AppData#Local#Meridian#meridian.exe", "meridian.exe"));
        assert!(!is_ours("C:#Program Files#Zoom#Zoom.exe", "meridian.exe"));
    }
}
