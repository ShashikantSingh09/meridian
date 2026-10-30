//! Anthropic's Messages API over raw HTTP: there is no official Rust SDK.

use async_trait::async_trait;
use reqwest::{Client, RequestBuilder};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::sse::read_events;
use crate::{ChatEvent, ChatRequest, Endpoint, ErrorKind, ModelInfo, Provider, ProviderError, Role, Sink};

// This version rejects temperature, top_p and top_k. None are ever sent.
const API_VERSION: &str = "2026-10-21";
const MAX_TOKENS: u32 = 64_000;

pub struct Anthropic {
    http: Client,
    endpoint: Endpoint,
}

impl Anthropic {
    pub fn new(http: Client, endpoint: Endpoint) -> Self {
        Self { http, endpoint }
    }

    fn url(&self, path: &str) -> String {
        format!("{}/v1/{path}", self.endpoint.base_url.trim_end_matches('/'))
    }

    fn authorized(&self, request: RequestBuilder) -> Result<RequestBuilder, ProviderError> {
        let key = self
            .endpoint
            .api_key
            .as_deref()
            .ok_or_else(|| ProviderError::new(ErrorKind::Auth, "No API key saved for Anthropic."))?;
        Ok(request.header("x-api-key", key).header("anthropic-version", API_VERSION))
    }
}

fn body(request: &ChatRequest) -> Value {
    let system: Vec<&str> = request
        .messages
        .iter()
        .filter(|m| m.role == Role::System)
        .map(|m| m.content.as_str())
        .collect();
    let messages: Vec<_> = request.messages.iter().filter(|m| m.role != Role::System).collect();
    let mut body = json!({
        "model": request.model,
        "max_tokens": MAX_TOKENS,
        "stream": true,
        "messages": messages,
    });
    if !system.is_empty() {
        body["system"] = json!(system.join("\n\n"));
    }
    body
}

fn stream_error(error: &Value) -> ProviderError {
    let kind = match error["type"].as_str() {
        Some("authentication_error" | "permission_error") => ErrorKind::Auth,
        Some("rate_limit_error") => ErrorKind::RateLimit,
        Some("overloaded_error" | "api_error" | "timeout_error") => ErrorKind::Unavailable,
        Some("invalid_request_error" | "not_found_error" | "request_too_large") => ErrorKind::BadRequest,
        _ => ErrorKind::Other,
    };
    ProviderError::new(kind, error["message"].as_str().unwrap_or("Anthropic reported an error."))
}

