//! One pass over one account: fetch, extract, upsert. The app owns the timer.
//! Position is saved after every page, so a failure resumes where it stopped,
//! and upserts are idempotent, so a repeated page costs requests and nothing else.

use chrono::{DateTime, TimeDelta, Utc};
use serde::{Deserialize, Serialize};

use crate::accounts::{CalendarChange, TokenStore};
use crate::extract::{extract, Message};
use crate::store::{Store, UpsertOutcome};
use crate::{Error, Gmail, GoogleCalendar, Graph};

const GMAIL: &str = "gmail";
const GOOGLE_CALENDAR: &str = "googleCalendar";
const GRAPH_MAIL: &str = "graphMail";
const GRAPH_CALENDAR: &str = "graphCalendar";

#[derive(Debug, Clone, Copy)]
pub struct SyncOptions {
    /// How far back the first mail sync looks.
    pub mail_window_days: u32,
    /// A cap on the first mail sync, however much the window matches.
    pub max_initial_messages: usize,
    pub calendar_past_days: u32,
    /// How far ahead Graph's calendar window reaches. Google's has no end.
    pub calendar_horizon_days: u32,
    pub page_size: u32,
}

impl Default for SyncOptions {
    fn default() -> Self {
        Self {
            mail_window_days: 90,
            max_initial_messages: 500,
            calendar_past_days: 1,
            calendar_horizon_days: 90,
            page_size: 50,
        }
    }
}

#[derive(Debug)]
pub struct SyncFailure {
    pub resource: &'static str,
    pub error: Error,
}

#[derive(Debug, Default)]
pub struct SyncSummary {
    pub messages_fetched: usize,
    pub calendar_changes: usize,
    pub items_extracted: usize,
    pub inserted: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub removed: usize,
    /// A stored position expired and that resource was read from scratch.
    pub resynced: bool,
    /// One resource failing does not stop the other, and what it fetched first
    /// is already stored. `RateLimited` here carries when to come back.
    pub failures: Vec<SyncFailure>,
}

impl SyncSummary {
    fn tally(&mut self, outcome: UpsertOutcome) {
        match outcome {
            UpsertOutcome::Inserted => self.inserted += 1,
            UpsertOutcome::Updated { .. } => self.updated += 1,
            UpsertOutcome::Unchanged => self.unchanged += 1,
        }
    }
}

/// Saved as JSON per account and resource.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Cursor {
    /// Where the next incremental run starts: historyId, syncToken or deltaLink.
    sync: Option<String>,
    /// The next page of the run in progress.
    page: Option<String>,
    /// Gmail: the historyId adopted once the first listing ends.
    pending_history_id: Option<String>,
    /// Gmail: messages taken so far by the first listing.
    listed: usize,
    /// Graph calendar: when the fixed delta window was opened.
    window_opened: Option<DateTime<Utc>>,
}

/// An unreadable cursor is only lost progress, so it means starting over.
fn load_cursor(store: &Store, account: &str, resource: &str) -> Result<Cursor, Error> {
    let saved = store.cursor(account, resource)?;
    Ok(saved.and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default())
}

fn save_cursor(store: &Store, account: &str, resource: &str, cursor: &Cursor, now: DateTime<Utc>) -> Result<(), Error> {
    let json = serde_json::to_string(cursor).map_err(|_| Error::Malformed("sync cursor"))?;
    store.set_cursor(account, resource, &json, now)
}

fn ingest_message(store: &Store, message: &Message, summary: &mut SyncSummary) -> Result<(), Error> {
    summary.messages_fetched += 1;
    for item in extract(message) {
        summary.items_extracted += 1;
        summary.tally(store.upsert(item)?);
    }
    Ok(())
}

fn ingest_change(
    store: &Store,
    account: &str,
    change: CalendarChange,
    now: DateTime<Utc>,
    summary: &mut SyncSummary,
) -> Result<(), Error> {
    summary.calendar_changes += 1;
    match change {
        CalendarChange::Event(event) => summary.tally(store.upsert(*event)?),
        CalendarChange::Removed(id) => {
            if store.cancel_calendar_event(account, &id, now)? {
                summary.removed += 1;
            }
        }
    }
    Ok(())
}

