//! Extraction against hand-written mail, end to end through the store where an
//! update has to land on what an earlier message created.

use activity::{
    extract, extract_with, ContextEvent, EventKind, EventSource, EventStatus, EventTime, Message, SourceRef, Store,
    UpsertOutcome,
};
use chrono::{DateTime, NaiveDate, Utc};

fn fixture(name: &str) -> Message {
    let path = format!("{}/tests/fixtures/{name}.msg", env!("CARGO_MANIFEST_DIR"));
    let raw = std::fs::read_to_string(&path).unwrap().replace("\r\n", "\n");
    let mut sections = raw.split("\n--- ");
    let head = sections.next().unwrap();
    let header = |name: &str| head.lines().find_map(|l| l.strip_prefix(name)).unwrap().trim().to_string();
    let received_at: DateTime<Utc> = header("Received:").parse().unwrap();
    let subject = header("Subject:");
    let mut message = Message {
        from: header("From:"),
        subject: subject.clone(),
        received_at,
        text: None,
        html: None,
        calendar: None,
        source_ref: SourceRef {
            account: "alex@example.test".into(),
            message_id: name.into(),
            subject,
            received_at,
            link: Some(format!("https://mail.example.test/{name}")),
        },
    };
    for section in sections {
        let (kind, body) = section.split_once('\n').unwrap();
        match kind.trim() {
            "text" => message.text = Some(body.to_string()),
            "html" => message.html = Some(body.to_string()),
            "calendar" => message.calendar = Some(body.to_string()),
            other => panic!("unknown section {other}"),
        }
    }
    message
}

fn one(name: &str) -> ContextEvent {
    let items = extract(&fixture(name));
    assert_eq!(items.len(), 1, "{name}: {items:#?}");
    items.into_iter().next().unwrap()
}

fn date(y: i32, m: u32, d: u32) -> EventTime {
    EventTime::Date(NaiveDate::from_ymd_opt(y, m, d).unwrap())
}

fn naive(y: i32, m: u32, d: u32, h: u32, min: u32) -> EventTime {
    EventTime::Naive(NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, min, 0).unwrap())
}

fn utc(text: &str) -> String {
    text.to_string()
}

fn store_all(names: &[&str]) -> (Store, Vec<UpsertOutcome>) {
    let store = Store::in_memory().unwrap();
    let mut outcomes = Vec::new();
    for name in names {
        for item in extract(&fixture(name)) {
            outcomes.push(store.upsert(item).unwrap());
        }
    }
    (store, outcomes)
}

fn every_item_is_sourced(items: &[ContextEvent]) {
    for item in items {
        assert!((0.0..=1.0).contains(&item.confidence), "{item:#?}");
        let source = item.source_ref.as_ref().expect("source reference");
        assert!(!source.message_id.is_empty());
        assert!(!item.dedupe_key.is_empty());
    }
}

// Structured data

#[test]
fn json_ld_flights_become_one_event_per_leg() {
    let items = extract(&fixture("flight_jsonld"));
    every_item_is_sourced(&items);
    assert_eq!(items.len(), 2);

    let out = &items[0];
    assert_eq!(out.kind, EventKind::Flight);
    assert_eq!(out.dedupe_key, "flight:RXJ34P:BOS-KEF");
    assert_eq!(out.metadata["flightNumber"], "NW100");
    assert_eq!(out.metadata["airline"], "Northwind Airways");
    assert_eq!(out.metadata["extractedBy"], "jsonLd");
    assert_eq!(out.starts_at.unwrap().to_string(), utc("2026-11-21T00:40:00Z"));
    assert!(out.confidence >= 0.9);

    let back = &items[1];
    assert_eq!(back.dedupe_key, "flight:RXJ34P:KEF-BOS");
    assert_eq!(back.starts_at, Some(naive(2026, 11, 27, 17, 0)), "no offset in the source, so none in the event");
    assert_eq!(back.ends_at, None, "no arrival time in the source");
    assert!(!back.metadata.contains_key("arrivalTime"));
}

#[test]
fn json_ld_lodging_keeps_date_only_and_zoned_values_distinct() {
    let stay = one("hotel_jsonld");
    assert_eq!(stay.kind, EventKind::Hotel);
    assert_eq!(stay.title, "Lakeshore Inn");
    assert_eq!(stay.dedupe_key, "hotel:LS-99120");
    assert_eq!(stay.starts_at, Some(date(2026, 12, 1)));
    assert!(matches!(stay.ends_at, Some(EventTime::Zoned(_))));
    assert_eq!(stay.metadata["address"], "1 Shore Road, Geneva, CH");
}

