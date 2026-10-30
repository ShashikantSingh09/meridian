//! Personal activity in the running app: the timers, the keychain and the
//! browser that crates/activity leaves to its host. All mail reading happens on
//! this machine, through read-only grants the user made.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use activity::accounts::{gmail, google_calendar, graph};
use activity::{
    disconnect, exchange_code, extract, sync_google, sync_microsoft, Category, ConnectedAccount, ContextEvent, Correction,
    Decision, EventFilter, EventKind, EventSource, EventTime, Gmail, GoogleCalendar, Graph, InterruptionContext,
    LogEntry, LoopbackFlow, Message, OAuthConfig, Priority, Provider, Reminder, Session, SourceRef, Store, SuggestedAction,
    SyncOptions, SyncSummary, TokenStore, Tokens,
};
use chrono::{Local, TimeDelta, Utc};
use keyring::Entry;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::Core;
use crate::island;

pub const SERVICE: &str = "dev.meridian.companion";
const TICK: Duration = Duration::from_secs(60);
/// In ticks: mail and calendars every 15 minutes.
const SYNC_EVERY: u32 = 15;
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
/// Set when a release is built, so customers need no registration of their own.
/// Google's desktop client secret is not confidential in this flow.
const BUILT_IN_GOOGLE: Option<&str> = option_env!("MERIDIAN_GOOGLE_CLIENT_ID");
const BUILT_IN_GOOGLE_SECRET: Option<&str> = option_env!("MERIDIAN_GOOGLE_CLIENT_SECRET");
const BUILT_IN_MICROSOFT: Option<&str> = option_env!("MERIDIAN_MICROSOFT_CLIENT_ID");
/// Credential Manager caps one secret at 2560 bytes of UTF-16, so 1280
/// characters, and an access token alone can pass that. Tokens go in pieces.
const CHUNK: usize = 1200;

fn stringify(err: impl std::fmt::Display) -> String {
    err.to_string()
}

// ── Tokens ──────────────────────────────────────────────────────────────────

fn chunks(text: &str) -> Vec<&str> {
    text.as_bytes().chunks(CHUNK).map(|c| std::str::from_utf8(c).unwrap_or_default()).collect()
}

pub struct Keychain;

impl Keychain {
    fn entry(account: &str, part: usize) -> Result<Entry, activity::Error> {
        Entry::new(SERVICE, &format!("oauth/{account}/{part}")).map_err(|e| activity::Error::TokenStore(e.to_string()))
    }
}

impl TokenStore for Keychain {
    fn load(&self, account: &str) -> Result<Option<Tokens>, activity::Error> {
        let mut json = String::new();
        for part in 0.. {
            match Self::entry(account, part)?.get_password() {
                Ok(piece) => json.push_str(&piece),
                Err(keyring::Error::NoEntry) => break,
                Err(err) => return Err(activity::Error::TokenStore(err.to_string())),
            }
        }
        if json.is_empty() {
            return Ok(None);
        }
        serde_json::from_str(&json).map(Some).map_err(|_| activity::Error::ReauthRequired)
    }

    fn save(&self, account: &str, tokens: &Tokens) -> Result<(), activity::Error> {
        self.delete(account)?;
        let json = serde_json::to_string(tokens).map_err(|e| activity::Error::TokenStore(e.to_string()))?;
        for (part, piece) in chunks(&json).into_iter().enumerate() {
            Self::entry(account, part)?.set_password(piece).map_err(|e| activity::Error::TokenStore(e.to_string()))?;
        }
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), activity::Error> {
        for part in 0.. {
            match Self::entry(account, part)?.delete_credential() {
                Ok(()) => {}
                Err(keyring::Error::NoEntry) => break,
                Err(err) => return Err(activity::Error::TokenStore(err.to_string())),
            }
        }
        Ok(())
    }
}

/// Google's client secret is not confidential in this flow, but it is kept with
/// the other credentials anyway.
fn client_secret(provider: Provider) -> Option<String> {
    Entry::new(SERVICE, &format!("oauth-client/{provider:?}")).ok()?.get_password().ok()
}

fn save_client_secret(provider: Provider, secret: &str) -> Result<(), String> {
    Entry::new(SERVICE, &format!("oauth-client/{provider:?}"))
        .and_then(|e| e.set_password(secret))
        .map_err(stringify)
}

// ── State ───────────────────────────────────────────────────────────────────

