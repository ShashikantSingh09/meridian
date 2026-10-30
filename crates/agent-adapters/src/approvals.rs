//! Approvals for Claude Code. Each run gets a `PermissionRequest` http hook,
//! injected for that run alone through `--settings`, so the user's own
//! settings.json is never written. The hook posts here and waits; the reply is
//! the user's click. Loopback only, with a random token per session in the path.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

use crate::{AgentEvent, Approval, Emit};

const MAX_BODY: usize = 1 << 20;
pub const READ_TIMEOUT: Duration = Duration::from_secs(5);
/// Written into the hook definition; the server gives up a little sooner so
/// Claude Code always hears from us.
pub const HOOK_TIMEOUT_SECS: u64 = 1800;
const DECISION_TIMEOUT: Duration = Duration::from_secs(HOOK_TIMEOUT_SECS - 10);

#[derive(Default)]
struct State {
    sessions: HashMap<String, Emit>,
    waiting: HashMap<String, oneshot::Sender<bool>>,
}

#[derive(Clone)]
pub struct ApprovalServer {
    state: Arc<Mutex<State>>,
    port: u16,
}

/// A session's hook registration.
pub struct Hook {
    pub token: String,
    pub url: String,
}

impl ApprovalServer {
    pub async fn start() -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let state: Arc<Mutex<State>> = Arc::default();
        let shared = state.clone();
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                tokio::spawn(handle(socket, shared.clone()));
            }
        });
        Ok(Self { state, port })
    }

    pub fn register(&self, emit: Emit) -> Hook {
        let token = uuid::Uuid::new_v4().simple().to_string();
        self.state.lock().unwrap().sessions.insert(token.clone(), emit);
        Hook { url: format!("http://127.0.0.1:{}/perm/{token}", self.port), token }
    }

    pub fn unregister(&self, hook: &Hook) {
        self.state.lock().unwrap().sessions.remove(&hook.token);
    }

    /// True when `id` was waiting here.
    pub fn answer(&self, id: &str, allow: bool) -> bool {
        match self.state.lock().unwrap().waiting.remove(id) {
            Some(tx) => {
                let _ = tx.send(allow);
                true
            }
            None => false,
        }
    }
}

/// The `--settings` JSON that injects the hook for one run.
pub fn settings_json(url: &str) -> String {
    json!({
        "hooks": { "PermissionRequest": [{
            "hooks": [{ "type": "http", "url": url, "timeout": HOOK_TIMEOUT_SECS }]
        }]}
    })
    .to_string()
}

/// One line for the island saying what is being asked for.
pub fn summarize(tool: &str, input: &Value) -> String {
    let text = match tool {
        "Bash" | "PowerShell" => input["command"].as_str(),
        "Edit" | "Write" | "MultiEdit" | "Read" | "NotebookEdit" => input["file_path"].as_str(),
        "WebFetch" => input["url"].as_str(),
        _ => None,
    };
    let text = text.map(str::to_string).unwrap_or_else(|| input.to_string());
    text.chars().take(240).collect()
}

pub fn decision_body(allow: bool) -> String {
    let decision = if allow {
        json!({ "behavior": "allow" })
    } else {
        json!({ "behavior": "deny", "message": "Denied by the user." })
    };
    json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } }).to_string()
}

pub async fn read_request(socket: &mut TcpStream, max: usize) -> Option<(String, Vec<u8>)> {
    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = socket.read(&mut buf).await.ok()?;
        if n == 0 {
            return None;
        }
        raw.extend_from_slice(&buf[..n]);
        if raw.len() > max {
            return None;
        }
        let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
        let head = String::from_utf8_lossy(&raw[..end]).to_string();
        let length = head
            .lines()
            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:")?.trim().parse::<usize>().ok())
            .unwrap_or(0);
        if length > max {
            return None;
        }
        if raw.len() >= end + 4 + length {
            return Some((head, raw[end + 4..end + 4 + length].to_vec()));
        }
    }
}

pub async fn respond(socket: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;
}

