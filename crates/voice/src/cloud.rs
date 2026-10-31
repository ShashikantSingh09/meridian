//! Cloud voices and hearing. All four speaking services are asked for raw 16-bit audio at 24 kHz,
//! which is their common format and the fastest to start, so the words begin as they are made.

use std::time::Duration;

use futures_util::StreamExt;
use reqwest::{multipart, Client, RequestBuilder};
use serde_json::{json, Value};

use crate::{VoiceError, VoiceInfo};

pub const RATE: u32 = 24_000;
const TIMEOUT: Duration = Duration::from_secs(60);

fn client() -> Result<Client, VoiceError> {
    Ok(Client::builder().connect_timeout(Duration::from_secs(10)).build()?)
}

fn named(id: &str, name: &str, note: &str) -> VoiceInfo {
    VoiceInfo { id: id.to_string(), name: name.to_string(), note: note.to_string() }
}

/// Reads a service's own words out of a refusal, because "401" helps nobody.
fn refusal(status: reqwest::StatusCode, body: &str) -> VoiceError {
    let parsed: Value = serde_json::from_str(body).unwrap_or_default();
    let said = ["message", "detail", "error", "err_msg"].iter().find_map(|key| {
        let value = &parsed[*key];
        value.as_str().or(value["message"].as_str()).or(value[0]["msg"].as_str())
    });
    VoiceError::Service(match (status.as_u16(), said) {
        (401 | 403, _) => "The service did not accept this key.".to_string(),
        (402 | 429, _) => "The service says this account has run out, or is sending too much.".to_string(),
        (_, Some(said)) => said.to_string(),
        (code, None) => format!("The service answered with error {code}."),
    })
}

fn speak_request(http: &Client, provider: &str, key: &str, voice: &str, text: &str) -> Result<RequestBuilder, VoiceError> {
    Ok(match provider {
        "elevenlabs" => http
            .post(format!("https://api.elevenlabs.io/v1/text-to-speech/{voice}/stream?output_format=pcm_24000"))
            .header("xi-api-key", key)
            .json(&json!({ "text": text, "model_id": "eleven_flash_v2_5" })),
        "openai" => http
            .post("https://api.openai.com/v1/audio/speech")
            .bearer_auth(key)
            .json(&json!({ "model": "gpt-4o-mini-tts", "voice": voice, "input": text, "response_format": "pcm" })),
        "cartesia" => http
            .post("https://api.cartesia.ai/tts/bytes")
            .bearer_auth(key)
            .header("Cartesia-Version", "2026-08-14")
            .json(&json!({
                "model_id": "sonic-3.6",
                "transcript": text,
                "voice": { "id": voice },
                "output_format": { "container": "raw", "encoding": "pcm_s16le", "sample_rate": RATE },
            })),
        "deepgram" => http
            .post(format!("https://api.deepgram.com/v1/speak?model={voice}&encoding=linear16&container=none&sample_rate={RATE}"))
            .header("Authorization", format!("Token {key}"))
            .json(&json!({ "text": text })),
        other => return Err(VoiceError::Service(format!("{other} is not a voice service."))),
    })
}

/// Streams speech to `chunk`, always in whole samples. Returning false stops it, which is what
/// happens when the user talks over it.
pub async fn speak(provider: &str, key: &str, voice: &str, text: &str, mut chunk: impl FnMut(&[u8]) -> bool) -> Result<(), VoiceError> {
    let response = speak_request(&client()?, provider, key, voice, text)?.timeout(TIMEOUT).send().await?;
    let status = response.status();
    if !status.is_success() {
        return Err(refusal(status, &response.text().await.unwrap_or_default()));
    }
    let mut body = response.bytes_stream();
    // A network packet can end halfway through a sample.
    let mut spare: Option<u8> = None;
    while let Some(part) = body.next().await {
        let part = part?;
        let mut bytes: Vec<u8> = spare.take().into_iter().chain(part.iter().copied()).collect();
        if bytes.len() % 2 == 1 {
            spare = bytes.pop();
        }
        if !bytes.is_empty() && !chunk(&bytes) {
            break;
        }
    }
    Ok(())
}

