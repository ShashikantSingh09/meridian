//! Listens for a few chosen phrases, with the speech recognizer built into Windows held to a fixed
//! list. It runs on this PC and needs no download. Nothing it hears is kept, and the text of a match
//! is all that leaves here. The rest of the speech path stays out of it until a phrase is heard.

use windows::core::{Interface, Ref, HSTRING};
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Globalization::Language;
use windows::Media::SpeechRecognition::{
    ISpeechRecognitionConstraint, SpeechContinuousRecognitionCompletedEventArgs, SpeechContinuousRecognitionResultGeneratedEventArgs,
    SpeechContinuousRecognitionSession, SpeechRecognitionConfidence, SpeechRecognitionGrammarFileConstraint, SpeechRecognitionListConstraint, SpeechRecognitionResultStatus,
    SpeechRecognizer,
};
use windows::Storage::StorageFile;
use windows::System::UserProfile::GlobalizationPreferences;
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS};
use windows_collections::IIterable;

use crate::VoiceError;

const MOST_LETTERS: usize = 40;
/// Windows would otherwise end the session after a few quiet seconds.
const QUIET_ALLOWED: TimeSpan = TimeSpan { Duration: 24 * 60 * 60 * 10_000_000 };
const MICROPHONE_USERS: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
/// Windows runs the recognizer in this, so its use of the microphone is ours.
const OUR_RECOGNIZER: &str = "speechruntime";

/// A phrase the recognizer can take: English letters and single spaces. It works out how a word
/// sounds from its spelling, so a Hindi name works when written in English letters.
pub fn clean(text: &str) -> Option<String> {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let fits = !joined.is_empty() && joined.len() <= MOST_LETTERS && joined.chars().all(|c| c.is_ascii_alphabetic() || c == ' ' || c == '\'');
    fits.then_some(joined)
}

/// Longer than this and more was said than a name, which is also what talk in the room looks like.
pub const NAME_MS: u64 = 1400;

/// Below this a Low match is noise. Room talk scored 0.002 and 0.008 on the reference machine.
const FAINTEST: f64 = 0.02;

/// How easily it wakes: "sure", "balanced" or "easily". Anything else is treated as balanced. A name
/// on its own may be faint, as a clear word across a room is. Inside a longer stretch of speech it
/// has to be certain, because that is what people talking to each other sounds like.
pub fn accepted(easiness: &str, confidence: SpeechRecognitionConfidence, raw: f64, spoken_ms: u64) -> bool {
    use SpeechRecognitionConfidence as C;
    let alone = spoken_ms <= NAME_MS;
    match easiness {
        "sure" => confidence == C::High,
        "easily" => confidence != C::Rejected && (alone || confidence != C::Low),
        _ if alone => confidence != C::Rejected && (confidence != C::Low || raw >= FAINTEST),
        _ => confidence == C::High,
    }
}

const GREETINGS: [&str; 6] = ["hey", "hi", "hello", "okay", "ok", "oye"];

/// Everything that counts as saying a wake word: the words themselves, the name alone, and the
/// name with any greeting, because nobody keeps to one exact phrase.
pub fn phrases(words: &[String]) -> Vec<String> {
    let mut all: Vec<String> = Vec::new();
    let mut add = |phrase: String| {
        if !phrase.is_empty() && !all.contains(&phrase) {
            all.push(phrase);
        }
    };
    for word in words {
        let word = word.to_lowercase();
        add(word.clone());
        let name = word.split_once(' ').filter(|(first, _)| GREETINGS.contains(first)).map_or(word.as_str(), |(_, rest)| rest);
        add(name.to_string());
        for greeting in GREETINGS {
            add(format!("{greeting} {name}"));
        }
    }
    all
}

/// A grammar that finds a phrase anywhere in what is said, so a command in the same breath counts.
/// Phrases have been through `clean`, so they need no escaping beyond the apostrophe.
pub fn grammar(phrases: &[String], language: &str) -> String {
    let items: String = phrases.iter().map(|phrase| format!("<item>{}</item>", phrase.replace('\'', "&apos;"))).collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><grammar version="1.0" xml:lang="{language}" root="wake" mode="voice" tag-format="semantics/1.0" xmlns="http://www.w3.org/2001/06/grammar"><rule id="wake" scope="public"><item repeat="0-1"><ruleref special="GARBAGE"/></item><one-of>{items}</one-of><item repeat="0-1"><ruleref special="GARBAGE"/></item></rule></grammar>"#
    )
}