#[test]
fn json_ld_parcel_carries_tracking_and_a_track_action() {
    let parcel = one("parcel_jsonld");
    assert_eq!(parcel.kind, EventKind::Delivery);
    assert_eq!(parcel.dedupe_key, "parcel:RM123456789GB");
    assert_eq!(parcel.metadata["carrier"], "Royal Mail");
    assert_eq!(parcel.metadata["orderNumber"], "AP-204417");
    assert_eq!(parcel.starts_at, Some(date(2026, 10, 22)));
    assert_eq!(parcel.ends_at, Some(date(2026, 10, 23)));
    assert_eq!(parcel.suggested_actions[0].action_id, "track");
}

#[test]
fn json_ld_order_is_found_inside_a_graph_with_a_full_type_url() {
    let order = one("order_jsonld");
    assert_eq!(order.kind, EventKind::Order);
    assert_eq!(order.dedupe_key, "order:alderandpine.example:AP-204417");
    assert_eq!(order.metadata["total"], "84.50");
    assert_eq!(order.suggested_actions[0].action_id, "viewOrder");
}

#[test]
fn json_ld_covers_event_restaurant_and_rental_reservations() {
    let items = extract(&fixture("reservations_jsonld"));
    every_item_is_sourced(&items);
    let kinds: Vec<EventKind> = items.iter().map(|i| i.kind).collect();
    assert_eq!(kinds, [EventKind::EventTicket, EventKind::Restaurant, EventKind::RentalCar]);
    assert_eq!(items[0].title, "Northern Lights Concert");
    assert_eq!(items[0].metadata["venue"], "Harpa Hall");
    assert_eq!(items[1].metadata["partySize"], 4);
    assert_eq!(items[1].starts_at, Some(naive(2026, 12, 12, 20, 0)));
    assert_eq!(items[2].title, "Glacier Rentals");
    assert_eq!(items[2].metadata["pickupLocation"], "Keflavik Airport");
}

#[test]
fn a_dangerous_tracking_url_never_reaches_a_button() {
    let mut message = fixture("parcel_jsonld");
    let html = message.html.take().unwrap();
    message.html = Some(html.replace("https://track.alderandpine.example/RM123456789GB", "javascript:alert(1)"));
    let parcel = extract(&message).remove(0);
    assert!(parcel.suggested_actions.iter().all(|a| a.action_id != "track"));
}

