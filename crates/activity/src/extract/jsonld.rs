//! schema.org markup. The sender states these facts outright, so this is the
//! most trusted reader, and any other type in a mail (promotions, the sender's
//! own Organization block) is ignored rather than interpreted.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use super::dates::parse_iso;
use super::{draft, put, safe_url, sender_org, FlightFacts, Message, OrderFacts, ParcelFacts, StayFacts};
use crate::event::{ContextEvent, EventKind, EventStatus, EventTime, Priority};

const CONFIDENCE: f64 = 0.95;
/// Still marked up, but missing the time that makes the item actionable.
const CONFIDENCE_WITHOUT_TIME: f64 = 0.85;

static SCRIPT: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r#"(?is)<script\b[^>]*\btype\s*=\s*["']?application/ld\+json\b[^>]*>(.*?)</script\s*>"#).ok()
});

pub(super) fn extract(message: &Message, html: &str) -> Vec<ContextEvent> {
    let Some(script) = SCRIPT.as_ref() else { return Vec::new() };
    script
        .captures_iter(html)
        .filter_map(|block| parse_block(&block[1]))
        .flat_map(entities)
        .flat_map(|entity| items(message, &entity))
        .collect()
}

/// Some senders entity-escape the block as if it were HTML text.
fn parse_block(raw: &str) -> Option<Value> {
    let raw = raw.trim();
    serde_json::from_str(raw).ok().or_else(|| serde_json::from_str(&raw.replace("&quot;", "\"")).ok())
}

fn entities(value: Value) -> Vec<Value> {
    match value {
        Value::Array(list) => list.into_iter().flat_map(entities).collect(),
        Value::Object(mut object) => match object.remove("@graph") {
            Some(graph) => entities(graph),
            None => vec![Value::Object(object)],
        },
        _ => Vec::new(),
    }
}

/// The bare name, from `Order`, `["Order"]` or `http://schema.org/Order`.
fn last_segment(value: &Value) -> Option<&str> {
    let raw = value.as_str().or(value[0].as_str())?;
    raw.rsplit(['/', ':', '#']).next()
}

fn text(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(text) => text.trim().to_string(),
        Value::Number(number) => number.to_string(),
        _ => return None,
    };
    (!text.is_empty()).then_some(text)
}

fn name(value: &Value) -> Option<String> {
    text(value).or_else(|| text(&value["name"]))
}

/// schema.org allows either a street string or a PostalAddress.
fn address(value: &Value) -> Option<String> {
    text(value).or_else(|| {
        let parts: Vec<String> =
            ["streetAddress", "addressLocality", "addressRegion", "addressCountry"].iter().filter_map(|k| text(&value[*k])).collect();
        (!parts.is_empty()).then(|| parts.join(", "))
    })
}

fn time(value: &Value) -> Option<EventTime> {
    parse_iso(value.as_str()?)
}

fn many(value: &Value) -> Vec<&Value> {
    match value {
        Value::Array(list) => list.iter().collect(),
        Value::Null => Vec::new(),
        single => vec![single],
    }
}

fn reservation_status(reservation: &Value) -> Option<EventStatus> {
    let status = last_segment(&reservation["reservationStatus"])?;
    status.to_ascii_lowercase().contains("cancel").then_some(EventStatus::Cancelled)
}

/// Google's mail markup says reservationNumber; schema.org itself says reservationId.
fn reference(reservation: &Value) -> Option<String> {
    text(&reservation["reservationNumber"]).or_else(|| text(&reservation["reservationId"]))
}

fn confidence(start: &Option<EventTime>) -> f64 {
    if start.is_some() {
        CONFIDENCE
    } else {
        CONFIDENCE_WITHOUT_TIME
    }
}

fn items(message: &Message, entity: &Value) -> Vec<ContextEvent> {
    let reservation_for = many(&entity["reservationFor"]);
    match last_segment(&entity["@type"]) {
        Some("FlightReservation") => reservation_for.iter().filter_map(|f| flight(message, entity, f)).collect(),
        Some("LodgingReservation") => lodging(message, entity).into_iter().collect(),
        Some("ParcelDelivery") => parcel(message, entity).into_iter().collect(),
        Some("Order") => order(message, entity).into_iter().collect(),
        Some("EventReservation") => reservation_for.iter().map(|e| ticket(message, entity, e)).collect(),
        Some("FoodEstablishmentReservation") => reservation_for.iter().map(|p| table(message, entity, p)).collect(),
        Some("RentalCarReservation") => vec![rental(message, entity)],
        _ => Vec::new(),
    }
}

fn flight(message: &Message, reservation: &Value, leg: &Value) -> Option<ContextEvent> {
    let code = text(&leg["airline"]["iataCode"]);
    let number = text(&leg["flightNumber"]).map(|number| {
        let number = number.replace(' ', "").to_uppercase();
        match &code {
            Some(code) if number.chars().all(|c| c.is_ascii_digit()) => format!("{code}{number}"),
            _ => number,
        }
    });
    let departs = time(&leg["departureTime"]);
    let facts = FlightFacts {
        reference: reference(reservation).map(|r| r.to_uppercase()),
        airline: name(&leg["airline"]),
        number,
        from: text(&leg["departureAirport"]["iataCode"]).map(|c| c.to_uppercase()),
        to: text(&leg["arrivalAirport"]["iataCode"]).map(|c| c.to_uppercase()),
        arrives: time(&leg["arrivalTime"]),
        status: reservation_status(reservation),
        departs,
    };
    let confidence = confidence(&facts.departs);
    facts.into_event(message, confidence)
}