/// The phrase in what was recognized, which can come wrapped in dots for the speech around it.
pub fn phrase_in(text: &str, phrases: &[String]) -> Option<String> {
    let text = text.to_lowercase();
    phrases.iter().filter(|phrase| text.contains(phrase.as_str())).max_by_key(|phrase| phrase.len()).cloned()
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Conditions {
    pub enabled: bool,
    /// Pause all monitoring, the one switch that stops everything.
    pub monitoring_paused: bool,
    pub has_words: bool,
    /// The Test button is waiting, which works with the switch off.
    pub testing: bool,
    /// A conversation holds the microphone.
    pub talking: bool,
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
    if c.talking {
        return Wanted::Paused("Paused during a conversation.");
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
    user.contains(OUR_RECOGNIZER) || user.contains(this_app)
}

/// Is some other app using the microphone? `this_app` is this program's file name.
pub fn others_on_microphone(this_app: &str) -> bool {
    microphone_users().iter().any(|user| !is_ours(user, &this_app.to_ascii_lowercase()))
}

/// The user's own language if Windows can recognize it, which is what tells Indian English from British.
fn language() -> Result<Language, VoiceError> {
    let supported = SpeechRecognizer::SupportedGrammarLanguages()?;
    let tags = supported.into_iter().filter_map(|l| l.LanguageTag().ok()).collect::<Vec<_>>();
    if let Some(tag) = GlobalizationPreferences::Languages()?.into_iter().find(|tag| tags.contains(tag)) {
        return Ok(Language::CreateLanguage(&tag)?);
    }
    if tags.is_empty() {
        return Err(VoiceError::Service("Windows has no speech recognizer here. Add English in Windows Settings, Time and language, Speech.".into()));
    }
    Ok(SpeechRecognizer::SystemSpeechLanguage()?)
}

pub fn use_grammar(recognizer: &SpeechRecognizer, phrases: &[String], language: &str) -> Result<bool, VoiceError> {
    let path = std::env::temp_dir().join("meridian-wake-words.grxml");
    std::fs::write(&path, grammar(phrases, language))?;
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path.as_os_str()))?.join()?;
    let constraint = SpeechRecognitionGrammarFileConstraint::CreateWithTag(&file, &HSTRING::from("wake"))?;
    recognizer.Constraints()?.Append(&constraint.cast::<ISpeechRecognitionConstraint>()?)?;
    Ok(recognizer.CompileConstraintsAsync()?.join()?.Status()? == SpeechRecognitionResultStatus::Success)
}

pub struct Heard {
    pub text: String,
    pub confidence: SpeechRecognitionConfidence,
    pub raw: f64,
    /// How long the whole utterance took, which tells a bare name from a name and a command.
    pub spoken_ms: u64,
}

/// Open for as long as this is held. Dropping it closes the microphone.
pub struct Listener {
    recognizer: SpeechRecognizer,
    session: SpeechContinuousRecognitionSession,
}

