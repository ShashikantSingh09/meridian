//! Microsoft Graph, read-only: inbox messages and calendarView, both through
//! delta queries, which is the only way Graph reports a deleted event.

use chrono::{DateTime, NaiveDateTime, SecondsFormat, Utc};
use serde_json::Value;

use super::{CalendarChange, Profile, Session};
use crate::event::{ContextEvent, EventKind, EventSource, EventStatus, EventTime, Priority, SourceRef};
use crate::extract::dates::in_zone;
use crate::extract::{is_meeting_link, join_action, Message};
use crate::Error;

pub const BASE_URL: &str = "https://graph.microsoft.com/v1.0";

/// Graph strips `<script>` from HTML bodies by default, and the JSON-LD lives
/// there. The HTML is only ever parsed, never rendered.
const UNSAFE_HTML: &str = "outlook.allow-unsafe-html";
/// Asking for UTC removes every Windows zone name from the responses.
const UTC_TIMES: &str = "outlook.timezone=\"UTC\"";

pub struct Graph {
    session: Session,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeltaPage<T> {
    pub items: Vec<T>,
    pub next_link: Option<String>,
    pub delta_link: Option<String>,
}

fn string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

fn links(value: &Value) -> (Option<String>, Option<String>) {
    (string(&value["@odata.nextLink"]), string(&value["@odata.deltaLink"]))
}

impl Graph {
    pub fn new(session: Session) -> Self {
        Self { session }
    }

    pub fn account(&self) -> &str {
        self.session.account()
    }

    pub async fn profile(&self) -> Result<Profile, Error> {
        let value = self.session.get("me", &[]).await?;
        Ok(Profile {
            email: string(&value["mail"]).or_else(|| string(&value["userPrincipalName"])),
            display_name: string(&value["displayName"]),
        })
    }

    /// Follows `link` if resuming, otherwise opens a delta over mail since
    /// `since`. An expired link is [`Error::CursorExpired`].
    pub async fn messages_page(
        &self,
        link: Option<&str>,
        since: DateTime<Utc>,
        size: u32,
    ) -> Result<DeltaPage<Message>, Error> {
        let prefer = format!("{UNSAFE_HTML}, odata.maxpagesize={size}");
        let value = match link {
            Some(link) => self.session.follow(link, &prefer).await?,
            None => {
                let query = [
                    ("$select", "id,subject,from,receivedDateTime,body,webLink".to_string()),
                    ("$filter", format!("receivedDateTime ge {}", since.to_rfc3339_opts(SecondsFormat::Secs, true))),
                    ("$orderby", "receivedDateTime desc".to_string()),
                ];
                self.session.get_with_prefer("me/mailFolders/inbox/messages/delta", &query, &prefer).await?
            }
        };
        let listed = value["value"].as_array().ok_or(Error::Malformed("Graph messages"))?;
        let (next_link, delta_link) = links(&value);
        Ok(DeltaPage {
            items: listed.iter().filter_map(|item| message(self.session.account(), item)).collect(),
            next_link,
            delta_link,
        })
    }