fn lodging(message: &Message, reservation: &Value) -> Option<ContextEvent> {
    let place = &reservation["reservationFor"];
    // Google's mail markup says checkinDate; schema.org itself says checkinTime.
    let check_in = time(&reservation["checkinDate"]).or_else(|| time(&reservation["checkinTime"]));
    let check_out = time(&reservation["checkoutDate"]).or_else(|| time(&reservation["checkoutTime"]));
    let confidence = confidence(&check_in);
    let facts = StayFacts {
        reference: reference(reservation),
        name: name(place),
        address: address(&place["address"]),
        status: reservation_status(reservation),
        check_in,
        check_out,
    };
    facts.into_event(message, confidence)
}

fn order(message: &Message, order: &Value) -> Option<ContextEvent> {
    let status = last_segment(&order["orderStatus"]).map(str::to_ascii_lowercase);
    let facts = OrderFacts {
        number: text(&order["orderNumber"]),
        merchant: name(&order["seller"]).or_else(|| name(&order["merchant"])),
        total: text(&order["price"]),
        currency: text(&order["priceCurrency"]),
        url: text(&order["url"]),
        status: status.as_deref().and_then(order_status),
    };
    facts.into_event(message, CONFIDENCE)
}

fn order_status(status: &str) -> Option<EventStatus> {
    if status.contains("cancel") {
        Some(EventStatus::Cancelled)
    } else if status.contains("delivered") || status.contains("returned") {
        Some(EventStatus::Completed)
    } else {
        None
    }
}

fn parcel(message: &Message, delivery: &Value) -> Option<ContextEvent> {
    let delivery_status = last_segment(&delivery["deliveryStatus"]).or(last_segment(&delivery["orderStatus"]));
    let lowered = delivery_status.map(str::to_ascii_lowercase);
    let expected_from = time(&delivery["expectedArrivalFrom"]);
    let expected_until = time(&delivery["expectedArrivalUntil"]);
    let confidence = confidence(&expected_from.or(expected_until));
    let facts = ParcelFacts {
        tracking: text(&delivery["trackingNumber"]),
        carrier: name(&delivery["carrier"]).or_else(|| name(&delivery["provider"])),
        delivery_status: delivery_status.map(|status| status.trim_start_matches("Order").to_string()),
        order_number: text(&delivery["partOfOrder"]["orderNumber"]),
        link: text(&delivery["trackingUrl"]),
        status: lowered.as_deref().and_then(order_status),
        expected_from,
        expected_until,
    };
    facts.into_event(message, confidence)
}

/// The three plainer reservations share a shape: a named thing at a time, keyed
/// by the reservation id when there is one and the message otherwise.
fn plain(
    message: &Message,
    reservation: &Value,
    kind: EventKind,
    prefix: &str,
    title: Option<String>,
    start: Option<EventTime>,
) -> ContextEvent {
    let reference = reference(reservation);
    let dedupe_key = match &reference {
        Some(reference) => format!("{prefix}:{}:{reference}", sender_org(&message.from)),
        None => format!("{prefix}:message:{}", message.source_ref.message_id),
    };
    let title = title.unwrap_or_else(|| message.subject.clone());
    let mut event = draft(message, kind, title, dedupe_key, confidence(&start));
    event.priority = Priority::Important;
    event.status = reservation_status(reservation).unwrap_or(EventStatus::Active);
    event.starts_at = start;
    event.body = reference.as_ref().map(|reference| format!("Reservation {reference}"));
    put(&mut event.metadata, "reservationId", reference);
    event
}

fn ticket(message: &Message, reservation: &Value, event: &Value) -> ContextEvent {
    let start = time(&event["startDate"]);
    let mut item = plain(message, reservation, EventKind::EventTicket, "ticket", name(event), start);
    item.ends_at = time(&event["endDate"]);
    put(&mut item.metadata, "venue", name(&event["location"]));
    put(&mut item.metadata, "address", address(&event["location"]["address"]));
    item
}

fn table(message: &Message, reservation: &Value, place: &Value) -> ContextEvent {
    let start = time(&reservation["startTime"]);
    let mut item = plain(message, reservation, EventKind::Restaurant, "table", name(place), start);
    item.ends_at = time(&reservation["endTime"]);
    put(&mut item.metadata, "address", address(&place["address"]));
    put(&mut item.metadata, "partySize", reservation["partySize"].as_i64());
    item
}

fn rental(message: &Message, reservation: &Value) -> ContextEvent {
    let car = &reservation["reservationFor"];
    let title = name(&reservation["provider"]).or_else(|| name(&car["rentalCompany"])).or_else(|| name(car));
    let start = time(&reservation["pickupTime"]);
    let mut item = plain(message, reservation, EventKind::RentalCar, "rental", title, start);
    item.ends_at = time(&reservation["dropoffTime"]);
    put(&mut item.metadata, "pickupLocation", name(&reservation["pickupLocation"]));
    put(&mut item.metadata, "dropoffLocation", name(&reservation["dropoffLocation"]));
    if let Some(url) = text(&reservation["url"]).as_deref().and_then(safe_url) {
        item.metadata.insert("url".into(), url.into());
    }
    item
}