#[test]
fn broken_json_ld_falls_through_to_the_next_reader() {
    let mut message = fixture("flight_text");
    message.html = Some(r#"<script type="application/ld+json">{ not json </script>"#.to_string());
    let item = extract(&message).remove(0);
    assert_eq!(item.metadata["extractedBy"], "heuristic");
}

#[test]
fn a_marked_up_mail_is_not_read_again_by_a_lower_trust_path() {
    let message = fixture("flight_jsonld");
    assert!(message.text.as_deref().unwrap().contains("Flight NW100"));
    assert_eq!(extract(&message).len(), 2, "the plain text repeats the first leg and adds nothing");
}

// iCalendar

#[test]
fn an_invite_reads_the_meeting_and_ignores_timezone_and_alarm_blocks() {
    let meeting = one("invite_request");
    every_item_is_sourced(std::slice::from_ref(&meeting));
    assert_eq!(meeting.kind, EventKind::Meeting);
    assert_eq!(meeting.title, "Quarterly planning, Q4", "folded and escaped, and not the alarm's summary");
    assert_eq!(meeting.dedupe_key, "ical:planning-q4@acme.example");
    assert_eq!(meeting.starts_at.unwrap().to_string(), utc("2026-11-05T15:00:00Z"));
    assert_eq!(meeting.ends_at.unwrap().to_string(), utc("2026-11-05T16:00:00Z"));
    assert_eq!(meeting.metadata["sequence"], 0);
    assert_eq!(meeting.metadata["organizer"], "Priya Nair");
    assert_eq!(meeting.metadata["location"], "Room 4, Floor 2");
    assert_eq!(meeting.suggested_actions[0].action_id, "join");
    assert_eq!(meeting.metadata["extractedBy"], "iCalendar");
}

#[test]
fn an_attendee_reply_is_not_a_change_to_the_meeting() {
    assert!(extract(&fixture("invite_reply")).is_empty());
}

#[test]
fn an_invite_update_moves_the_meeting_and_a_cancel_closes_it() {
    let (store, outcomes) = store_all(&["invite_request", "invite_update", "invite_cancel"]);
    assert_eq!(outcomes[0], UpsertOutcome::Inserted);
    assert!(matches!(&outcomes[1], UpsertOutcome::Updated { changed } if changed.iter().any(|c| c == "startsAt")));
    assert!(matches!(&outcomes[2], UpsertOutcome::Updated { changed } if changed.iter().any(|c| c == "status")));

    let id = one("invite_request").id;
    let saved = store.get(&id).unwrap().unwrap();
    assert_eq!(saved.status, EventStatus::Cancelled);
    assert_eq!(saved.starts_at.unwrap().to_string(), utc("2026-11-05T19:00:00Z"));
    assert_eq!(saved.metadata["sequence"], 2);
    assert_eq!(saved.metadata["organizer"], "Priya Nair", "the update did not repeat it, so it stays");
}

#[test]
fn invites_arriving_out_of_order_settle_on_the_highest_sequence() {
    let (store, _) = store_all(&["invite_update", "invite_request"]);
    let saved = store.get(&one("invite_request").id).unwrap().unwrap();
    assert_eq!(saved.metadata["sequence"], 1);
    assert_eq!(saved.starts_at.unwrap().to_string(), utc("2026-11-05T19:00:00Z"));
}

fn calendar_message(body: &str) -> Message {
    let mut message = fixture("invite_request");
    message.calendar = Some(format!("BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\n{body}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"));
    message
}

#[test]
fn an_add_to_calendar_file_does_not_hide_the_flight_it_came_with() {
    let mut message = fixture("flight_text");
    message.calendar = Some(
        "BEGIN:VCALENDAR\r\nMETHOD:PUBLISH\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261121T004000Z\r\nSUMMARY:Flight\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
            .to_string(),
    );
    let items = extract(&message);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].kind, EventKind::Flight);
}

#[test]
fn a_published_calendar_with_nothing_else_is_still_read() {
    let mut message = fixture("newsletter");
    message.html = None;
    message.calendar = Some(
        "BEGIN:VCALENDAR\r\nMETHOD:PUBLISH\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261121T004000Z\r\nSUMMARY:Book club\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
            .to_string(),
    );
    assert_eq!(extract(&message)[0].title, "Book club");
}

#[test]
fn a_bare_date_without_a_value_parameter_is_still_a_date() {
    let meeting = extract(&calendar_message("UID:a\r\nDTSTART:20261105")).remove(0);
    assert_eq!(meeting.starts_at, Some(date(2026, 11, 5)));
}

#[test]
fn a_figure_that_is_not_the_total_is_not_reported_as_one() {
    let mut message = fixture("order_text");
    let text = message.text.take().unwrap().replace("Order total: $84.50", "Free shipping over $50!");
    message.text = Some(text);
    assert!(!extract(&message)[0].metadata.contains_key("total"));
}

#[test]
fn a_floating_time_stays_naive_and_an_all_day_end_is_inclusive() {
    let floating = extract(&calendar_message("UID:a\r\nDTSTART:20261105T100000\r\nDTEND:20261105T110000")).remove(0);
    assert_eq!(floating.starts_at, Some(naive(2026, 11, 5, 10, 0)));

    let all_day = extract(&calendar_message("UID:b\r\nDTSTART;VALUE=DATE:20261105\r\nDTEND;VALUE=DATE:20261106")).remove(0);
    assert_eq!(all_day.starts_at, Some(date(2026, 11, 5)));
    assert_eq!(all_day.ends_at, Some(date(2026, 11, 5)));
}

#[test]
fn an_unknown_timezone_stays_naive_and_is_recorded() {
    let body = "UID:a\r\nDTSTART;TZID=Customized Time Zone:20261105T100000";
    let meeting = extract(&calendar_message(body)).remove(0);
    assert_eq!(meeting.starts_at, Some(naive(2026, 11, 5, 10, 0)));
    assert_eq!(meeting.metadata["timezoneUnresolved"], "Customized Time Zone");
}

#[test]
fn an_alarm_never_stands_in_for_what_the_meeting_left_out() {
    let body = "UID:a\r\nDTSTART:20261105T100000Z\r\nBEGIN:VALARM\r\nSUMMARY:Alarm text\r\nLOCATION:Alarm room\r\nEND:VALARM";
    let message = calendar_message(body);
    let meeting = extract(&message).remove(0);
    assert_eq!(meeting.title, message.subject);
    assert_eq!(meeting.body, None);
}