    /// The window is fixed when the delta opens, so sync restarts it before it
    /// runs out rather than miss what lies beyond.
    pub async fn calendar_page(
        &self,
        link: Option<&str>,
        window: (DateTime<Utc>, DateTime<Utc>),
        size: u32,
    ) -> Result<DeltaPage<CalendarChange>, Error> {
        let prefer = format!("{UTC_TIMES}, odata.maxpagesize={size}");
        let value = match link {
            Some(link) => self.session.follow(link, &prefer).await?,
            None => {
                let query = [
                    ("startDateTime", window.0.to_rfc3339_opts(SecondsFormat::Secs, true)),
                    ("endDateTime", window.1.to_rfc3339_opts(SecondsFormat::Secs, true)),
                ];
                self.session.get_with_prefer("me/calendarView/delta", &query, &prefer).await?
            }
        };
        let listed = value["value"].as_array().ok_or(Error::Malformed("Graph calendar"))?;
        let (next_link, delta_link) = links(&value);
        Ok(DeltaPage {
            items: listed.iter().filter_map(|item| change(self.session.account(), item)).collect(),
            next_link,
            delta_link,
        })
    }
}

fn message(account: &str, item: &Value) -> Option<Message> {
    if !item["@removed"].is_null() {
        return None;
    }
    let id = string(&item["id"])?;
    let received_at = item["receivedDateTime"].as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok())?.to_utc();
    let sender = &item["from"]["emailAddress"];
    let from = match (sender["name"].as_str(), sender["address"].as_str()) {
        (Some(name), Some(address)) => format!("{name} <{address}>"),
        (None, Some(address)) => address.to_string(),
        _ => String::new(),
    };
    let subject = string(&item["subject"]).unwrap_or_default();
    let content = string(&item["body"]["content"]);
    let html = item["body"]["contentType"].as_str().is_some_and(|t| t.eq_ignore_ascii_case("html"));
    Some(Message {
        source_ref: SourceRef {
            account: account.to_string(),
            message_id: id,
            subject: subject.clone(),
            received_at,
            link: string(&item["webLink"]),
        },
        from,
        subject,
        received_at,
        text: if html { None } else { content.clone() },
        html: if html { content } else { None },
        // Graph does not expose the text/calendar part; meetings come from calendarView.
        calendar: None,
    })
}

fn change(account: &str, item: &Value) -> Option<CalendarChange> {
    let id = item["id"].as_str()?;
    if !item["@removed"].is_null() {
        return Some(CalendarChange::Removed(id.to_string()));
    }
    Some(CalendarChange::Event(Box::new(event(account, id, item)?)))
}

/// Times come back as a bare local value beside a zone name, with seven decimals.
fn time(value: &Value, all_day: bool) -> Option<EventTime> {
    let naive = NaiveDateTime::parse_from_str(value["dateTime"].as_str()?, "%Y-%m-%dT%H:%M:%S%.f").ok()?;
    if all_day {
        return Some(EventTime::Date(naive.date()));
    }
    Some(match value["timeZone"].as_str() {
        Some(zone) => in_zone(naive, zone).unwrap_or(EventTime::Naive(naive)),
        None => EventTime::Naive(naive),
    })
}

