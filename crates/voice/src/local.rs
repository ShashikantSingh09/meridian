//! Speech that runs on this PC, through the sherpa-onnx engine. It is loaded at run time because
//! it is a download, not part of the app, and it stays loaded so a reply never waits for it.
//!
//! The structs mirror `c-api.h` of the version pinned in `pack_list.rs`, field for field. They
//! must change together. Fields not set here stay zero, which the engine reads as "not used".

use std::ffi::{c_char, c_void, CStr, CString};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use libloading::os::windows::{Library as WinLibrary, LOAD_WITH_ALTERED_SEARCH_PATH};
use libloading::Library;

use crate::VoiceError;

type Text = *const c_char;
/// What hearing expects, and what the microphone is resampled to.
pub const HEARING_RATE: i32 = 16_000;

#[repr(C)]
struct VitsConfig { model: Text, lexicon: Text, tokens: Text, data_dir: Text, noise_scale: f32, noise_scale_w: f32, length_scale: f32, dict_dir: Text }
#[repr(C)]
struct MatchaConfig { acoustic_model: Text, vocoder: Text, lexicon: Text, tokens: Text, data_dir: Text, noise_scale: f32, length_scale: f32, dict_dir: Text }
#[repr(C)]
struct KokoroConfig { model: Text, voices: Text, tokens: Text, data_dir: Text, length_scale: f32, dict_dir: Text, lexicon: Text, lang: Text }
#[repr(C)]
struct KittenConfig { model: Text, voices: Text, tokens: Text, data_dir: Text, length_scale: f32, lexicon: Text }
#[repr(C)]
struct ZipvoiceConfig { tokens: Text, encoder: Text, decoder: Text, vocoder: Text, data_dir: Text, lexicon: Text, feat_scale: f32, t_shift: f32, target_rms: f32, guidance_scale: f32 }
#[repr(C)]
struct PocketConfig { lm_flow: Text, lm_main: Text, encoder: Text, decoder: Text, text_conditioner: Text, vocab_json: Text, token_scores_json: Text, voice_embedding_cache_capacity: i32 }
#[repr(C)]
struct SupertonicConfig { duration_predictor: Text, text_encoder: Text, vector_estimator: Text, vocoder: Text, tts_json: Text, unicode_indexer: Text, voice_style: Text }
#[repr(C)]
struct TtsModelConfig { vits: VitsConfig, num_threads: i32, debug: i32, provider: Text, matcha: MatchaConfig, kokoro: KokoroConfig, kitten: KittenConfig, zipvoice: ZipvoiceConfig, pocket: PocketConfig, supertonic: SupertonicConfig }
#[repr(C)]
struct TtsConfig { model: TtsModelConfig, rule_fsts: Text, max_num_sentences: i32, rule_fars: Text, silence_scale: f32 }
#[repr(C)]
struct GeneratedAudio { samples: *const f32, n: i32, sample_rate: i32 }

#[repr(C)]
struct TransducerConfig { encoder: Text, decoder: Text, joiner: Text }
#[repr(C)]
struct ParaformerConfig { encoder: Text, decoder: Text }
#[repr(C)]
struct OneModel { model: Text }
#[repr(C)]
struct OnlineModelConfig {
    transducer: TransducerConfig, paraformer: ParaformerConfig, zipformer2_ctc: OneModel, tokens: Text, num_threads: i32, provider: Text, debug: i32,
    model_type: Text, modeling_unit: Text, bpe_vocab: Text, tokens_buf: Text, tokens_buf_size: i32, nemo_ctc: OneModel, t_one_ctc: OneModel,
}
#[repr(C)]
struct FeatureConfig { sample_rate: i32, feature_dim: i32 }
#[repr(C)]
struct CtcFstConfig { graph: Text, max_active: i32 }
#[repr(C)]
struct HomophoneConfig { dict_dir: Text, lexicon: Text, rule_fsts: Text }
#[repr(C)]
struct RecognizerConfig {
    feat_config: FeatureConfig, model_config: OnlineModelConfig, decoding_method: Text, max_active_paths: i32, enable_endpoint: i32,
    rule1_min_trailing_silence: f32, rule2_min_trailing_silence: f32, rule3_min_utterance_length: f32, hotwords_file: Text, hotwords_score: f32,
    ctc_fst_decoder_config: CtcFstConfig, rule_fsts: Text, rule_fars: Text, blank_penalty: f32, hotwords_buf: Text, hotwords_buf_size: i32, hr: HomophoneConfig,
}
#[repr(C)]
struct RecognizerResult { text: Text, tokens: Text, tokens_arr: *const Text, timestamps: *mut f32, count: i32, json: Text }

