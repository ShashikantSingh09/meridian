//! Turns one email into zero or more events. Three readers run in order of
//! trust and the first to find anything wins, because a booking mail usually
//! says the same thing twice and a lower-trust reading adds only a duplicate.
//! Nothing here fills a gap: a fact the mail does not state stays absent.

use std::collections::HashSet;
use std::fmt;

use chrono::{DateTime, Utc};
use serde_json::{Map, Value};

use crate::event::{ContextEvent, EventKind, EventSource, EventStatus, EventTime, Priority, SourceRef, SuggestedAction};

pub(crate) mod dates;
mod heuristics;
mod ical;
mod jsonld;

/// One email, however it was fetched.
#[derive(Clone)]
pub struct Message {
    pub from: String,
    pub subject: String,
    pub received_at: DateTime<Utc>,
    pub text: Option<String>,
    pub html: Option<String>,
    pub calendar: Option<String>,
    pub source_ref: SourceRef,
}

/// Bodies stay out of `{:?}` so a stray debug print cannot leak mail into a log.
impl fmt::Debug for Message {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Message").field("message_id", &self.source_ref.message_id).finish_non_exhaustive()
    }
}

pub fn extract(message: &Message) -> Vec<ContextEvent> {
    extract_with(message, |_| Vec::new())
}

/// `fallback` runs only when all three readers found nothing, which is where an
/// optional LLM extractor would plug in. It must set `confidence` and
/// `source_ref` itself, and a low confidence is the honest default.
pub fn extract_with(message: &Message, fallback: impl Fn(&Message) -> Vec<ContextEvent>) -> Vec<ContextEvent> {
    let mut items = message.html.as_deref().map(|html| jsonld::extract(message, html)).unwrap_or_default();
    let mut path = "jsonLd";
    if items.is_empty() {
        items = message.calendar.as_deref().map(|calendar| ical::extract(message, calendar)).unwrap_or_default();
        path = "iCalendar";
    }
    // An airline's add-to-calendar file is PUBLISH, not an invite, and reading
    // it as a meeting would cost the flight its own reminders.
    let invited = items.iter().any(|item| item.metadata.get("method").is_some_and(|method| method != "PUBLISH"));
    if !invited && path == "iCalendar" {
        let read = heuristics::extract(message);
        if !read.is_empty() {
            items = read;
            path = "heuristic";
        }
    }
    if items.is_empty() {
        items = fallback(message);
        path = "fallback";
    }
    let mut seen = HashSet::new();
    items.retain(|item| seen.insert(item.dedupe_key.clone()));
    for item in &mut items {
        item.metadata.insert("extractedBy".into(), path.into());
    }
    items
}

fn draft(message: &Message, kind: EventKind, title: String, dedupe_key: String, confidence: f64) -> ContextEvent {
    let mut event = ContextEvent::new(kind, EventSource::Email, title, dedupe_key, message.received_at);
    event.confidence = confidence.clamp(0.0, 1.0);
    event.source_ref = Some(message.source_ref.clone());
    if let Some(url) = message.source_ref.link.as_deref().and_then(safe_url) {
        event.suggested_actions.push(action("Open email", "openEmail", url));
    }
    event
}

fn action(label: &str, action_id: &str, url: String) -> SuggestedAction {
    SuggestedAction { label: label.into(), action_id: action_id.into(), url: Some(url) }
}

fn put(metadata: &mut Map<String, Value>, key: &str, value: Option<impl Into<Value>>) {
    if let Some(value) = value {
        metadata.insert(key.to_string(), value.into());
    }
}

/// Links come from the mail, so only plain web URLs ever reach a button.
pub(crate) fn safe_url(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url.trim()).ok()?;
    matches!(parsed.scheme(), "https" | "http").then(|| parsed.to_string())
}

const JOIN_HOSTS: &[&str] = &["meet.google.com", "zoom.us", "teams.microsoft.com", "teams.live.com", "webex.com"];

/// A Join button, for a URL from a conferencing field or a location that is
/// visibly a meeting link. Calendar invites are sender-controlled, so anything
/// but https is dropped.
pub(crate) fn join_action(url: &str) -> Option<SuggestedAction> {
    let safe = safe_url(url)?;
    safe.starts_with("https://").then(|| action("Join", "join", safe))
}

