//! Windows' own speech engine, the one it uses offline, fed the same microphone sound as the rest of
//! wake words. It runs inside this app from models that come with Windows, listens only for the
//! words it is given, and sends nothing anywhere.
//!
//! It is reached through SAPI's OneCore classes, not `Windows.Media.SpeechRecognition`, because only
//! these take their sound from the app. The WinRT recognizer opens the microphone by itself, and
//! hearing nothing in some runs is why it was dropped before (see DECISIONS, D59 and D63).

use std::collections::VecDeque;
use std::ffi::c_void;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::Duration;

use windows::core::{implement, IUnknown, Interface, Ref, GUID, HRESULT, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{E_NOTIMPL, S_FALSE, S_OK};
use windows::Win32::Media::Audio::WAVEFORMATEX;
use windows::Win32::Media::Speech::{
    ISpObjectToken, ISpObjectTokenCategory, ISpRecoContext, ISpRecoGrammar, ISpRecoResult, ISpRecognizer, ISpStream, SPEVENT, SPEVENTENUM, SPEI_RECOGNITION,
    SPEI_RESERVED1, SPEI_RESERVED2, SPET_LPARAM_IS_OBJECT, SPET_LPARAM_IS_POINTER, SPET_LPARAM_IS_STRING, SPET_LPARAM_IS_TOKEN, SPLO_STATIC, SPRS_ACTIVE,
    SPRST_ACTIVE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, ISequentialStream_Impl, IStream, IStream_Impl, CLSCTX_INPROC_SERVER,
    COINIT_MULTITHREADED, LOCKTYPE, STATFLAG, STATSTG, STGC, STGTY_STREAM, STREAM_SEEK, STREAM_SEEK_CUR,
};

use crate::VoiceError;

/// SAPI's OneCore classes, from `sapi_onecore.dll`. The desktop SAPI classes reach only Windows' older engines.
const INPROC_RECOGNIZER: GUID = GUID::from_u128(0x8a44ffb7_8140_432f_bec5_1b5ff725bac8);
const TOKEN_CATEGORY: GUID = GUID::from_u128(0x461ded9e_81d5_494f_bc96_6432c8645733);
const STREAM: GUID = GUID::from_u128(0x0dd1b55e_2eb8_42e2_b8d0_f11594a29477);
/// SPDFID_WaveFormatEx, which says the stream's format is the WAVEFORMATEX passed with it.
const WAVE_FORMAT: GUID = GUID::from_u128(0xc31adbae_527f_4ff5_a230_f62bb61ff70c);
const RECOGNIZERS: &str = r"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Speech_OneCore\Recognizers";
/// The English recognizers Windows ships, as the locale and the language number its list uses.
const ENGLISH: [(&str, u32); 5] = [("en-US", 0x409), ("en-GB", 0x809), ("en-IN", 0x4009), ("en-AU", 0xc09), ("en-CA", 0x1009)];
const BYTES_PER_MS: u64 = 32;
/// Sound kept for the engine if it falls behind, so a stall cannot fill memory.
const MOST_WAITING: usize = 10 * 32_000;
const STARTING: Duration = Duration::from_secs(10);

/// How sure the engine has to be. On synthesized speech at 0.5 it caught Indian English voices
/// every time and never woke on 270 sentences without the name; at 0.4 it woke twice.
pub fn cutoff(easiness: &str) -> f32 {
    match easiness {
        "sure" => 0.6,
        "easily" => 0.4,
        _ => 0.5,
    }
}

/// The words this engine can take, which is those spelled in English letters.
pub fn spellable(word: &str) -> bool {
    !word.trim().is_empty() && word.chars().all(|c| c.is_ascii_alphabetic() || c == ' ' || c == '\'')
}

/// English recognizers to try, the one for the user's own country first. Anyone in India gets Indian English.
pub fn preferred(locale: &str) -> Vec<(&'static str, u32)> {
    let country = locale.rsplit('-').next().unwrap_or_default().to_ascii_uppercase();
    let (mut order, rest): (Vec<(&str, u32)>, Vec<_>) = ENGLISH.iter().copied().partition(|(tag, _)| !country.is_empty() && tag.ends_with(&country));
    order.extend(rest);
    order
}

fn grammar(words: &[String], tag: &str) -> String {
    let items: String = words.iter().map(|word| format!("<item>{}</item>", word.trim().to_lowercase())).collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<grammar version="1.0" xml:lang="{tag}" root="wake" xmlns="http://www.w3.org/2001/06/grammar">
  <rule id="wake" scope="public"><one-of>{items}</one-of></rule>
</grammar>"#
    )
}

