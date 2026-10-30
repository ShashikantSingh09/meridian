//! Google Calendar, read-only.

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::Value;

use super::{CalendarChange, Session};
use crate::event::{ContextEvent, EventKind, EventSource, EventStatus, EventTime, Priority, SourceRef};
use crate::extract::dates::parse_iso;
use crate::extract::{is_meeting_link, join_action};
use crate::Error;

pub const BASE_URL: &str = "https://www.googleapis.com";

/// Not meetings: these mark the user's own status on the calendar.
const STATUS_EVENT_TYPES: &[&str] = &["workingLocation", "focusTime", "outOfOffice"];

pub struct GoogleCalendar {
    session: Session,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CalendarPage {
    pub changes: Vec<CalendarChange>,
    pub next_page: Option<String>,
    pub sync_token: Option<String>,
}

impl GoogleCalendar {
    pub fn new(session: Session) -> Self {
        Self { session }
    }

    pub fn account(&self) -> &str {
        self.session.account()
    }

    /// One page of the primary calendar. With `sync_token` it returns changes
    /// since then, and Google rejects `timeMin` alongside one; without it,
    /// everything from `time_min`. `singleEvents` must match across both or the
    /// token's meaning is undefined. An expired token is [`Error::CursorExpired`].
    pub async fn events_page(
        &self,
        sync_token: Option<&str>,
        page: Option<&str>,
        time_min: DateTime<Utc>,
        size: u32,
    ) -> Result<CalendarPage, Error> {
        let mut query = vec![("singleEvents", "true".to_string()), ("maxResults", size.to_string())];
        match sync_token {
            Some(token) => query.push(("syncToken", token.to_string())),
            None => query.push(("timeMin", time_min.to_rfc3339_opts(SecondsFormat::Secs, true))),
        }
        if let Some(page) = page {
            query.push(("pageToken", page.to_string()));
        }
        let value = self.session.get("calendar/v3/calendars/primary/events", &query).await?;
        let items = value["items"].as_array().ok_or(Error::Malformed("calendar events"))?;
        Ok(CalendarPage {
            changes: items.iter().filter_map(|item| change(self.session.account(), item)).collect(),
            next_page: value["nextPageToken"].as_str().map(str::to_string),
            sync_token: value["nextSyncToken"].as_str().map(str::to_string),
        })
    }
}

fn change(account: &str, item: &Value) -> Option<CalendarChange> {
    let id = item["id"].as_str()?;
    // A deletion often has nothing but the id, so it cannot be mapped.
    if item["status"].as_str() == Some("cancelled") {
        return Some(CalendarChange::Removed(id.to_string()));
    }
    if item["eventType"].as_str().is_some_and(|t| STATUS_EVENT_TYPES.contains(&t)) {
        return None;
    }
    Some(CalendarChange::Event(Box::new(event(account, id, item)?)))
}

fn time(value: &Value) -> Option<EventTime> {
    value["dateTime"].as_str().or(value["date"].as_str()).and_then(parse_iso)
}

fn dedupe_key(id: &str, item: &Value) -> String {
    let Some(uid) = item["iCalUID"].as_str() else { return format!("gcal:{id}") };
    // Every instance of a series shares one UID.
    match time(&item["originalStartTime"]) {
        Some(instance) => format!("ical:{uid}:{instance}"),
        None => format!("ical:{uid}"),
    }
}

fn join_link(item: &Value) -> Option<String> {
    let video = item["conferenceData"]["entryPoints"].as_array().and_then(|points| {
        points.iter().find(|p| p["entryPointType"] == "video").and_then(|p| p["uri"].as_str())
    });
    let location = item["location"].as_str().filter(|l| is_meeting_link(l));
    item["hangoutLink"].as_str().or(video).or(location).map(str::to_string)
}

fn event(account: &str, id: &str, item: &Value) -> Option<ContextEvent> {
    let updated = item["updated"].as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok())?.to_utc();
    let title = item["summary"].as_str().unwrap_or("Untitled event");
    let mut event = ContextEvent::new(EventKind::Meeting, EventSource::Calendar, title, dedupe_key(id, item), updated);
    event.confidence = 1.0;
    event.starts_at = time(&item["start"]);
    // All-day ends are exclusive here; the model stores the last day.
    event.ends_at = match time(&item["end"]) {
        Some(EventTime::Date(date)) => date.pred_opt().map(EventTime::Date),
        other => other,
    };
    event.priority = match event.starts_at {
        Some(EventTime::Date(_)) => Priority::Informational,
        _ => Priority::Important,
    };
    event.status = EventStatus::Active;
    event.body = item["location"].as_str().map(str::to_string);
    let link = item["htmlLink"].as_str().map(str::to_string);
    event.source_ref = Some(SourceRef {
        account: account.to_string(),
        message_id: id.to_string(),
        subject: title.to_string(),
        received_at: updated,
        link,
    });
    event.suggested_actions.extend(join_link(item).as_deref().and_then(join_action));