/// The voices a service offers. Two list the account's own, and two have a fixed set.
pub async fn voices(provider: &str, key: &str) -> Result<Vec<VoiceInfo>, VoiceError> {
    let http = client()?;
    let read = |request: RequestBuilder| async move {
        let response = request.timeout(TIMEOUT).send().await?;
        let status = response.status();
        let text = response.text().await?;
        if !status.is_success() {
            return Err(refusal(status, &text));
        }
        serde_json::from_str::<Value>(&text).map_err(|_| VoiceError::Service("The service sent something unexpected.".into()))
    };
    Ok(match provider {
        "elevenlabs" => {
            let list = read(http.get("https://api.elevenlabs.io/v2/voices?page_size=100").header("xi-api-key", key)).await?;
            let found = list["voices"].as_array().cloned().unwrap_or_default();
            found.iter().filter_map(|v| Some(named(v["voice_id"].as_str()?, v["name"].as_str()?, v["category"].as_str().unwrap_or_default()))).collect()
        }
        "cartesia" => {
            let list = read(http.get("https://api.cartesia.ai/voices?limit=100").bearer_auth(key).header("Cartesia-Version", "2026-08-14")).await?;
            let found = list["data"].as_array().cloned().unwrap_or_default();
            found.iter().filter_map(|v| Some(named(v["id"].as_str()?, v["name"].as_str()?, v["language"].as_str().unwrap_or_default()))).collect()
        }
        "openai" => ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"]
            .iter()
            .map(|id| named(id, &format!("{}{}", id[..1].to_uppercase(), &id[1..]), ""))
            .collect(),
        "deepgram" => [("aura-2-thalia-en", "Thalia"), ("aura-2-andromeda-en", "Andromeda"), ("aura-2-helena-en", "Helena"), ("aura-2-apollo-en", "Apollo"), ("aura-2-arcas-en", "Arcas"), ("aura-2-aries-en", "Aries")]
            .iter()
            .map(|(id, name)| named(id, name, ""))
            .collect(),
        other => return Err(VoiceError::Service(format!("{other} is not a voice service."))),
    })
}

/// Writes down one finished turn. These services work on a whole recording, so with them the
/// words appear when you stop speaking rather than as you speak.
pub async fn transcribe(provider: &str, key: &str, wav: Vec<u8>) -> Result<String, VoiceError> {
    let http = client()?;
    let request = match provider {
        "elevenlabs" => {
            let file = multipart::Part::bytes(wav).file_name("speech.wav").mime_str("audio/wav")?;
            let form = multipart::Form::new().text("model_id", "scribe_v2").part("file", file);
            http.post("https://api.elevenlabs.io/v1/speech-to-text").header("xi-api-key", key).multipart(form)
        }
        "deepgram" => http
            .post("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true")
            .header("Authorization", format!("Token {key}"))
            .header("Content-Type", "audio/wav")
            .body(wav),
        other => return Err(VoiceError::Service(format!("{other} cannot hear."))),
    };
    let response = request.timeout(TIMEOUT).send().await?;
    let status = response.status();
    let text = response.text().await?;
    if !status.is_success() {
        return Err(refusal(status, &text));
    }
    let body: Value = serde_json::from_str(&text).unwrap_or_default();
    let words = if provider == "deepgram" { &body["results"]["channels"][0]["alternatives"][0]["transcript"] } else { &body["text"] };
    Ok(words.as_str().unwrap_or_default().trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::StatusCode;

    #[test]
    fn a_refusal_is_put_plainly() {
        let key = refusal(StatusCode::UNAUTHORIZED, r#"{"detail":{"message":"invalid api key"}}"#);
        assert_eq!(key.to_string(), "The service did not accept this key.");
        assert!(refusal(StatusCode::TOO_MANY_REQUESTS, "").to_string().contains("run out"));
        assert_eq!(refusal(StatusCode::BAD_REQUEST, r#"{"detail":{"message":"text too long"}}"#).to_string(), "text too long");
        assert_eq!(refusal(StatusCode::BAD_GATEWAY, "<html>").to_string(), "The service answered with error 502.");
    }

    #[tokio::test]
    async fn fixed_lists_need_no_network() {
        assert_eq!(voices("openai", "").await.unwrap()[0].name, "Marin");
        assert_eq!(voices("deepgram", "").await.unwrap()[0].id, "aura-2-thalia-en");
    }

    #[test]
    fn each_service_is_asked_for_the_same_audio() {
        let http = client().unwrap();
        for (provider, marker) in [("elevenlabs", "pcm_24000"), ("deepgram", "linear16")] {
            let request = speak_request(&http, provider, "k", "v", "hi").unwrap().build().unwrap();
            assert!(request.url().as_str().contains(marker), "{provider}");
        }
        assert!(speak_request(&http, "nobody", "k", "v", "hi").is_err());
    }
}
