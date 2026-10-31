//! SQLite persistence. An event is one JSON document plus the few columns SQL
//! needs, which keeps the merge rules in one place instead of spread over a
//! column per field.

use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};

use chrono::{DateTime, FixedOffset, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::accounts::Provider;
use crate::event::{Category, ContextEvent, EventKind, EventStatus, EventTime, Priority};
use crate::notify::{Decision, Disposition, LogEntry, Reminder};
use crate::Error;

const MIGRATIONS: &[&str] = &["
    CREATE TABLE events (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        account TEXT,
        status TEXT NOT NULL,
        user_fields TEXT NOT NULL DEFAULT '[]',
        doc TEXT NOT NULL
    );
    CREATE INDEX events_account ON events(account);
    CREATE TABLE notification_log (
        key TEXT NOT NULL,
        event_id TEXT NOT NULL,
        disposition TEXT NOT NULL,
        at TEXT NOT NULL,
        entry TEXT NOT NULL,
        PRIMARY KEY (key, disposition)
    );
    CREATE INDEX notification_log_event ON notification_log(event_id);
    CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        doc TEXT NOT NULL
    );
    CREATE TABLE sync_cursors (
        account TEXT NOT NULL,
        resource TEXT NOT NULL,
        cursor TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account, resource)
    );
"];

/// The fields whose change counts as a real update, named as they serialise,
/// which is also how `user_fields` pins them.
const COMPARED_FIELDS: &[&str] =
    &["title", "body", "startsAt", "endsAt", "status", "priority", "metadata", "suggestedActions"];

/// Metadata about a connected account. Tokens never come through here: they
/// live behind [`crate::TokenStore`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedAccount {
    pub id: String,
    pub provider: Provider,
    pub email: Option<String>,
    pub scopes: Vec<String>,
    pub connected_at: DateTime<Utc>,
    pub last_sync_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpsertOutcome {
    Inserted,
    Updated { changed: Vec<String> },
    Unchanged,
}

#[derive(Debug, Clone, Default)]
pub struct EventFilter {
    pub category: Option<Category>,
    pub account: Option<String>,
    pub kind: Option<EventKind>,
    pub min_confidence: Option<f64>,
    pub include_dismissed: bool,
    pub limit: Option<usize>,
}

/// A user's edit. Unset fields are left as they are.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Correction {
    pub title: Option<String>,
    pub body: Option<String>,
    pub starts_at: Option<EventTime>,
    pub ends_at: Option<EventTime>,
    pub priority: Option<Priority>,
    pub metadata: Option<serde_json::Map<String, Value>>,
}

/// Shareable across threads, because a connection alone is `!Sync` and that
/// would make every async sync future holding `&Store` unspawnable.
pub struct Store {
    db: Mutex<Connection>,
}

fn stored_json(_: serde_json::Error) -> Error {
    Error::Malformed("stored event")
}

