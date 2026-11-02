//! OAuth 2.0 authorization code with PKCE over a loopback redirect. The app
//! opens the URL in the browser; everything else happens here. Client ids come
//! from whoever calls this: the app builds them in when a release is registered.

use std::collections::HashMap;
use std::fmt;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, TimeDelta, Utc};
use reqwest::header::ACCEPT;
use reqwest::redirect::Policy;
use reqwest::{Client, Response, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

use super::{classify, retry_after};
use crate::Error;

pub const GOOGLE_AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const MICROSOFT_AUTHORIZE_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
pub const MICROSOFT_TOKEN_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

pub const GOOGLE_SCOPES: &[&str] =
    &["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/calendar.readonly"];
pub const MICROSOFT_SCOPES: &[&str] = &["Mail.Read", "Calendars.Read", "offline_access", "User.Read"];

const MAX_TOKEN_REPLY_BYTES: usize = 1 << 20;
/// A redirect line longer than this is not a real redirect.
const MAX_REDIRECT_BYTES: usize = 8 * 1024;
/// So a spare socket a browser never writes to does not outlive the sign-in.
const REDIRECT_READ_TIMEOUT: Duration = Duration::from_secs(30);

const DONE_PAGE: &str = "<!doctype html><title>Meridian</title><p>Connected. You can close this window.</p>";
const FAILED_PAGE: &str = "<!doctype html><title>Meridian</title><p>That did not work. You can close this window and try again.</p>";

#[derive(Clone)]
pub struct OAuthConfig {
    pub authorize_url: String,
    pub token_url: String,
    pub client_id: String,
    /// Google desktop clients need this although it is not confidential in
    /// this flow. Microsoft public clients have none.
    pub client_secret: Option<String>,
    pub scopes: Vec<String>,
    pub extra_authorize_params: Vec<(String, String)>,
    /// Sent on both the code exchange and every refresh. MCP servers need
    /// `resource` on each, so a token stays bound to one server.
    pub extra_token_params: Vec<(String, String)>,
    /// How the redirect names this machine. Microsoft ignores the port only for
    /// `localhost`, and Google accepts the address itself.
    pub redirect_host: &'static str,
}

impl OAuthConfig {
    pub fn google(client_id: impl Into<String>, client_secret: Option<String>) -> Self {
        Self {
            authorize_url: GOOGLE_AUTHORIZE_URL.to_string(),
            token_url: GOOGLE_TOKEN_URL.to_string(),
            client_id: client_id.into(),
            client_secret,
            scopes: GOOGLE_SCOPES.iter().map(|s| s.to_string()).collect(),
            // Without these Google issues no refresh token on a repeat consent.
            extra_authorize_params: vec![
                ("access_type".to_string(), "offline".to_string()),
                ("prompt".to_string(), "consent".to_string()),
            ],
            extra_token_params: Vec::new(),
            redirect_host: "127.0.0.1",
        }
    }

    pub fn microsoft(client_id: impl Into<String>) -> Self {
        Self {
            authorize_url: MICROSOFT_AUTHORIZE_URL.to_string(),
            token_url: MICROSOFT_TOKEN_URL.to_string(),
            client_id: client_id.into(),
            client_secret: None,
            scopes: MICROSOFT_SCOPES.iter().map(|s| s.to_string()).collect(),
            extra_authorize_params: Vec::new(),
            extra_token_params: Vec::new(),
            redirect_host: "localhost",
        }
    }
}

impl fmt::Debug for OAuthConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OAuthConfig").field("client_id", &self.client_id).finish_non_exhaustive()
    }
}

/// What a [`crate::TokenStore`] holds. Never printed, whatever `{:?}` reaches it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
}

impl fmt::Debug for Tokens {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Tokens(redacted)")
    }
}

/// A code ready to trade for tokens, with what proves this client asked for it.
pub struct AuthorizationCode {
    code: String,
    verifier: String,
    redirect_uri: String,
}

fn random_token() -> Result<String, Error> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| Error::RandomSource)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn authorize_url(
    config: &OAuthConfig,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
) -> Result<String, Error> {
    let mut url = Url::parse(&config.authorize_url).map_err(|_| Error::Malformed("authorize URL"))?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", &config.client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("state", state)
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256")
            .extend_pairs(&config.extra_authorize_params);
        // An empty `scope` is not the same as none: some servers reject it.
        if !config.scopes.is_empty() {
            query.append_pair("scope", &config.scopes.join(" "));
        }
    }
    Ok(url.into())
}

/// One sign-in attempt: a listener on a random 127.0.0.1 port, waiting for the
/// browser to come back.
pub struct LoopbackFlow {
    listener: TcpListener,
    url: String,
    state: String,
    verifier: String,
    redirect_uri: String,
}

