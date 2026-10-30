//! Streamable HTTP, the transport remote servers share. Every message is a POST
//! and a reply is either JSON or a short event stream. The GET stream for
//! server-initiated messages is never opened, because a read-only client has
//! nothing to hear on it.

use std::time::Duration;

use ai_core::sse::SseParser;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, ACCEPT, CONTENT_TYPE, WWW_AUTHENTICATE};
use reqwest::redirect::Policy;
use reqwest::{RequestBuilder, Response};
use serde_json::{json, Value};

use crate::Error;

const PROTOCOL_VERSION: &str = "2025-11-25";
const VERSION_HEADER: &str = "MCP-Protocol-Version";
const SESSION_HEADER: &str = "MCP-Session-Id";
/// Tools past this are not worth a request, and a server cannot keep us paging.
const MAX_TOOLS: usize = 200;
const MAX_REPLY_BYTES: usize = 8 * 1024 * 1024;

/// A redirect is an address chosen by the server, so following one would walk
/// past the guard in [`crate::auth`].
// ponytail: no redirects at all, send them through check_url if a vendor needs
// one. The token requests go through activity's client, which still follows them.
pub(crate) fn http_client() -> Result<reqwest::Client, Error> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .redirect(Policy::none())
        .build()
        .map_err(Error::from_reqwest)
}

/// One open conversation with a server. The token only ever goes to `url`.
pub(crate) struct Connection {
    http: reqwest::Client,
    url: String,
    token: Option<String>,
    session: Option<String>,
    protocol: Option<String>,
    next_id: u64,
    pub server: Option<String>,
}

impl Connection {
    pub fn new(url: &str, token: Option<String>) -> Result<Self, Error> {
        Ok(Self {
            http: http_client()?,
            url: url.to_string(),
            token,
            session: None,
            protocol: None,
            next_id: 0,
            server: None,
        })
    }

    fn with_headers(&self, mut request: RequestBuilder) -> RequestBuilder {
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        if let Some(protocol) = &self.protocol {
            request = request.header(VERSION_HEADER, protocol);
        }
        if let Some(session) = &self.session {
            request = request.header(SESSION_HEADER, session);
        }
        request
    }

    async fn send(&self, message: &Value) -> Result<Response, Error> {
        let request = self.http.post(&self.url).header(ACCEPT, "application/json, text/event-stream").json(message);
        self.with_headers(request).send().await.map_err(Error::from_reqwest)
    }

    fn take_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    /// Sends `initialize` and hands back the raw response, which is how
    /// discovery gets its 401 challenge.
    pub async fn knock(&self) -> Result<Response, Error> {
        self.send(&initialize_message(1)).await
    }

    /// Starts a conversation. Also how a lost session starts over, so nothing
    /// from the old one may reach the server.
    pub async fn initialize(&mut self) -> Result<(), Error> {
        self.session = None;
        self.protocol = None;
        let id = self.take_id();
        let response = check(self.send(&initialize_message(id)).await?)?;
        let session = response.headers().get(SESSION_HEADER).and_then(|value| value.to_str().ok()).map(str::to_string);
        let result = into_result(self.scrub(read_reply(response, id).await?)?)?;
        self.session = session;
        self.protocol = Some(result["protocolVersion"].as_str().unwrap_or(PROTOCOL_VERSION).to_string());
        let info = &result["serverInfo"];
        self.server = info["title"].as_str().or(info["name"].as_str()).map(str::to_string);
        check(self.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await?)?;
        Ok(())
    }

    async fn call(&mut self, method: &str, params: &Value) -> Result<Value, Error> {
        let id = self.take_id();
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let response = check(self.send(&message).await?)?;
        into_result(self.scrub(read_reply(response, id).await?)?)
    }

    /// Replies end up on screen and in errors, and a careless server may quote
    /// the token it was sent. Doing this on the whole message means it happens
    /// before anything is cut short, so no fragment survives.
    fn scrub(&self, message: Value) -> Result<Value, Error> {
        let Some(token) = self.token.as_deref().filter(|token| !token.is_empty()) else { return Ok(message) };
        let text = message.to_string();
        if !text.contains(token) {
            return Ok(message);
        }
        serde_json::from_str(&text.replace(token, "[token]")).map_err(|_| Error::Malformed("server reply"))
    }

    /// A 404 on a session means the server forgot it, which it may do at any
    /// time, so that earns one fresh start.
    async fn request(&mut self, method: &str, params: Value) -> Result<Value, Error> {
        match self.call(method, &params).await {
            Err(Error::Http(404)) if self.session.is_some() => {
                self.initialize().await?;
                self.call(method, &params).await
            }
            outcome => outcome,
        }
    }

