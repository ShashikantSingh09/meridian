//! OpenAI-style chat completions: OpenAI itself and every compatible server,
//! cloud or local.

use async_trait::async_trait;
use reqwest::{Client, RequestBuilder, Response};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::sse::read_events;
use crate::{ChatEvent, ChatRequest, Endpoint, ErrorKind, Message, ModelInfo, Provider, ProviderError, Sink};

/// Listed by `/models` but unable to chat.
const NOT_CHAT: &[&str] = &["embed", "whisper", "tts", "dall-e", "moderation", "transcribe", "sora", "image"];

fn wire_message(message: &Message) -> Value {
    if message.images.is_empty() {
        return json!({ "role": message.role, "content": message.content });
    }
    let mut content = vec![json!({ "type": "text", "text": message.content })];
    content.extend(message.images.iter().map(|url| json!({ "type": "image_url", "image_url": { "url": url } })));
    json!({ "role": message.role, "content": content })
}

pub struct OpenAi {
    http: Client,
    endpoint: Endpoint,
}

impl OpenAi {
    pub fn new(http: Client, endpoint: Endpoint) -> Self {
        Self { http, endpoint }
    }

    fn url(&self, path: &str) -> String {
        format!("{}/{path}", self.endpoint.base_url.trim_end_matches('/'))
    }

    fn authorized(&self, request: RequestBuilder) -> RequestBuilder {
        match &self.endpoint.api_key {
            Some(key) => request.bearer_auth(key),
            None => request,
        }
    }

    async fn post(&self, request: &ChatRequest, usage: bool) -> Result<Response, ProviderError> {
        let messages: Vec<Value> = request.messages.iter().map(wire_message).collect();
        let mut body = json!({ "model": request.model, "messages": messages, "stream": true });
        if usage {
            body["stream_options"] = json!({ "include_usage": true });
        }
        self.authorized(self.http.post(self.url("chat/completions")))
            .json(&body)
            .send()
            .await
            .map_err(ProviderError::from_reqwest)
    }
}