fn event(account: &str, id: &str, item: &Value) -> Option<ContextEvent> {
    let modified = item["lastModifiedDateTime"].as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok())?.to_utc();
    let title = item["subject"].as_str().filter(|s| !s.is_empty()).unwrap_or("Untitled event");
    // Graph's iCalUId already differs per occurrence.
    let dedupe_key = item["iCalUId"].as_str().map_or_else(|| format!("graph:{id}"), |uid| format!("ical:{uid}"));
    let all_day = item["isAllDay"] == true;
    let mut event = ContextEvent::new(EventKind::Meeting, EventSource::Calendar, title, dedupe_key, modified);
    event.starts_at = time(&item["start"], all_day);
    // All-day ends are exclusive here; the model stores the last day.
    event.ends_at = match time(&item["end"], all_day) {
        Some(EventTime::Date(date)) => date.pred_opt().map(EventTime::Date),
        other => other,
    };
    event.priority = if all_day { Priority::Informational } else { Priority::Important };
    event.status = if item["isCancelled"] == true { EventStatus::Cancelled } else { EventStatus::Active };
    let location = item["location"]["displayName"].as_str().filter(|l| !l.is_empty());
    event.body = location.map(str::to_string);
    event.source_ref = Some(SourceRef {
        account: account.to_string(),
        message_id: id.to_string(),
        subject: title.to_string(),
        received_at: modified,
        link: string(&item["webLink"]),
    });
    let join = item["onlineMeeting"]["joinUrl"].as_str().or(location.filter(|l| is_meeting_link(l)));
    event.suggested_actions.extend(join.and_then(join_action));

    let metadata = &mut event.metadata;
    metadata.insert("calendarEventId".into(), id.into());
    let organizer = &item["organizer"]["emailAddress"];
    if let Some(name) = organizer["name"].as_str().or(organizer["address"].as_str()) {
        metadata.insert("organizer".into(), name.into());
    }
    if let Some(response) = item["responseStatus"]["response"].as_str() {
        metadata.insert("responseStatus".into(), response.into());
    }
    Some(event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item() -> Value {
        json!({
            "id": "AAMk1",
            "iCalUId": "uid-1@graph.test",
            "subject": "Budget sync",
            "lastModifiedDateTime": "2026-10-01T09:00:00Z",
            "start": { "dateTime": "2026-11-05T15:00:00.0000000", "timeZone": "UTC" },
            "end": { "dateTime": "2026-11-05T15:30:00.0000000", "timeZone": "UTC" },
            "isAllDay": false,
            "isCancelled": false,
            "location": { "displayName": "Room 4" },
            "onlineMeeting": { "joinUrl": "https://teams.microsoft.com/l/meetup-join/1" },
            "responseStatus": { "response": "accepted" },
            "webLink": "https://outlook.office365.com/owa/?itemid=1"
        })
    }

    fn mapped(item: &Value) -> ContextEvent {
        match change("me@example.test", item) {
            Some(CalendarChange::Event(event)) => *event,
            other => panic!("expected an event, got {other:?}"),
        }
    }

    #[test]
    fn maps_times_and_the_teams_link() {
        let event = mapped(&item());
        assert_eq!(event.dedupe_key, "ical:uid-1@graph.test");
        assert_eq!(event.starts_at.unwrap().to_string(), "2026-11-05T15:00:00Z");
        assert_eq!(event.suggested_actions[0].action_id, "join");
        assert_eq!(event.metadata["responseStatus"], "accepted");
    }

    #[test]
    fn resolves_a_windows_zone_if_the_utc_preference_is_ignored() {
        let mut value = item();
        value["start"] = json!({ "dateTime": "2026-11-05T10:00:00.0000000", "timeZone": "Eastern Standard Time" });
        assert_eq!(mapped(&value).starts_at.unwrap().to_string(), "2026-11-05T15:00:00Z");
    }

    #[test]
    fn an_unknown_zone_stays_naive_rather_than_guessed() {
        let mut value = item();
        value["start"] = json!({ "dateTime": "2026-11-05T10:00:00.0000000", "timeZone": "Customized Time Zone" });
        assert!(matches!(mapped(&value).starts_at, Some(EventTime::Naive(_))));
    }

    #[test]
    fn an_all_day_event_is_a_date_with_an_inclusive_end() {
        let mut value = item();
        value["isAllDay"] = json!(true);
        value["start"] = json!({ "dateTime": "2026-11-05T00:00:00.0000000", "timeZone": "UTC" });
        value["end"] = json!({ "dateTime": "2026-11-06T00:00:00.0000000", "timeZone": "UTC" });
        let event = mapped(&value);
        assert!(matches!(event.starts_at, Some(EventTime::Date(_))));
        assert_eq!(event.starts_at, event.ends_at);
    }

    #[test]
    fn a_cancelled_flag_and_a_removal_are_both_understood() {
        let mut value = item();
        value["isCancelled"] = json!(true);
        assert_eq!(mapped(&value).status, EventStatus::Cancelled);
        let removed = json!({ "id": "AAMk1", "@removed": { "reason": "deleted" } });
        assert_eq!(change("me@example.test", &removed), Some(CalendarChange::Removed("AAMk1".into())));
    }

    #[test]
    fn maps_a_message_with_an_html_body() {
        let value = json!({
            "id": "m1",
            "subject": "Hello",
            "receivedDateTime": "2026-10-01T09:00:00Z",
            "from": { "emailAddress": { "name": "Shop", "address": "orders@shop.example" } },
            "body": { "contentType": "html", "content": "<p>Hi</p>" }
        });
        let message = message("me@example.test", &value).unwrap();
        assert_eq!(message.from, "Shop <orders@shop.example>");
        assert_eq!(message.html.as_deref(), Some("<p>Hi</p>"));
        assert_eq!(message.text, None);
    }

    #[test]
    fn a_removed_message_is_skipped() {
        assert!(message("me@example.test", &json!({ "id": "m1", "@removed": {} })).is_none());
    }
}
