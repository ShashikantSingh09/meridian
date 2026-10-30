//! A stateful stand-in for a vendor on a real socket: protected resource
//! metadata, authorization server metadata, registration, tokens and the MCP
//! endpoint itself, so tests cover actual HTTP rather than a mock of it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use mcp::{Access, Service};
use reqwest::Url;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub const PRM_PATH: &str = "/.well-known/oauth-protected-resource/mcp";
pub const PRM_ROOT: &str = "/.well-known/oauth-protected-resource";
pub const METADATA_PATH: &str = "/.well-known/oauth-authorization-server";

/// One request as the server saw it.
#[derive(Debug, Clone)]
pub struct Seen {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

impl Seen {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }

    pub fn form(&self) -> HashMap<String, String> {
        Url::parse(&format!("http://x/?{}", self.body)).unwrap().query_pairs().into_owned().collect()
    }

    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
}

#[derive(Clone)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
    /// Keeps the socket open after writing, as a live event stream does.
    pub hold_open: bool,
}

impl Reply {
    pub fn json(status: u16, body: Value) -> Self {
        let headers = vec![("content-type".to_string(), "application/json".to_string())];
        Self { status, headers, body: body.to_string(), hold_open: false }
    }

    pub fn empty(status: u16) -> Self {
        Self { status, headers: Vec::new(), body: String::new(), hold_open: false }
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }
}

/// Everything a test can change or read.
pub struct World {
    pub seen: Vec<Seen>,
    /// Served as they stand. Removing one makes that path a 404.
    pub pages: HashMap<String, Reply>,
    pub challenge: Option<String>,
    /// Bearer tokens the MCP endpoint takes.
    pub accepted: Vec<String>,
    pub tools: Vec<Value>,
    pub page_size: usize,
    pub endless_pages: bool,
    pub result: Value,
    pub rpc_error: Option<String>,
    pub sse: bool,
    /// Ends the stream without ever answering.
    pub sse_silent: bool,
    pub gives_sessions: bool,
    pub session: Option<String>,
    pub sessions_started: usize,
    /// How many sessions to forget, one per `tools/list`.
    pub forget_sessions: usize,
    pub protocol: String,
    /// Replaces a normal `/token` reply.
    pub token_failure: Option<Reply>,
}