#[async_trait]
impl Provider for OpenAi {
    async fn models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        let response = self
            .authorized(self.http.get(self.url("models")))
            .send()
            .await
            .map_err(ProviderError::from_reqwest)?;
        let status = response.status();
        let body = response.text().await.map_err(ProviderError::from_reqwest)?;
        if !status.is_success() {
            return Err(ProviderError::from_status(status.as_u16(), &body));
        }
        let value: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        // Any web server answers 200. Only a model list proves this is a model server.
        let listed = value["data"]
            .as_array()
            .ok_or_else(|| ProviderError::new(ErrorKind::BadRequest, "This endpoint did not return a model list."))?;
        let mut models: Vec<ModelInfo> = listed
            .iter()
            .filter_map(|m| m["id"].as_str())
            .filter(|id| !NOT_CHAT.iter().any(|skip| id.to_ascii_lowercase().contains(skip)))
            .map(|id| ModelInfo { id: id.to_string(), label: id.to_string() })
            .collect();
        models.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(models)
    }

    async fn stream(
        &self,
        request: &ChatRequest,
        sink: &mut Sink<'_>,
        cancel: &CancellationToken,
    ) -> Result<(), ProviderError> {
        let mut response = self.post(request, true).await?;
        let mut status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            // Strict servers refuse the usage option by name; the chat itself is fine.
            if !(status.is_client_error() && body.contains("stream_options")) {
                return Err(ProviderError::from_status(status.as_u16(), &body));
            }
            response = self.post(request, false).await?;
            status = response.status();
            if !status.is_success() {
                let body = response.text().await.unwrap_or_default();
                return Err(ProviderError::from_status(status.as_u16(), &body));
            }
        }

        read_events(response, cancel, |data| {
            if data == "[DONE]" {
                return Ok(false);
            }
            let Ok(event) = serde_json::from_str::<Value>(data) else { return Ok(true) };
            if !event["error"].is_null() {
                return Err(ProviderError::from_status(500, data));
            }
            if let Some(text) = event["choices"][0]["delta"]["content"].as_str() {
                if !text.is_empty() {
                    sink(ChatEvent::Delta { text: text.to_string() });
                }
            }
            let usage = &event["usage"];
            if let (Some(input), Some(output)) = (usage["prompt_tokens"].as_u64(), usage["completion_tokens"].as_u64()) {
                sink(ChatEvent::Usage { input, output });
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
    use crate::{run_chat, Protocol, Role};

    fn request() -> ChatRequest {
        ChatRequest { model: "m".into(), messages: vec![Message { role: Role::User, content: "hi".into(), images: vec![] }] }
    }

    async fn collect(base_url: String, cancel: CancellationToken) -> Vec<ChatEvent> {
        let provider = crate::client(Protocol::OpenAi, Endpoint { base_url, api_key: Some("secret".into()) }).unwrap();
        let mut events = Vec::new();
        run_chat(provider.as_ref(), &request(), &mut |e| events.push(e), &cancel).await;
        events
    }

    #[test]
    fn images_become_content_parts_and_plain_text_stays_plain() {
        let plain = wire_message(&Message { role: Role::User, content: "hi".into(), images: vec![] });
        assert_eq!(plain["content"], "hi");
        let with = wire_message(&Message { role: Role::User, content: "hi".into(), images: vec!["data:image/jpeg;base64,AA".into()] });
        assert_eq!(with["content"][0]["text"], "hi");
        assert_eq!(with["content"][1]["image_url"]["url"], "data:image/jpeg;base64,AA");
    }

    #[tokio::test]
    async fn streams_text_and_usage_then_finishes() {
        let (url, seen) = serve(vec![Canned::sse(&[
            r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#,
            r#"data: {"choices":[{"delta":{"content":"Hel"}}]}"#,
            r#"data: {"choices":[{"delta":{"content":"lo"}}]}"#,
            r#"data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}"#,
            "data: [DONE]",
        ])])
        .await;
        let events = collect(url, CancellationToken::new()).await;
        assert_eq!(
            events,
            [
                ChatEvent::Delta { text: "Hel".into() },
                ChatEvent::Delta { text: "lo".into() },
                ChatEvent::Usage { input: 3, output: 2 },
                ChatEvent::Done,
            ]
        );
        let sent = &seen.lock().unwrap()[0];
        assert!(sent.contains("POST /chat/completions"));
        assert!(sent.to_ascii_lowercase().contains("authorization: bearer secret"));
    }

    #[tokio::test]
    async fn reports_a_bad_key_as_auth() {
        let (url, _) = serve(vec![Canned::status(401, r#"{"error":{"message":"invalid api key"}}"#)]).await;
        let events = collect(url, CancellationToken::new()).await;
        assert!(matches!(&events[..], [ChatEvent::Error { kind: ErrorKind::Auth, message }] if message.contains("invalid api key")));
    }

    #[tokio::test]
    async fn reports_a_server_that_is_down_in_plain_words() {
        let events = collect("http://127.0.0.1:9".into(), CancellationToken::new()).await;
        assert!(matches!(&events[..], [ChatEvent::Error { kind: ErrorKind::Unavailable, message }] if message.contains("server running")));
    }

    #[tokio::test]
    async fn retries_without_usage_when_the_server_refuses_the_option() {
        let (url, seen) = serve(vec![
            Canned::status(422, r#"{"detail":[{"loc":["body","stream_options"],"msg":"extra"}]}"#),
            Canned::sse(&[r#"data: {"choices":[{"delta":{"content":"ok"}}]}"#, "data: [DONE]"]),
        ])
        .await;
        let events = collect(url, CancellationToken::new()).await;
        assert_eq!(events, [ChatEvent::Delta { text: "ok".into() }, ChatEvent::Done]);
        assert!(!seen.lock().unwrap()[1].contains("stream_options"));
    }

    #[tokio::test]
    async fn surfaces_an_error_sent_mid_stream() {
        let (url, _) = serve(vec![Canned::sse(&[
            r#"data: {"choices":[{"delta":{"content":"par"}}]}"#,
            r#"data: {"error":{"message":"upstream died"}}"#,
        ])])
        .await;
        let events = collect(url, CancellationToken::new()).await;
        assert!(matches!(events.last(), Some(ChatEvent::Error { message, .. }) if message.contains("upstream died")));
    }

    #[tokio::test]
    async fn skips_chunks_it_cannot_parse() {
        let (url, _) = serve(vec![Canned::sse(&["data: not json", r#"data: {"choices":[{"delta":{"content":"ok"}}]}"#, "data: [DONE]"])]).await;
        let events = collect(url, CancellationToken::new()).await;
        assert_eq!(events, [ChatEvent::Delta { text: "ok".into() }, ChatEvent::Done]);
    }

    #[tokio::test]
    async fn stops_on_cancel_while_the_server_hangs() {
        let (url, _) = serve(vec![Canned::hanging(r#"data: {"choices":[{"delta":{"content":"a"}}]}"#)]).await;
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(80)).await;
            trigger.cancel();
        });
        let events = tokio::time::timeout(std::time::Duration::from_secs(3), collect(url, cancel)).await.unwrap();
        assert!(matches!(events.last(), Some(ChatEvent::Error { kind: ErrorKind::Cancelled, .. })));
    }

    #[tokio::test]
    async fn lists_chat_models_only_and_sorted() {
        let (url, _) = serve(vec![Canned::json(r#"{"data":[{"id":"gpt-b"},{"id":"text-embedding-3"},{"id":"gpt-a"},{"id":"whisper-1"}]}"#)]).await;
        let provider = crate::client(Protocol::OpenAi, Endpoint { base_url: url, api_key: None }).unwrap();
        let ids: Vec<_> = provider.models().await.unwrap().into_iter().map(|m| m.id).collect();
        assert_eq!(ids, ["gpt-a", "gpt-b"]);
    }
}
