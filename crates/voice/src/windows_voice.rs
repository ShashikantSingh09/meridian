//! The voices built into Windows. Plainer than the others, but they are already installed, need
//! no key and work offline, so there is always a voice.

use windows::core::{Interface, HSTRING};
use windows::Media::SpeechSynthesis::SpeechSynthesizer;
use windows::Storage::Streams::{DataReader, IInputStream};

use crate::{from_wav, VoiceError, VoiceInfo};

pub fn voices() -> Vec<VoiceInfo> {
    let Ok(all) = SpeechSynthesizer::AllVoices() else { return Vec::new() };
    all.into_iter()
        .filter_map(|voice| {
            let name = voice.DisplayName().ok()?.to_string();
            let short = name.trim_start_matches("Microsoft ").split(" - ").next().unwrap_or(&name).to_string();
            Some(VoiceInfo { id: voice.Id().ok()?.to_string(), name: short, note: voice.Language().map(|l| l.to_string()).unwrap_or_default() })
        })
        .collect()
}

/// Speaks `text`, and returns the sample rate and audio. Windows makes it all at once.
pub fn speak(voice: Option<&str>, text: &str) -> Result<(u32, Vec<u8>), VoiceError> {
    let synth = SpeechSynthesizer::new()?;
    if let Some(wanted) = voice {
        if let Some(found) = SpeechSynthesizer::AllVoices()?.into_iter().find(|v| v.Id().is_ok_and(|id| id == wanted)) {
            synth.SetVoice(&found)?;
        }
    }
    let stream = synth.SynthesizeTextToStreamAsync(&HSTRING::from(text))?.join()?;
    let size = stream.Size()? as u32;
    let input: IInputStream = stream.GetInputStreamAt(0)?.cast()?;
    let reader = DataReader::CreateDataReader(&input)?;
    reader.LoadAsync(size)?.join()?;
    let mut wav = vec![0u8; size as usize];
    reader.ReadBytes(&mut wav)?;
    from_wav(&wav).ok_or_else(|| VoiceError::Windows("Windows made audio this app cannot read.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "uses the voices installed on this PC"]
    fn speaks_for_real() {
        let found = voices();
        println!("{found:?}");
        assert!(!found.is_empty(), "Windows has at least one voice");
        let (rate, pcm) = speak(Some(&found[0].id), "Hello there.").unwrap();
        println!("rate {rate}, {} bytes", pcm.len());
        assert!(rate >= 8_000);
        assert!(pcm.len() > 10_000, "about a second of speech");
        let loudest = pcm.chunks_exact(2).map(|s| i16::from_le_bytes([s[0], s[1]]).unsigned_abs()).max().unwrap();
        assert!(loudest > 1_000, "real sound, not silence");
    }
}