/// A word that was heard, and how much sound has come in since it ended.
#[derive(Debug, Clone, PartialEq)]
pub struct Recognized {
    pub word: String,
    pub after_ms: u64,
}

#[derive(Default)]
struct Waiting {
    sound: VecDeque<u8>,
    /// Where the end of the sound handed in is, counted the way the engine counts its stream.
    written: u64,
    read: u64,
    /// A word that ended before here was said before the microphone went away, so it is not a call now.
    stale_until: u64,
    closed: bool,
}

type Shared = Arc<(Mutex<Waiting>, Condvar)>;

/// The stream the engine reads. A read waits for the sound, as a microphone would.
#[implement(IStream)]
struct Feed(Shared);

impl ISequentialStream_Impl for Feed_Impl {
    fn Read(&self, pv: *mut c_void, cb: u32, pcbread: *mut u32) -> HRESULT {
        let (lock, arrived) = &*self.0;
        let mut waiting = lock.lock().unwrap();
        // A short read would end the stream, so it waits for all of it.
        while waiting.sound.len() < cb as usize && !waiting.closed {
            waiting = arrived.wait(waiting).unwrap();
        }
        let n = waiting.sound.len().min(cb as usize);
        let out = unsafe { std::slice::from_raw_parts_mut(pv as *mut u8, n) };
        for (slot, byte) in out.iter_mut().zip(waiting.sound.drain(..n)) {
            *slot = byte;
        }
        waiting.read += n as u64;
        if !pcbread.is_null() {
            unsafe { *pcbread = n as u32 };
        }
        if n < cb as usize {
            S_FALSE
        } else {
            S_OK
        }
    }

    fn Write(&self, _: *const c_void, _: u32, _: *mut u32) -> HRESULT {
        E_NOTIMPL
    }
}

impl IStream_Impl for Feed_Impl {
    /// Only "where are you" is answered, because the stream cannot go back.
    fn Seek(&self, distance: i64, origin: STREAM_SEEK, position: *mut u64) -> windows::core::Result<()> {
        if distance != 0 || origin != STREAM_SEEK_CUR {
            return Err(E_NOTIMPL.into());
        }
        if !position.is_null() {
            unsafe { *position = self.0 .0.lock().unwrap().read };
        }
        Ok(())
    }
    fn SetSize(&self, _: u64) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn CopyTo(&self, _: Ref<IStream>, _: u64, _: *mut u64, _: *mut u64) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn Commit(&self, _: &STGC) -> windows::core::Result<()> {
        Ok(())
    }
    fn Revert(&self) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn LockRegion(&self, _: u64, _: u64, _: &LOCKTYPE) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn UnlockRegion(&self, _: u64, _: u64, _: u32) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn Stat(&self, stat: *mut STATSTG, _: &STATFLAG) -> windows::core::Result<()> {
        if !stat.is_null() {
            unsafe {
                *stat = STATSTG { r#type: STGTY_STREAM.0 as u32, cbSize: u64::MAX, ..Default::default() };
            }
        }
        Ok(())
    }
    fn Clone(&self) -> windows::core::Result<IStream> {
        Err(E_NOTIMPL.into())
    }
}

/// Listens on its own thread for as long as it is kept. Dropping it ends the thread.
pub struct Recognizer {
    shared: Shared,
    found: mpsc::Receiver<Recognized>,
}

impl Recognizer {
    /// Starts listening for those of `words` it can spell, or gives None if there are none.
    pub fn start(words: &[String], cutoff: f32) -> Result<Option<Self>, VoiceError> {
        let words: Vec<String> = words.iter().filter(|word| spellable(word)).cloned().collect();
        if words.is_empty() {
            return Ok(None);
        }
        let shared: Shared = Arc::default();
        let (tell, found) = mpsc::channel();
        let (ready, started) = mpsc::channel();
        let feed = shared.clone();
        std::thread::Builder::new()
            .name("wake recognizer".into())
            .spawn(move || run(words, cutoff, feed, tell, ready))
            .map_err(|err| VoiceError::Windows(err.to_string()))?;
        match started.recv_timeout(STARTING) {
            Ok(Ok(())) => Ok(Some(Self { shared, found })),
            Ok(Err(why)) => Err(VoiceError::Windows(why)),
            Err(_) => {
                close(&shared);
                Err(VoiceError::Windows("Windows speech did not start.".into()))
            }
        }
    }