pub struct Life {
    pub store: Arc<Store>,
    tokens: Arc<Keychain>,
    context: Mutex<InterruptionContext>,
}

impl Life {
    fn new(store: Store) -> Self {
        Self { store: Arc::new(store), tokens: Arc::new(Keychain), context: Mutex::new(InterruptionContext::default()) }
    }
}

/// A reminder with what the user can do about it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Surfaced {
    #[serde(flatten)]
    reminder: Reminder,
    actions: Vec<SuggestedAction>,
}

fn surfaced(store: &Store, decision: &Decision) -> Vec<Surfaced> {
    decision
        .surface
        .iter()
        .map(|reminder| Surfaced {
            actions: store.get(&reminder.event_id).ok().flatten().map(|e| e.suggested_actions).unwrap_or_default(),
            reminder: reminder.clone(),
        })
        .collect()
}

/// One pass of the notification engine. Everything it decides is logged, which
/// is what makes each reminder fire only once.
fn remind(app: &AppHandle) -> Result<(), activity::Error> {
    let life = app.state::<Life>();
    let preferences = app.state::<Core>().settings.lock().unwrap().activity.clone();
    let context = life.context.lock().unwrap().clone();
    let now = Local::now().fixed_offset();
    let events = life.store.list(&EventFilter::default(), now)?;
    let log = life.store.notification_log()?;
    let decision = activity::decide(&events, now, &preferences, &context, &log);
    life.store.record_decision(&decision, now.to_utc())?;
    if !decision.surface.is_empty() {
        let _ = app.emit_to(island::LABEL, "activity-reminders", surfaced(&life.store, &decision));
    }
    Ok(())
}

/// The user's own registration wins over the one a release was built with.
fn client_id(own: &str, built_in: Option<&str>) -> Option<String> {
    (!own.is_empty()).then(|| own.to_string()).or(built_in.map(str::to_string))
}

fn oauth_config(core: &Core, provider: Provider, secret: Option<String>) -> Result<OAuthConfig, String> {
    let settings = core.settings.lock().unwrap();
    match provider {
        Provider::Google => {
            let id = client_id(&settings.google_client_id, BUILT_IN_GOOGLE).ok_or("Add a Google client ID first.")?;
            let secret = secret.or_else(|| client_secret(Provider::Google)).or(BUILT_IN_GOOGLE_SECRET.map(str::to_string));
            Ok(OAuthConfig::google(id, secret))
        }
        Provider::Microsoft => {
            let id = client_id(&settings.microsoft_client_id, BUILT_IN_MICROSOFT).ok_or("Add a Microsoft application ID first.")?;
            Ok(OAuthConfig::microsoft(id))
        }
    }
}

/// Which sign-ins work with no registration of the user's own.
#[tauri::command]
pub fn built_in_clients() -> (bool, bool) {
    (BUILT_IN_GOOGLE.is_some(), BUILT_IN_MICROSOFT.is_some())
}

async fn sync_account(core: &Core, life: &Life, account: &ConnectedAccount) -> Result<SyncSummary, String> {
    let config = oauth_config(core, account.provider, None)?;
    let session = |base: &str| {
        Session::new(base, config.clone(), account.id.clone(), life.tokens.clone()).map_err(stringify)
    };
    let (options, now) = (SyncOptions::default(), Utc::now());
    let summary = match account.provider {
        Provider::Google => {
            let (mail, calendar) = (Gmail::new(session(gmail::BASE_URL)?), GoogleCalendar::new(session(google_calendar::BASE_URL)?));
            sync_google(&mail, &calendar, &life.store, &options, now).await
        }
        Provider::Microsoft => sync_microsoft(&Graph::new(session(graph::BASE_URL)?), &life.store, &options, now).await,
    };
    let mut saved = account.clone();
    saved.last_sync_at = Some(now);
    life.store.save_account(&saved).map_err(stringify)?;
    Ok(summary)
}