async fn handle(mut socket: TcpStream, state: Arc<Mutex<State>>) {
    let Ok(Some((head, body))) = tokio::time::timeout(READ_TIMEOUT, read_request(&mut socket, MAX_BODY)).await else {
        return;
    };
    let token = head
        .lines()
        .next()
        .and_then(|l| l.strip_prefix("POST /perm/"))
        .and_then(|l| l.split(' ').next())
        .unwrap_or_default();
    let Some(emit) = state.lock().unwrap().sessions.get(token).cloned() else {
        return respond(&mut socket, "404 Not Found", "{}").await;
    };
    let Ok(payload) = serde_json::from_slice::<Value>(&body) else {
        return respond(&mut socket, "400 Bad Request", "{}").await;
    };

    let id = uuid::Uuid::new_v4().to_string();
    let tool = payload["tool_name"].as_str().unwrap_or("Tool").to_string();
    let summary = summarize(&tool, &payload["tool_input"]);
    let (tx, rx) = oneshot::channel();
    state.lock().unwrap().waiting.insert(id.clone(), tx);
    emit(AgentEvent::Approval { approval: Approval { id: id.clone(), tool, summary } });

    let decision = tokio::time::timeout(DECISION_TIMEOUT, rx).await;
    state.lock().unwrap().waiting.remove(&id);
    emit(AgentEvent::ApprovalResolved { id });
    match decision {
        Ok(Ok(allow)) => respond(&mut socket, "200 OK", &decision_body(allow)).await,
        // Nobody answered. No decision lets Claude Code apply its own rule.
        _ => respond(&mut socket, "200 OK", "{}").await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::recorder;

    async fn post(url: &str, body: &str) -> (TcpStream, String) {
        let rest = url.strip_prefix("http://").unwrap();
        let (host, path) = rest.split_once('/').unwrap();
        let mut socket = TcpStream::connect(host).await.unwrap();
        let request = format!("POST /{path} HTTP/1.1\r\nhost: {host}\r\ncontent-length: {}\r\n\r\n{body}", body.len());
        socket.write_all(request.as_bytes()).await.unwrap();
        (socket, String::new())
    }

    async fn reply(socket: &mut TcpStream) -> String {
        let mut text = String::new();
        socket.read_to_string(&mut text).await.unwrap();
        text
    }

    const PAYLOAD: &str = r#"{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"echo hello > out.txt","description":"Write hello"}}"#;

    #[tokio::test]
    async fn a_click_reaches_the_waiting_hook_as_a_decision() {
        let server = ApprovalServer::start().await.unwrap();
        let (emit, events) = recorder();
        let hook = server.register(emit);
        let (mut socket, _) = post(&hook.url, PAYLOAD).await;

        let id = loop {
            if let Some(AgentEvent::Approval { approval }) = events.lock().unwrap().first() {
                assert_eq!(approval.tool, "Bash");
                assert_eq!(approval.summary, "echo hello > out.txt");
                break approval.id.clone();
            }
            tokio::task::yield_now().await;
        };
        assert!(server.answer(&id, true));
        let text = reply(&mut socket).await;
        assert!(text.contains(r#""behavior":"allow""#), "{text}");
        assert!(text.contains(r#""hookEventName":"PermissionRequest""#));
    }

    #[tokio::test]
    async fn a_denial_carries_a_reason() {
        let server = ApprovalServer::start().await.unwrap();
        let (emit, events) = recorder();
        let hook = server.register(emit);
        let (mut socket, _) = post(&hook.url, PAYLOAD).await;
        let id = loop {
            if let Some(AgentEvent::Approval { approval }) = events.lock().unwrap().first() {
                break approval.id.clone();
            }
            tokio::task::yield_now().await;
        };
        server.answer(&id, false);
        let text = reply(&mut socket).await;
        assert!(text.contains(r#""behavior":"deny""#), "{text}");
    }

    #[tokio::test]
    async fn an_unknown_token_gets_nothing_and_raises_no_approval() {
        let server = ApprovalServer::start().await.unwrap();
        let (emit, events) = recorder();
        let hook = server.register(emit);
        let wrong = hook.url.replace(&hook.token, "not-the-token");
        let (mut socket, _) = post(&wrong, PAYLOAD).await;
        assert!(reply(&mut socket).await.starts_with("HTTP/1.1 404"));
        assert!(events.lock().unwrap().is_empty());
    }

    #[test]
    fn answering_an_unknown_approval_reports_false() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let server = ApprovalServer::start().await.unwrap();
            assert!(!server.answer("nope", true));
        });
    }

    #[test]
    fn injected_settings_name_the_hook_event_and_url() {
        let value: Value = serde_json::from_str(&settings_json("http://127.0.0.1:1/perm/t")).unwrap();
        let handler = &value["hooks"]["PermissionRequest"][0]["hooks"][0];
        assert_eq!(handler["type"], "http");
        assert_eq!(handler["url"], "http://127.0.0.1:1/perm/t");
    }

    #[test]
    fn summaries_lead_with_what_matters() {
        assert_eq!(summarize("Edit", &json!({"file_path": "a.rs"})), "a.rs");
        assert!(summarize("Mystery", &json!({"x": 1})).contains("\"x\""));
        assert!(summarize("Bash", &json!({"command": "y".repeat(999)})).len() <= 240);
    }
}