/// Every file under a folder, so nothing depends on how an archive happens to be laid out.
fn files(folder: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(folder).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() { files(&path, out) } else { out.push(path) }
    }
}

fn find(folder: &Path, wanted: impl Fn(&str) -> bool) -> Option<PathBuf> {
    let mut all = Vec::new();
    files(folder, &mut all);
    all.sort();
    // The smaller, quantised model is as good for this and faster on a CPU.
    let name = |p: &PathBuf| p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let matching = || all.iter().filter(|p| wanted(&name(p)));
    matching().find(|p| name(p).contains("int8")).or_else(|| matching().next()).cloned()
}

fn text(path: &Path) -> Result<CString, VoiceError> {
    CString::new(path.to_string_lossy().as_bytes()).map_err(|_| VoiceError::Engine("A file path held an invalid character.".into()))
}

fn need(found: Option<PathBuf>, what: &str) -> Result<CString, VoiceError> {
    text(&found.ok_or_else(|| VoiceError::Engine(format!("The download is missing its {what}. Remove it and download it again.")))?)
}

/// `espeak-ng-data`, which turns spelling into sounds.
fn sounds(folder: &Path) -> Option<PathBuf> {
    find(folder, |name| name == "phontab").and_then(|file| file.parent().map(Path::to_path_buf))
}

pub struct Engine(Library);

// The library is only ever called through the types below, one call at a time.
unsafe impl Send for Engine {}
unsafe impl Sync for Engine {}

impl Engine {
    pub fn load(folder: &Path) -> Result<Arc<Self>, VoiceError> {
        let dll = find(folder, |name| name == "sherpa-onnx-c-api.dll").ok_or_else(|| VoiceError::Engine("The speech engine is missing a file.".into()))?;
        // This flag makes Windows look beside the DLL for what the DLL itself needs.
        let library = unsafe { WinLibrary::load_with_flags(&dll, LOAD_WITH_ALTERED_SEARCH_PATH) }.map_err(|err| VoiceError::Engine(format!("The speech engine would not load: {err}")))?;
        Ok(Arc::new(Self(library.into())))
    }

    fn get<T>(&self, name: &[u8]) -> Result<libloading::Symbol<'_, T>, VoiceError> {
        unsafe { self.0.get(name) }.map_err(|err| VoiceError::Engine(format!("The speech engine is the wrong version: {err}")))
    }
}

/// How many cores speech may use, leaving the rest of the PC responsive.
fn threads() -> i32 {
    std::thread::available_parallelism().map_or(2, |n| (n.get() as i32 / 2).clamp(1, 4))
}

/// A voice, loaded and ready.
pub struct Speaker {
    engine: Arc<Engine>,
    tts: *const c_void,
}

unsafe impl Send for Speaker {}

impl Speaker {
    fn create(engine: Arc<Engine>, config: &TtsConfig) -> Result<Self, VoiceError> {
        let create = engine.get::<unsafe extern "C" fn(*const TtsConfig) -> *const c_void>(b"SherpaOnnxCreateOfflineTts\0")?;
        let tts = unsafe { create(config) };
        if tts.is_null() {
            return Err(VoiceError::Engine("The voice would not load. Remove it and download it again.".into()));
        }
        drop(create);
        Ok(Self { engine, tts })
    }

    pub fn kokoro(engine: Arc<Engine>, folder: &Path) -> Result<Self, VoiceError> {
        let model = need(find(folder, |n| n == "model.onnx"), "model")?;
        let voices = need(find(folder, |n| n == "voices.bin"), "voices")?;
        let tokens = need(find(folder, |n| n == "tokens.txt"), "tokens")?;
        let data = need(sounds(folder), "sound data")?;
        let provider = CString::new("cpu").unwrap();
        let mut config: TtsConfig = unsafe { std::mem::zeroed() };
        config.model.kokoro.model = model.as_ptr();
        config.model.kokoro.voices = voices.as_ptr();
        config.model.kokoro.tokens = tokens.as_ptr();
        config.model.kokoro.data_dir = data.as_ptr();
        config.model.kokoro.length_scale = 1.0;
        config.model.num_threads = threads();
        config.model.provider = provider.as_ptr();
        config.max_num_sentences = 1;
        Self::create(engine, &config)
    }

