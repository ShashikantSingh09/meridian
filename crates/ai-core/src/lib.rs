//! Provider-agnostic AI client. Nothing here knows about Tauri or the UI: a
//! provider is a catalog entry plus an implementation of [`Provider`], and every
//! entry declares what it can actually do so the UI never offers the rest.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

mod anthropic;
mod catalog;
mod discovery;
mod openai;
mod sse;
#[cfg(test)]
mod test_server;

pub use catalog::{catalog, find, Kind, ProviderDef, Protocol};
pub use discovery::{discover, LocalServer};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub streaming: bool,
    pub tools: bool,
    pub vision: bool,
    pub model_discovery: bool,
    pub usage: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<Message>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ChatEvent {
    Delta { text: String },
    Usage { input: u64, output: u64 },
    Done,
    Error { kind: ErrorKind, message: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    Auth,
    RateLimit,
    Unavailable,
    BadRequest,
    Network,
    Cancelled,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct ProviderError {
    pub kind: ErrorKind,
    pub message: String,
}

impl ProviderError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }

    pub fn cancelled() -> Self {
        Self::new(ErrorKind::Cancelled, "Cancelled")
    }

    /// A failed response, classified by status so the UI can offer the right
    /// recovery. Only the provider's own message is kept, never request headers.
    pub(crate) fn from_status(status: u16, body: &str) -> Self {
        let kind = match status {
            401 | 403 => ErrorKind::Auth,
            429 => ErrorKind::RateLimit,
            400 | 404 | 413 | 422 => ErrorKind::BadRequest,
            500..=599 => ErrorKind::Unavailable,
            _ => ErrorKind::Other,
        };
        Self::new(kind, format!("HTTP {status}: {}", error_text(body)))
    }

    /// reqwest's own text ("error sending request") explains nothing, and its
    /// URL could carry a token from a custom endpoint, so neither is shown.
    pub(crate) fn from_reqwest(err: reqwest::Error) -> Self {
        if err.is_connect() {
            Self::new(ErrorKind::Unavailable, "Could not connect. Is the server running?")
        } else if err.is_timeout() {
            Self::new(ErrorKind::Network, "The request timed out.")
        } else {
            Self::new(ErrorKind::Network, "The connection failed.")
        }
    }
}

/// Pulls a readable message out of the JSON error bodies providers return.
fn error_text(body: &str) -> String {
    let parsed: Option<serde_json::Value> = serde_json::from_str(body).ok();
    let text = parsed
        .as_ref()
        .and_then(|v| v["error"]["message"].as_str().or(v["error"].as_str()).or(v["message"].as_str()))
        .unwrap_or(body);
    text.chars().take(300).collect()
}

pub type Sink<'a> = dyn FnMut(ChatEvent) + Send + 'a;

#[async_trait]
pub trait Provider: Send + Sync {
    async fn models(&self) -> Result<Vec<ModelInfo>, ProviderError>;

    /// Streams one reply into `sink`. Emits deltas and usage only: `Done` and
    /// `Error` are the caller's to send, see [`run_chat`].
    async fn stream(
        &self,
        request: &ChatRequest,
        sink: &mut Sink<'_>,
        cancel: &CancellationToken,
    ) -> Result<(), ProviderError>;
}

/// Connection details for one provider, resolved from settings and the keystore.
#[derive(Debug, Clone)]
pub struct Endpoint {
    pub base_url: String,
    pub api_key: Option<String>,
}

pub fn client(protocol: Protocol, endpoint: Endpoint) -> Result<Box<dyn Provider>, ProviderError> {
    let http = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(ProviderError::from_reqwest)?;
    Ok(match protocol {
        Protocol::OpenAi => Box::new(openai::OpenAi::new(http, endpoint)),
        Protocol::Anthropic => Box::new(anthropic::Anthropic::new(http, endpoint)),
    })
}

/// Runs a chat to its end. Whatever happens, `sink` sees exactly one terminal
/// event, so a provider failure can never leave the UI waiting.
pub async fn run_chat(provider: &dyn Provider, request: &ChatRequest, sink: &mut Sink<'_>, cancel: &CancellationToken) {
    match provider.stream(request, sink, cancel).await {
        Ok(()) => sink(ChatEvent::Done),
        Err(err) => sink(ChatEvent::Error { kind: err.kind, message: err.message }),
    }
}

/// Health check: listing models proves address, reachability and credentials.
pub async fn test_connection(provider: &dyn Provider) -> Result<String, ProviderError> {
    let models = provider.models().await?;
    Ok(match models.len() {
        1 => "Connected. 1 model available.".to_string(),
        n => format!("Connected. {n} models available."),
    })
}

/// Whether an address stays on this machine. Local-only mode decides from the
/// address itself, so a custom endpoint cannot slip past on its label.
pub fn is_loopback(base_url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base_url) else { return false };
    let Some(host) = url.host_str() else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => ip.is_loopback(),
        Err(_) => host == "localhost" || host.ends_with(".localhost"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_status_codes() {
        assert_eq!(ProviderError::from_status(401, "").kind, ErrorKind::Auth);
        assert_eq!(ProviderError::from_status(429, "").kind, ErrorKind::RateLimit);
        assert_eq!(ProviderError::from_status(404, "").kind, ErrorKind::BadRequest);
        assert_eq!(ProviderError::from_status(529, "").kind, ErrorKind::Unavailable);
    }

    #[test]
    fn extracts_provider_error_messages() {
        let openai = r#"{"error":{"message":"bad key","type":"auth"}}"#;
        let anthropic = r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#;
        let ollama = r#"{"error":"model not found"}"#;
        assert!(ProviderError::from_status(401, openai).message.ends_with("bad key"));
        assert!(ProviderError::from_status(529, anthropic).message.ends_with("Overloaded"));
        assert!(ProviderError::from_status(404, ollama).message.ends_with("model not found"));
    }

    #[test]
    fn keeps_html_error_pages_short() {
        let page = "x".repeat(10_000);
        assert!(ProviderError::from_status(502, &page).message.len() < 320);
    }

    #[test]
    fn recognises_loopback_addresses() {
        for local in ["http://localhost:1234/v1", "http://127.0.0.1:8080", "http://[::1]:11434", "http://foo.localhost"] {
            assert!(is_loopback(local), "{local}");
        }
        for remote in ["https://api.openai.com/v1", "http://192.168.1.4:1234", "http://localhost.evil.com", "nonsense"] {
            assert!(!is_loopback(remote), "{remote}");
        }
    }
}
