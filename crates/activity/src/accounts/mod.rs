//! Read-only connectors. All of them share [`Session`], which holds the one
//! place a token touches a request, and take a base URL so tests can point them
//! at a local server.

use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};
use reqwest::header::{HeaderMap, RETRY_AFTER};
use reqwest::{Client, RequestBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::event::ContextEvent;
use crate::Error;

pub mod gmail;
pub mod google_calendar;
pub mod graph;
pub mod oauth;

use oauth::{refresh_tokens, OAuthConfig, Tokens};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    Google,
    Microsoft,
}

/// Where tokens live. The app backs this with Windows Credential Manager; a
/// token never touches the SQLite store.
pub trait TokenStore: Send + Sync {
    fn load(&self, account: &str) -> Result<Option<Tokens>, Error>;
    fn save(&self, account: &str, tokens: &Tokens) -> Result<(), Error>;
    fn delete(&self, account: &str) -> Result<(), Error>;
}

/// The signed-in identity, which also proves the tokens work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    pub email: Option<String>,
    pub display_name: Option<String>,
}

/// One change from a calendar. A deletion carries only the provider's id,
/// because that is all the provider sends.
#[derive(Debug, Clone, PartialEq)]
pub enum CalendarChange {
    Event(Box<ContextEvent>),
    Removed(String),
}

/// One account at one API.
pub struct Session {
    http: Client,
    base_url: String,
    account: String,
    oauth: OAuthConfig,
    tokens: Arc<dyn TokenStore>,
}

/// Tokens this close to expiry are refreshed first, so a request does not spend
/// a round trip on a 401 it could predict.
const EXPIRY_MARGIN_SECONDS: i64 = 60;

/// A stalled server must not hold a sync open forever.
fn http_client() -> Result<Client, Error> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(Error::from_reqwest)
}

impl Session {
    pub fn new(
        base_url: impl Into<String>,
        oauth: OAuthConfig,
        account: impl Into<String>,
        tokens: Arc<dyn TokenStore>,
    ) -> Result<Self, Error> {
        let base_url = base_url.into().trim_end_matches('/').to_string();
        Ok(Self { http: http_client()?, base_url, account: account.into(), oauth, tokens })
    }

    pub fn account(&self) -> &str {
        &self.account
    }

    fn url(&self, path: &str) -> String {
        format!("{}/{path}", self.base_url)
    }

    async fn access_token(&self, force_refresh: bool) -> Result<String, Error> {
        let tokens = self.tokens.load(&self.account)?.ok_or(Error::ReauthRequired)?;
        let margin = TimeDelta::seconds(EXPIRY_MARGIN_SECONDS);
        if !force_refresh && tokens.expires_at.is_none_or(|at| at > Utc::now() + margin) {
            return Ok(tokens.access_token);
        }
        let refreshed = refresh_tokens(&self.oauth, &tokens).await?;
        self.tokens.save(&self.account, &refreshed)?;
        Ok(refreshed.access_token)
    }

    /// GETs JSON with a bearer token, refreshing once if the server rejects it.
    /// A second rejection means the grant itself is gone.
    async fn send(&self, build: impl Fn() -> RequestBuilder) -> Result<Value, Error> {
        let mut token = self.access_token(false).await?;
        let mut refreshed = false;
        loop {
            let response = build().bearer_auth(&token).send().await.map_err(Error::from_reqwest)?;
            let status = response.status().as_u16();
            if status == 401 && !refreshed {
                token = self.access_token(true).await?;
                refreshed = true;
                continue;
            }
            let retry = retry_after(response.headers(), Utc::now());
            let body = response.text().await.map_err(Error::from_reqwest)?;
            if !(200..300).contains(&status) {
                return Err(classify(status, retry, &body));
            }
            // Only an object proves this is the API and not a captive portal.
            return match serde_json::from_str(&body) {
                Ok(value @ Value::Object(_)) => Ok(value),
                _ => Err(Error::Malformed("server response")),
            };
        }
    }