    pub fn piper(engine: Arc<Engine>, folder: &Path) -> Result<Self, VoiceError> {
        let model = need(find(folder, |n| n.ends_with(".onnx")), "model")?;
        let tokens = need(find(folder, |n| n == "tokens.txt"), "tokens")?;
        let data = need(sounds(folder), "sound data")?;
        let provider = CString::new("cpu").unwrap();
        let mut config: TtsConfig = unsafe { std::mem::zeroed() };
        config.model.vits.model = model.as_ptr();
        config.model.vits.tokens = tokens.as_ptr();
        config.model.vits.data_dir = data.as_ptr();
        config.model.vits.noise_scale = 0.667;
        config.model.vits.noise_scale_w = 0.8;
        config.model.vits.length_scale = 1.0;
        config.model.num_threads = threads();
        config.model.provider = provider.as_ptr();
        config.max_num_sentences = 1;
        Self::create(engine, &config)
    }

    /// One sentence, as a sample rate and 16-bit audio.
    pub fn say(&self, words: &str, speaker: i32) -> Result<(u32, Vec<u8>), VoiceError> {
        let words = CString::new(words.replace('\0', " ")).map_err(|_| VoiceError::Engine("That text could not be read.".into()))?;
        let generate = self.engine.get::<unsafe extern "C" fn(*const c_void, Text, i32, f32) -> *const GeneratedAudio>(b"SherpaOnnxOfflineTtsGenerate\0")?;
        let free = self.engine.get::<unsafe extern "C" fn(*const GeneratedAudio)>(b"SherpaOnnxDestroyOfflineTtsGeneratedAudio\0")?;
        let audio = unsafe { generate(self.tts, words.as_ptr(), speaker, 1.0) };
        if audio.is_null() {
            return Err(VoiceError::Engine("The voice could not say that.".into()));
        }
        let (rate, pcm) = unsafe {
            let made = &*audio;
            let samples = std::slice::from_raw_parts(made.samples, made.n.max(0) as usize);
            (made.sample_rate as u32, samples.iter().flat_map(|s| ((s.clamp(-1.0, 1.0) * 32_767.0) as i16).to_le_bytes()).collect())
        };
        unsafe { free(audio) };
        Ok((rate, pcm))
    }
}

impl Drop for Speaker {
    fn drop(&mut self) {
        if let Ok(destroy) = self.engine.get::<unsafe extern "C" fn(*const c_void)>(b"SherpaOnnxDestroyOfflineTts\0") {
            unsafe { destroy(self.tts) };
        }
    }
}

/// Hearing, which writes words down while they are being said.
pub struct Ears {
    engine: Arc<Engine>,
    recognizer: *const c_void,
    stream: *const c_void,
}

unsafe impl Send for Ears {}

impl Ears {
    pub fn new(engine: Arc<Engine>, folder: &Path) -> Result<Self, VoiceError> {
        let encoder = need(find(folder, |n| n.contains("encoder") && n.ends_with(".onnx")), "encoder")?;
        let decoder = need(find(folder, |n| n.contains("decoder") && n.ends_with(".onnx")), "decoder")?;
        let joiner = need(find(folder, |n| n.contains("joiner") && n.ends_with(".onnx")), "joiner")?;
        let tokens = need(find(folder, |n| n == "tokens.txt"), "tokens")?;
        let (provider, method) = (CString::new("cpu").unwrap(), CString::new("greedy_search").unwrap());
        let mut config: RecognizerConfig = unsafe { std::mem::zeroed() };
        config.feat_config = FeatureConfig { sample_rate: HEARING_RATE, feature_dim: 80 };
        config.model_config.transducer = TransducerConfig { encoder: encoder.as_ptr(), decoder: decoder.as_ptr(), joiner: joiner.as_ptr() };
        config.model_config.tokens = tokens.as_ptr();
        config.model_config.num_threads = threads();
        config.model_config.provider = provider.as_ptr();
        config.decoding_method = method.as_ptr();
        config.max_active_paths = 4;

        let create = engine.get::<unsafe extern "C" fn(*const RecognizerConfig) -> *const c_void>(b"SherpaOnnxCreateOnlineRecognizer\0")?;
        let recognizer = unsafe { create(&config) };
        if recognizer.is_null() {
            return Err(VoiceError::Engine("Hearing would not load. Remove it and download it again.".into()));
        }
        drop(create);
        let open = engine.get::<unsafe extern "C" fn(*const c_void) -> *const c_void>(b"SherpaOnnxCreateOnlineStream\0")?;
        let stream = unsafe { open(recognizer) };
        drop(open);
        Ok(Self { engine, recognizer, stream })
    }

