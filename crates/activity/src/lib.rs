//! Personal activity and unified events for Meridian. Nothing here knows about
//! Tauri: the app supplies timers, tokens and a browser, and this crate owns
//! extraction, storage, notification decisions and read-only account sync.

use std::time::Duration;

pub mod accounts;
pub mod event;
pub mod extract;
pub mod notify;
pub mod store;
pub mod sync;

pub use accounts::gmail::Gmail;
pub use accounts::google_calendar::GoogleCalendar;
pub use accounts::graph::Graph;
pub use accounts::oauth::{exchange_code, exchange_for_key, refresh_tokens, AuthorizationCode, LoopbackFlow, OAuthConfig, Tokens};
pub use accounts::{CalendarChange, Profile, Provider, Session, TokenStore};
pub use event::{
    Category, ContextEvent, EventKind, EventSource, EventStatus, EventTime, Priority, SourceRef, SuggestedAction,
};
pub use extract::{extract, extract_with, parse_loose, Message};
pub use notify::{
    decide, decide_island, CategoryPreferences, Decision, Disposition, Hold, IslandItem, InterruptionContext,
    LogEntry, Preferences, QuietHours, Reminder, Stage,
};
pub use store::{ConnectedAccount, Correction, EventFilter, Store, UpsertOutcome};
pub use sync::{disconnect, sync_google, sync_microsoft, SyncFailure, SyncOptions, SyncSummary};

/// Every failure the app can see. Messages never carry tokens or message
/// bodies, so each one is safe to log or show as it stands.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// No usable token, or the provider refused the refresh: connect again.
    #[error("Sign in to this account again.")]
    ReauthRequired,
    /// The app owns the timer, so backoff is reported rather than slept through.
    #[error("The provider is rate limiting requests.")]
    RateLimited { retry_after: Option<Duration> },
    #[error("The sync position expired.")]
    CursorExpired,
    #[error("Not found.")]
    NotFound,
    #[error("HTTP {status}: {message}")]
    Http { status: u16, message: String },
    #[error("Could not read the {0}.")]
    Malformed(&'static str),
    #[error("{0}")]
    Network(&'static str),
    #[error("Authorization was refused: {0}")]
    AuthorizationDenied(String),
    #[error("The authorization reply did not match this request.")]
    StateMismatch,
    #[error("Authorization timed out.")]
    AuthorizationTimedOut,
    #[error("Token storage failed: {0}")]
    TokenStore(String),
    #[error("The system random source failed.")]
    RandomSource,
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("This database is schema {found}; this build understands up to {supported}.")]
    SchemaTooNew { found: usize, supported: usize },
    #[error("No such event: {0}")]
    UnknownEvent(String),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_send_sync<T: Send + Sync>() {}

    /// A sync runs on the app's async runtime, and a `!Sync` store would make
    /// every future holding a reference to it unspawnable.
    #[test]
    fn shared_types_cross_threads() {
        assert_send_sync::<Store>();
        assert_send_sync::<Gmail>();
        assert_send_sync::<GoogleCalendar>();
        assert_send_sync::<Graph>();
        assert_send_sync::<Error>();
    }
}