    /// Hands over the next piece of 16 kHz mono 16-bit sound, and gives a word heard since the last piece.
    pub fn hear(&self, pcm: &[u8]) -> Option<Recognized> {
        {
            let (lock, arrived) = &*self.shared;
            let mut waiting = lock.lock().unwrap();
            waiting.sound.extend(pcm);
            waiting.written += pcm.len() as u64;
            // Dropped sound never reaches the stream, so it does not count towards where it is.
            let over = waiting.sound.len().saturating_sub(MOST_WAITING);
            waiting.sound.drain(..over);
            waiting.written -= over as u64;
            arrived.notify_all();
        }
        self.found.try_recv().ok()
    }

    /// The microphone went away, to a conversation or for good. A second of quiet lets the engine
    /// finish whatever it was halfway through, and nothing it finishes from before now is a call.
    pub fn settle(&self) {
        let quiet = [0u8; 32_000];
        // Marked before the quiet goes in, because the engine can finish within moments of it.
        {
            let mut waiting = self.shared.0.lock().unwrap();
            waiting.stale_until = waiting.written + quiet.len() as u64;
        }
        self.hear(&quiet);
        while self.found.try_recv().is_ok() {}
    }
}

impl Drop for Recognizer {
    fn drop(&mut self) {
        close(&self.shared);
    }
}

fn close(shared: &Shared) {
    shared.0.lock().unwrap().closed = true;
    shared.1.notify_all();
}

/// The engine and what it was given, for the life of the thread.
struct Session {
    _recognizer: ISpRecognizer,
    context: ISpRecoContext,
    _grammar: ISpRecoGrammar,
}

fn interest(events: &[SPEVENTENUM]) -> u64 {
    events.iter().fold((1u64 << SPEI_RESERVED1.0) | (1u64 << SPEI_RESERVED2.0), |all, event| all | (1u64 << event.0))
}

/// The recognizer for the user's English, from the ones this PC has.
unsafe fn english() -> windows::core::Result<(ISpObjectToken, &'static str)> {
    let category: ISpObjectTokenCategory = CoCreateInstance(&TOKEN_CATEGORY, None, CLSCTX_INPROC_SERVER)?;
    category.SetId(&HSTRING::from(RECOGNIZERS), false)?;
    let locale = windows_registry::CURRENT_USER.open(r"Control Panel\International").and_then(|key| key.get_string("LocaleName")).unwrap_or_default();
    for (tag, number) in preferred(&locale) {
        let tokens = category.EnumTokens(&HSTRING::from(format!("Language={number:x}")), PCWSTR::null())?;
        let mut token = None;
        if tokens.Next(1, &mut token, None).is_ok() {
            if let Some(token) = token {
                return Ok((token, tag));
            }
        }
    }
    Err(windows::core::Error::new(E_NOTIMPL, "This PC has no English speech recognizer. Add English speech in Windows Settings, Time and language."))
}

unsafe fn open(words: &[String], shared: &Shared) -> windows::core::Result<Session> {
    let recognizer: ISpRecognizer = CoCreateInstance(&INPROC_RECOGNIZER, None, CLSCTX_INPROC_SERVER)?;
    let (token, tag) = english()?;
    recognizer.SetRecognizer(&token)?;
    let format = WAVEFORMATEX { wFormatTag: 1, nChannels: 1, nSamplesPerSec: 16_000, nAvgBytesPerSec: 32_000, nBlockAlign: 2, wBitsPerSample: 16, cbSize: 0 };
    let feed: IStream = Feed(shared.clone()).into();
    let stream: ISpStream = CoCreateInstance(&STREAM, None, CLSCTX_INPROC_SERVER)?;
    stream.SetBaseStream(&feed, &WAVE_FORMAT, &format)?;
    recognizer.SetInput(&stream, true)?;
    let context = recognizer.CreateRecoContext()?;
    context.SetNotifyWin32Event()?;
    let wanted = interest(&[SPEI_RECOGNITION]);
    context.SetInterest(wanted, wanted)?;
    let rules = context.CreateGrammar(1)?;
    // The grammar is read from a file, so it is written for a moment to this app's temporary folder.
    let file = std::env::temp_dir().join(format!("meridian-wake-{}.xml", std::process::id()));
    std::fs::write(&file, grammar(words, tag)).map_err(|err| windows::core::Error::new(E_NOTIMPL, err.to_string()))?;
    let loaded = rules.LoadCmdFromFile(&HSTRING::from(file.as_os_str()), SPLO_STATIC);
    let _ = std::fs::remove_file(&file);
    loaded?;
    rules.SetRuleState(PCWSTR::null(), std::ptr::null_mut(), SPRS_ACTIVE)?;
    recognizer.SetRecoState(SPRST_ACTIVE)?;
    Ok(Session { _recognizer: recognizer, context, _grammar: rules })
}

/// What the engine was sure of, as text and how sure, with where in the stream it ended.
unsafe fn phrase_of(result: &ISpRecoResult) -> windows::core::Result<(String, f32, u64)> {
    let phrase = result.GetPhrase()?;
    let base = &(*phrase).Base;
    let (sure, end) = (base.Rule.SREngineConfidence, base.ullAudioStreamPosition + u64::from(base.ulAudioSizeBytes));
    CoTaskMemFree(Some(phrase as *const c_void));
    let mut text = PWSTR::null();
    result.GetText(u32::MAX, u32::MAX, true, &mut text, None)?;
    let said = text.to_string().unwrap_or_default();
    CoTaskMemFree(Some(text.0 as *const c_void));
    Ok((said, sure, end))
}

/// Takes every waiting event, and gives what it heard. Each event owns what it carries, so all of it is let go.
unsafe fn heard(context: &ISpRecoContext) -> Vec<(String, f32, u64)> {
    let mut out = Vec::new();
    loop {
        let mut event = SPEVENT::default();
        let mut fetched = 0u32;
        if context.GetEvents(1, &mut event, &mut fetched).is_err() || fetched == 0 {
            return out;
        }
        let (id, kind) = (event._bitfield & 0xffff, (event._bitfield >> 16) & 0xffff);
        if event.lParam.0 == 0 {
            continue;
        }
        if kind == SPET_LPARAM_IS_OBJECT.0 || kind == SPET_LPARAM_IS_TOKEN.0 {
            let object = IUnknown::from_raw(event.lParam.0 as *mut c_void);
            if id == SPEI_RECOGNITION.0 {
                if let Ok(phrase) = object.cast::<ISpRecoResult>().and_then(|result| phrase_of(&result)) {
                    out.push(phrase);
                }
            }
        } else if kind == SPET_LPARAM_IS_POINTER.0 || kind == SPET_LPARAM_IS_STRING.0 {
            CoTaskMemFree(Some(event.lParam.0 as *const c_void));
        }
    }
}

fn run(words: Vec<String>, cutoff: f32, shared: Shared, tell: mpsc::Sender<Recognized>, ready: mpsc::Sender<Result<(), String>>) {
    let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    match unsafe { open(&words, &shared) } {
        Err(err) => {
            let _ = ready.send(Err(err.message()));
        }
        Ok(session) => {
            let _ = ready.send(Ok(()));
            while !shared.0.lock().unwrap().closed {
                let _ = unsafe { session.context.WaitForNotifyEvent(200) };
                for (said, sure, end) in unsafe { heard(&session.context) } {
                    let Some(word) = words.iter().find(|word| word.trim().eq_ignore_ascii_case(said.trim())) else { continue };
                    let waiting = shared.0.lock().unwrap();
                    if sure < cutoff || end <= waiting.stale_until {
                        continue;
                    }
                    let after_ms = waiting.written.saturating_sub(end) / BYTES_PER_MS;
                    drop(waiting);
                    let _ = tell.send(Recognized { word: word.clone(), after_ms });
                }
            }
            drop(session);
        }
    }
    if com.is_ok() {
        unsafe { CoUninitialize() };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_words_in_english_letters_go_to_it() {
        assert!(spellable("Hey Meridian"));
        assert!(spellable("O'Neil"));
        assert!(!spellable("सुनो मीरा"));
        assert!(!spellable("Héllo"));
        assert!(!spellable("  "));
    }

    #[test]
    fn the_users_own_english_comes_first() {
        assert_eq!(preferred("en-IN")[0].0, "en-IN");
        assert_eq!(preferred("hi-IN")[0].0, "en-IN", "Hindi speakers get Indian English");
        assert_eq!(preferred("en-GB")[0].0, "en-GB");
        assert_eq!(preferred("fr-FR")[0].0, "en-US", "anyone else starts with US English");
        assert_eq!(preferred("").len(), ENGLISH.len());
        assert_eq!(preferred("en-IN").len(), ENGLISH.len(), "each once");
    }

    #[test]
    fn a_grammar_holds_exactly_the_words() {
        let xml = grammar(&["Hey Meridian".into(), "Meridian".into()], "en-IN");
        assert!(xml.contains(r#"xml:lang="en-IN""#));
        assert!(xml.contains("<item>hey meridian</item><item>meridian</item>"));
        assert!(!xml.contains("GARBAGE"), "a name inside a sentence it was not listening for is not a call");
    }

    #[test]
    fn how_easily_it_wakes_moves_the_cutoff() {
        assert!(cutoff("sure") > cutoff("balanced") && cutoff("balanced") > cutoff("easily"));
    }

    /// Speech made by Windows' own voices, so nobody has to speak: the name, alone and with a
    /// command, has to be heard, and sentences that only sound close must not be.
    #[test]
    #[ignore = "uses the speech engine and voices installed on this PC"]
    fn hears_the_name_in_speech_and_nothing_else() {
        let recognizer = Recognizer::start(&["Hey Meridian".to_string(), "Meridian".to_string()], cutoff("balanced")).unwrap().expect("an English recognizer");
        let voices = crate::windows_voice::voices();
        let indian: Vec<_> = voices.iter().filter(|voice| voice.note.contains("IN")).collect();
        assert!(!indian.is_empty(), "this test wants an Indian English voice: {voices:?}");
        let silence = vec![0u8; 32_000];
        let say = |text: &str, voice: &str| {
            let (rate, pcm) = crate::windows_voice::speak(Some(voice), text).unwrap();
            assert_eq!(rate, 16_000, "the voices here speak at 16 kHz");
            let mut found = Vec::new();
            for piece in [silence.as_slice(), &pcm, &silence, &silence].concat().chunks(3_200) {
                found.extend(recognizer.hear(piece));
                std::thread::sleep(Duration::from_millis(4));
            }
            found
        };
        for voice in &indian {
            let found = say("Hey Meridian", &voice.id);
            assert_eq!(found.first().map(|r| r.word.as_str()), Some("Hey Meridian"), "{}", voice.name);
            let found = say("Hey Meridian, open Chrome", &voice.id);
            let first = found.first().unwrap_or_else(|| panic!("{} said it with a command", voice.name));
            assert_eq!(first.word, "Hey Meridian");
            println!("{}: heard with {} ms said after it", voice.name, first.after_ms);
            assert!(first.after_ms < 4_000, "the command and the quiet after it are all there is");
            for sentence in ["Hey Mary, did you see the game last night", "Let me check the calendar for tomorrow", "Hey Maria, come here"] {
                assert!(say(sentence, &voice.id).is_empty(), "{} woke on: {sentence}", voice.name);
            }
        }
    }
}
