//! Speaking and hearing. Every voice ends up as the same thing, 16-bit mono audio at a stated
//! sample rate, so one player can stream any of them and stop dead when interrupted.
//!
//! Three kinds of voice sit behind that: cloud services, which need the user's key; the voices
//! built into Windows, which need nothing; and models that run on this PC, downloaded only when
//! asked for, with an engine that stays loaded so a reply does not wait for it.

pub mod cloud;
pub mod local;
pub mod packs;
pub mod windows_voice;

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum VoiceError {
    #[error("{0}")]
    Service(String),
    #[error("Could not reach the voice service: {0}")]
    Network(#[from] reqwest::Error),
    #[error("Could not save the download: {0}")]
    Disk(#[from] std::io::Error),
    #[error("{0}")]
    Windows(String),
    #[error("{0}")]
    Engine(String),
}

impl From<windows::core::Error> for VoiceError {
    fn from(err: windows::core::Error) -> Self {
        Self::Windows(err.message())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VoiceInfo {
    pub id: String,
    pub name: String,
    pub note: String,
}

/// Turns the bytes of a WAV file into its sample rate and 16-bit mono audio.
pub fn from_wav(bytes: &[u8]) -> Option<(u32, Vec<u8>)> {
    let u16_at = |at: usize| bytes.get(at..at + 2).map(|b| u16::from_le_bytes([b[0], b[1]]));
    let u32_at = |at: usize| bytes.get(at..at + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    if bytes.get(..4)? != b"RIFF" || bytes.get(8..12)? != b"WAVE" {
        return None;
    }
    let (mut at, mut format) = (12, None);
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32_at(at + 4)? as usize;
        let body = at + 8;
        if id == b"fmt " {
            format = Some((u16_at(body + 2)? as usize, u32_at(body + 4)?, u16_at(body + 14)?));
        } else if id == b"data" {
            let (channels, rate, bits) = format?;
            if bits != 16 || channels == 0 {
                return None;
            }
            let data = bytes.get(body..(body + size).min(bytes.len()))?;
            // A stereo voice keeps its left channel. Speech is the same on both.
            let mono = data.chunks_exact(2 * channels).flat_map(|frame| [frame[0], frame[1]]).collect();
            return Some((rate, mono));
        }
        at = body + size + (size & 1);
    }
    None
}

/// Wraps 16 kHz mono audio as a WAV file, which is what the hearing services take.
pub fn to_wav(pcm: &[u8], rate: u32) -> Vec<u8> {
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&rate.to_le_bytes());
    wav.extend_from_slice(&(rate * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wav_goes_there_and_back() {
        let pcm = [1u8, 2, 3, 4, 5, 6];
        assert_eq!(from_wav(&to_wav(&pcm, 16_000)), Some((16_000, pcm.to_vec())));
    }

    #[test]
    fn stereo_keeps_one_channel() {
        let mut wav = to_wav(&[1, 2, 9, 9, 3, 4, 9, 9], 22_050);
        wav[22] = 2;
        assert_eq!(from_wav(&wav), Some((22_050, vec![1, 2, 3, 4])));
    }

    #[test]
    fn anything_else_is_refused() {
        assert_eq!(from_wav(b"not a wav file at all"), None);
        assert_eq!(from_wav(&[]), None);
    }
}