/// Syncs a Google account's mail and calendar. Both clients must be for the
/// same account, and the app should call this from its own timer.
pub async fn sync_google(
    gmail: &Gmail,
    calendar: &GoogleCalendar,
    store: &Store,
    options: &SyncOptions,
    now: DateTime<Utc>,
) -> SyncSummary {
    let mut summary = SyncSummary::default();
    if let Err(error) = sync_gmail(gmail, store, options, now, &mut summary).await {
        summary.failures.push(SyncFailure { resource: GMAIL, error });
    }
    if let Err(error) = sync_google_calendar(calendar, store, options, now, &mut summary).await {
        summary.failures.push(SyncFailure { resource: GOOGLE_CALENDAR, error });
    }
    finish(store, gmail.account(), now, summary)
}

/// Syncs a Microsoft account's mail and calendar.
pub async fn sync_microsoft(graph: &Graph, store: &Store, options: &SyncOptions, now: DateTime<Utc>) -> SyncSummary {
    let mut summary = SyncSummary::default();
    if let Err(error) = sync_graph_mail(graph, store, options, now, &mut summary).await {
        summary.failures.push(SyncFailure { resource: GRAPH_MAIL, error });
    }
    if let Err(error) = sync_graph_calendar(graph, store, options, now, &mut summary).await {
        summary.failures.push(SyncFailure { resource: GRAPH_CALENDAR, error });
    }
    finish(store, graph.account(), now, summary)
}

fn finish(store: &Store, account: &str, now: DateTime<Utc>, mut summary: SyncSummary) -> SyncSummary {
    if summary.failures.is_empty() {
        if let Err(error) = store.mark_synced(account, now) {
            summary.failures.push(SyncFailure { resource: "account", error });
        }
    }
    summary
}

/// Removes tokens and everything stored for the account. Tokens go first: a
/// failure after that leaves stale rows, never a live credential.
pub fn disconnect(store: &Store, tokens: &dyn TokenStore, account: &str) -> Result<usize, Error> {
    tokens.delete(account)?;
    store.delete_account(account)
}

async fn sync_gmail(
    gmail: &Gmail,
    store: &Store,
    options: &SyncOptions,
    now: DateTime<Utc>,
    summary: &mut SyncSummary,
) -> Result<(), Error> {
    let account = gmail.account();
    let mut cursor = load_cursor(store, account, GMAIL)?;
    if let Some(start) = cursor.sync.clone() {
        match gmail_history(gmail, store, &start, &mut cursor, now, summary).await {
            Err(Error::CursorExpired) => {
                cursor = Cursor::default();
                summary.resynced = true;
            }
            other => return other,
        }
    }

    if cursor.pending_history_id.is_none() {
        cursor.pending_history_id = Some(gmail.current_history_id().await?);
    }
    loop {
        let page = gmail.list_messages(options.mail_window_days, cursor.page.as_deref(), options.page_size).await?;
        for id in &page.ids {
            if let Some(message) = gmail.get_message(id).await? {
                ingest_message(store, &message, summary)?;
            }
        }
        cursor.listed += page.ids.len();
        cursor.page = page.next_page;
        if cursor.page.is_none() || cursor.listed >= options.max_initial_messages {
            let finished = Cursor { sync: cursor.pending_history_id.take(), ..Cursor::default() };
            return save_cursor(store, account, GMAIL, &finished, now);
        }
        save_cursor(store, account, GMAIL, &cursor, now)?;
    }
}

async fn gmail_history(
    gmail: &Gmail,
    store: &Store,
    start: &str,
    cursor: &mut Cursor,
    now: DateTime<Utc>,
    summary: &mut SyncSummary,
) -> Result<(), Error> {
    let account = gmail.account();
    loop {
        let page = gmail.history(start, cursor.page.as_deref()).await?;
        for id in &page.added {
            if let Some(message) = gmail.get_message(id).await? {
                ingest_message(store, &message, summary)?;
            }
        }
        cursor.page = page.next_page;
        if cursor.page.is_none() {
            cursor.sync = page.history_id.or_else(|| cursor.sync.take());
            return save_cursor(store, account, GMAIL, cursor, now);
        }
        save_cursor(store, account, GMAIL, cursor, now)?;
    }
}