    let metadata = &mut event.metadata;
    metadata.insert("calendarEventId".into(), id.into());
    if let Some(sequence) = item["sequence"].as_i64() {
        metadata.insert("sequence".into(), sequence.into());
    }
    if let Some(organizer) = item["organizer"]["displayName"].as_str().or(item["organizer"]["email"].as_str()) {
        metadata.insert("organizer".into(), organizer.into());
    }
    let attendees = item["attendees"].as_array().map(Vec::as_slice).unwrap_or_default();
    if let Some(me) = attendees.iter().find(|a| a["self"] == true) {
        if let Some(response) = me["responseStatus"].as_str() {
            metadata.insert("responseStatus".into(), response.into());
        }
    }
    Some(event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item() -> Value {
        json!({
            "id": "evt1",
            "status": "confirmed",
            "summary": "Design review",
            "iCalUID": "uid-1@google.test",
            "updated": "2026-10-01T09:00:00.000Z",
            "start": { "dateTime": "2026-11-05T10:00:00-05:00", "timeZone": "America/New_York" },
            "end": { "dateTime": "2026-11-05T11:00:00-05:00" },
            "hangoutLink": "https://meet.google.com/abc-defg-hij",
            "attendees": [
                { "email": "other@example.test", "responseStatus": "accepted" },
                { "email": "me@example.test", "self": true, "responseStatus": "declined" }
            ],
            "htmlLink": "https://calendar.google.com/event?eid=1"
        })
    }

    fn mapped(item: &Value) -> ContextEvent {
        match change("me@example.test", item) {
            Some(CalendarChange::Event(event)) => *event,
            other => panic!("expected an event, got {other:?}"),
        }
    }

    #[test]
    fn maps_a_meeting_with_a_join_action_and_the_users_response() {
        let event = mapped(&item());
        assert_eq!(event.dedupe_key, "ical:uid-1@google.test");
        assert_eq!(event.kind, EventKind::Meeting);
        assert_eq!(event.starts_at.unwrap().to_string(), "2026-11-05T15:00:00Z");
        assert_eq!(event.suggested_actions[0].action_id, "join");
        assert_eq!(event.metadata["responseStatus"], "declined");
        assert_eq!(event.metadata["calendarEventId"], "evt1");
    }

    #[test]
    fn an_all_day_event_keeps_its_date_and_the_inclusive_last_day() {
        let mut value = item();
        value["start"] = json!({ "date": "2026-11-05" });
        value["end"] = json!({ "date": "2026-11-06" });
        let event = mapped(&value);
        assert!(matches!(event.starts_at, Some(EventTime::Date(_))));
        assert_eq!(event.starts_at, event.ends_at);
        assert_eq!(event.priority, Priority::Informational);
    }

    #[test]
    fn instances_of_a_series_get_their_own_keys() {
        let mut first = item();
        first["originalStartTime"] = json!({ "dateTime": "2026-11-05T15:00:00Z" });
        let mut second = item();
        second["originalStartTime"] = json!({ "dateTime": "2026-11-12T15:00:00Z" });
        assert_ne!(mapped(&first).dedupe_key, mapped(&second).dedupe_key);
    }

    #[test]
    fn a_tombstone_with_only_an_id_is_a_removal() {
        let tombstone = json!({ "id": "evt1", "status": "cancelled" });
        assert_eq!(change("me@example.test", &tombstone), Some(CalendarChange::Removed("evt1".into())));
    }

    #[test]
    fn working_location_is_not_a_meeting() {
        let mut value = item();
        value["eventType"] = json!("workingLocation");
        assert_eq!(change("me@example.test", &value), None);
    }

    #[test]
    fn a_meeting_link_in_the_location_becomes_join() {
        let mut value = item();
        value.as_object_mut().unwrap().remove("hangoutLink");
        value["location"] = json!("https://acme.zoom.us/j/123");
        assert_eq!(mapped(&value).suggested_actions[0].action_id, "join");
        value["location"] = json!("Room 4");
        assert!(mapped(&value).suggested_actions.is_empty());
    }
}