impl LoopbackFlow {
    pub async fn start(config: &OAuthConfig) -> Result<Self, Error> {
        let listener =
            TcpListener::bind("127.0.0.1:0").await.map_err(|_| Error::Network("Could not open a local port."))?;
        Self::start_on(listener, config)
    }

    /// For a client registered on the spot, whose redirect URI has to name the
    /// port before the authorize URL can exist.
    pub fn start_on(listener: TcpListener, config: &OAuthConfig) -> Result<Self, Error> {
        let port = listener.local_addr().map_err(|_| Error::Network("Could not open a local port."))?.port();
        let redirect_uri = format!("http://{}:{port}", config.redirect_host);
        let state = random_token()?;
        let verifier = random_token()?;
        let url = authorize_url(config, &redirect_uri, &state, &challenge_for(&verifier))?;
        Ok(Self { listener, url, state, verifier, redirect_uri })
    }

    /// Opening this in the browser is the app's job.
    pub fn authorize_url(&self) -> &str {
        &self.url
    }

    /// Waits for the redirect. Each connection is handled on its own because
    /// browsers open spare sockets they never write to, and those must not
    /// block the one that carries the code.
    pub async fn wait_for_code(self, timeout: Duration) -> Result<AuthorizationCode, Error> {
        let (sender, mut results) = mpsc::channel(1);
        let accept_loop = async {
            loop {
                tokio::select! {
                    accepted = self.listener.accept() => {
                        let Ok((socket, _)) = accepted else { continue };
                        tokio::spawn(answer_redirect(socket, self.state.clone(), sender.clone()));
                    }
                    Some(result) = results.recv() => return result,
                }
            }
        };
        let code = tokio::time::timeout(timeout, accept_loop).await.map_err(|_| Error::AuthorizationTimedOut)??;
        Ok(AuthorizationCode { code, verifier: self.verifier, redirect_uri: self.redirect_uri })
    }
}

async fn read_request_line(socket: &mut TcpStream) -> Option<String> {
    let mut raw = Vec::new();
    let mut buffer = [0u8; 1024];
    while raw.len() < MAX_REDIRECT_BYTES {
        let read = socket.read(&mut buffer).await.ok()?;
        if read == 0 {
            return None;
        }
        raw.extend_from_slice(&buffer[..read]);
        if let Some(end) = raw.windows(2).position(|pair| pair == b"\r\n") {
            let line = std::str::from_utf8(&raw[..end]).ok()?;
            return line.split(' ').nth(1).map(str::to_string);
        }
    }
    None
}

async fn answer_redirect(mut socket: TcpStream, expected_state: String, results: mpsc::Sender<Result<String, Error>>) {
    let reading = tokio::time::timeout(REDIRECT_READ_TIMEOUT, read_request_line(&mut socket)).await;
    let Ok(Some(target)) = reading else { return };
    let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else { return };
    let params: HashMap<String, String> = url.query_pairs().into_owned().collect();
    // Browsers also ask for /favicon.ico, which is neither an answer nor an attack.
    if url.path() != "/" || !(params.contains_key("code") || params.contains_key("error")) {
        let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").await;
        return;
    }
    let outcome = if params.get("state") != Some(&expected_state) {
        Err(Error::StateMismatch)
    } else if let Some(error) = params.get("error") {
        Err(Error::AuthorizationDenied(error.chars().take(100).collect()))
    } else {
        params.get("code").cloned().ok_or(Error::Malformed("authorization reply"))
    };
    let page = if outcome.is_ok() { DONE_PAGE } else { FAILED_PAGE };
    let head = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        page.len()
    );
    let _ = socket.write_all(head.as_bytes()).await;
    let _ = socket.write_all(page.as_bytes()).await;
    let _ = socket.flush().await;
    let _ = results.send(outcome).await;
}

/// A token request carries a code or a refresh token, which must not follow a
/// redirect anywhere the endpoint chooses.
fn token_client() -> Result<Client, Error> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .redirect(Policy::none())
        .build()
        .map_err(Error::from_reqwest)
}

/// For a service that gives back a key instead of tokens, as OpenRouter does: the code
/// and its proof go to `endpoint`, and the key is what returns.
pub async fn exchange_for_key(endpoint: &str, code: &AuthorizationCode) -> Result<String, Error> {
    let body = serde_json::json!({ "code": code.code, "code_verifier": code.verifier, "code_challenge_method": "S256" });
    let response = token_client()?.post(endpoint).json(&body).send().await.map_err(Error::from_reqwest)?;
    let status = response.status().as_u16();
    let body = read_capped(response).await?;
    if !(200..300).contains(&status) {
        return Err(classify(status, None, &body));
    }
    parse_key(&body)
}

fn parse_key(body: &str) -> Result<String, Error> {
    #[derive(Deserialize)]
    struct Reply {
        key: String,
    }
    serde_json::from_str::<Reply>(body).map(|reply| reply.key).map_err(|_| Error::Malformed("key response"))
}