#[async_trait]
impl Provider for Anthropic {
    async fn models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        let response = self
            .authorized(self.http.get(self.url("models")).query(&[("limit", "1000")]))?
            .send()
            .await
            .map_err(ProviderError::from_reqwest)?;
        let status = response.status();
        let body = response.text().await.map_err(ProviderError::from_reqwest)?;
        if !status.is_success() {
            return Err(ProviderError::from_status(status.as_u16(), &body));
        }
        let value: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        Ok(value["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| {
                let id = m["id"].as_str()?;
                let label = m["display_name"].as_str().unwrap_or(id);
                Some(ModelInfo { id: id.to_string(), label: label.to_string() })
            })
            .collect())
    }

    async fn stream(
        &self,
        request: &ChatRequest,
        sink: &mut Sink<'_>,
        cancel: &CancellationToken,
    ) -> Result<(), ProviderError> {
        let response = self
            .authorized(self.http.post(self.url("messages")))?
            .json(&body(request))
            .send()
            .await
            .map_err(ProviderError::from_reqwest)?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(ProviderError::from_status(status.as_u16(), &text));
        }

        let mut input = 0;
        read_events(response, cancel, |data| {
            let Ok(event) = serde_json::from_str::<Value>(data) else { return Ok(true) };
            match event["type"].as_str() {
                Some("message_start") => {
                    let usage = &event["message"]["usage"];
                    input = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
                        .iter()
                        .filter_map(|k| usage[*k].as_u64())
                        .sum();
                }
                Some("content_block_delta") if event["delta"]["type"] == "text_delta" => {
                    if let Some(text) = event["delta"]["text"].as_str() {
                        sink(ChatEvent::Delta { text: text.to_string() });
                    }
                }
                Some("message_delta") => {
                    if let Some(output) = event["usage"]["output_tokens"].as_u64() {
                        sink(ChatEvent::Usage { input, output });
                    }
                    if event["delta"]["stop_reason"] == "refusal" {
                        return Err(ProviderError::new(ErrorKind::Other, "Claude declined this request."));
                    }
                }
                Some("message_stop") => return Ok(false),
                Some("error") => return Err(stream_error(&event["error"])),
                _ => {}
            }
            Ok(true)
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_server::{serve, Canned};
    use crate::{run_chat, Message, Protocol};

    fn message(role: Role, content: &str) -> Message {
        Message { role, content: content.into() }
    }

    fn request() -> ChatRequest {
        ChatRequest {
            model: "claude-opus-5-5".into(),
            messages: vec![message(Role::System, "Be brief."), message(Role::User, "hi")],
        }
    }

    async fn collect(base_url: String, api_key: Option<&str>) -> Vec<ChatEvent> {
        let endpoint = Endpoint { base_url, api_key: api_key.map(String::from) };
        let provider = crate::client(Protocol::Anthropic, endpoint).unwrap();
        let mut events = Vec::new();
        run_chat(provider.as_ref(), &request(), &mut |e| events.push(e), &CancellationToken::new()).await;
        events
    }

    #[test]
    fn moves_system_messages_to_the_top_level_and_sends_no_sampling() {
        let body = body(&request());
        assert_eq!(body["system"], "Be brief.");
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert_eq!(body["messages"][0]["role"], "user");
        for removed in ["temperature", "top_p", "top_k"] {
            assert!(body.get(removed).is_none());
        }
    }

    #[tokio::test]
    async fn streams_text_ignoring_thinking_and_reports_usage() {
        let (url, seen) = serve(vec![Canned::sse(&[
            r#"data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":5,"output_tokens":1}}}"#,
            r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"secret"}}"#,
            r#"data: {"type":"ping"}"#,
            r#"data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello"}}"#,
            r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}"#,
            r#"data: {"type":"message_stop"}"#,
        ])])
        .await;
        let events = collect(url, Some("sk")).await;
        assert_eq!(
            events,
            [ChatEvent::Delta { text: "Hello".into() }, ChatEvent::Usage { input: 15, output: 7 }, ChatEvent::Done]
        );
        let sent = seen.lock().unwrap()[0].to_ascii_lowercase();
        assert!(sent.contains("post /v1/messages"));
        assert!(sent.contains("x-api-key: sk"));
        assert!(sent.contains("anthropic-version: 2026-10-21"));
    }

    #[tokio::test]
    async fn turns_a_refusal_into_a_visible_error() {
        let (url, _) = serve(vec![Canned::sse(&[
            r#"data: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":0}}"#,
        ])])
        .await;
        let events = collect(url, Some("sk")).await;
        assert!(matches!(events.last(), Some(ChatEvent::Error { .. })));
    }

    #[tokio::test]
    async fn classifies_an_overload_sent_mid_stream() {
        let (url, _) = serve(vec![Canned::sse(&[
            r#"data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
        ])])
        .await;
        let events = collect(url, Some("sk")).await;
        assert!(matches!(&events[..], [ChatEvent::Error { kind: ErrorKind::Unavailable, .. }]));
    }

    #[tokio::test]
    async fn refuses_to_call_without_a_key() {
        let events = collect("http://127.0.0.1:9".into(), None).await;
        assert!(matches!(&events[..], [ChatEvent::Error { kind: ErrorKind::Auth, .. }]));
    }

    #[tokio::test]
    async fn lists_models_with_display_names() {
        let (url, _) = serve(vec![Canned::json(
            r#"{"data":[{"type":"model","id":"claude-opus-5-5","display_name":"Claude Opus 5.5"}],"has_more":false}"#,
        )])
        .await;
        let provider = crate::client(Protocol::Anthropic, Endpoint { base_url: url, api_key: Some("sk".into()) }).unwrap();
        assert_eq!(
            provider.models().await.unwrap(),
            [ModelInfo { id: "claude-opus-5-5".into(), label: "Claude Opus 5.5".into() }]
        );
    }
}