    async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value, Error> {
        let url = self.url(path);
        self.send(|| self.http.get(&url).query(query)).await
    }

    async fn get_with_prefer(&self, path: &str, query: &[(&str, String)], prefer: &str) -> Result<Value, Error> {
        let url = self.url(path);
        self.send(|| self.http.get(&url).query(query).header("Prefer", prefer)).await
    }

    /// Follows a link the server returned. It carries the bearer token, so it
    /// must stay on the host this session was configured for.
    async fn follow(&self, link: &str, prefer: &str) -> Result<Value, Error> {
        if !link.starts_with(&format!("{}/", self.base_url)) {
            return Err(Error::Malformed("paging link"));
        }
        self.send(|| self.http.get(link).header("Prefer", prefer)).await
    }
}

/// A failed response, classified so the app can offer the right recovery. Only
/// the provider's own message is kept, and that never holds a token or mail.
pub(crate) fn classify(status: u16, retry_after: Option<Duration>, body: &str) -> Error {
    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let error = &parsed["error"];
    let reason = error["errors"][0]["reason"].as_str().unwrap_or_default();
    match status {
        401 => Error::ReauthRequired,
        404 => Error::NotFound,
        410 => Error::CursorExpired,
        429 => Error::RateLimited { retry_after },
        // Google signals quota with 403, and Graph signals throttling with 503.
        403 if matches!(reason, "rateLimitExceeded" | "userRateLimitExceeded") => Error::RateLimited { retry_after },
        503 if retry_after.is_some() => Error::RateLimited { retry_after },
        _ => {
            let text = error["message"].as_str().or(error.as_str()).or(parsed["error_description"].as_str());
            Error::Http { status, message: text.unwrap_or_default().chars().take(300).collect() }
        }
    }
}

/// Retry-After is either seconds or an HTTP date.
pub(crate) fn retry_after(headers: &HeaderMap, now: DateTime<Utc>) -> Option<Duration> {
    let value = headers.get(RETRY_AFTER)?.to_str().ok()?.trim();
    if let Ok(seconds) = value.parse() {
        return Some(Duration::from_secs(seconds));
    }
    let until = DateTime::parse_from_rfc2822(value).ok()?;
    (until.to_utc() - now).to_std().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn classifies_google_quota_as_rate_limiting() {
        let quota = r#"{"error":{"code":403,"errors":[{"reason":"rateLimitExceeded"}],"message":"slow down"}}"#;
        assert!(matches!(classify(403, None, quota), Error::RateLimited { .. }));
        let denied = r#"{"error":{"code":403,"errors":[{"reason":"insufficientPermissions"}],"message":"no"}}"#;
        assert!(matches!(classify(403, None, denied), Error::Http { status: 403, .. }));
    }

    #[test]
    fn a_503_is_throttling_only_when_it_says_when_to_come_back() {
        assert!(matches!(classify(503, Some(Duration::from_secs(5)), ""), Error::RateLimited { .. }));
        assert!(matches!(classify(503, None, ""), Error::Http { status: 503, .. }));
    }

    #[test]
    fn keeps_error_text_short() {
        let body = format!(r#"{{"error":{{"message":"{}"}}}}"#, "x".repeat(5000));
        assert!(classify(500, None, &body).to_string().len() < 320);
    }

    #[test]
    fn reads_retry_after_as_seconds_or_a_date() {
        let now = Utc.with_ymd_and_hms(2026, 11, 5, 12, 0, 0).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, "120".parse().unwrap());
        assert_eq!(retry_after(&headers, now), Some(Duration::from_secs(120)));
        headers.insert(RETRY_AFTER, "Thu, 05 Nov 2026 12:00:30 GMT".parse().unwrap());
        assert_eq!(retry_after(&headers, now), Some(Duration::from_secs(30)));
        headers.insert(RETRY_AFTER, "soon".parse().unwrap());
        assert_eq!(retry_after(&headers, now), None);
    }
}