pub(crate) fn is_meeting_link(url: &str) -> bool {
    let host = reqwest::Url::parse(url.trim()).ok().and_then(|u| u.host_str().map(str::to_ascii_lowercase));
    host.is_some_and(|h| JOIN_HOSTS.iter().any(|known| h == *known || h.ends_with(&format!(".{known}"))))
}

/// The sender's organisation, so one merchant's mail from orders.x.com and
/// help.x.com lands on the same order while order 1234 at two shops stays apart.
fn sender_org(from: &str) -> String {
    let address = from.rsplit_once('<').map_or(from, |(_, rest)| rest).trim_end_matches(['>', ' ']);
    let domain = address.rsplit_once('@').map_or("", |(_, domain)| domain).to_ascii_lowercase();
    let labels: Vec<&str> = domain.split('.').collect();
    // ponytail: rough registrable domain without the public suffix list; a two-letter
    // TLD after a short label (co.uk, com.au) keeps three labels.
    let keep = match labels.as_slice() {
        [.., second, tld] if tld.len() == 2 && second.len() <= 3 => 3,
        _ => 2,
    };
    labels[labels.len().saturating_sub(keep)..].join(".")
}

fn sender_name(from: &str) -> Option<String> {
    let name = from.split_once('<')?.0.trim().trim_matches('"').trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// Facts about one flight leg, from either structured data or mail text.
#[derive(Default)]
struct FlightFacts {
    reference: Option<String>,
    airline: Option<String>,
    number: Option<String>,
    from: Option<String>,
    to: Option<String>,
    departs: Option<EventTime>,
    arrives: Option<EventTime>,
    status: Option<EventStatus>,
}

impl FlightFacts {
    /// The key names the leg, not just the booking, because one reference
    /// covers every leg of a trip. The route outlives a retiming or a new flight
    /// number, so it is the better discriminator when it is known.
    fn key(&self) -> Option<String> {
        let reference = self.reference.as_deref();
        let leg = match (&self.from, &self.to) {
            (Some(from), Some(to)) => Some(format!("{from}-{to}")),
            _ => self.number.clone(),
        };
        match (reference, leg, &self.number, &self.departs) {
            (Some(reference), Some(leg), ..) => Some(format!("flight:{reference}:{leg}")),
            (Some(reference), None, ..) => Some(format!("flight:{reference}")),
            (None, _, Some(number), Some(departs)) => Some(format!("flight:{number}:{}", departs.to_string().get(..10)?)),
            _ => None,
        }
    }

    fn into_event(self, message: &Message, confidence: f64) -> Option<ContextEvent> {
        let dedupe_key = self.key()?;
        let title = match (&self.number, &self.from, &self.to) {
            (Some(number), Some(from), Some(to)) => format!("Flight {number} {from} → {to}"),
            (Some(number), ..) => format!("Flight {number}"),
            (None, Some(from), Some(to)) => format!("Flight {from} → {to}"),
            _ => message.subject.clone(),
        };
        let mut event = draft(message, EventKind::Flight, title, dedupe_key, confidence);
        event.priority = Priority::Important;
        event.status = self.status.unwrap_or(EventStatus::Active);
        event.starts_at = self.departs;
        event.ends_at = self.arrives;
        event.body = self.reference.as_ref().map(|reference| format!("Booking reference {reference}"));
        put(&mut event.metadata, "bookingReference", self.reference);
        put(&mut event.metadata, "airline", self.airline);
        put(&mut event.metadata, "flightNumber", self.number);
        put(&mut event.metadata, "departureAirport", self.from);
        put(&mut event.metadata, "arrivalAirport", self.to);
        Some(event)
    }
}

#[derive(Default)]
struct StayFacts {
    reference: Option<String>,
    name: Option<String>,
    address: Option<String>,
    check_in: Option<EventTime>,
    check_out: Option<EventTime>,
    status: Option<EventStatus>,
}

impl StayFacts {
    fn into_event(self, message: &Message, confidence: f64) -> Option<ContextEvent> {
        let dedupe_key = match (&self.reference, &self.name, &self.check_in) {
            (Some(reference), ..) => format!("hotel:{reference}"),
            (None, Some(name), Some(check_in)) => {
                format!("hotel:{}:{}:{}", sender_org(&message.from), name.to_lowercase(), check_in)
            }
            _ => return None,
        };
        let title = self.name.clone().unwrap_or_else(|| message.subject.clone());
        let mut event = draft(message, EventKind::Hotel, title, dedupe_key, confidence);
        event.priority = Priority::Important;
        event.status = self.status.unwrap_or(EventStatus::Active);
        event.starts_at = self.check_in;
        event.ends_at = self.check_out;
        event.body = self.reference.as_ref().map(|reference| format!("Confirmation {reference}"));
        put(&mut event.metadata, "confirmationNumber", self.reference);
        put(&mut event.metadata, "hotel", self.name);
        put(&mut event.metadata, "address", self.address);
        Some(event)
    }
}

#[derive(Default)]
struct OrderFacts {
    number: Option<String>,
    merchant: Option<String>,
    total: Option<String>,
    currency: Option<String>,
    url: Option<String>,
    status: Option<EventStatus>,
}

impl OrderFacts {
    fn into_event(self, message: &Message, confidence: f64) -> Option<ContextEvent> {
        let number = self.number?;
        let dedupe_key = format!("order:{}:{number}", sender_org(&message.from));
        let title = match &self.merchant {
            Some(merchant) => format!("{merchant} order {number}"),
            None => format!("Order {number}"),
        };
        let mut event = draft(message, EventKind::Order, title, dedupe_key, confidence);
        event.status = self.status.unwrap_or(EventStatus::Active);
        if let Some(url) = self.url.as_deref().and_then(safe_url) {
            event.suggested_actions.insert(0, action("View order", "viewOrder", url));
        }
        put(&mut event.metadata, "orderNumber", Some(number));
        put(&mut event.metadata, "merchant", self.merchant);
        put(&mut event.metadata, "total", self.total);
        put(&mut event.metadata, "currency", self.currency);
        Some(event)
    }
}

#[derive(Default)]
struct ParcelFacts {
    tracking: Option<String>,
    carrier: Option<String>,
    delivery_status: Option<String>,
    expected_from: Option<EventTime>,
    expected_until: Option<EventTime>,
    order_number: Option<String>,
    link: Option<String>,
    status: Option<EventStatus>,
}

impl ParcelFacts {
    fn into_event(self, message: &Message, confidence: f64) -> Option<ContextEvent> {
        let dedupe_key = match (&self.tracking, &self.order_number) {
            (Some(tracking), _) => format!("parcel:{tracking}"),
            (None, Some(order)) => format!("parcel:{}:{order}", sender_org(&message.from)),
            _ => return None,
        };
        let title = match (&self.carrier, &self.delivery_status) {
            (Some(carrier), Some(status)) => format!("{carrier} package: {status}"),
            (None, Some(status)) => format!("Package: {status}"),
            _ => "Package update".to_string(),
        };
        let mut event = draft(message, EventKind::Delivery, title, dedupe_key, confidence);
        event.status = self.status.unwrap_or(EventStatus::Active);
        event.starts_at = self.expected_from.or(self.expected_until);
        event.ends_at = self.expected_until;
        event.body = self.tracking.as_ref().map(|tracking| format!("Tracking {tracking}"));
        if let Some(url) = self.link.as_deref().and_then(safe_url) {
            event.suggested_actions.insert(0, action("Track", "track", url));
        }
        put(&mut event.metadata, "trackingNumber", self.tracking);
        put(&mut event.metadata, "carrier", self.carrier);
        put(&mut event.metadata, "deliveryStatus", self.delivery_status);
        put(&mut event.metadata, "orderNumber", self.order_number);
        Some(event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sender_org_merges_subdomains_but_not_merchants() {
        assert_eq!(sender_org("Shop <orders@mail.shop.example>"), "shop.example");
        assert_eq!(sender_org("help@shop.example"), "shop.example");
        assert_eq!(sender_org("Shop <orders@shop.co.uk>"), "shop.co.uk");
        assert_ne!(sender_org("a@one.example"), sender_org("a@two.example"));
    }

    #[test]
    fn only_web_links_become_buttons() {
        assert!(safe_url("javascript:alert(1)").is_none());
        assert!(safe_url("file:///c:/windows").is_none());
        assert!(safe_url("https://track.example/1").is_some());
        assert!(join_action("http://zoom.us/j/1").is_none());
        assert!(join_action("https://zoom.us/j/1").is_some());
    }

    #[test]
    fn recognises_meeting_hosts_exactly() {
        assert!(is_meeting_link("https://acme.zoom.us/j/1"));
        assert!(is_meeting_link("https://meet.google.com/abc-defg-hij"));
        assert!(!is_meeting_link("https://zoom.us.evil.example/j/1"));
    }
}
