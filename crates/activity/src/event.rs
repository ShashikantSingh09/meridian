//! The one shape every source is reduced to, so the timeline, the store and the
//! notification engine never need to know where something came from.

use std::fmt;

use chrono::{DateTime, Datelike, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime, SecondsFormat, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EventKind {
    DesktopActivity,
    ScreenUnderstanding,
    AiSession,
    MediaSession,
    Email,
    Meeting,
    Flight,
    Hotel,
    RentalCar,
    Restaurant,
    EventTicket,
    Order,
    Delivery,
    ReturnDeadline,
    SubscriptionRenewal,
    PaymentReminder,
    Appointment,
    UserReminder,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EventSource {
    Desktop,
    Screen,
    AiSession,
    Media,
    Email,
    Calendar,
    User,
}

/// Ordered so `max` picks the more urgent of two.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Priority {
    Low,
    Informational,
    Important,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EventStatus {
    Active,
    Updated,
    Cancelled,
    Completed,
    Dismissed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    Today,
    Upcoming,
    Travel,
    Deliveries,
    Meetings,
    Orders,
    ImportantDates,
    Completed,
}

/// When something happens, at the precision the source actually stated. A date
/// or wall-clock value is not an instant, and treating one as zoned would invent
/// a timezone, so the three stay distinct all the way to the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum EventTime {
    Date(NaiveDate),
    Naive(NaiveDateTime),
    Zoned(DateTime<FixedOffset>),
}

impl EventTime {
    /// Where this falls for someone at `local`. Only `Zoned` is exact: the
    /// others are read as that person's wall clock, which is a scheduling
    /// convenience and never written back to the event.
    pub fn instant(&self, local: FixedOffset) -> DateTime<Utc> {
        let shift = TimeDelta::seconds(local.local_minus_utc().into());
        let wall_clock = |naive: NaiveDateTime| naive.checked_sub_signed(shift).unwrap_or(naive).and_utc();
        match self {
            Self::Date(date) => wall_clock(date.and_time(NaiveTime::MIN)),
            Self::Naive(naive) => wall_clock(*naive),
            Self::Zoned(zoned) => zoned.to_utc(),
        }
    }

    pub fn local_date(&self, local: FixedOffset) -> NaiveDate {
        match self {
            Self::Date(date) => *date,
            Self::Naive(naive) => naive.date(),
            Self::Zoned(zoned) => zoned.with_timezone(&local).date_naive(),
        }
    }

    pub fn is_exact(&self) -> bool {
        matches!(self, Self::Zoned(_))
    }

    /// A year anything real could fall in. Mail chooses these values, and one at
    /// the edge of what the calendar holds breaks every later sum on it.
    pub fn sensible(&self) -> bool {
        let year = match self {
            Self::Date(date) => date.year(),
            Self::Naive(naive) => naive.year(),
            Self::Zoned(zoned) => zoned.year(),
        };
        (1900..=2200).contains(&year)
    }

    /// A date-only or naive restatement of `finer` adds nothing, while a
    /// different value is a real change.
    pub fn is_coarser_view_of(&self, finer: &EventTime) -> bool {
        match (self, finer) {
            (Self::Date(date), Self::Naive(naive)) => *date == naive.date(),
            (Self::Date(date), Self::Zoned(zoned)) => *date == zoned.date_naive(),
            (Self::Naive(naive), Self::Zoned(zoned)) => *naive == zoned.naive_local(),
            _ => false,
        }
    }
}

impl fmt::Display for EventTime {
    /// Stable text for reminder keys: an offset restated differently is still
    /// the same moment.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Date(date) => write!(f, "{date}"),
            Self::Naive(naive) => write!(f, "{}", naive.format("%Y-%m-%dT%H:%M:%S")),
            Self::Zoned(zoned) => f.write_str(&zoned.to_utc().to_rfc3339_opts(SecondsFormat::Secs, true)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedAction {
    pub label: String,
    pub action_id: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    pub account: String,
    pub message_id: String,
    pub subject: String,
    pub received_at: DateTime<Utc>,
    pub link: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextEvent {
    pub id: String,
    pub kind: EventKind,
    pub source: EventSource,
    pub occurred_at: DateTime<Utc>,
    pub starts_at: Option<EventTime>,
    /// For a date-only value this is the last day included, not the exclusive
    /// end that iCalendar and the calendar APIs use.
    pub ends_at: Option<EventTime>,
    pub title: String,
    pub body: Option<String>,
    pub metadata: Map<String, Value>,
    pub confidence: f64,
    pub priority: Priority,
    pub status: EventStatus,
    pub suggested_actions: Vec<SuggestedAction>,
    pub expires_at: Option<DateTime<Utc>>,
    pub dedupe_key: String,
    pub source_ref: Option<SourceRef>,
    /// Set by the store: the user changed this and sync must not undo it.
    pub user_edited: bool,
    /// Set by the store: bumped each time a newer source changes the event.
    pub revision: u32,
    /// Set by the store: what the latest revision changed, as camelCase names.
    pub changed_fields: Vec<String>,
    pub snoozed_until: Option<DateTime<Utc>>,
}

impl ContextEvent {
    /// The id derives from the key, so the same entity keeps one id however it
    /// arrives and notification history stays attached to it.
    pub fn new(
        kind: EventKind,
        source: EventSource,
        title: impl Into<String>,
        dedupe_key: impl Into<String>,
        occurred_at: DateTime<Utc>,
    ) -> Self {
        let dedupe_key = dedupe_key.into();
        Self {
            id: Sha256::digest(dedupe_key.as_bytes()).iter().take(16).map(|b| format!("{b:02x}")).collect(),
            kind,
            source,
            occurred_at,
            starts_at: None,
            ends_at: None,
            title: title.into(),
            body: None,
            metadata: Map::new(),
            confidence: 1.0,
            priority: Priority::Informational,
            status: EventStatus::Active,
            suggested_actions: Vec::new(),
            expires_at: None,
            dedupe_key,
            source_ref: None,
            user_edited: false,
            revision: 1,
            changed_fields: Vec::new(),
            snoozed_until: None,
        }
    }

    pub fn account(&self) -> Option<&str> {
        self.source_ref.as_ref().map(|s| s.account.as_str())
    }

    /// Where the event sits on a timeline read from `local`.
    pub fn timeline_at(&self, local: FixedOffset) -> DateTime<Utc> {
        self.starts_at.or(self.ends_at).map_or(self.occurred_at, |t| t.instant(local))
    }

    /// The category that owns this event for preferences, whatever the date.
    pub fn home_category(&self) -> Option<Category> {
        match self.kind {
            EventKind::Flight | EventKind::Hotel | EventKind::RentalCar => Some(Category::Travel),
            EventKind::Delivery => Some(Category::Deliveries),
            EventKind::Meeting => Some(Category::Meetings),
            EventKind::Order => Some(Category::Orders),
            EventKind::Restaurant
            | EventKind::EventTicket
            | EventKind::ReturnDeadline
            | EventKind::SubscriptionRenewal
            | EventKind::PaymentReminder
            | EventKind::Appointment
            | EventKind::UserReminder => Some(Category::ImportantDates),
            EventKind::DesktopActivity
            | EventKind::ScreenUnderstanding
            | EventKind::AiSession
            | EventKind::MediaSession
            | EventKind::Email => None,
        }
    }

    /// Today and Upcoming depend on the clock, so an event can be in several
    /// categories at once: a flight today is both Today and Travel.
    pub fn in_category(&self, category: Category, now: DateTime<FixedOffset>) -> bool {
        let local = *now.offset();
        let today = now.date_naive();
        let open = !matches!(self.status, EventStatus::Cancelled | EventStatus::Dismissed | EventStatus::Completed);
        let first = self.starts_at.or(self.ends_at);
        let last = self.ends_at.or(self.starts_at);
        match category {
            Category::Today => {
                open && first.is_some_and(|t| t.local_date(local) <= today)
                    && last.is_some_and(|t| t.local_date(local) >= today)
            }
            Category::Upcoming => open && first.is_some_and(|t| t.local_date(local) > today),
            Category::Completed => {
                self.status == EventStatus::Completed || (open && last.is_some_and(|t| is_past(t, now)))
            }
            home => self.home_category() == Some(home),
        }
    }
}

/// A date-only value is past only once its whole day is.
fn is_past(time: EventTime, now: DateTime<FixedOffset>) -> bool {
    match time {
        EventTime::Date(date) => date < now.date_naive(),
        other => other.instant(*now.offset()) < now,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;

    fn now() -> DateTime<FixedOffset> {
        FixedOffset::east_opt(3600).unwrap().with_ymd_and_hms(2026, 11, 5, 12, 0, 0).unwrap()
    }

    fn event_at(kind: EventKind, starts_at: EventTime) -> ContextEvent {
        let mut event = ContextEvent::new(kind, EventSource::Email, "t", "k", now().to_utc());
        event.starts_at = Some(starts_at);
        event
    }

    #[test]
    fn serialises_camel_case_and_keeps_time_precision_visible() {
        let mut event = ContextEvent::new(EventKind::ReturnDeadline, EventSource::Email, "t", "k", now().to_utc());
        event.starts_at = Some(EventTime::Date(NaiveDate::from_ymd_opt(2026, 11, 20).unwrap()));
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["kind"], "returnDeadline");
        assert_eq!(value["dedupeKey"], "k");
        assert_eq!(value["priority"], "informational");
        assert_eq!(value["startsAt"], json!({ "kind": "date", "value": "2026-11-20" }));
        assert_eq!(serde_json::from_value::<ContextEvent>(value).unwrap(), event);
    }

    #[test]
    fn same_key_gets_the_same_id() {
        let a = ContextEvent::new(EventKind::Order, EventSource::Email, "a", "order:x", now().to_utc());
        let b = ContextEvent::new(EventKind::Delivery, EventSource::Calendar, "b", "order:x", now().to_utc());
        assert_eq!(a.id, b.id);
    }

    #[test]
    fn a_flight_today_is_in_today_and_travel_but_not_upcoming() {
        let event = event_at(EventKind::Flight, EventTime::Zoned(now() + TimeDelta::hours(2)));
        assert!(event.in_category(Category::Today, now()));
        assert!(event.in_category(Category::Travel, now()));
        assert!(!event.in_category(Category::Upcoming, now()));
    }

    #[test]
    fn local_day_decides_today_not_the_utc_day() {
        // 23:30 UTC on the 4th is already the 5th at UTC+1.
        let late = chrono::Utc.with_ymd_and_hms(2026, 11, 4, 23, 30, 0).unwrap().fixed_offset();
        let event = event_at(EventKind::Meeting, EventTime::Zoned(late));
        assert!(event.in_category(Category::Today, now()));
    }

    #[test]
    fn a_date_only_event_is_not_past_until_its_day_ends() {
        let today = event_at(EventKind::ReturnDeadline, EventTime::Date(now().date_naive()));
        assert!(!today.in_category(Category::Completed, now()));
        assert!(today.in_category(Category::Today, now()));
        let yesterday = event_at(EventKind::ReturnDeadline, EventTime::Date(now().date_naive().pred_opt().unwrap()));
        assert!(yesterday.in_category(Category::Completed, now()));
    }

    #[test]
    fn a_stay_spanning_today_counts_as_today() {
        let mut event = event_at(EventKind::Hotel, EventTime::Date(now().date_naive().pred_opt().unwrap()));
        event.ends_at = Some(EventTime::Date(now().date_naive().succ_opt().unwrap()));
        assert!(event.in_category(Category::Today, now()));
    }

    #[test]
    fn cancelled_events_leave_today_but_stay_in_their_home_category() {
        let mut event = event_at(EventKind::Flight, EventTime::Zoned(now() + TimeDelta::hours(2)));
        event.status = EventStatus::Cancelled;
        assert!(!event.in_category(Category::Today, now()));
        assert!(event.in_category(Category::Travel, now()));
    }

    #[test]
    fn recognises_a_coarser_restatement_of_the_same_moment() {
        let zoned = EventTime::Zoned(now());
        let naive = EventTime::Naive(now().naive_local());
        let date = EventTime::Date(now().date_naive());
        assert!(naive.is_coarser_view_of(&zoned));
        assert!(date.is_coarser_view_of(&zoned));
        assert!(date.is_coarser_view_of(&naive));
        let moved = EventTime::Naive(now().naive_local() + TimeDelta::hours(1));
        assert!(!moved.is_coarser_view_of(&zoned));
    }
}
