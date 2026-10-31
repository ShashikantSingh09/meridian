//! text/calendar parts: invites, updates and cancellations. Only top-level
//! VEVENTs count, because VTIMEZONE and VALARM carry DTSTART and DESCRIPTION
//! lines of their own that would otherwise overwrite the meeting's.

use chrono::{NaiveDate, NaiveDateTime, TimeDelta};
use serde_json::Value;

use super::dates::in_zone;
use super::{draft, is_meeting_link, join_action, put, Message};
use crate::event::{ContextEvent, EventKind, EventStatus, EventTime, Priority};

const CONFIDENCE: f64 = 0.9;
const CONFIDENCE_WITHOUT_TIME: f64 = 0.75;

struct Property {
    name: String,
    params: Vec<(String, String)>,
    value: String,
}

impl Property {
    fn parse(line: &str) -> Option<Self> {
        // A colon inside a quoted parameter is not the separator: TZID="UTC:foo".
        let mut quoted = false;
        let (colon, _) = line.char_indices().find(|(_, c)| {
            quoted ^= *c == '"';
            *c == ':' && !quoted
        })?;
        let mut head = line[..colon].split(';');
        let name = head.next()?.to_ascii_uppercase();
        let params = head
            .filter_map(|p| p.split_once('='))
            .map(|(k, v)| (k.to_ascii_uppercase(), v.trim_matches('"').to_string()))
            .collect();
        Some(Self { name, params, value: line[colon + 1..].to_string() })
    }

    fn param(&self, name: &str) -> Option<&str> {
        self.params.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    /// The time this property states. A TZID nobody can resolve keeps its
    /// wall-clock value and comes back as the second element to be recorded.
    fn time(&self) -> Option<(EventTime, Option<String>)> {
        let value = self.value.trim();
        // Some producers write a bare date without declaring VALUE=DATE.
        if value.len() == 8 || self.param("VALUE").is_some_and(|v| v.eq_ignore_ascii_case("DATE")) {
            return Some((EventTime::Date(NaiveDate::parse_from_str(value, "%Y%m%d").ok()?), None));
        }
        if let Some(utc) = value.strip_suffix('Z') {
            let naive = NaiveDateTime::parse_from_str(utc, "%Y%m%dT%H%M%S").ok()?;
            return Some((EventTime::Zoned(naive.and_utc().fixed_offset()), None));
        }
        let naive = NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S").ok()?;
        match self.param("TZID") {
            None => Some((EventTime::Naive(naive), None)),
            Some(tzid) => Some(match in_zone(naive, tzid) {
                Some(zoned) => (zoned, None),
                None => (EventTime::Naive(naive), Some(tzid.to_string())),
            }),
        }
    }
}

/// Lines continue with a leading space or tab, and a long folded line can split
/// anywhere, including inside a word.
fn unfold(calendar: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in calendar.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        match (line.strip_prefix([' ', '\t']), lines.last_mut()) {
            (Some(rest), Some(last)) => last.push_str(rest),
            _ => lines.push(line.to_string()),
        }
    }
    lines
}

fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push('\n'),
            Some(escaped) => out.push(escaped),
            None => {}
        }
    }
    out
}

/// Whole days, hours, minutes and seconds, which is all a VEVENT uses.
fn parse_duration(value: &str) -> Option<TimeDelta> {
    let body = value.trim().trim_start_matches('+').strip_prefix('P')?;
    let mut total = TimeDelta::zero();
    let mut number = String::new();
    for c in body.chars() {
        match c {
            '0'..='9' => number.push(c),
            'T' => {}
            'W' | 'D' | 'H' | 'M' | 'S' => {
                let amount: i64 = number.parse().ok()?;
                number.clear();
                let part = match c {
                    'W' => TimeDelta::try_weeks(amount),
                    'D' => TimeDelta::try_days(amount),
                    'H' => TimeDelta::try_hours(amount),
                    'M' => TimeDelta::try_minutes(amount),
                    _ => TimeDelta::try_seconds(amount),
                }?;
                total = total.checked_add(&part)?;
            }
            _ => return None,
        }
    }
    Some(total)
}

/// The sender picks `by`, so a sum past the calendar's end is no end time.
fn shifted(start: EventTime, by: TimeDelta) -> Option<EventTime> {
    Some(match start {
        EventTime::Date(date) => EventTime::Date(date.checked_add_signed(by)?),
        EventTime::Naive(naive) => EventTime::Naive(naive.checked_add_signed(by)?),
        EventTime::Zoned(zoned) => EventTime::Zoned(zoned.checked_add_signed(by)?),
    })
}

pub(super) fn extract(message: &Message, calendar: &str) -> Vec<ContextEvent> {
    let mut method = None;
    let mut stack: Vec<String> = Vec::new();
    let mut current: Vec<Property> = Vec::new();
    let mut events = Vec::new();
    for line in unfold(calendar) {
        let Some(property) = Property::parse(&line) else { continue };
        match property.name.as_str() {
            "BEGIN" => stack.push(property.value.trim().to_ascii_uppercase()),
            "END" => {
                if stack.pop().as_deref() == Some("VEVENT") && !stack.iter().any(|s| s == "VEVENT") {
                    events.extend(event(message, method.as_deref(), &current));
                    current.clear();
                }
            }
            "METHOD" if stack.len() == 1 => method = Some(property.value.trim().to_ascii_uppercase()),
            _ if stack.last().is_some_and(|s| s == "VEVENT") => current.push(property),
            _ => {}
        }
    }
    events
}