    fn decode(&self) -> Result<String, VoiceError> {
        let ready = self.engine.get::<unsafe extern "C" fn(*const c_void, *const c_void) -> i32>(b"SherpaOnnxIsOnlineStreamReady\0")?;
        let decode = self.engine.get::<unsafe extern "C" fn(*const c_void, *const c_void)>(b"SherpaOnnxDecodeOnlineStream\0")?;
        let result = self.engine.get::<unsafe extern "C" fn(*const c_void, *const c_void) -> *const RecognizerResult>(b"SherpaOnnxGetOnlineStreamResult\0")?;
        let free = self.engine.get::<unsafe extern "C" fn(*const RecognizerResult)>(b"SherpaOnnxDestroyOnlineRecognizerResult\0")?;
        unsafe {
            while ready(self.recognizer, self.stream) != 0 {
                decode(self.recognizer, self.stream);
            }
            let found = result(self.recognizer, self.stream);
            if found.is_null() {
                return Ok(String::new());
            }
            let words = CStr::from_ptr((*found).text).to_string_lossy().trim().to_string();
            free(found);
            Ok(words)
        }
    }

    /// Takes more 16-bit audio at 16 kHz, and returns everything heard so far this turn.
    pub fn accept(&mut self, pcm: &[u8]) -> Result<String, VoiceError> {
        let samples: Vec<f32> = pcm.chunks_exact(2).map(|s| i16::from_le_bytes([s[0], s[1]]) as f32 / 32_768.0).collect();
        let accept = self.engine.get::<unsafe extern "C" fn(*const c_void, i32, *const f32, i32)>(b"SherpaOnnxOnlineStreamAcceptWaveform\0")?;
        unsafe { accept(self.stream, HEARING_RATE, samples.as_ptr(), samples.len() as i32) };
        drop(accept);
        self.decode()
    }

    /// Ends the turn, and returns its final words.
    pub fn finish(&mut self) -> Result<String, VoiceError> {
        // The model looks ahead, so the last word needs a moment of silence after it.
        let quiet = vec![0f32; HEARING_RATE as usize / 2];
        let accept = self.engine.get::<unsafe extern "C" fn(*const c_void, i32, *const f32, i32)>(b"SherpaOnnxOnlineStreamAcceptWaveform\0")?;
        unsafe { accept(self.stream, HEARING_RATE, quiet.as_ptr(), quiet.len() as i32) };
        drop(accept);
        let finished = self.engine.get::<unsafe extern "C" fn(*const c_void)>(b"SherpaOnnxOnlineStreamInputFinished\0")?;
        unsafe { finished(self.stream) };
        drop(finished);
        let words = self.decode()?;
        self.restart()?;
        Ok(words)
    }

    /// Drops whatever was heard and starts a new turn.
    pub fn restart(&mut self) -> Result<(), VoiceError> {
        let close = self.engine.get::<unsafe extern "C" fn(*const c_void)>(b"SherpaOnnxDestroyOnlineStream\0")?;
        let open = self.engine.get::<unsafe extern "C" fn(*const c_void) -> *const c_void>(b"SherpaOnnxCreateOnlineStream\0")?;
        unsafe {
            close(self.stream);
            self.stream = open(self.recognizer);
        }
        Ok(())
    }
}

impl Drop for Ears {
    fn drop(&mut self) {
        unsafe {
            if let Ok(close) = self.engine.get::<unsafe extern "C" fn(*const c_void)>(b"SherpaOnnxDestroyOnlineStream\0") {
                close(self.stream);
            }
            if let Ok(destroy) = self.engine.get::<unsafe extern "C" fn(*const c_void)>(b"SherpaOnnxDestroyOnlineRecognizer\0") {
                destroy(self.recognizer);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quantised_model_is_preferred() {
        let dir = std::env::temp_dir().join(format!("meridian-find-{}", std::process::id()));
        let inner = dir.join("nested");
        fs::create_dir_all(&inner).unwrap();
        for name in ["encoder-epoch-99.onnx", "encoder-epoch-99.int8.onnx", "tokens.txt"] {
            fs::write(inner.join(name), "").unwrap();
        }
        let found = find(&dir, |n| n.contains("encoder") && n.ends_with(".onnx")).unwrap();
        assert!(found.to_string_lossy().contains("int8"));
        assert!(find(&dir, |n| n == "tokens.txt").is_some());
        assert!(find(&dir, |n| n == "missing").is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