#[test]
fn a_duration_gives_the_end_and_a_missing_uid_gives_nothing() {
    let timed = extract(&calendar_message("UID:a\r\nDTSTART:20261105T100000Z\r\nDURATION:PT1H30M")).remove(0);
    assert_eq!(timed.ends_at.unwrap().to_string(), utc("2026-11-05T11:30:00Z"));
    assert!(extract(&calendar_message("DTSTART:20261105T100000Z")).is_empty());
}

#[test]
fn one_occurrence_of_a_series_gets_its_own_key() {
    let body = "UID:series\r\nRECURRENCE-ID:20261112T150000Z\r\nDTSTART:20261112T160000Z";
    assert_eq!(extract(&calendar_message(body)).remove(0).dedupe_key, "ical:series:2026-11-12T15:00:00Z");
}

#[test]
fn cancelling_a_whole_series_reaches_its_stored_occurrences() {
    let store = Store::in_memory().unwrap();
    let instance = extract(&calendar_message("UID:series\r\nRECURRENCE-ID:20261112T150000Z\r\nDTSTART:20261112T150000Z")).remove(0);
    store.upsert(instance.clone()).unwrap();
    let mut cancel = calendar_message("UID:series\r\nDTSTART:20261105T150000Z");
    cancel.calendar = cancel.calendar.map(|c| c.replace("METHOD:REQUEST", "METHOD:CANCEL"));
    cancel.received_at += chrono::TimeDelta::days(1);
    store.upsert(extract(&cancel).remove(0)).unwrap();
    assert_eq!(store.get(&instance.id).unwrap().unwrap().status, EventStatus::Cancelled);
}

// Heuristics

#[test]
fn a_flight_confirmation_reads_every_field_from_plain_text() {
    let flight = one("flight_text");
    every_item_is_sourced(std::slice::from_ref(&flight));
    assert_eq!(flight.kind, EventKind::Flight);
    assert_eq!(flight.dedupe_key, "flight:QX7K2M:BOS-KEF");
    assert_eq!(flight.title, "Flight NW204 BOS → KEF");
    assert_eq!(flight.metadata["airline"], "Northwind Airways");
    assert_eq!(flight.starts_at, Some(naive(2026, 11, 20, 19, 40)));
    assert_eq!(flight.ends_at, Some(naive(2026, 11, 21, 5, 5)));
    assert_eq!(flight.status, EventStatus::Active, "the conditions text mentions cancellation in passing");
    assert_eq!(flight.metadata["extractedBy"], "heuristic");
}

#[test]
fn heuristics_stay_below_structured_data_and_fall_with_fewer_fields() {
    let structured = extract(&fixture("flight_jsonld")).remove(0);
    let full = one("flight_text");
    let sparse = one("flight_text_sparse");
    assert!(structured.confidence > full.confidence);
    assert!(full.confidence > sparse.confidence);
}

#[test]
fn a_date_with_no_year_is_left_out_rather_than_guessed() {
    let flight = one("flight_text_sparse");
    assert_eq!(flight.starts_at, None);
    assert_eq!(flight.dedupe_key, "flight:PK3W8A:NW330");
    assert!(!flight.metadata.contains_key("departureAirport"));
}

#[test]
fn a_two_leg_itinerary_keeps_each_legs_times_apart() {
    let items = extract(&fixture("flight_text_two_legs"));
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].dedupe_key, "flight:LM4T9Z:BOS-KEF");
    assert_eq!(items[0].starts_at, Some(naive(2026, 12, 12, 19, 40)));
    assert_eq!(items[1].dedupe_key, "flight:LM4T9Z:KEF-BOS");
    assert_eq!(items[1].starts_at, Some(naive(2026, 12, 19, 17, 0)));
    assert_eq!(items[1].ends_at, Some(naive(2026, 12, 19, 19, 15)));
}