async fn sync_google_calendar(
    calendar: &GoogleCalendar,
    store: &Store,
    options: &SyncOptions,
    now: DateTime<Utc>,
    summary: &mut SyncSummary,
) -> Result<(), Error> {
    let account = calendar.account();
    let mut cursor = load_cursor(store, account, GOOGLE_CALENDAR)?;
    let time_min = now - TimeDelta::days(options.calendar_past_days.into());
    loop {
        let result = calendar.events_page(cursor.sync.as_deref(), cursor.page.as_deref(), time_min, options.page_size).await;
        let page = match result {
            // ponytail: rows deleted upstream during the gap stay until they age
            // out; diff the resync against stored ids if that ever matters.
            Err(Error::CursorExpired) if cursor.sync.is_some() || cursor.page.is_some() => {
                cursor = Cursor::default();
                summary.resynced = true;
                store.clear_cursor(account, GOOGLE_CALENDAR)?;
                continue;
            }
            other => other?,
        };
        for change in page.changes {
            ingest_change(store, account, change, now, summary)?;
        }
        cursor.page = page.next_page;
        if cursor.page.is_none() {
            cursor.sync = page.sync_token.or_else(|| cursor.sync.take());
            return save_cursor(store, account, GOOGLE_CALENDAR, &cursor, now);
        }
        save_cursor(store, account, GOOGLE_CALENDAR, &cursor, now)?;
    }
}

async fn sync_graph_mail(
    graph: &Graph,
    store: &Store,
    options: &SyncOptions,
    now: DateTime<Utc>,
    summary: &mut SyncSummary,
) -> Result<(), Error> {
    let account = graph.account();
    let mut cursor = load_cursor(store, account, GRAPH_MAIL)?;
    let since = now - TimeDelta::days(options.mail_window_days.into());
    loop {
        let link = cursor.page.as_deref().or(cursor.sync.as_deref());
        let page = match graph.messages_page(link, since, options.page_size).await {
            Err(Error::CursorExpired) if link.is_some() => {
                cursor = Cursor::default();
                summary.resynced = true;
                store.clear_cursor(account, GRAPH_MAIL)?;
                continue;
            }
            other => other?,
        };
        for message in &page.items {
            ingest_message(store, message, summary)?;
        }
        cursor.page = page.next_link;
        if page.delta_link.is_some() {
            cursor.sync = page.delta_link;
        }
        save_cursor(store, account, GRAPH_MAIL, &cursor, now)?;
        if cursor.page.is_none() {
            return Ok(());
        }
    }
}

async fn sync_graph_calendar(
    graph: &Graph,
    store: &Store,
    options: &SyncOptions,
    now: DateTime<Utc>,
    summary: &mut SyncSummary,
) -> Result<(), Error> {
    let account = graph.account();
    let mut cursor = load_cursor(store, account, GRAPH_CALENDAR)?;
    let horizon = TimeDelta::days(options.calendar_horizon_days.into());
    // The window is frozen when the delta opens, so it is reopened at the
    // halfway point, while everything near still lies inside it.
    if cursor.window_opened.is_some_and(|opened| now - opened > horizon / 2) {
        cursor = Cursor::default();
    }
    let window = (now - TimeDelta::days(options.calendar_past_days.into()), now + horizon);
    loop {
        let link = cursor.page.as_deref().or(cursor.sync.as_deref());
        let page = match graph.calendar_page(link, window, options.page_size).await {
            Err(Error::CursorExpired) if link.is_some() => {
                cursor = Cursor::default();
                summary.resynced = true;
                store.clear_cursor(account, GRAPH_CALENDAR)?;
                continue;
            }
            other => other?,
        };
        cursor.window_opened.get_or_insert(now);
        for change in page.items {
            ingest_change(store, account, change, now, summary)?;
        }
        cursor.page = page.next_link;
        if page.delta_link.is_some() {
            cursor.sync = page.delta_link;
        }
        save_cursor(store, account, GRAPH_CALENDAR, &cursor, now)?;
        if cursor.page.is_none() {
            return Ok(());
        }
    }
}
