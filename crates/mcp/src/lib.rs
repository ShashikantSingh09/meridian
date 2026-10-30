//! Read-only client for remote Model Context Protocol servers, so the app can
//! sign in to vendors like Linear or Notion and show what it fetched. Nothing
//! here knows about Tauri: the app supplies the browser and the token store,
//! and this crate only ever calls tools it has judged read-only.

use activity::TokenStore;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

mod auth;
mod catalog;
mod client;
mod digest;

pub use auth::{sign_in, use_token};
pub use catalog::{catalog, find, Access, Service};

use client::Connection;

/// A whole fetch, however many slow pages a server sends.
const FETCH_LIMIT: std::time::Duration = std::time::Duration::from_secs(120);

/// A client registered with the vendor by hand. It has no `Debug`, nor does
/// [`SignedIn`], so a secret cannot reach a log by accident.
pub struct Client {
    pub id: String,
    pub secret: Option<String>,
}

/// Non-secret and saved by the app. The token lives in the [`TokenStore`] and
/// any client secret is the app's to keep.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub service: String,
    pub url: String,
    pub token_url: String,
    pub client_id: String,
    pub scopes: Vec<String>,
    pub resource: String,
    pub static_token: bool,
    pub connected_at: DateTime<Utc>,
}

pub struct SignedIn {
    pub link: Link,
    pub client_secret: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Digest {
    pub server: Option<String>,
    /// The tool called, or `None` when the server offers nothing readable.
    pub tool: Option<String>,
    /// Only tools [`digest`] would agree to call, so any of them can be asked for.
    pub tools: Vec<String>,
    pub items: Vec<Item>,
    pub text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub key: String,
    pub title: String,
    pub detail: Option<String>,
    pub url: Option<String>,
    pub when: Option<String>,
}

/// Every failure the app can see. Each message is safe to show as it stands: a
/// server's words only appear in [`Error::Tool`], and replies lose any quoted
/// token before they get that far.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The server's metadata names another service, which would send it that
    /// service's token.
    #[error("This server's sign-in details point at another service, so sign-in was refused.")]
    ForeignResource,
    /// No usable token, or the server turned ours down: connect again.
    #[error("Sign in to this service again.")]
    ReauthRequired,
    #[error("The service refused that token.")]
    TokenRefused,
    #[error("{0} needs a registered app before it can connect.")]
    NeedsRegisteredApp(String),
    #[error("This service does not say how to sign in.")]
    NoAuthorizationServer,
    #[error("This service does not offer the secure sign-in Meridian requires.")]
    PkceUnsupported,
    #[error("This service's sign-in details do not match its address.")]
    IssuerMismatch,
    #[error("This service pointed at an address Meridian will not use.")]
    UnsafeUrl,
    #[error("{0} is not a read-only tool Meridian can call.")]
    ToolRefused(String),
    #[error("The service reported an error: {0}")]
    Tool(String),
    #[error("The service sent too much data.")]
    TooLarge,
    #[error("The service answered with HTTP {0}.")]
    Http(u16),
    #[error("Could not read the {0}.")]
    Malformed(&'static str),
    #[error("{0}")]
    Network(&'static str),
    #[error("Could not open the browser: {0}")]
    Browser(String),
    #[error("{0}")]
    Account(activity::Error),
}

impl Error {
    /// reqwest's own text can carry the request URL, so it is never kept.
    pub(crate) fn from_reqwest(err: reqwest::Error) -> Self {
        if err.is_connect() {
            Self::Network("Could not connect.")
        } else if err.is_timeout() {
            Self::Network("The request timed out.")
        } else {
            Self::Network("The connection failed.")
        }
    }
}

impl From<activity::Error> for Error {
    fn from(err: activity::Error) -> Self {
        match err {
            activity::Error::ReauthRequired => Self::ReauthRequired,
            // The message is the token endpoint's own, and that endpoint has
            // just been handed a code or a refresh token it could echo.
            activity::Error::Http { status, .. } => Self::Http(status),
            other => Self::Account(other),
        }
    }
}

/// Opens a connection, calls one read-only tool, closes. `tool` asks for a
/// particular one and is refused if it is not readable.
pub async fn digest(
    link: &Link,
    client_secret: Option<String>,
    store: &dyn TokenStore,
    account: &str,
    tool: Option<&str>,
) -> Result<Digest, Error> {
    let tokens = auth::fresh_tokens(link, client_secret, store, account).await?;
    let mut connection = Connection::new(&link.url, Some(tokens.access_token))?;
    let outcome = tokio::time::timeout(FETCH_LIMIT, read_one(&mut connection, find(&link.service), tool)).await;
    connection.close().await;
    outcome.unwrap_or(Err(Error::Network("The service took too long to answer.")))
}

async fn read_one(
    connection: &mut Connection,
    service: Option<&Service>,
    tool: Option<&str>,
) -> Result<Digest, Error> {
    connection.initialize().await?;
    let tools = connection.list_tools().await?;
    let chosen = digest::choose(&tools, service, tool)?;
    let mut found = Digest {
        server: connection.server.clone(),
        tool: None,
        tools: digest::usable_names(&tools, service),
        items: Vec::new(),
        text: None,
    };
    if let Some((name, arguments)) = chosen {
        let result = connection.call_tool(&name, arguments).await?;
        (found.items, found.text) = digest::rows(&result)?;
        found.tool = Some(name);
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_send_sync<T: Send + Sync>() {}
    fn assert_send<T: Send>(_: T) {}

    /// Tauri commands run on a multi-threaded runtime, so a `!Send` future
    /// would only show up in the app's build.
    #[test]
    fn shared_types_and_futures_cross_threads() {
        assert_send_sync::<Error>();
        assert_send_sync::<Link>();
        struct NoTokens;
        impl TokenStore for NoTokens {
            fn load(&self, _: &str) -> Result<Option<activity::Tokens>, activity::Error> {
                Ok(None)
            }
            fn save(&self, _: &str, _: &activity::Tokens) -> Result<(), activity::Error> {
                Ok(())
            }
            fn delete(&self, _: &str) -> Result<(), activity::Error> {
                Ok(())
            }
        }
        let service = find("linear").unwrap();
        let link = Link {
            service: "linear".to_string(),
            url: String::new(),
            token_url: String::new(),
            client_id: String::new(),
            scopes: Vec::new(),
            resource: String::new(),
            static_token: false,
            connected_at: Utc::now(),
        };
        assert_send(digest(&link, None, &NoTokens, "a", None));
        assert_send(use_token(service, String::new(), &NoTokens, "a"));
        assert_send(sign_in(service, None, &NoTokens, "a", |_| Ok(()), std::time::Duration::ZERO));
    }

    #[test]
    fn a_token_endpoint_cannot_put_its_own_words_in_an_error() {
        let upstream = activity::Error::Http { status: 400, message: "rejected sekrit-code".to_string() };
        let shown = Error::from(upstream).to_string();
        assert!(shown.contains("400"));
        assert!(!shown.contains("sekrit"));
    }

    #[test]
    fn a_refused_refresh_means_sign_in_again() {
        assert!(matches!(Error::from(activity::Error::ReauthRequired), Error::ReauthRequired));
    }

    #[test]
    fn link_round_trips_in_camel_case() {
        let link = Link {
            service: "linear".to_string(),
            url: "https://mcp.linear.app/mcp".to_string(),
            token_url: "https://mcp.linear.app/token".to_string(),
            client_id: "c".to_string(),
            scopes: vec!["read".to_string()],
            resource: "https://mcp.linear.app/mcp".to_string(),
            static_token: false,
            connected_at: Utc::now(),
        };
        let saved = serde_json::to_value(&link).unwrap();
        assert_eq!(saved["tokenUrl"], "https://mcp.linear.app/token");
        assert_eq!(saved["staticToken"], false);
        assert_eq!(serde_json::from_value::<Link>(saved).unwrap(), link);
    }

    #[test]
    fn digest_serializes_in_camel_case() {
        let digest = Digest {
            server: Some("s".to_string()),
            tool: None,
            tools: Vec::new(),
            items: vec![Item {
                key: "k".to_string(),
                title: "t".to_string(),
                detail: None,
                url: None,
                when: Some("w".to_string()),
            }],
            text: None,
        };
        let shown = serde_json::to_value(&digest).unwrap();
        assert_eq!(shown["items"][0]["when"], "w");
        assert_eq!(shown["server"], "s");
    }
}
