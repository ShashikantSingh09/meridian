//! Real speech through the real engine, with no microphone: a voice speaks, and hearing has to
//! write down what it said. Needs the packs unpacked in a folder, one per id:
//!
//!     set MERIDIAN_SPEECH_DIR=<folder>
//!     cargo test -p voice --test live_local -- --ignored --nocapture --test-threads=1

use std::path::PathBuf;
use std::time::Instant;

use voice::local::{Ears, Engine, Speaker, HEARING_RATE};
use voice::windows_voice;

const SENTENCE: &str = "The quick brown fox jumps over the lazy dog.";

fn pack(id: &str) -> PathBuf {
    PathBuf::from(std::env::var("MERIDIAN_SPEECH_DIR").expect("set MERIDIAN_SPEECH_DIR")).join(id)
}

fn loudest(pcm: &[u8]) -> u16 {
    pcm.chunks_exact(2).map(|s| i16::from_le_bytes([s[0], s[1]]).unsigned_abs()).max().unwrap_or(0)
}

/// Changes sample rate by nearest sample, which is plenty for a test sentence.
fn resample(pcm: &[u8], from: u32) -> Vec<u8> {
    let frames = pcm.len() / 2;
    let out = frames as u64 * HEARING_RATE as u64 / from as u64;
    (0..out).flat_map(|i| {
        let at = (i * from as u64 / HEARING_RATE as u64) as usize * 2;
        [pcm[at], pcm[at + 1]]
    }).collect()
}

fn hear(ears: &mut Ears, pcm: &[u8]) -> String {
    let mut partials = 0;
    for chunk in pcm.chunks(3200) {
        if !ears.accept(chunk).unwrap().is_empty() {
            partials += 1;
        }
    }
    let heard = ears.finish().unwrap().to_lowercase();
    println!("heard {heard:?}, words appeared on {partials} of {} chunks", pcm.len() / 3200);
    assert!(partials > 2, "words should appear while speech is still going");
    heard
}

fn ears() -> Ears {
    let started = Instant::now();
    let found = Ears::new(Engine::load(&pack("engine")).unwrap(), &pack("hearing")).unwrap();
    println!("hearing loaded in {:?}", started.elapsed());
    found
}

#[test]
#[ignore = "needs the downloaded speech packs"]
fn hearing_writes_down_a_windows_voice() {
    let (rate, pcm) = windows_voice::speak(None, SENTENCE).unwrap();
    let heard = hear(&mut ears(), &resample(&pcm, rate));
    for word in ["fox", "dog"] {
        assert!(heard.contains(word), "{heard}");
    }
}

#[test]
#[ignore = "needs the downloaded speech packs"]
fn hearing_starts_clean_on_the_next_turn() {
    let mut ears = ears();
    let (rate, pcm) = windows_voice::speak(None, SENTENCE).unwrap();
    let audio = resample(&pcm, rate);
    hear(&mut ears, &audio);
    let again = hear(&mut ears, &audio);
    assert_eq!(again.matches("fox").count(), 1, "{again}");
}

#[test]
#[ignore = "needs the downloaded speech packs"]
fn piper_speaks_and_can_be_understood() {
    let engine = Engine::load(&pack("engine")).unwrap();
    let started = Instant::now();
    let piper = Speaker::piper(engine, &pack("piper-amy")).unwrap();
    println!("piper loaded in {:?}", started.elapsed());
    let started = Instant::now();
    let (rate, pcm) = piper.say(SENTENCE, 0).unwrap();
    println!("piper said it in {:?}, {} s of audio at {rate}", started.elapsed(), pcm.len() as f32 / 2.0 / rate as f32);
    assert!(loudest(&pcm) > 1_000);
    assert!(hear(&mut ears(), &resample(&pcm, rate)).contains("fox"));
}

#[test]
#[ignore = "needs the downloaded speech packs"]
fn kokoro_speaks_fast_once_loaded() {
    let engine = Engine::load(&pack("engine")).unwrap();
    let started = Instant::now();
    let kokoro = Speaker::kokoro(engine, &pack("kokoro")).unwrap();
    println!("kokoro loaded in {:?}", started.elapsed());
    let started = Instant::now();
    let (rate, pcm) = kokoro.say(SENTENCE, 1).unwrap();
    let took = started.elapsed();
    let length = pcm.len() as f32 / 2.0 / rate as f32;
    println!("kokoro said it in {took:?}, {length} s of audio at {rate}");
    assert!(loudest(&pcm) > 1_000);
    assert!(hear(&mut ears(), &resample(&pcm, rate)).contains("fox"));
}