impl Listener {
    /// `stopped` is told if Windows ends the session by itself, such as when the microphone goes.
    pub fn start(words: &[String], heard: impl Fn(Heard) + Send + 'static, stopped: impl Fn() + Send + 'static) -> Result<Self, VoiceError> {
        let language = language()?;
        let recognizer = SpeechRecognizer::Create(&language)?;
        let all = phrases(words);
        let tag = language.LanguageTag()?.to_string();
        // Falls back to exact phrases if a future Windows will not take the grammar.
        if !use_grammar(&recognizer, &all, &tag).unwrap_or(false) {
            let list: IIterable<HSTRING> = all.iter().map(HSTRING::from).collect::<Vec<_>>().into();
            let constraint = SpeechRecognitionListConstraint::CreateWithTag(&list, &HSTRING::from("wake"))?;
            let constraints = recognizer.Constraints()?;
            constraints.Clear()?;
            constraints.Append(&constraint.cast::<ISpeechRecognitionConstraint>()?)?;
            if recognizer.CompileConstraintsAsync()?.join()?.Status()? != SpeechRecognitionResultStatus::Success {
                return Err(VoiceError::Service("Windows could not use those wake words.".into()));
            }
        }
        let session = recognizer.ContinuousRecognitionSession()?;
        session.SetAutoStopSilenceTimeout(QUIET_ALLOWED)?;
        session.ResultGenerated(&TypedEventHandler::new(
            move |_, args: Ref<SpeechContinuousRecognitionResultGeneratedEventArgs>| {
                if let Some(result) = args.as_ref().and_then(|args| args.Result().ok()) {
                    if result.Status()? == SpeechRecognitionResultStatus::Success {
                        let spoken_ms = (result.PhraseDuration()?.Duration / 10_000).max(0) as u64;
                        heard(Heard { text: result.Text()?.to_string(), confidence: result.Confidence()?, raw: result.RawConfidence()?, spoken_ms });
                    }
                }
                Ok(())
            },
        ))?;
        session.Completed(&TypedEventHandler::new(move |_, _: Ref<SpeechContinuousRecognitionCompletedEventArgs>| {
            stopped();
            Ok(())
        }))?;
        session.StartAsync()?.join()?;
        Ok(Self { recognizer, session })
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        let _ = self.session.CancelAsync().and_then(|stop| stop.join());
        let _ = self.recognizer.Close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use SpeechRecognitionConfidence as C;

    #[test]
    fn a_wake_word_is_english_letters_and_single_spaces() {
        assert_eq!(clean("  Hey   Meridian "), Some("Hey Meridian".into()));
        assert_eq!(clean("Suno Mira"), Some("Suno Mira".into()));
        assert_eq!(clean("   "), None);
        assert_eq!(clean("सुनो मीरा"), None);
        assert_eq!(clean("hey <mira>"), None);
        assert_eq!(clean(&"a".repeat(41)), None);
    }

    #[test]
    fn how_easily_it_wakes_changes_what_counts() {
        const ALONE: u64 = 800;
        assert!(accepted("sure", C::High, 0.9, ALONE) && !accepted("sure", C::Medium, 0.9, ALONE));
        assert!(accepted("balanced", C::Low, 0.3, ALONE) && !accepted("balanced", C::Rejected, 0.3, ALONE));
        assert!(!accepted("balanced", C::Low, 0.008, ALONE), "this is what noise scored");
        assert!(accepted("easily", C::Low, 0.002, ALONE) && !accepted("easily", C::Rejected, 0.3, ALONE));
    }

    #[test]
    fn talk_in_the_room_does_not_wake_it() {
        const TALK: u64 = 3000;
        assert!(!accepted("balanced", C::Low, 0.5, TALK) && !accepted("balanced", C::Medium, 0.5, TALK));
        assert!(accepted("balanced", C::High, 0.9, TALK), "a clear name and a command still works");
        assert!(!accepted("easily", C::Low, 0.5, TALK));
    }

    #[test]
    fn saying_the_name_any_natural_way_counts() {
        let all = phrases(&["Hey Meridian".to_string()]);
        for said in ["hey meridian", "meridian", "hi meridian", "okay meridian", "ok meridian", "hello meridian"] {
            assert!(all.iter().any(|p| p == said), "{said}");
        }
        let mine = phrases(&["Suno Mira".to_string()]);
        assert!(mine.iter().any(|p| p == "suno mira") && mine.iter().any(|p| p == "hey suno mira"));
    }

    #[test]
    fn the_grammar_finds_a_phrase_anywhere_in_a_sentence() {
        let text = grammar(&["hey meridian".to_string(), "bob's name".to_string()], "en-IN");
        assert!(text.contains(r#"xml:lang="en-IN""#));
        assert_eq!(text.matches(r#"special="GARBAGE""#).count(), 2);
        assert!(text.contains("<item>hey meridian</item>") && text.contains("bob&apos;s name"));
    }

    #[test]
    fn the_phrase_is_found_in_what_came_back() {
        let all = phrases(&["Hey Meridian".to_string()]);
        assert_eq!(phrase_in("... Hey Meridian ...", &all).as_deref(), Some("hey meridian"));
        assert_eq!(phrase_in("meridian", &all).as_deref(), Some("meridian"));
        assert_eq!(phrase_in("", &all), None);
    }

    const ON: Conditions = Conditions {
        enabled: true,
        monitoring_paused: false,
        has_words: true,
        testing: false,
        talking: false,
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
            Conditions { talking: true, ..ON },
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
        assert!(is_ours("C:#Windows#System32#Speech_OneCore#Common#SpeechRuntime.exe", "meridian.exe"));
        assert!(is_ours("C:#Users#me#AppData#Local#Meridian#meridian.exe", "meridian.exe"));
        assert!(!is_ours("C:#Program Files#Zoom#Zoom.exe", "meridian.exe"));
    }
}