    pub async fn list_tools(&mut self) -> Result<Vec<Value>, Error> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        let mut received = 0;
        // One page per tool at worst, so an endless run of empty pages stops too.
        for _ in 0..MAX_TOOLS {
            let params = cursor.as_ref().map_or_else(|| json!({}), |cursor| json!({ "cursor": cursor }));
            let result = self.request("tools/list", params).await?;
            received += result.to_string().len();
            tools.extend(result["tools"].as_array().into_iter().flatten().cloned());
            cursor = result["nextCursor"].as_str().map(str::to_string);
            // The reply cap is per page, so a long run of huge pages is stopped here.
            if cursor.is_none() || tools.len() >= MAX_TOOLS || received > MAX_REPLY_BYTES {
                break;
            }
        }
        tools.truncate(MAX_TOOLS);
        Ok(tools)
    }

    pub async fn call_tool(&mut self, name: &str, arguments: Value) -> Result<Value, Error> {
        self.request("tools/call", json!({ "name": name, "arguments": arguments })).await
    }

    /// Best effort: the session ends on the server's side anyway, and many
    /// servers answer 405 to this.
    pub async fn close(self) {
        if self.session.is_some() {
            let _ = self.with_headers(self.http.delete(&self.url)).send().await;
        }
    }
}

fn initialize_message(id: u64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "Meridian", "version": env!("CARGO_PKG_VERSION") }
        }
    })
}

fn check(response: Response) -> Result<Response, Error> {
    match response.status().as_u16() {
        200..=299 => Ok(response),
        401 => Err(Error::ReauthRequired),
        status => Err(Error::Http(status)),
    }
}

fn into_result(mut message: Value) -> Result<Value, Error> {
    if let Some(text) = message["error"]["message"].as_str() {
        return Err(Error::Tool(text.chars().take(200).collect()));
    }
    message.get_mut("result").map(Value::take).ok_or(Error::Malformed("server reply"))
}

/// A server may send its own requests down the same stream, and those number
/// from 1 as well, so a matching id alone proves nothing.
fn answers(message: &Value, id: u64) -> bool {
    message["id"] == id && message.get("method").is_none()
}

async fn read_reply(response: Response, id: u64) -> Result<Value, Error> {
    let kind = response.headers().get(CONTENT_TYPE).and_then(|value| value.to_str().ok()).unwrap_or_default();
    if !kind.to_ascii_lowercase().starts_with("text/event-stream") {
        return read_json(response).await?.filter(|message| answers(message, id)).ok_or(Error::Malformed("server reply"));
    }
    // ponytail: a stream closed before its reply is not resumed, so it reads as
    // malformed. Add a GET with Last-Event-ID if a vendor closes them on purpose.
    let mut parser = SseParser::default();
    let mut reply = None;
    read_capped(response, |chunk| {
        reply = parser.push(chunk).iter().filter_map(|event| serde_json::from_str(event).ok()).find(|m| answers(m, id));
        reply.is_some()
    })
    .await?;
    reply.ok_or(Error::Malformed("server reply"))
}

/// Feeds the body to `each` until it returns true, the body ends, or it passes
/// the cap.
async fn read_capped(response: Response, mut each: impl FnMut(&[u8]) -> bool) -> Result<(), Error> {
    let mut body = response.bytes_stream();
    let mut total = 0;
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(Error::from_reqwest)?;
        total += chunk.len();
        if total > MAX_REPLY_BYTES {
            return Err(Error::TooLarge);
        }
        if each(&chunk) {
            break;
        }
    }
    Ok(())
}

/// `None` when the body is not JSON, which is the caller's to judge.
pub(crate) async fn read_json(response: Response) -> Result<Option<Value>, Error> {
    let mut body = Vec::new();
    read_capped(response, |chunk| {
        body.extend_from_slice(chunk);
        false
    })
    .await?;
    Ok(serde_json::from_slice(&body).ok())
}

/// The parts of a 401 that discovery uses.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Challenge {
    pub resource_metadata: Option<String>,
    pub scope: Option<String>,
}

impl Challenge {
    pub fn from_headers(headers: &HeaderMap) -> Self {
        let values: Vec<&str> = headers.get_all(WWW_AUTHENTICATE).iter().filter_map(|v| v.to_str().ok()).collect();
        parse_challenge(&values.join(", "))
    }
}