#[test]
fn a_reschedule_then_a_cancellation_update_the_same_flight() {
    let (store, outcomes) = store_all(&["flight_text", "flight_text_reschedule", "flight_text_cancelled"]);
    assert_eq!(outcomes[0], UpsertOutcome::Inserted);
    assert!(matches!(&outcomes[1], UpsertOutcome::Updated { changed } if changed.iter().any(|c| c == "startsAt")));
    assert!(matches!(&outcomes[2], UpsertOutcome::Updated { .. }));

    let id = one("flight_text").id;
    let saved = store.get(&id).unwrap().unwrap();
    assert_eq!(saved.status, EventStatus::Cancelled);
    assert_eq!(saved.starts_at, Some(naive(2026, 11, 20, 21, 10)));
    assert_eq!(saved.revision, 3);
    assert_eq!(saved.metadata["airline"], "Northwind Airways", "kept from the first mail");
}

#[test]
fn a_structured_booking_is_rescheduled_by_a_later_structured_mail() {
    let (store, _) = store_all(&["flight_jsonld", "flight_jsonld_reschedule"]);
    let out = extract(&fixture("flight_jsonld")).remove(0);
    let saved = store.get(&out.id).unwrap().unwrap();
    assert_eq!(saved.status, EventStatus::Updated);
    assert_eq!(saved.starts_at.unwrap().to_string(), utc("2026-11-21T02:10:00Z"));
    let back = extract(&fixture("flight_jsonld")).remove(1);
    assert_eq!(store.get(&back.id).unwrap().unwrap().status, EventStatus::Active, "the other leg is untouched");
}

#[test]
fn a_hotel_booking_ignores_its_cancellation_policy_and_a_real_cancellation_lands() {
    let stay = one("hotel_text");
    assert_eq!(stay.status, EventStatus::Active);
    assert_eq!(stay.title, "Harbour View Hotel");
    assert_eq!(stay.starts_at, Some(date(2027, 1, 14)));
    assert_eq!(stay.ends_at, Some(date(2027, 1, 17)));

    let (store, _) = store_all(&["hotel_text", "hotel_text_cancelled"]);
    assert_eq!(store.get(&stay.id).unwrap().unwrap().status, EventStatus::Cancelled);
}

#[test]
fn an_order_confirmation_also_yields_its_return_deadline() {
    let items = extract(&fixture("order_text"));
    assert_eq!(items.len(), 2, "{items:#?}");
    assert_eq!(items[0].kind, EventKind::Order);
    assert_eq!(items[0].dedupe_key, "order:alderandpine.example:AP-204417");
    assert_eq!(items[0].metadata["total"], "$84.50");
    assert_eq!(items[0].metadata["merchant"], "Alder & Pine");
    assert_eq!(items[1].kind, EventKind::ReturnDeadline);
    assert_eq!(items[1].starts_at, Some(date(2027, 1, 15)));
}

#[test]
fn an_order_is_read_from_html_when_there_is_no_plain_part() {
    let order = one("order_html_only");
    assert_eq!(order.metadata["orderNumber"], "T1000234");
    assert_eq!(order.metadata["merchant"], "Tessellate");
}

#[test]
fn an_order_cancellation_from_another_mailbox_at_the_shop_lands_on_the_order() {
    let (store, _) = store_all(&["order_jsonld", "order_text_cancelled"]);
    let order = one("order_jsonld");
    assert_eq!(store.get(&order.id).unwrap().unwrap().status, EventStatus::Cancelled);
}

#[test]
fn the_same_order_number_at_two_shops_stays_apart() {
    let ours = one("order_jsonld");
    let mut other = fixture("order_jsonld");
    other.from = "Other <orders@othershop.example>".to_string();
    assert_ne!(extract(&other).remove(0).dedupe_key, ours.dedupe_key);
}

#[test]
fn a_shipment_reads_carrier_tracking_link_date_and_status() {
    let parcel = one("shipment_text");
    assert_eq!(parcel.kind, EventKind::Delivery);
    assert_eq!(parcel.dedupe_key, "parcel:1Z999AA10123456784");
    assert_eq!(parcel.metadata["carrier"], "UPS");
    assert_eq!(parcel.metadata["deliveryStatus"], "Shipped");
    assert_eq!(parcel.metadata["orderNumber"], "AP-204417");
    assert_eq!(parcel.starts_at, Some(date(2026, 10, 22)));
    let track = &parcel.suggested_actions[0];
    assert_eq!(track.action_id, "track");
    assert!(track.url.as_deref().unwrap().contains("1Z999AA10123456784"), "not the newsletter link");
}