fn status_text(status: EventStatus) -> Result<String, Error> {
    let value = serde_json::to_value(status).map_err(stored_json)?;
    Ok(value.as_str().unwrap_or_default().to_string())
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, Error> {
        Self::prepare(Connection::open(path)?)
    }

    pub fn in_memory() -> Result<Self, Error> {
        Self::prepare(Connection::open_in_memory()?)
    }

    fn prepare(mut db: Connection) -> Result<Self, Error> {
        let version: u32 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        let version = version as usize;
        if version > MIGRATIONS.len() {
            return Err(Error::SchemaTooNew { found: version, supported: MIGRATIONS.len() });
        }
        for (index, migration) in MIGRATIONS.iter().enumerate().skip(version) {
            let tx = db.transaction()?;
            tx.execute_batch(migration)?;
            tx.pragma_update(None, "user_version", (index + 1) as u32)?;
            tx.commit()?;
        }
        Ok(Self { db: Mutex::new(db) })
    }

    /// One writer dying mid-statement leaves SQLite itself consistent, so a
    /// poisoned lock is still safe to use.
    fn db(&self) -> MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Inserts by `dedupe_key`, or merges into the existing row. Arrival order
    /// does not matter: Gmail lists newest first, so an older message reaching
    /// a newer row only fills gaps and can never undo a cancellation.
    pub fn upsert(&self, incoming: ContextEvent) -> Result<UpsertOutcome, Error> {
        let mut db = self.db();
        let tx = db.transaction()?;
        let outcome = upsert_in(&tx, incoming)?;
        tx.commit()?;
        Ok(outcome)
    }

    pub fn get(&self, id: &str) -> Result<Option<ContextEvent>, Error> {
        let db = self.db();
        Ok(load(&db, id)?.map(|(event, _)| event))
    }

    /// Filtered and ordered in Rust because Today, Upcoming and past-ness all
    /// depend on the clock and on three kinds of time that SQL cannot compare.
    // ponytail: reads every row of a personal timeline; index a sort column if this passes ~100k rows.
    pub fn list(&self, filter: &EventFilter, now: DateTime<FixedOffset>) -> Result<Vec<ContextEvent>, Error> {
        let local = *now.offset();
        let mut events: Vec<ContextEvent> = self
            .all(filter.account.as_deref())?
            .into_iter()
            .filter(|e| filter.include_dismissed || e.status != EventStatus::Dismissed)
            .filter(|e| e.expires_at.is_none_or(|at| at > now.to_utc()))
            .filter(|e| filter.kind.is_none_or(|kind| e.kind == kind))
            .filter(|e| filter.min_confidence.is_none_or(|min| e.confidence >= min))
            .filter(|e| filter.category.is_none_or(|category| e.in_category(category, now)))
            .collect();
        events.sort_by_key(|e| e.timeline_at(local));
        events.truncate(filter.limit.unwrap_or(usize::MAX));
        Ok(events)
    }

    pub fn today(&self, now: DateTime<FixedOffset>) -> Result<Vec<ContextEvent>, Error> {
        self.list(&EventFilter { category: Some(Category::Today), ..Default::default() }, now)
    }

    pub fn upcoming(&self, now: DateTime<FixedOffset>) -> Result<Vec<ContextEvent>, Error> {
        self.list(&EventFilter { category: Some(Category::Upcoming), ..Default::default() }, now)
    }

    fn all(&self, account: Option<&str>) -> Result<Vec<ContextEvent>, Error> {
        let db = self.db();
        let mut query = db.prepare("SELECT doc FROM events WHERE ?1 IS NULL OR account = ?1")?;
        let docs = query.query_map(params![account], |row| row.get::<_, String>(0))?;
        docs.map(|doc| serde_json::from_str(&doc?).map_err(stored_json)).collect()
    }

    /// Applies a user's edit and pins the edited fields, so later sync updates
    /// the rest of the event but never these.
    pub fn correct(&self, id: &str, correction: &Correction) -> Result<ContextEvent, Error> {
        self.edit(id, |event, user_fields| {
            let mut pin = |field: &str| {
                if !user_fields.iter().any(|f| f == field) {
                    user_fields.push(field.to_string());
                }
            };
            if let Some(title) = &correction.title {
                event.title = title.clone();
                pin("title");
            }
            if let Some(body) = &correction.body {
                event.body = Some(body.clone());
                pin("body");
            }
            if let Some(starts_at) = correction.starts_at {
                event.starts_at = Some(starts_at);
                pin("startsAt");
            }
            if let Some(ends_at) = correction.ends_at {
                event.ends_at = Some(ends_at);
                pin("endsAt");
            }
            if let Some(priority) = correction.priority {
                event.priority = priority;
                pin("priority");
            }
            if let Some(metadata) = &correction.metadata {
                event.metadata = metadata.clone();
                pin("metadata");
            }
            event.user_edited = true;
        })
    }

    pub fn dismiss(&self, id: &str) -> Result<ContextEvent, Error> {
        self.edit(id, |event, _| event.status = EventStatus::Dismissed)
    }

    pub fn snooze(&self, id: &str, until: DateTime<Utc>) -> Result<ContextEvent, Error> {
        self.edit(id, |event, _| event.snoozed_until = Some(until))
    }

    fn edit(
        &self,
        id: &str,
        change: impl FnOnce(&mut ContextEvent, &mut Vec<String>),
    ) -> Result<ContextEvent, Error> {
        let mut db = self.db();
        let tx = db.transaction()?;
        let (mut event, mut user_fields) = load(&tx, id)?.ok_or_else(|| Error::UnknownEvent(id.to_string()))?;
        change(&mut event, &mut user_fields);
        write(&tx, &event, &user_fields)?;
        tx.commit()?;
        Ok(event)
    }

    /// Forgets the event. A later message about the same entity recreates it;
    /// dismiss instead to keep it gone.
    pub fn delete(&self, id: &str) -> Result<(), Error> {
        let mut db = self.db();
        let tx = db.transaction()?;
        tx.execute("DELETE FROM notification_log WHERE event_id = ?1", params![id])?;
        tx.execute("DELETE FROM events WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    /// Removes all trace of an account on disconnect, including its cursors, so
    /// connecting again starts clean.
    pub fn delete_account(&self, account: &str) -> Result<usize, Error> {
        let mut db = self.db();
        let tx = db.transaction()?;
        tx.execute(
            "DELETE FROM notification_log WHERE event_id IN (SELECT id FROM events WHERE account = ?1)",
            params![account],
        )?;
        let deleted = tx.execute("DELETE FROM events WHERE account = ?1", params![account])?;
        tx.execute("DELETE FROM sync_cursors WHERE account = ?1", params![account])?;
        tx.execute("DELETE FROM accounts WHERE id = ?1", params![account])?;
        tx.commit()?;
        Ok(deleted)
    }

    /// Drops what has expired or ended before `before`, by when the event ends
    /// rather than when its mail arrived: a renewal notice from last year can
    /// still point at next month.
    pub fn purge(&self, before: DateTime<Utc>, now: DateTime<Utc>) -> Result<usize, Error> {
        let utc = FixedOffset::east_opt(0).ok_or(Error::Malformed("UTC offset"))?;
        let stale: Vec<String> = self
            .all(None)?
            .into_iter()
            .filter(|e| {
                let ends = e.ends_at.or(e.starts_at).map_or(e.occurred_at, |t| t.instant(utc));
                ends < before || e.expires_at.is_some_and(|at| at <= now)
            })
            .map(|e| e.id)
            .collect();
        let mut db = self.db();
        let tx = db.transaction()?;
        for id in &stale {
            tx.execute("DELETE FROM notification_log WHERE event_id = ?1", params![id])?;
            tx.execute("DELETE FROM events WHERE id = ?1", params![id])?;
        }
        tx.execute("DELETE FROM notification_log WHERE at < ?1", params![before.to_rfc3339()])?;
        tx.commit()?;
        Ok(stale.len())
    }

    /// Records what a decision did, so the next one fires nothing twice.
    pub fn record_decision(&self, decision: &Decision, now: DateTime<Utc>) -> Result<(), Error> {
        let mut db = self.db();
        let tx = db.transaction()?;
        for reminder in &decision.surface {
            log_reminder(&tx, reminder, Disposition::Surfaced, now)?;
        }
        for reminder in &decision.activity_centre {
            let disposition = if reminder.hold.is_some() { Disposition::Held } else { Disposition::Centre };
            log_reminder(&tx, reminder, disposition, now)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn notification_log(&self) -> Result<Vec<LogEntry>, Error> {
        let db = self.db();
        let mut query = db.prepare("SELECT entry FROM notification_log ORDER BY at")?;
        let entries = query.query_map([], |row| row.get::<_, String>(0))?;
        entries.map(|entry| serde_json::from_str(&entry?).map_err(stored_json)).collect()
    }

    pub fn save_account(&self, account: &ConnectedAccount) -> Result<(), Error> {
        let doc = serde_json::to_string(account).map_err(stored_json)?;
        self.db().execute(
            "INSERT INTO accounts (id, doc) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET doc = ?2",
            params![account.id, doc],
        )?;
        Ok(())
    }

    pub fn mark_synced(&self, account: &str, now: DateTime<Utc>) -> Result<(), Error> {
        self.db().execute(
            "UPDATE accounts SET doc = json_set(doc, '$.lastSyncAt', ?2) WHERE id = ?1",
            params![account, now.to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn accounts(&self) -> Result<Vec<ConnectedAccount>, Error> {
        let db = self.db();
        let mut query = db.prepare("SELECT doc FROM accounts ORDER BY id")?;
        let docs = query.query_map([], |row| row.get::<_, String>(0))?;
        docs.map(|doc| serde_json::from_str(&doc?).map_err(stored_json)).collect()
    }

    pub fn cursor(&self, account: &str, resource: &str) -> Result<Option<String>, Error> {
        let db = self.db();
        let found = db
            .query_row(
                "SELECT cursor FROM sync_cursors WHERE account = ?1 AND resource = ?2",
                params![account, resource],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found)
    }

    pub fn set_cursor(&self, account: &str, resource: &str, cursor: &str, now: DateTime<Utc>) -> Result<(), Error> {
        self.db().execute(
            "INSERT INTO sync_cursors (account, resource, cursor, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(account, resource) DO UPDATE SET cursor = ?3, updated_at = ?4",
            params![account, resource, cursor, now.to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn clear_cursor(&self, account: &str, resource: &str) -> Result<(), Error> {
        self.db().execute(
            "DELETE FROM sync_cursors WHERE account = ?1 AND resource = ?2",
            params![account, resource],
        )?;
        Ok(())
    }

    /// A calendar deletion arrives as a bare provider id, with no iCal UID to
    /// build a key from. The id is kept in metadata so it finds the row even
    /// if a mail invite was the last thing to touch it.
    pub fn cancel_calendar_event(&self, account: &str, event_id: &str, now: DateTime<Utc>) -> Result<bool, Error> {
        let mut db = self.db();
        let tx = db.transaction()?;
        let id: Option<String> = tx
            .query_row(
                "SELECT id FROM events WHERE account = ?1 AND json_extract(doc, '$.metadata.calendarEventId') = ?2",
                params![account, event_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(id) = id else { return Ok(false) };
        let Some((mut event, user_fields)) = load(&tx, &id)? else { return Ok(false) };
        if matches!(event.status, EventStatus::Cancelled | EventStatus::Dismissed) {
            return Ok(false);
        }
        event.status = EventStatus::Cancelled;
        event.occurred_at = now;
        event.revision += 1;
        event.changed_fields = vec!["status".to_string()];
        write(&tx, &event, &user_fields)?;
        tx.commit()?;
        Ok(true)
    }
}

fn log_reminder(tx: &Transaction, reminder: &Reminder, disposition: Disposition, now: DateTime<Utc>) -> Result<(), Error> {
    let entry = LogEntry {
        key: reminder.key.clone(),
        event_id: reminder.event_id.clone(),
        stage: reminder.stage,
        starts_at: reminder.starts_at,
        disposition,
        at: now,
    };
    let disposition_text = serde_json::to_value(disposition).map_err(stored_json)?;
    tx.execute(
        "INSERT OR IGNORE INTO notification_log (key, event_id, disposition, at, entry) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            entry.key,
            entry.event_id,
            disposition_text.as_str().unwrap_or_default(),
            now.to_rfc3339(),
            serde_json::to_string(&entry).map_err(stored_json)?
        ],
    )?;
    Ok(())
}

fn load(db: &Connection, id: &str) -> Result<Option<(ContextEvent, Vec<String>)>, Error> {
    let row: Option<(String, String)> = db
        .query_row("SELECT doc, user_fields FROM events WHERE id = ?1", params![id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;
    row.map(decode).transpose()
}

fn load_by_key(db: &Connection, dedupe_key: &str) -> Result<Option<(ContextEvent, Vec<String>)>, Error> {
    let row: Option<(String, String)> = db
        .query_row("SELECT doc, user_fields FROM events WHERE dedupe_key = ?1", params![dedupe_key], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;
    row.map(decode).transpose()
}

fn decode((doc, user_fields): (String, String)) -> Result<(ContextEvent, Vec<String>), Error> {
    Ok((serde_json::from_str(&doc).map_err(stored_json)?, serde_json::from_str(&user_fields).map_err(stored_json)?))
}

fn write(tx: &Transaction, event: &ContextEvent, user_fields: &[String]) -> Result<(), Error> {
    tx.execute(
        "INSERT OR REPLACE INTO events (id, dedupe_key, account, status, user_fields, doc)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            event.id,
            event.dedupe_key,
            event.account(),
            status_text(event.status)?,
            serde_json::to_string(user_fields).map_err(stored_json)?,
            serde_json::to_string(event).map_err(stored_json)?
        ],
    )?;
    Ok(())
}

fn upsert_in(tx: &Transaction, mut incoming: ContextEvent) -> Result<UpsertOutcome, Error> {
    // Not an error: the same mail comes back until its page is done, so that
    // would stop the sync here on every run.
    if ![incoming.starts_at, incoming.ends_at].iter().flatten().all(EventTime::sensible) {
        return Ok(UpsertOutcome::Unchanged);
    }
    let legs = if incoming.status == EventStatus::Cancelled { cancel_each_leg(tx, &incoming)? } else { None };
    let Some((stored, user_fields)) = load_by_key(tx, &incoming.dedupe_key)? else {
        if let Some(outcome) = legs {
            return Ok(outcome);
        }
        if incoming.status == EventStatus::Active && parent_cancelled_it(tx, &incoming)? {
            incoming.status = EventStatus::Cancelled;
        }
        write(tx, &incoming, &[])?;
        return Ok(UpsertOutcome::Inserted);
    };
    let Some((merged, changed)) = merge(&stored, incoming, &user_fields)? else {
        return Ok(legs.unwrap_or(UpsertOutcome::Unchanged));
    };
    write(tx, &merged, &user_fields)?;
    Ok(UpsertOutcome::Updated { changed })
}

/// The other half of [`cancel_each_leg`]: mail lists newest first, so a
/// cancellation naming only the booking can land before the legs it covers.
fn parent_cancelled_it(tx: &Transaction, incoming: &ContextEvent) -> Result<bool, Error> {
    let mut query = tx.prepare(
        "SELECT doc, user_fields FROM events
         WHERE status = 'cancelled' AND substr(?1, 1, length(dedupe_key) + 1) = dedupe_key || ':'",
    )?;
    let rows = query.query_map(params![incoming.dedupe_key], |row| Ok((row.get(0)?, row.get(1)?)))?;
    for row in rows.collect::<Result<Vec<(String, String)>, _>>()? {
        if is_older(incoming, &decode(row)?.0) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// "Booking ABC123 was cancelled" names no leg, and an iCal CANCEL with no
/// RECURRENCE-ID names no instance, but both mean every row under that key.
fn cancel_each_leg(tx: &Transaction, cancellation: &ContextEvent) -> Result<Option<UpsertOutcome>, Error> {
    let prefix = format!("{}:", cancellation.dedupe_key);
    let mut query = tx.prepare("SELECT doc, user_fields FROM events WHERE substr(dedupe_key, 1, length(?1)) = ?1")?;
    let rows = query.query_map(params![prefix], |row| Ok((row.get(0)?, row.get(1)?)))?;
    let legs = rows.collect::<Result<Vec<(String, String)>, _>>()?;
    if legs.is_empty() {
        return Ok(None);
    }
    let mut outcome = UpsertOutcome::Unchanged;
    for leg in legs {
        let (stored, user_fields) = decode(leg)?;
        let mut update = stored.clone();
        update.status = EventStatus::Cancelled;
        update.occurred_at = cancellation.occurred_at;
        update.source_ref = cancellation.source_ref.clone();
        if let Some((merged, changed)) = merge(&stored, update, &user_fields)? {
            write(tx, &merged, &user_fields)?;
            outcome = UpsertOutcome::Updated { changed };
        }
    }
    Ok(Some(outcome))
}

/// A higher SEQUENCE beats arrival order; otherwise the later message wins.
fn is_older(incoming: &ContextEvent, stored: &ContextEvent) -> bool {
    let sequence = |event: &ContextEvent| event.metadata.get("sequence").and_then(Value::as_i64);
    match (sequence(incoming), sequence(stored)) {
        (Some(a), Some(b)) if a != b => a < b,
        _ => incoming.occurred_at < stored.occurred_at,
    }
}

/// Lays `newer` over `older`: a fact it omits is kept, never cleared, and a
/// coarser restatement of a known time does not downgrade it.
fn overlay(older: &ContextEvent, newer: &ContextEvent) -> Result<ContextEvent, Error> {
    let base = serde_json::to_value(older).map_err(stored_json)?;
    let mut merged = serde_json::to_value(newer).map_err(stored_json)?;
    if let (Value::Object(base), Value::Object(top)) = (base, &mut merged) {
        for (key, value) in base {
            let slot = top.entry(key.as_str()).or_insert(Value::Null);
            if key == "metadata" {
                if let (Value::Object(old), Value::Object(new)) = (value, &mut *slot) {
                    for (name, fact) in old {
                        new.entry(name).or_insert(fact);
                    }
                }
            } else if slot.is_null() || slot.as_array().is_some_and(Vec::is_empty) {
                *slot = value;
            }
        }
    }
    let mut merged: ContextEvent = serde_json::from_value(merged).map_err(stored_json)?;
    if let (Some(new), Some(old)) = (newer.starts_at, older.starts_at) {
        if new.is_coarser_view_of(&old) {
            merged.starts_at = Some(old);
        }
    }
    if let (Some(new), Some(old)) = (newer.ends_at, older.ends_at) {
        if new.is_coarser_view_of(&old) {
            merged.ends_at = Some(old);
        }
    }
    Ok(merged)
}

fn merge(
    stored: &ContextEvent,
    incoming: ContextEvent,
    user_fields: &[String],
) -> Result<Option<(ContextEvent, Vec<String>)>, Error> {
    let stale = is_older(&incoming, stored);
    let mut merged = if stale { overlay(&incoming, stored)? } else { overlay(stored, &incoming)? };

    merged.id = stored.id.clone();
    merged.user_edited = stored.user_edited;
    merged.snoozed_until = stored.snoozed_until;
    merged.revision = stored.revision;
    merged.changed_fields = stored.changed_fields.clone();
    if stored.status == EventStatus::Dismissed
        || (merged.status == EventStatus::Active && stored.status == EventStatus::Updated)
    {
        merged.status = stored.status;
    }

    let before = serde_json::to_value(stored).map_err(stored_json)?;
    let mut after = serde_json::to_value(&merged).map_err(stored_json)?;
    for field in user_fields {
        after[field.as_str()] = before[field.as_str()].clone();
    }
    let changed: Vec<String> =
        COMPARED_FIELDS.iter().filter(|f| before[**f] != after[**f]).map(|f| f.to_string()).collect();
    if changed.is_empty() {
        return Ok(None);
    }
    let mut merged: ContextEvent = serde_json::from_value(after).map_err(stored_json)?;
    // An old mail filling a gap is backfill, not news.
    if !stale {
        merged.revision += 1;
        merged.changed_fields = changed.clone();
        if merged.status == EventStatus::Active {
            merged.status = EventStatus::Updated;
        }
    }
    Ok(Some((merged, changed)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{EventKind, EventSource, SourceRef};
    use crate::notify::Stage;
    use chrono::{NaiveDate, TimeDelta, TimeZone};

    fn day(day: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, day, 9, 0, 0).unwrap()
    }

    fn local(day: u32) -> DateTime<FixedOffset> {
        day_utc(day).fixed_offset()
    }

    fn day_utc(day: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, day, 12, 0, 0).unwrap()
    }

    fn event(key: &str, received: DateTime<Utc>) -> ContextEvent {
        let mut event = ContextEvent::new(EventKind::Flight, EventSource::Email, "Flight BA117", key, received);
        event.source_ref = Some(SourceRef {
            account: "a@example.test".into(),
            message_id: format!("m-{key}"),
            subject: "s".into(),
            received_at: received,
            link: None,
        });
        event.starts_at = Some(EventTime::Zoned(day(20).fixed_offset()));
        event
    }

    fn cancelled(key: &str, received: DateTime<Utc>) -> ContextEvent {
        let mut update = event(key, received);
        update.status = EventStatus::Cancelled;
        update.starts_at = None;
        update
    }

    fn store() -> Store {
        Store::in_memory().unwrap()
    }

    #[test]
    fn inserts_then_reports_no_change_for_the_same_facts() {
        let store = store();
        assert_eq!(store.upsert(event("k", day(1))).unwrap(), UpsertOutcome::Inserted);
        assert_eq!(store.upsert(event("k", day(2))).unwrap(), UpsertOutcome::Unchanged);
        assert_eq!(store.all(None).unwrap().len(), 1);
    }

    #[test]
    fn an_update_keeps_the_row_and_tracks_what_changed() {
        let store = store();
        let first = event("k", day(1));
        store.upsert(first.clone()).unwrap();
        let mut moved = event("k", day(2));
        moved.starts_at = Some(EventTime::Zoned(day(21).fixed_offset()));
        let outcome = store.upsert(moved).unwrap();
        assert_eq!(outcome, UpsertOutcome::Updated { changed: vec!["startsAt".to_string()] });

        let saved = store.get(&first.id).unwrap().unwrap();
        assert_eq!(saved.status, EventStatus::Updated);
        assert_eq!(saved.revision, 2);
        assert_eq!(saved.changed_fields, ["startsAt"]);
        assert_eq!(saved.starts_at, Some(EventTime::Zoned(day(21).fixed_offset())));
    }

    #[test]
    fn a_field_the_update_omits_is_kept() {
        let store = store();
        let mut first = event("k", day(1));
        first.metadata.insert("airline".into(), "Example Air".into());
        store.upsert(first.clone()).unwrap();
        let mut update = event("k", day(2));
        update.starts_at = None;
        update.metadata.insert("gate".into(), "B7".into());
        store.upsert(update).unwrap();

        let saved = store.get(&first.id).unwrap().unwrap();
        assert_eq!(saved.starts_at, first.starts_at);
        assert_eq!(saved.metadata["airline"], "Example Air");
        assert_eq!(saved.metadata["gate"], "B7");
    }

    #[test]
    fn a_coarser_restatement_does_not_downgrade_a_zoned_time() {
        let store = store();
        let first = event("k", day(1));
        store.upsert(first.clone()).unwrap();
        let mut restated = event("k", day(2));
        restated.starts_at = Some(EventTime::Naive(day(20).naive_utc()));
        assert_eq!(store.upsert(restated).unwrap(), UpsertOutcome::Unchanged);
        assert_eq!(store.get(&first.id).unwrap().unwrap().starts_at, first.starts_at);
    }

    #[test]
    fn an_older_message_arriving_late_cannot_undo_a_cancellation() {
        let store = store();
        let id = event("k", day(1)).id;
        // Newest first, the way Gmail lists: the cancellation arrives before the booking.
        store.upsert(cancelled("k", day(3))).unwrap();
        let mut booking = event("k", day(1));
        booking.metadata.insert("airline".into(), "Example Air".into());
        store.upsert(booking).unwrap();

        let saved = store.get(&id).unwrap().unwrap();
        assert_eq!(saved.status, EventStatus::Cancelled);
        assert_eq!(saved.metadata["airline"], "Example Air", "the old mail still fills gaps");
        assert!(saved.starts_at.is_some());
        assert_eq!(saved.revision, 1, "backfill is not news");
    }

    #[test]
    fn a_higher_sequence_wins_over_arrival_order() {
        let store = store();
        let mut newer = event("ical:1", day(1));
        newer.metadata.insert("sequence".into(), 2.into());
        newer.title = "Moved".into();
        store.upsert(newer.clone()).unwrap();
        let mut older = event("ical:1", day(2));
        older.metadata.insert("sequence".into(), 1.into());
        older.title = "Original".into();
        store.upsert(older).unwrap();
        assert_eq!(store.get(&newer.id).unwrap().unwrap().title, "Moved");
    }

    #[test]
    fn a_cancellation_naming_only_the_booking_reaches_every_leg() {
        let store = store();
        let out = event("flight:ABC123:JFK-LHR", day(1));
        let back = event("flight:ABC123:LHR-JFK", day(1));
        store.upsert(out.clone()).unwrap();
        store.upsert(back.clone()).unwrap();
        store.upsert(cancelled("flight:ABC123", day(2))).unwrap();

        assert_eq!(store.all(None).unwrap().len(), 2, "no third row for the bare booking");
        assert_eq!(store.get(&out.id).unwrap().unwrap().status, EventStatus::Cancelled);
        assert_eq!(store.get(&back.id).unwrap().unwrap().status, EventStatus::Cancelled);
    }

    #[test]
    fn a_cancellation_listed_before_the_booking_still_covers_its_legs() {
        let store = store();
        // Newest first, so the cancellation meets no legs yet.
        store.upsert(cancelled("flight:ABC123", day(3))).unwrap();
        let leg = event("flight:ABC123:JFK-LHR", day(1));
        store.upsert(leg.clone()).unwrap();
        assert_eq!(store.get(&leg.id).unwrap().unwrap().status, EventStatus::Cancelled);

        let rebooked = event("flight:ABC123:LHR-JFK", day(4));
        store.upsert(rebooked.clone()).unwrap();
        assert_eq!(store.get(&rebooked.id).unwrap().unwrap().status, EventStatus::Active, "newer than the cancellation");
    }

    #[test]
    fn a_later_cancellation_reaches_the_legs_past_an_earlier_bare_row() {
        let store = store();
        store.upsert(cancelled("flight:ABC123", day(1))).unwrap();
        let leg = event("flight:ABC123:JFK-LHR", day(2));
        store.upsert(leg.clone()).unwrap();
        store.upsert(cancelled("flight:ABC123", day(3))).unwrap();
        assert_eq!(store.get(&leg.id).unwrap().unwrap().status, EventStatus::Cancelled);
    }

    #[test]
    fn a_time_at_the_edge_of_the_calendar_is_refused_and_cannot_panic() {
        let store = store();
        let edge = NaiveDate::from_ymd_opt(-262143, 1, 1).unwrap().and_hms_opt(0, 0, 0).unwrap();
        let mut forged = event("forged", day(1));
        forged.starts_at = Some(EventTime::Naive(edge));
        assert_eq!(store.upsert(forged.clone()).unwrap(), UpsertOutcome::Unchanged, "an error would stop the sync here");
        assert!(store.get(&forged.id).unwrap().is_none());
        EventTime::Naive(edge).instant(FixedOffset::east_opt(19_800).unwrap());
    }

    #[test]
    fn a_booking_prefix_does_not_reach_a_longer_lookalike() {
        let store = store();
        let other = event("flight:ABC1234:JFK-LHR", day(1));
        store.upsert(other.clone()).unwrap();
        store.upsert(cancelled("flight:ABC123", day(2))).unwrap();
        assert_eq!(store.get(&other.id).unwrap().unwrap().status, EventStatus::Active);
    }

    #[test]
    fn user_corrections_survive_sync_but_the_rest_still_updates() {
        let store = store();
        let first = event("k", day(1));
        store.upsert(first.clone()).unwrap();
        let wrong = EventTime::Zoned(day(25).fixed_offset());
        let correction = Correction { title: Some("My flight".into()), starts_at: Some(wrong), ..Default::default() };
        let corrected = store.correct(&first.id, &correction).unwrap();
        assert!(corrected.user_edited);

        let mut update = event("k", day(2));
        update.title = "Flight BA117 retimed".into();
        update.starts_at = Some(EventTime::Zoned(day(22).fixed_offset()));
        update.body = Some("Gate B7".into());
        let outcome = store.upsert(update).unwrap();
        assert_eq!(outcome, UpsertOutcome::Updated { changed: vec!["body".to_string()] });

        let saved = store.get(&first.id).unwrap().unwrap();
        assert_eq!(saved.title, "My flight");
        assert_eq!(saved.starts_at, Some(wrong));
        assert_eq!(saved.body.as_deref(), Some("Gate B7"));
        assert!(saved.user_edited);
    }

    #[test]
    fn a_source_cancellation_still_lands_on_a_corrected_event() {
        let store = store();
        let first = event("k", day(1));
        store.upsert(first.clone()).unwrap();
        store.correct(&first.id, &Correction { title: Some("Mine".into()), ..Default::default() }).unwrap();
        store.upsert(cancelled("k", day(2))).unwrap();
        let saved = store.get(&first.id).unwrap().unwrap();
        assert_eq!(saved.status, EventStatus::Cancelled);
        assert_eq!(saved.title, "Mine");
    }

    #[test]
    fn dismissal_survives_updates() {
        let store = store();
        let first = event("k", day(1));
        store.upsert(first.clone()).unwrap();
        store.dismiss(&first.id).unwrap();
        let mut update = event("k", day(2));
        update.title = "Retimed".into();
        store.upsert(update).unwrap();
        let saved = store.get(&first.id).unwrap().unwrap();
        assert_eq!(saved.status, EventStatus::Dismissed);
        assert_eq!(saved.title, "Retimed");
    }

    #[test]
    fn a_snooze_survives_updates() {
        let store = store();
        let first = event("k", day(1));
        store.upsert(first.clone()).unwrap();
        store.snooze(&first.id, day(3)).unwrap();
        let mut update = event("k", day(2));
        update.title = "Retimed".into();
        store.upsert(update).unwrap();
        assert_eq!(store.get(&first.id).unwrap().unwrap().snoozed_until, Some(day(3)));
    }

    #[test]
    fn editing_an_unknown_event_is_a_typed_error() {
        assert!(matches!(store().dismiss("nope"), Err(Error::UnknownEvent(_))));
    }

    #[test]
    fn lists_today_and_upcoming_with_filters() {
        let store = store();
        let now = local(5);
        let mut today = event("today", day(1));
        today.starts_at = Some(EventTime::Date(NaiveDate::from_ymd_opt(2026, 11, 5).unwrap()));
        let mut soon = event("soon", day(1));
        soon.starts_at = Some(EventTime::Zoned(day(6).fixed_offset()));
        let mut later = event("later", day(1));
        later.starts_at = Some(EventTime::Naive(day(20).naive_utc()));
        later.confidence = 0.4;
        let mut dismissed = event("dismissed", day(1));
        dismissed.starts_at = Some(EventTime::Zoned(day(7).fixed_offset()));
        for item in [today, later, soon, dismissed.clone()] {
            store.upsert(item).unwrap();
        }
        store.dismiss(&dismissed.id).unwrap();

        assert_eq!(store.today(now).unwrap().len(), 1);
        let upcoming = store.upcoming(now).unwrap();
        assert_eq!(upcoming.iter().map(|e| e.dedupe_key.as_str()).collect::<Vec<_>>(), ["soon", "later"]);

        let confident = EventFilter { category: Some(Category::Upcoming), min_confidence: Some(0.5), ..Default::default() };
        assert_eq!(store.list(&confident, now).unwrap().len(), 1);
        let limited = EventFilter { category: Some(Category::Travel), limit: Some(1), ..Default::default() };
        assert_eq!(store.list(&limited, now).unwrap().len(), 1);
        let all = EventFilter { category: Some(Category::Travel), include_dismissed: true, ..Default::default() };
        assert_eq!(store.list(&all, now).unwrap().len(), 4);
    }

    #[test]
    fn an_expired_event_leaves_the_timeline() {
        let store = store();
        let mut gone = event("k", day(1));
        gone.expires_at = Some(day(2));
        store.upsert(gone).unwrap();
        let everything = EventFilter { category: Some(Category::Travel), ..Default::default() };
        assert!(store.list(&everything, local(5)).unwrap().is_empty());
    }

    #[test]
    fn delete_removes_the_event_and_its_notification_history() {
        let store = store();
        let first = event("k", day(1));
        store.upsert(first.clone()).unwrap();
        let reminder = Reminder {
            key: "r".into(),
            event_id: first.id.clone(),
            stage: Stage::Changed,
            priority: Priority::Low,
            title: "t".into(),
            starts_at: None,
            approximate_time: false,
            replaces: None,
            hold: None,
        };
        let decision = Decision { surface: vec![reminder], activity_centre: Vec::new() };
        store.record_decision(&decision, day(2)).unwrap();
        store.record_decision(&decision, day(3)).unwrap();
        assert_eq!(store.notification_log().unwrap().len(), 1, "recording is idempotent");

        store.delete(&first.id).unwrap();
        assert!(store.get(&first.id).unwrap().is_none());
        assert!(store.notification_log().unwrap().is_empty());
    }

    #[test]
    fn deleting_an_account_removes_only_its_data() {
        let store = store();
        let mine = event("mine", day(1));
        let mut theirs = event("theirs", day(1));
        theirs.source_ref.as_mut().unwrap().account = "b@example.test".into();
        store.upsert(mine.clone()).unwrap();
        store.upsert(theirs.clone()).unwrap();
        store.set_cursor("a@example.test", "gmail", "{}", day(1)).unwrap();
        store.set_cursor("b@example.test", "gmail", "{}", day(1)).unwrap();
        store
            .save_account(&ConnectedAccount {
                id: "a@example.test".into(),
                provider: Provider::Google,
                email: Some("a@example.test".into()),
                scopes: vec![],
                connected_at: day(1),
                last_sync_at: None,
            })
            .unwrap();

        store.mark_synced("a@example.test", day(2)).unwrap();
        assert_eq!(store.accounts().unwrap()[0].last_sync_at, Some(day(2)));

        assert_eq!(store.delete_account("a@example.test").unwrap(), 1);
        assert!(store.get(&mine.id).unwrap().is_none());
        assert!(store.get(&theirs.id).unwrap().is_some());
        assert_eq!(store.cursor("a@example.test", "gmail").unwrap(), None);
        assert!(store.cursor("b@example.test", "gmail").unwrap().is_some());
        assert!(store.accounts().unwrap().is_empty());
    }

    #[test]
    fn purge_goes_by_when_events_end_not_when_mail_arrived() {
        let store = store();
        let mut old_mail_future_event = event("renewal", day(1) - TimeDelta::days(400));
        old_mail_future_event.starts_at = Some(EventTime::Zoned(day(20).fixed_offset()));
        let mut finished = event("finished", day(1) - TimeDelta::days(400));
        finished.starts_at = Some(EventTime::Zoned((day(1) - TimeDelta::days(399)).fixed_offset()));
        let mut expired = event("expired", day(1));
        expired.expires_at = Some(day(2));
        store.upsert(old_mail_future_event.clone()).unwrap();
        store.upsert(finished).unwrap();
        store.upsert(expired).unwrap();

        assert_eq!(store.purge(day(1) - TimeDelta::days(90), day(5)).unwrap(), 2);
        assert_eq!(store.all(None).unwrap().len(), 1);
        assert!(store.get(&old_mail_future_event.id).unwrap().is_some());
    }

    #[test]
    fn a_calendar_deletion_finds_the_row_by_provider_id() {
        let store = store();
        let mut meeting = event("ical:1", day(1));
        meeting.metadata.insert("calendarEventId".into(), "gcal-1".into());
        store.upsert(meeting.clone()).unwrap();

        assert!(store.cancel_calendar_event("a@example.test", "gcal-1", day(2)).unwrap());
        assert_eq!(store.get(&meeting.id).unwrap().unwrap().status, EventStatus::Cancelled);
        assert!(!store.cancel_calendar_event("a@example.test", "gcal-1", day(3)).unwrap(), "already cancelled");
        assert!(!store.cancel_calendar_event("b@example.test", "gcal-1", day(3)).unwrap(), "another account");
    }

    #[test]
    fn migrates_once_and_refuses_a_newer_schema() {
        let path = std::env::temp_dir().join(format!("activity-test-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let store = Store::open(&path).unwrap();
            store.upsert(event("k", day(1))).unwrap();
            let version: u32 = store.db().query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
            assert_eq!(version as usize, MIGRATIONS.len());
        }
        {
            let reopened = Store::open(&path).unwrap();
            assert_eq!(reopened.all(None).unwrap().len(), 1);
            reopened.db().pragma_update(None, "user_version", MIGRATIONS.len() as u32 + 1).unwrap();
        }
        assert!(matches!(Store::open(&path), Err(Error::SchemaTooNew { .. })));
        let _ = std::fs::remove_file(&path);
    }
}