pub fn spawn(app: AppHandle) {
    let path = app.path().app_local_data_dir().map(|dir| {
        let _ = std::fs::create_dir_all(&dir);
        dir.join("activity.db")
    });
    // A broken database must not stop the app. Nothing persists until it is fixed.
    let store = path.map_err(stringify).and_then(|p| Store::open(p).map_err(stringify)).or_else(|err| {
        eprintln!("activity store unavailable: {err}");
        Store::in_memory().map_err(stringify)
    });
    let Ok(store) = store else { return };
    app.manage(Life::new(store));

    tauri::async_runtime::spawn(async move {
        let mut ticks = 0u32;
        loop {
            if let Err(err) = remind(&app) {
                eprintln!("reminders: {err}");
            }
            let core = app.state::<Core>();
            let life = app.state::<Life>();
            let paused = core.settings.lock().unwrap().monitoring_paused;
            if ticks % SYNC_EVERY == 0 && !paused {
                for account in life.store.accounts().unwrap_or_default() {
                    if let Err(err) = sync_account(&core, &life, &account).await {
                        eprintln!("sync of one account failed: {err}");
                    }
                }
                let _ = app.emit_to(island::LABEL, "activity-changed", ());
            }
            ticks = ticks.wrapping_add(1);
            tokio::time::sleep(TICK).await;
        }
    });
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn activity_list(life: State<'_, Life>, category: Option<Category>) -> Result<Vec<ContextEvent>, String> {
    let filter = EventFilter { category, ..EventFilter::default() };
    life.store.list(&filter, Local::now().fixed_offset()).map_err(stringify)
}

#[tauri::command]
pub fn activity_dismiss(life: State<'_, Life>, id: String) -> Result<(), String> {
    life.store.dismiss(&id).map(|_| ()).map_err(stringify)
}

#[tauri::command]
pub fn activity_delete(life: State<'_, Life>, id: String) -> Result<(), String> {
    life.store.delete(&id).map_err(stringify)
}

#[tauri::command]
pub fn activity_snooze(life: State<'_, Life>, id: String, minutes: i64) -> Result<(), String> {
    let until = Utc::now() + TimeDelta::minutes(minutes);
    life.store.snooze(&id, until).map(|_| ()).map_err(stringify)
}

#[tauri::command]
pub fn activity_correct(life: State<'_, Life>, id: String, title: String) -> Result<(), String> {
    let correction = Correction { title: Some(title), ..Correction::default() };
    life.store.correct(&id, &correction).map(|_| ()).map_err(stringify)
}

#[tauri::command]
pub fn activity_add_reminder(app: AppHandle, life: State<'_, Life>, title: String, starts_at: EventTime) -> Result<(), String> {
    let now = Utc::now();
    let key = format!("reminder:{}", now.timestamp_nanos_opt().unwrap_or_default());
    let mut event = ContextEvent::new(EventKind::UserReminder, EventSource::User, title, key, now);
    event.starts_at = Some(starts_at);
    event.priority = Priority::Important;
    life.store.upsert(event).map_err(stringify)?;
    remind(&app).map_err(stringify)
}

/// Reads one pasted email through the same extractor as a connected mailbox.
#[tauri::command]
pub fn activity_import(life: State<'_, Life>, subject: String, from: String, body: String) -> Result<usize, String> {
    let now = Utc::now();
    let html = body.contains("<html") || body.contains("application/ld+json");
    let message = Message {
        from,
        source_ref: SourceRef {
            account: "pasted email".into(),
            message_id: format!("pasted-{}", now.timestamp_nanos_opt().unwrap_or_default()),
            subject: subject.clone(),
            received_at: now,
            link: None,
        },
        subject,
        received_at: now,
        text: (!html).then(|| body.clone()),
        html: html.then_some(body),
        calendar: None,
    };
    let found = extract(&message);
    let count = found.len();
    for event in found {
        life.store.upsert(event).map_err(stringify)?;
    }
    Ok(count)
}

#[tauri::command]
pub fn activity_context(life: State<'_, Life>, agent: bool, media: bool, screen: bool) {
    let mut context = life.context.lock().unwrap();
    context.agent_session_active = agent;
    context.media_playing = media;
    context.screen_assist_active = screen;
}

#[tauri::command]
pub fn reminder_log(life: State<'_, Life>) -> Result<Vec<LogEntry>, String> {
    life.store.notification_log().map_err(stringify)
}

#[tauri::command]
pub fn accounts_list(life: State<'_, Life>) -> Result<Vec<ConnectedAccount>, String> {
    life.store.accounts().map_err(stringify)
}

/// The whole sign-in: a loopback redirect, the user's own browser, and a token
/// exchange. The app never sees a password.
#[tauri::command]
pub async fn account_connect(
    core: State<'_, Core>,
    life: State<'_, Life>,
    provider: Provider,
    secret: Option<String>,
) -> Result<ConnectedAccount, String> {
    if let Some(secret) = secret.as_deref().filter(|s| !s.is_empty()) {
        save_client_secret(provider, secret)?;
    }
    let config = oauth_config(&core, provider, secret)?;
    let flow = LoopbackFlow::start(&config).await.map_err(stringify)?;
    open_in_browser(flow.authorize_url())?;
    let code = flow.wait_for_code(SIGN_IN_TIMEOUT).await.map_err(stringify)?;
    let tokens = exchange_code(&config, &code).await.map_err(stringify)?;

    // The account's name comes from the provider, which needs the tokens first.
    let pending = format!("pending-{provider:?}");
    life.tokens.save(&pending, &tokens).map_err(stringify)?;
    let session = |base: &str| Session::new(base, config.clone(), pending.clone(), life.tokens.clone()).map_err(stringify);
    let profile = match provider {
        Provider::Google => Gmail::new(session(gmail::BASE_URL)?).profile().await,
        Provider::Microsoft => Graph::new(session(graph::BASE_URL)?).profile().await,
    }
    .map_err(stringify)?;
    let id = format!("{provider:?}:{}", profile.email.clone().unwrap_or_else(|| "account".into())).to_lowercase();
    let live = life.tokens.load(&pending).map_err(stringify)?.ok_or("Sign-in did not complete.")?;
    life.tokens.save(&id, &live).map_err(stringify)?;
    life.tokens.delete(&pending).map_err(stringify)?;

    let account = ConnectedAccount {
        id,
        provider,
        email: profile.email,
        scopes: config.scopes.clone(),
        connected_at: Utc::now(),
        last_sync_at: None,
    };
    life.store.save_account(&account).map_err(stringify)?;
    Ok(account)
}

/// Removes the account, its tokens and everything read from it.
#[tauri::command]
pub fn account_disconnect(life: State<'_, Life>, id: String) -> Result<(), String> {
    disconnect(&life.store, life.tokens.as_ref(), &id).map(|_| ()).map_err(stringify)
}

#[tauri::command]
pub async fn account_sync(core: State<'_, Core>, life: State<'_, Life>, id: String) -> Result<String, String> {
    let accounts = life.store.accounts().map_err(stringify)?;
    let account = accounts.iter().find(|a| a.id == id).ok_or("That account is not connected.")?;
    let summary = sync_account(&core, &life, account).await?;
    if let Some(failure) = summary.failures.first() {
        return Err(format!("{}: {}", failure.resource, failure.error));
    }
    Ok(format!("Read {} messages. {} new, {} updated.", summary.messages_fetched, summary.inserted, summary.updated))
}

/// The parsed form goes on, which is plain ASCII. The handler reads the ANSI code
/// page, which can turn a lookalike slash into a real one and change the host.
pub fn open_in_browser(url: &str) -> Result<(), String> {
    let url = tauri::Url::parse(url).map_err(|_| "That link is not valid.")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only web links can be opened.".into());
    }
    std::process::Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", url.as_str()]).spawn().map(|_| ()).map_err(stringify)
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    open_in_browser(&url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_tokens_split_and_rejoin() {
        let token = "x".repeat(CHUNK * 3 + 7);
        let parts = chunks(&token);
        assert_eq!(parts.len(), 4);
        assert!(parts.iter().all(|p| p.len() <= CHUNK));
        assert_eq!(parts.concat(), token);
    }

    #[test]
    fn a_users_own_registration_wins_over_the_built_in_one() {
        assert_eq!(client_id("mine", Some("built-in")).as_deref(), Some("mine"));
        assert_eq!(client_id("", Some("built-in")).as_deref(), Some("built-in"));
        assert_eq!(client_id("", None), None);
    }

    #[test]
    fn only_web_links_open() {
        assert!(open_in_browser("file:///c:/windows/system32/calc.exe").is_err());
        assert!(open_in_browser("javascript:alert(1)").is_err());
    }

    #[test]
    #[ignore = "writes to the real Credential Manager, under a test account"]
    fn a_token_too_long_for_one_entry_round_trips() {
        let tokens = Tokens { access_token: "a".repeat(5000), refresh_token: Some("r".repeat(600)), expires_at: None };
        let store = Keychain;
        store.save("test/roundtrip", &tokens).unwrap();
        let back = store.load("test/roundtrip").unwrap().unwrap();
        store.delete("test/roundtrip").unwrap();
        assert_eq!(back.access_token, tokens.access_token);
        assert!(store.load("test/roundtrip").unwrap().is_none());
    }
}