#[test]
fn delivery_completes_the_same_parcel_even_from_the_carrier_itself() {
    let (store, outcomes) = store_all(&["shipment_text", "shipment_delivered"]);
    assert!(matches!(&outcomes[1], UpsertOutcome::Updated { .. }));
    let saved = store.get(&one("shipment_text").id).unwrap().unwrap();
    assert_eq!(saved.status, EventStatus::Completed);
    assert_eq!(saved.metadata["deliveryStatus"], "Delivered");
    assert_eq!(saved.metadata["carrier"], "UPS", "kept from the shipping mail");
}

#[test]
fn an_ambiguous_or_yearless_delivery_date_stays_empty_and_lowers_confidence() {
    let dated = one("shipment_text");
    for name in ["shipment_ambiguous_date", "shipment_no_year"] {
        let parcel = one(name);
        assert_eq!(parcel.starts_at, None, "{name}");
        assert_eq!(parcel.ends_at, None, "{name}");
        assert!(parcel.confidence < dated.confidence, "{name}");
    }
}

#[test]
fn a_subscription_renewal_is_a_dated_event() {
    let renewal = one("subscription_renewal");
    assert_eq!(renewal.kind, EventKind::SubscriptionRenewal);
    assert_eq!(renewal.starts_at, Some(date(2027, 2, 12)));
    assert_eq!(renewal.metadata["plan"], "Family");
    assert_eq!(renewal.metadata["amount"], "$14.99");
    assert_eq!(renewal.dedupe_key, "subscription:streamly.example:family");
}

#[test]
fn a_payment_reminder_is_a_dated_event() {
    let payment = one("payment_reminder");
    assert_eq!(payment.kind, EventKind::PaymentReminder);
    assert_eq!(payment.starts_at, Some(date(2026, 12, 5)));
    assert_eq!(payment.metadata["invoice"], "INV-88213");
    assert_eq!(payment.dedupe_key, "payment:citypower.example:INV-88213");
}

#[test]
fn an_appointment_combines_separate_date_and_time_lines() {
    let appointment = one("appointment_reminder");
    assert_eq!(appointment.kind, EventKind::Appointment);
    assert_eq!(appointment.title, "Appointment with Brightside Dental");
    assert_eq!(appointment.starts_at, Some(naive(2026, 12, 8, 14, 30)));
}

// Negatives

#[test]
fn marketing_and_chatter_produce_nothing() {
    for name in [
        "promo_flight_sale",
        "promo_quiet_subject",
        "promo_booking_code",
        "promo_quiet_code",
        "promo_jsonld",
        "newsletter",
        "order_mention",
        "hotel_marketing",
        "personal_reply",
    ] {
        let items = extract(&fixture(name));
        assert!(items.is_empty(), "{name} produced {items:#?}");
    }
}

#[test]
fn a_real_confirmation_survives_a_promo_word_in_its_subject() {
    let mut message = fixture("flight_text");
    message.subject = "Your booking confirmation - save this email".to_string();
    assert_eq!(extract(&message)[0].kind, EventKind::Flight);
}

#[test]
fn a_reference_is_still_found_when_a_redeem_line_comes_first() {
    let mut message = fixture("flight_text");
    let body = message.text.take().unwrap();
    message.text = Some(format!("Use booking code SPRING26 next time.\n{body}"));
    assert_eq!(extract(&message)[0].dedupe_key, "flight:QX7K2M:BOS-KEF");
}

// The door left open for an LLM

#[test]
fn the_fallback_runs_only_when_every_reader_found_nothing() {
    let fallback = |message: &Message| {
        let mut item = ContextEvent::new(EventKind::Email, EventSource::Email, "guess", "llm:1", message.received_at);
        item.confidence = 0.3;
        vec![item]
    };
    let found = extract_with(&fixture("newsletter"), fallback);
    assert_eq!(found[0].metadata["extractedBy"], "fallback");
    assert!(extract_with(&fixture("flight_text"), fallback).iter().all(|i| i.kind == EventKind::Flight));
}

#[test]
fn debug_output_never_contains_the_mail() {
    let shown = format!("{:?}", fixture("flight_text"));
    assert!(!shown.contains("QX7K2M"));
    assert!(!shown.contains("Alex Morgan"));
}

#[test]
fn stored_events_hold_extracted_facts_not_the_mail_body() {
    let (store, _) = store_all(&["flight_text"]);
    let saved = store.get(&one("flight_text").id).unwrap().unwrap();
    let json = serde_json::to_string(&saved).unwrap();
    assert!(!json.contains("Alex Morgan"));
    assert!(!json.contains("conditions of carriage"));
}