pub async fn exchange_code(config: &OAuthConfig, code: &AuthorizationCode) -> Result<Tokens, Error> {
    let http = token_client()?;
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code.code.as_str()),
        ("client_id", config.client_id.as_str()),
        ("redirect_uri", code.redirect_uri.as_str()),
        ("code_verifier", code.verifier.as_str()),
    ];
    if let Some(secret) = &config.client_secret {
        form.push(("client_secret", secret.as_str()));
    }
    form.extend(config.extra_token_params.iter().map(|(name, value)| (name.as_str(), value.as_str())));
    let body = token_request(&http, config, &form).await?;
    parse_tokens(&body, None, Utc::now())
}

/// Microsoft rotates the refresh token and Google usually does not send one
/// back, so the old one is kept only when the reply omits it.
pub async fn refresh_tokens(config: &OAuthConfig, tokens: &Tokens) -> Result<Tokens, Error> {
    let http = token_client()?;
    let refresh_token = tokens.refresh_token.as_deref().ok_or(Error::ReauthRequired)?;
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", config.client_id.as_str()),
    ];
    if let Some(secret) = &config.client_secret {
        form.push(("client_secret", secret.as_str()));
    }
    form.extend(config.extra_token_params.iter().map(|(name, value)| (name.as_str(), value.as_str())));
    let body = token_request(&http, config, &form).await?;
    parse_tokens(&body, Some(refresh_token), Utc::now())
}

/// The endpoint can come from a server's metadata, and a timeout limits only time.
async fn read_capped(mut response: Response) -> Result<String, Error> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(Error::from_reqwest)? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_TOKEN_REPLY_BYTES {
            return Err(Error::Malformed("token response"));
        }
    }
    String::from_utf8(body).map_err(|_| Error::Malformed("token response"))
}

async fn token_request(http: &Client, config: &OAuthConfig, form: &[(&str, &str)]) -> Result<String, Error> {
    // GitHub answers in form encoding unless asked for JSON.
    let response = http.post(&config.token_url).header(ACCEPT, "application/json").form(form).send().await.map_err(Error::from_reqwest)?;
    let status = response.status().as_u16();
    let retry = retry_after(response.headers(), Utc::now());
    let body = read_capped(response).await?;
    if (200..300).contains(&status) {
        return Ok(body);
    }
    let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    if matches!(parsed["error"].as_str(), Some("invalid_grant" | "interaction_required")) {
        return Err(Error::ReauthRequired);
    }
    Err(classify(status, retry, &body))
}