fn event(message: &Message, method: Option<&str>, properties: &[Property]) -> Option<ContextEvent> {
    // REPLY is someone answering an invite, not a change to the meeting.
    if matches!(method, Some("REPLY" | "COUNTER" | "DECLINECOUNTER" | "REFRESH")) {
        return None;
    }
    let find = |name: &str| properties.iter().find(|p| p.name == name);
    let uid = find("UID")?.value.trim().to_string();

    let start = find("DTSTART").and_then(Property::time);
    let end = find("DTEND").and_then(Property::time);
    let duration = find("DURATION").and_then(|p| parse_duration(&p.value));
    let unresolved = start.as_ref().and_then(|s| s.1.clone());
    let starts_at = start.map(|s| s.0);
    let ends_at = match (end.map(|e| e.0), starts_at, duration) {
        (Some(end), ..) => Some(end),
        (None, Some(start), Some(duration)) => shifted(start, duration),
        _ => None,
    };
    // DTEND on an all-day event is exclusive; the model keeps the last day.
    let ends_at = match ends_at {
        Some(EventTime::Date(date)) => date.pred_opt().map(EventTime::Date),
        other => other,
    };

    let cancelled = method == Some("CANCEL")
        || find("STATUS").is_some_and(|p| p.value.trim().eq_ignore_ascii_case("CANCELLED"));
    let dedupe_key = match find("RECURRENCE-ID").and_then(Property::time) {
        // The same form the calendar APIs key an instance by, so mail and sync agree.
        Some((instance, _)) => format!("ical:{uid}:{instance}"),
        None => format!("ical:{uid}"),
    };
    let title = find("SUMMARY").map_or_else(|| message.subject.clone(), |p| unescape(p.value.trim()));
    let location = find("LOCATION").map(|p| unescape(p.value.trim())).filter(|l| !l.is_empty());
    let confidence = if starts_at.is_some() { CONFIDENCE } else { CONFIDENCE_WITHOUT_TIME };

    let mut item = draft(message, EventKind::Meeting, title, dedupe_key, confidence);
    item.priority = Priority::Important;
    item.status = if cancelled { EventStatus::Cancelled } else { EventStatus::Active };
    item.starts_at = starts_at;
    item.ends_at = ends_at;
    item.body = location.clone();

    let conference = ["X-GOOGLE-CONFERENCE", "X-MICROSOFT-SKYPETEAMSMEETINGURL"].iter().find_map(|n| find(n));
    let link = conference.map(|p| p.value.trim().to_string()).or_else(|| {
        let candidates = [find("URL").map(|p| p.value.trim().to_string()), location.clone()];
        candidates.into_iter().flatten().find(|url| is_meeting_link(url))
    });
    if let Some(join) = link.as_deref().and_then(join_action) {
        item.suggested_actions.insert(0, join);
    }

    put(&mut item.metadata, "uid", Some(uid));
    put(&mut item.metadata, "sequence", Some(sequence(find("SEQUENCE"))));
    put(&mut item.metadata, "method", method);
    put(&mut item.metadata, "location", location);
    put(&mut item.metadata, "organizer", find("ORGANIZER").and_then(organizer));
    put(&mut item.metadata, "timezoneUnresolved", unresolved);
    if find("RRULE").is_some() {
        // ponytail: the series is one event at its first start; sync gets real
        // instances from the calendar APIs, so RRULE is never expanded here.
        item.metadata.insert("recurring".into(), Value::Bool(true));
    }
    Some(item)
}

fn sequence(property: Option<&Property>) -> i64 {
    property.and_then(|p| p.value.trim().parse().ok()).unwrap_or(0)
}

fn organizer(property: &Property) -> Option<String> {
    property.param("CN").map(str::to_string).or_else(|| {
        let address = property.value.trim();
        Some(address.strip_prefix("mailto:").unwrap_or(address).to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unfolds_lines_split_mid_word() {
        assert_eq!(unfold("SUMMARY:Quar\r\n terly\r\n\tplan\r\nUID:1"), ["SUMMARY:Quarterlyplan", "UID:1"]);
    }

    #[test]
    fn unescapes_text_values() {
        assert_eq!(unescape(r"Room 1\, floor 2\nBring a\\the laptop\;"), "Room 1, floor 2\nBring a\\the laptop;");
    }

    #[test]
    fn parses_properties_with_quoted_colons() {
        let property = Property::parse(r#"ORGANIZER;CN="Ops: Team";X=1:mailto:ops@example.test"#).unwrap();
        assert_eq!(property.name, "ORGANIZER");
        assert_eq!(property.param("CN"), Some("Ops: Team"));
        assert_eq!(property.value, "mailto:ops@example.test");
    }

    #[test]
    fn parses_durations() {
        assert_eq!(parse_duration("PT1H30M"), Some(TimeDelta::minutes(90)));
        assert_eq!(parse_duration("P1DT2H"), Some(TimeDelta::hours(26)));
        assert_eq!(parse_duration("P2W"), Some(TimeDelta::weeks(2)));
        assert_eq!(parse_duration("nonsense"), None);
    }

    #[test]
    fn a_duration_too_long_to_hold_is_no_duration() {
        assert_eq!(parse_duration("P9999999999999W"), None);
        assert_eq!(parse_duration("P106751991167DT9999999H"), None);
        let start = EventTime::Date(NaiveDate::from_ymd_opt(2026, 11, 5).unwrap());
        assert_eq!(shifted(start, TimeDelta::days(99_999_999)), None);
    }
}