/// Reads `name=value` pairs and ignores the scheme around them. Values may be
/// quoted, and a quoted one may hold commas, spaces and escaped quotes, so
/// splitting on commas would cut a scope list in half.
fn parse_challenge(header: &str) -> Challenge {
    let mut challenge = Challenge::default();
    let mut rest = header;
    while let Some((before, after)) = rest.split_once('=') {
        let name = before.rsplit([' ', ',', '\t']).next().unwrap_or_default().to_ascii_lowercase();
        let (value, next) = match after.strip_prefix('"') {
            Some(quoted) => read_quoted(quoted),
            None => {
                let (value, next) = after.split_once([',', ' ', '\t']).unwrap_or((after, ""));
                (value.to_string(), next)
            }
        };
        let slot = match name.as_str() {
            "resource_metadata" => Some(&mut challenge.resource_metadata),
            "scope" => Some(&mut challenge.scope),
            _ => None,
        };
        if let Some(slot) = slot {
            slot.get_or_insert(value);
        }
        rest = next;
    }
    challenge
}

fn read_quoted(text: &str) -> (String, &str) {
    let mut value = String::new();
    let mut chars = text.char_indices();
    while let Some((at, c)) = chars.next() {
        match c {
            '"' => return (value, &text[at + 1..]),
            '\\' => value.extend(chars.next().map(|(_, escaped)| escaped)),
            _ => value.push(c),
        }
    }
    (value, "")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn challenge(metadata: Option<&str>, scope: Option<&str>) -> Challenge {
        Challenge { resource_metadata: metadata.map(str::to_string), scope: scope.map(str::to_string) }
    }

    #[test]
    fn reads_quoted_parameters() {
        let header = r#"Bearer resource_metadata="https://a.example/prm", scope="read write""#;
        assert_eq!(parse_challenge(header), challenge(Some("https://a.example/prm"), Some("read write")));
    }

    #[test]
    fn reads_bare_parameters() {
        let header = "Bearer scope=read,resource_metadata=https://a.example/prm?x=1";
        assert_eq!(parse_challenge(header), challenge(Some("https://a.example/prm?x=1"), Some("read")));
    }

    #[test]
    fn reads_them_past_other_parameters_and_in_any_case() {
        let header = r#"Bearer realm="x, y", error="invalid_token", Resource_Metadata="https://a.example/prm""#;
        assert_eq!(parse_challenge(header), challenge(Some("https://a.example/prm"), None));
    }

    #[test]
    fn a_comma_inside_quotes_stays_in_the_value() {
        assert_eq!(parse_challenge(r#"Bearer scope="a, b""#).scope.as_deref(), Some("a, b"));
    }

    #[test]
    fn an_escaped_quote_does_not_end_the_value() {
        assert_eq!(parse_challenge(r#"Bearer scope="a\"b", realm="z""#).scope.as_deref(), Some("a\"b"));
    }

    #[test]
    fn a_longer_name_ending_the_same_way_is_not_a_match() {
        assert_eq!(parse_challenge(r#"Bearer x_scope="no""#).scope, None);
    }

    #[test]
    fn an_unterminated_quote_ends_quietly() {
        assert_eq!(parse_challenge(r#"Bearer scope="open"#).scope.as_deref(), Some("open"));
    }

    #[test]
    fn nothing_useful_is_nothing() {
        assert_eq!(parse_challenge("Bearer"), Challenge::default());
        assert_eq!(parse_challenge(""), Challenge::default());
    }

    #[test]
    fn several_headers_are_read_together() {
        let mut headers = HeaderMap::new();
        headers.append(WWW_AUTHENTICATE, r#"Basic realm="old""#.parse().unwrap());
        headers.append(WWW_AUTHENTICATE, r#"Bearer scope="read""#.parse().unwrap());
        assert_eq!(Challenge::from_headers(&headers).scope.as_deref(), Some("read"));
    }

    #[test]
    fn a_server_request_with_our_id_is_not_our_answer() {
        assert!(answers(&json!({ "id": 3, "result": {} }), 3));
        assert!(!answers(&json!({ "id": 3, "method": "ping" }), 3));
        assert!(!answers(&json!({ "id": 4, "result": {} }), 3));
        assert!(!answers(&json!({ "method": "notifications/progress" }), 3));
    }

    #[test]
    fn a_json_rpc_error_keeps_only_a_short_message() {
        let long = "x".repeat(500);
        let Err(Error::Tool(text)) = into_result(json!({ "id": 1, "error": { "code": -1, "message": long } })) else {
            panic!("expected an error");
        };
        assert_eq!(text.len(), 200);
    }

    #[test]
    fn a_reply_with_neither_result_nor_error_is_malformed() {
        assert!(matches!(into_result(json!({ "id": 1 })), Err(Error::Malformed(_))));
    }
}