fn parse_tokens(body: &str, previous_refresh: Option<&str>, now: DateTime<Utc>) -> Result<Tokens, Error> {
    #[derive(Deserialize)]
    struct Reply {
        access_token: String,
        refresh_token: Option<String>,
        expires_in: Option<i64>,
    }
    // The serde error text can quote the value it choked on, which here is a token.
    let reply: Reply = serde_json::from_str(body).map_err(|_| Error::Malformed("token response"))?;
    Ok(Tokens {
        access_token: reply.access_token,
        refresh_token: reply.refresh_token.or_else(|| previous_refresh.map(str::to_string)),
        // A server chooses this number, so an absurd one means no known expiry, not a panic.
        expires_at: reply.expires_in.and_then(TimeDelta::try_seconds).and_then(|delta| now.checked_add_signed(delta)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn s256_matches_the_rfc_7636_vector() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(challenge_for(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn random_tokens_differ_and_meet_the_pkce_length_rule() {
        let (a, b) = (random_token().unwrap(), random_token().unwrap());
        assert_ne!(a, b);
        assert!((43..=128).contains(&a.len()));
    }

    #[test]
    fn google_authorize_url_asks_for_offline_read_only_access() {
        let config = OAuthConfig::google("client-1", None);
        let url = Url::parse(&authorize_url(&config, "http://127.0.0.1:5000", "st", "ch").unwrap()).unwrap();
        let params: HashMap<String, String> = url.query_pairs().into_owned().collect();
        assert_eq!(params["client_id"], "client-1");
        assert_eq!(params["redirect_uri"], "http://127.0.0.1:5000");
        assert_eq!(params["state"], "st");
        assert_eq!(params["code_challenge"], "ch");
        assert_eq!(params["code_challenge_method"], "S256");
        assert_eq!(params["access_type"], "offline");
        assert!(params["scope"].contains("gmail.readonly"));
        assert!(params["scope"].contains("calendar.readonly"));
    }

    #[test]
    fn no_scopes_means_no_scope_parameter() {
        let mut config = OAuthConfig::microsoft("client-1");
        config.scopes.clear();
        let url = Url::parse(&authorize_url(&config, "http://127.0.0.1:5000", "st", "ch").unwrap()).unwrap();
        assert!(url.query_pairs().all(|(name, _)| name != "scope"));
        assert!(url.query_pairs().any(|(name, _)| name == "client_id"));
    }

    #[tokio::test]
    async fn start_on_builds_the_redirect_from_the_listener_it_was_given() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let flow = LoopbackFlow::start_on(listener, &OAuthConfig::google("client-1", None)).unwrap();
        let url = Url::parse(flow.authorize_url()).unwrap();
        let params: HashMap<String, String> = url.query_pairs().into_owned().collect();
        assert_eq!(params["redirect_uri"], format!("http://127.0.0.1:{port}"));
    }

    /// Answers one token request on a real socket and hands back its body.
    async fn one_token_request() -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/token", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut raw = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let read = socket.read(&mut buffer).await.unwrap();
                raw.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&raw);
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let length = head.lines().find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length: ")?.parse().ok());
                    if read == 0 || body.len() >= length.unwrap_or(0) {
                        break;
                    }
                }
            }
            let reply = r#"{"access_token":"a"}"#;
            let head = format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", reply.len());
            socket.write_all(head.as_bytes()).await.unwrap();
            socket.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&raw).into_owned()
        });
        (url, handle)
    }

    fn config_with_resource(token_url: String) -> OAuthConfig {
        let mut config = OAuthConfig::microsoft("client-1");
        config.token_url = token_url;
        config.extra_token_params = vec![("resource".to_string(), "https://mcp.example.test/mcp".to_string())];
        config
    }

    #[tokio::test]
    async fn extra_token_params_go_out_on_the_code_exchange() {
        let (url, request) = one_token_request().await;
        let code = AuthorizationCode {
            code: "c".to_string(),
            verifier: "v".to_string(),
            redirect_uri: "http://127.0.0.1:5000".to_string(),
        };
        exchange_code(&config_with_resource(url), &code).await.unwrap();
        assert!(request.await.unwrap().contains("resource=https%3A%2F%2Fmcp.example.test%2Fmcp"));
    }

    #[tokio::test]
    async fn extra_token_params_go_out_on_a_refresh() {
        let (url, request) = one_token_request().await;
        let tokens = Tokens { access_token: "a".to_string(), refresh_token: Some("r".to_string()), expires_at: None };
        refresh_tokens(&config_with_resource(url), &tokens).await.unwrap();
        assert!(request.await.unwrap().contains("resource=https%3A%2F%2Fmcp.example.test%2Fmcp"));
    }

    #[test]
    fn microsoft_is_a_public_client_with_read_scopes() {
        let config = OAuthConfig::microsoft("client-2");
        assert!(config.client_secret.is_none());
        assert_eq!(config.scopes, ["Mail.Read", "Calendars.Read", "offline_access", "User.Read"]);
    }

    #[test]
    fn a_refresh_reply_without_a_refresh_token_keeps_the_old_one() {
        let now = Utc::now();
        let google = parse_tokens(r#"{"access_token":"new","expires_in":3600}"#, Some("old"), now).unwrap();
        assert_eq!(google.refresh_token.as_deref(), Some("old"));
        assert_eq!(google.expires_at, Some(now + TimeDelta::hours(1)));
        let rotated = parse_tokens(r#"{"access_token":"new","refresh_token":"next"}"#, Some("old"), now).unwrap();
        assert_eq!(rotated.refresh_token.as_deref(), Some("next"));
    }

    #[test]
    fn a_key_reply_gives_the_key_and_a_bad_one_never_echoes() {
        assert_eq!(parse_key(r#"{"key":"sk-or-1","user_id":"u"}"#).unwrap(), "sk-or-1");
        let error = parse_key(r#"{"key":12345,"note":"sekrit"}"#).unwrap_err();
        assert!(!error.to_string().contains("sekrit"));
    }

    #[test]
    fn an_absurd_expiry_is_treated_as_unknown_rather_than_panicking() {
        let body = format!(r#"{{"access_token":"a","expires_in":{}}}"#, i64::MAX);
        assert_eq!(parse_tokens(&body, None, Utc::now()).unwrap().expires_at, None);
    }

    #[test]
    fn a_malformed_token_reply_never_echoes_its_contents() {
        let error = parse_tokens(r#"{"access_token":12345,"note":"sekrit"}"#, None, Utc::now()).unwrap_err();
        assert!(!error.to_string().contains("sekrit"));
    }

    #[test]
    fn debug_output_hides_every_secret() {
        let tokens = Tokens {
            access_token: "sekrit-a".into(),
            refresh_token: Some("sekrit-r".into()),
            expires_at: None,
        };
        assert!(!format!("{tokens:?}").contains("sekrit"));
        let config = OAuthConfig::google("id", Some("sekrit-c".into()));
        assert!(!format!("{config:?}").contains("sekrit"));
    }
}