impl World {
    fn new(base: &str) -> Self {
        let mut pages = HashMap::new();
        pages.insert(
            PRM_PATH.to_string(),
            Reply::json(
                200,
                json!({
                    "resource": format!("{base}/mcp"),
                    "authorization_servers": [base],
                    "scopes_supported": ["from-document"],
                }),
            ),
        );
        pages.insert(
            METADATA_PATH.to_string(),
            Reply::json(
                200,
                json!({
                    "issuer": base,
                    "authorization_endpoint": format!("{base}/authorize"),
                    "token_endpoint": format!("{base}/token"),
                    "registration_endpoint": format!("{base}/register"),
                    "code_challenge_methods_supported": ["S256"],
                }),
            ),
        );
        pages.insert("/register".to_string(), Reply::json(201, json!({ "client_id": "registered-1" })));
        Self {
            seen: Vec::new(),
            pages,
            challenge: Some(format!(r#"Bearer resource_metadata="{base}{PRM_PATH}", scope="from-challenge""#)),
            accepted: vec!["access-1".to_string()],
            tools: vec![json!({ "name": "list_things", "annotations": { "readOnlyHint": true } })],
            page_size: 100,
            endless_pages: false,
            result: json!({ "structuredContent": { "things": [{ "id": "T-1", "title": "First thing" }] } }),
            rpc_error: None,
            sse: false,
            sse_silent: false,
            gives_sessions: true,
            session: None,
            sessions_started: 0,
            forget_sessions: 0,
            protocol: "2025-11-25".to_string(),
            token_failure: None,
        }
    }

    fn answer(&mut self, request: &Seen) -> Reply {
        self.seen.push(request.clone());
        let path = request.path.split('?').next().unwrap_or_default();
        match path {
            "/token" => self.token(request),
            "/mcp" => self.mcp(request),
            _ => self.pages.get(path).cloned().unwrap_or_else(|| Reply::empty(404)),
        }
    }

    fn token(&mut self, request: &Seen) -> Reply {
        if let Some(failure) = &self.token_failure {
            return failure.clone();
        }
        let form = request.form();
        let (access, refresh) = match form["grant_type"].as_str() {
            "authorization_code" if form["code"] == "the-code" => ("access-1", "refresh-1"),
            "refresh_token" if form["refresh_token"] == "refresh-1" => ("access-2", "refresh-2"),
            _ => return Reply::json(400, json!({ "error": "invalid_grant" })),
        };
        // Old tokens stop working, so a client that keeps using one gets a 401.
        self.accepted = vec![access.to_string()];
        Reply::json(200, json!({ "access_token": access, "refresh_token": refresh, "expires_in": 3600 }))
    }

    fn mcp(&mut self, request: &Seen) -> Reply {
        let bearer = request.header("authorization").and_then(|value| value.strip_prefix("Bearer "));
        if !bearer.is_some_and(|token| self.accepted.iter().any(|accepted| accepted == token)) {
            let reply = Reply::empty(401);
            return match &self.challenge {
                Some(challenge) => reply.with_header("www-authenticate", challenge),
                None => reply,
            };
        }
        if request.method == "DELETE" {
            return Reply::empty(405);
        }
        let message = request.json();
        let id = message["id"].clone();
        let method = message["method"].as_str().unwrap_or_default();
        if method == "notifications/initialized" {
            return Reply::empty(202);
        }
        if method == "initialize" {
            self.sessions_started += 1;
            let session = format!("session-{}", self.sessions_started);
            self.session = self.gives_sessions.then_some(session);
            let result = json!({
                "protocolVersion": self.protocol,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "Fake Server" },
            });
            let reply = self.rpc_reply(&id, result);
            return match self.session.clone() {
                Some(session) => reply.with_header("MCP-Session-Id", &session),
                None => reply,
            };
        }
        if method == "tools/list" && self.forget_sessions > 0 {
            self.forget_sessions -= 1;
            self.session = None;
        }
        if self.gives_sessions && request.header("mcp-session-id") != self.session.as_deref() {
            return Reply::empty(404);
        }
        let result = match method {
            "tools/list" => self.tools_page(&message["params"]),
            _ => self.result.clone(),
        };
        self.rpc_reply(&id, result)
    }

    fn tools_page(&self, params: &Value) -> Value {
        if self.endless_pages {
            return json!({ "tools": [], "nextCursor": "again" });
        }
        let start: usize = params["cursor"].as_str().and_then(|cursor| cursor.parse().ok()).unwrap_or(0);
        let end = (start + self.page_size).min(self.tools.len());
        let mut page = json!({ "tools": self.tools[start..end] });
        if end < self.tools.len() {
            page["nextCursor"] = json!(end.to_string());
        }
        page
    }

    fn rpc_reply(&self, id: &Value, result: Value) -> Reply {
        let message = match &self.rpc_error {
            Some(text) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": text } }),
            None => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        };
        if !self.sse {
            return Reply::json(200, message);
        }
        let mut lines = vec![
            // The spec's priming event: an id and empty data.
            "id: 1\ndata:".to_string(),
            ": keep-alive".to_string(),
            // A request from the server wearing our id, which is not the answer.
            format!("data: {}", json!({ "jsonrpc": "2.0", "id": id, "method": "ping" })),
            "event: message\ndata: not json".to_string(),
            format!("data: {}", json!({ "jsonrpc": "2.0", "method": "notifications/progress", "params": {} })),
        ];
        if !self.sse_silent {
            lines.push(format!("data: {message}"));
        }
        let headers = vec![("content-type".to_string(), "text/event-stream".to_string())];
        Reply { status: 200, headers, body: lines.join("\n\n") + "\n\n", hold_open: !self.sse_silent }
    }
}

#[derive(Clone)]
pub struct Fake {
    pub base: String,
    world: Arc<Mutex<World>>,
}

impl Fake {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let world = Arc::new(Mutex::new(World::new(&base)));
        let shared = world.clone();
        tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else { return };
                tokio::spawn(serve(socket, shared.clone()));
            }
        });
        Self { base, world }
    }

    pub fn world(&self) -> MutexGuard<'_, World> {
        self.world.lock().unwrap()
    }

    pub fn service(&self) -> Service {
        Service {
            id: "fake",
            name: "Fake",
            group: "Test",
            blurb: "",
            url: Box::leak(format!("{}/mcp", self.base).into_boxed_str()),
            access: Access::Open,
            read_scopes: &[],
            prefer: &[],
        }
    }

    /// Changes one field of a JSON page.
    pub fn edit_page(&self, path: &str, edit: impl FnOnce(&mut Value)) {
        let mut world = self.world();
        let page = world.pages.get_mut(path).unwrap();
        let mut document: Value = serde_json::from_str(&page.body).unwrap();
        edit(&mut document);
        page.body = document.to_string();
    }

    pub fn hits(&self, path: &str) -> Vec<Seen> {
        self.world().seen.iter().filter(|seen| seen.path.split('?').next() == Some(path)).cloned().collect()
    }

    /// The paths asked for, in order.
    pub fn paths(&self) -> Vec<String> {
        self.world().seen.iter().map(|seen| seen.path.clone()).collect()
    }

    pub fn rpc(&self, method: &str) -> Vec<Seen> {
        self.world().seen.iter().filter(|seen| seen.json()["method"] == method).cloned().collect()
    }
}

async fn serve(mut socket: TcpStream, world: Arc<Mutex<World>>) {
    let Some(request) = read_request(&mut socket).await else { return };
    let reply = world.lock().unwrap().answer(&request);
    let mut head = format!("HTTP/1.1 {} X\r\nconnection: close\r\n", reply.status);
    for (name, value) in &reply.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    if !reply.hold_open {
        head.push_str(&format!("content-length: {}\r\n", reply.body.len()));
    }
    head.push_str("\r\n");
    let _ = socket.write_all(head.as_bytes()).await;
    let _ = socket.write_all(reply.body.as_bytes()).await;
    let _ = socket.flush().await;
    if reply.hold_open {
        tokio::time::sleep(Duration::from_secs(40)).await;
    }
}

async fn read_request(socket: &mut TcpStream) -> Option<Seen> {
    let mut raw = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let read = socket.read(&mut buffer).await.ok()?;
        raw.extend_from_slice(&buffer[..read]);
        if let Some(end) = raw.windows(4).position(|window| window == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&raw[..end]).to_string();
            let mut lines = head.lines();
            let mut first = lines.next()?.split(' ');
            let (method, path) = (first.next()?.to_string(), first.next()?.to_string());
            let headers: HashMap<String, String> = lines
                .filter_map(|line| line.split_once(':'))
                .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_string()))
                .collect();
            let length: usize = headers.get("content-length").and_then(|value| value.parse().ok()).unwrap_or(0);
            if raw.len() >= end + 4 + length {
                let body = String::from_utf8_lossy(&raw[end + 4..]).to_string();
                return Some(Seen { method, path, headers, body });
            }
        }
        if read == 0 {
            return None;
        }
    }
}
