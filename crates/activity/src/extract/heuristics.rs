//! Rules over subject and body for mail with no structured data. Every rule
//! needs both a phrase and a concrete identifier: marketing mail has the
//! phrases, and only a real transaction has the identifier.

use std::sync::LazyLock;

use regex::Regex;

use super::dates::{clock, parse_loose};
use super::{draft, put, sender_name, sender_org, FlightFacts, Message, OrderFacts, ParcelFacts, StayFacts};
use crate::event::{ContextEvent, EventKind, EventStatus, EventTime, Priority};

/// Always below structured data, and lower with fewer corroborating fields.
fn confidence(corroborating: usize) -> f64 {
    (0.3 + 0.08 * corroborating as f64).min(0.8)
}

/// Uppercase words a booking label can run into, and codes that look like
/// airports but are not.
const NOT_A_REFERENCE: &[&str] = &["BOOKED", "CANCEL", "NUMBER", "STATUS", "TICKET", "CHANGE", "PLEASE"];
const NOT_AN_AIRPORT: &[&str] = &["USD", "EUR", "GBP", "INR", "AUD", "CAD", "THE", "AND", "FOR", "YOU", "PDF", "FAQ"];
const CARRIER_LINK_HOSTS: &[&str] =
    &["ups.com", "fedex.com", "usps.com", "dhl.", "royalmail.com", "dpd.", "evri.com", "delhivery.com", "bluedart.com"];

struct Rules {
    reply: Regex,
    promo: Regex,
    transactional: Regex,
    cancelled_subject: Regex,
    cancelled_body: Regex,
    conditional: Regex,
    invisible: Regex,
    block_end: Regex,
    tag: Regex,
    numeric_entity: Regex,
    url: Regex,

    booking_ref: Regex,
    redeem: Regex,
    flight_context: Regex,
    flight_word: Regex,
    flight_notice: Regex,
    flight_number: Regex,
    route: Regex,
    paren_code: Regex,
    departure: Regex,
    arrival: Regex,
    date_line: Regex,
    time_line: Regex,
    airline: Regex,

    hotel_context: Regex,
    check_in: Regex,
    check_out: Regex,
    hotel_name: Regex,

    order_context: Regex,
    order_number: Regex,

    tracking_number: Regex,
    carrier: Regex,
    delivered: Regex,
    out_for_delivery: Regex,
    delivery_problem: Regex,
    in_transit: Regex,
    shipped: Regex,
    expected: Regex,

    return_by: Regex,
    renewal_context: Regex,
    renewal_date: Regex,
    plan: Regex,
    payment_context: Regex,
    due_date: Regex,
    amount: Regex,
    invoice: Regex,
    appointment_subject: Regex,
    appointment_time: Regex,
}

impl Rules {
    fn new() -> Result<Self, regex::Error> {
        let re = Regex::new;
        Ok(Self {
            reply: re(r"(?i)^\s*(?:re|aw|sv)\s*:")?,
            promo: re(r"(?i)\b(?:sale|deals?|offers?|discounts?|save|savings|newsletter|digest|getaway|giveaway|coupon|promo|fares? from|flights? from)\b|\d+\s*%\s*off")?,
            transactional: re(r"(?i)\b(?:confirm(?:ed|ation)|receipt|itinerary|e-?ticket|shipped|dispatched|delivered|out for delivery|cancell?ed|rescheduled)\b")?,
            cancelled_subject: re(r"(?i)\bcancell?(?:ed|ation)\b")?,
            cancelled_body: re(r"(?i)\b(?:has|have|had|was|were)\s+(?:been\s+)?cancell?ed\b")?,
            conditional: re(r"(?i)\b(?:if|unless|in case|should|when|may|might)\b")?,
            invisible: re(r"(?is)<(?:script|style|head)\b.*?</(?:script|style|head)\s*>|<!--.*?-->")?,
            block_end: re(r"(?i)<br\s*/?>|</(?:p|div|tr|li|h[1-6]|table)\s*>")?,
            tag: re(r"<[^>]*>")?,
            numeric_entity: re(r"&#(x?[0-9a-fA-F]{1,6});")?,
            url: re(r#"https?://[^\s"'<>)]+"#)?,

            booking_ref: re(r"(?:(?i:booking|reservation|confirmation)(?:\s+(?i:ref(?:erence)?\.?|code|number|no\.?|id))?|(?i:record\s+locator)|PNR)\s*(?:(?i:is)\s+)?[:#-]?\s*([A-Z0-9]{5,10})\b")?,
            redeem: re(r"(?i)\b(?:use|enter|apply|redeem|checkout|promo|coupon|discount)\b")?,
            flight_context: re(r"(?i)\b(?:your\s+(?:booking|flight|trip|itinerary|e-?ticket|reservation)|thank\s+you\s+for\s+booking|e-?ticket|boarding\s+pass)\b")?,
            flight_word: re(r"(?i)\b(?:flights?|airline|e-?ticket|boarding\s+pass)\b")?,
            flight_notice: re(r"(?i)\b(?:confirm(?:ed|ation)|itinerary|e-?ticket|delay(?:ed)?|changed?|rescheduled|cancell?ed|reminder|check-?in)\b")?,
            flight_number: re(r"(?i:flight)(?:\s+(?i:number|no\.?|#))?\s*[:#]?\s*\b([A-Z]{2}|[A-Z][0-9]|[0-9][A-Z])\s?(\d{1,4})\b")?,
            route: re(r"\b([A-Z]{3})\s*(?:→|->|⇒|–|—|-|\bto\b)\s*([A-Z]{3})\b")?,
            paren_code: re(r"\(([A-Z]{3})\)")?,
            departure: re(r"(?i:depart(?:s|ure|ing)?(?:\s+time)?)\s*[:\-]?\s*([^\n]{4,60})")?,
            arrival: re(r"(?i:arriv(?:es?|al|ing)(?:\s+time)?)\s*[:\-]?\s*([^\n]{4,60})")?,
            date_line: re(r"(?i:\bdate)\s*[:\-]\s*([^\n]{6,40})")?,
            time_line: re(r"(?i:\btime)\s*[:\-]\s*([^\n]{3,30})")?,
            airline: re(r"(?i:airline|operated by)\s*[:\-]?\s*([A-Z][^\n,]{2,40})")?,

            hotel_context: re(r"(?i)\b(?:hotels?|your stay|lodging|resort|property)\b")?,
            check_in: re(r"(?i:check[- ]?in(?:\s+date)?)\s*[:\-]?\s*([^\n]{4,60})")?,
            check_out: re(r"(?i:check[- ]?out(?:\s+date)?)\s*[:\-]?\s*([^\n]{4,60})")?,
            hotel_name: re(r"(?i:hotel|property|accommodation)(?:\s+(?i:name))?\s*:\s*([^\n]{3,80})")?,

            order_context: re(r"(?i)\b(?:order\s+(?:confirm(?:ed|ation)|received|placed|details|summary|cancell?ed)|thanks?(?:\s+you)?\s+for\s+your\s+(?:order|purchase)|your\s+order)\b")?,
            order_number: re(r"(?i:order)(?:\s+(?i:number|no\.?|id|reference|ref\.?)\s*[:#]?|\s*[:#])\s*#?\s*([A-Z0-9][A-Z0-9-]{3,29})\b")?,

            tracking_number: re(r"(?i:tracking|waybill|air\s*waybill|AWB)(?:\s+(?i:number|no\.?|id|code))?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{7,33})\b")?,
            carrier: re(r"\b(UPS|FedEx|USPS|DHL|Royal Mail|DPD|Evri|Hermes|Yodel|Canada Post|Australia Post|Amazon Logistics|Blue Dart|Delhivery|OnTrac|GLS|Purolator)\b")?,
            delivered: re(r"(?i)\b(?:has|have|had|was|were)\s+(?:been\s+)?delivered\b|\bdelivered\s+(?:on|at|today)\b|^\s*delivered\b")?,
            out_for_delivery: re(r"(?i)\bout for delivery\b")?,
            delivery_problem: re(r"(?i)\b(?:delivery (?:attempt|exception)|missed delivery|delayed)\b")?,
            in_transit: re(r"(?i)\b(?:in transit|on (?:its|the) way)\b")?,
            shipped: re(r"(?i)\b(?:shipped|dispatched)\b")?,
            expected: re(r"(?i:(?:expected|estimated|scheduled)\s+(?:delivery|arrival)(?:\s+(?:date|on|by))?|arriving(?:\s+(?:on|by))?|get it by|delivery\s+(?:date|by))\s*[:\-]?\s*([^\n]{4,60})")?,

            return_by: re(r"(?i:return\s+(?:by|before|deadline)|returns?\s+window\s+(?:closes|ends)(?:\s+on)?|last\s+day\s+to\s+return|return\s+(?:it|items?)\s+by|eligible\s+for\s+(?:a\s+)?return\s+(?:until|through|by))\s*[:\-]?\s*([^\n]{4,60})")?,
            renewal_context: re(r"(?i)\b(?:subscription|membership|renews?|renewal)\b")?,
            renewal_date: re(r"(?i:renews?(?:\s+automatically)?(?:\s+on)?|renewal\s+date|next\s+(?:billing|payment|charge)\s+date|will\s+be\s+(?:charged|billed)\s+on)\s*[:\-]?\s*([^\n]{4,60})")?,
            plan: re(r"(?i:\bplan)\s*:\s*([^\n]{2,40})")?,
            payment_context: re(r"(?i)\b(?:payment\s+(?:is\s+)?(?:due|reminder)|amount\s+due|balance\s+due|bill\s+(?:is\s+)?due|minimum\s+payment)\b")?,
            due_date: re(r"(?i:due\s+(?:date|on|by)|pay\s+by|payment\s+due(?:\s+(?:date|on|by))?)\s*[:\-]?\s*([^\n]{4,60})")?,
            amount: re(r"[$€£₹]\s?\d[\d,]*(?:\.\d{2})?|\b(?:USD|EUR|GBP|INR)\s?\d[\d,]*(?:\.\d{2})?")?,
            invoice: re(r"(?i:invoice|bill|statement)(?:\s+(?i:number|no\.?))?\s*[:#]\s*#?\s*([A-Z0-9][A-Z0-9-]{2,29})\b")?,
            appointment_subject: re(r"(?i)\bappointment\b.*\b(?:reminder|confirm(?:ed|ation)|scheduled|booked|rescheduled|upcoming)\b|\b(?:reminder|confirm(?:ed|ation)|scheduled|booked|rescheduled|upcoming)\b.*\bappointment\b")?,
            appointment_time: re(r"(?i:\bwhen|\bdate(?:\s*(?:and|&)\s*time)?|\bappointment(?:\s+(?:date|time))?|\bscheduled\s+for)\s*[:\-]\s*([^\n]{4,60})")?,
        })
    }
}

static RULES: LazyLock<Option<Rules>> = LazyLock::new(|| Rules::new().ok());

pub(super) fn extract(message: &Message) -> Vec<ContextEvent> {
    let Some(rules) = RULES.as_ref() else { return Vec::new() };
    let subject = message.subject.as_str();
    if rules.reply.is_match(subject) || (rules.promo.is_match(subject) && !rules.transactional.is_match(subject)) {
        return Vec::new();
    }
    let body = readable_body(message, rules);
    let mail = Mail {
        message,
        rules,
        cancelled: rules.cancelled_subject.is_match(subject)
            || body.lines().any(|l| rules.cancelled_body.is_match(l) && !rules.conditional.is_match(l)),
        text: format!("{subject}\n{body}"),
    };

    let mut items = mail.flights();
    if items.is_empty() {
        items.extend(mail.stay().or_else(|| mail.parcel()).or_else(|| mail.order()));
    }
    if items.is_empty() {
        items.extend(mail.renewal().or_else(|| mail.payment()).or_else(|| mail.appointment()));
    }
    // A deadline often sits in an order mail, so it is looked for alongside it.
    items.extend(mail.return_deadline());
    items
}

fn readable_body(message: &Message, rules: &Rules) -> String {
    // Some senders put only "view this in your browser" in the plain part.
    let plain = message.text.as_deref().filter(|text| text.trim().len() >= 40);
    let body = match (plain, message.html.as_deref()) {
        (Some(text), _) => text.to_string(),
        (None, Some(html)) => html_to_text(html, rules),
        (None, None) => message.text.clone().unwrap_or_default(),
    };
    body.replace("\r\n", "\n").replace('\u{a0}', " ")
}

fn html_to_text(html: &str, rules: &Rules) -> String {
    let visible = rules.invisible.replace_all(html, " ");
    let lined = rules.block_end.replace_all(&visible, "\n");
    let cells = lined.replace("</td>", " ").replace("</TD>", " ");
    let bare = rules.tag.replace_all(&cells, "");
    let numeric = rules.numeric_entity.replace_all(&bare, |c: &regex::Captures| {
        let code = c[1].strip_prefix('x').map_or_else(|| c[1].parse().ok(), |hex| u32::from_str_radix(hex, 16).ok());
        code.and_then(char::from_u32).map(String::from).unwrap_or_default()
    });
    numeric
        .replace("&nbsp;", " ")
        .replace("&pound;", "£")
        .replace("&euro;", "€")
        .replace("&rarr;", "→")
        .replace("&ndash;", "–")
        .replace("&mdash;", "—")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// The first value after a label that actually reads as a date.
fn labelled(label: &Regex, text: &str) -> Option<EventTime> {
    label.captures_iter(text).find_map(|c| parse_loose(&c[1]))
}

struct Mail<'a> {
    message: &'a Message,
    rules: &'a Rules,
    /// Subject and readable body: the text every rule reads.
    text: String,
    cancelled: bool,
}

impl Mail<'_> {
    fn status(&self) -> Option<EventStatus> {
        self.cancelled.then_some(EventStatus::Cancelled)
    }

    fn reference(&self) -> Option<String> {
        self.rules.booking_ref.captures_iter(&self.text).find_map(|c| {
            let found = c.get(1)?;
            let value = found.as_str();
            let digit = value.chars().any(|c| c.is_ascii_digit());
            // "Use booking code SPRING26" is a discount, not a booking.
            let line_start = self.text[..found.start()].rfind('\n').map_or(0, |i| i + 1);
            let line_end = self.text[found.end()..].find('\n').map_or(self.text.len(), |i| found.end() + i);
            let redeemed = self.rules.redeem.is_match(&self.text[line_start..line_end]);
            ((digit || value.len() == 6) && !NOT_A_REFERENCE.contains(&value) && !redeemed).then(|| value.to_string())
        })
    }

    /// As `labelled`, also accepting "Departs: 08:45" under a separate date line.
    fn labelled_with_date_line(&self, label: &Regex, text: &str) -> Option<EventTime> {
        labelled(label, text).or_else(|| {
            let (time, _) = label.captures_iter(text).find_map(|c| clock(&c[1]))?;
            match labelled(&self.rules.date_line, text)? {
                EventTime::Date(date) => Some(EventTime::Naive(date.and_time(time))),
                _ => None,
            }
        })
    }

    fn flights(&self) -> Vec<ContextEvent> {
        if !self.rules.flight_context.is_match(&self.text) {
            return Vec::new();
        }
        let reference = self.reference();
        let legs = self.flight_legs();
        if legs.is_empty() {
            // "Booking ABC123 has been cancelled" names no leg, and the store
            // applies a bare booking key to all of them. "Your reservation" alone
            // could just as well be a hotel, so this needs to say flight.
            if self.cancelled && reference.is_some() && self.rules.flight_word.is_match(&self.text) {
                let facts = FlightFacts { reference, status: self.status(), ..Default::default() };
                return facts.into_event(self.message, confidence(2)).into_iter().collect();
            }
            return Vec::new();
        }
        if reference.is_none() && !self.rules.flight_notice.is_match(&self.message.subject) {
            return Vec::new();
        }
        let airline = self.rules.airline.captures(&self.text).map(|c| c[1].trim().to_string());
        let mut items = Vec::new();
        for (index, (number, start)) in legs.iter().enumerate() {
            let segment = if legs.len() == 1 {
                self.text.as_str()
            } else {
                &self.text[*start..legs.get(index + 1).map_or(self.text.len(), |next| next.1)]
            };
            let (from, to) = self.airports(segment);
            let facts = FlightFacts {
                reference: reference.clone(),
                airline: airline.clone(),
                number: Some(number.clone()),
                departs: self.labelled_with_date_line(&self.rules.departure, segment),
                arrives: self.labelled_with_date_line(&self.rules.arrival, segment),
                status: self.status(),
                from,
                to,
            };
            let corroborating = [
                facts.reference.is_some(),
                facts.airline.is_some(),
                facts.from.is_some(),
                facts.to.is_some(),
                facts.departs.is_some(),
                facts.arrives.is_some(),
                true,
            ];
            let score = confidence(corroborating.iter().filter(|known| **known).count());
            items.extend(facts.into_event(self.message, score));
        }
        items
    }

    /// Distinct flight numbers with where each first appears, so a two-leg
    /// itinerary can be cut into one stretch of text per leg.
    fn flight_legs(&self) -> Vec<(String, usize)> {
        let mut legs: Vec<(String, usize)> = Vec::new();
        for found in self.rules.flight_number.captures_iter(&self.text) {
            let number = format!("{}{}", &found[1], &found[2]);
            if !legs.iter().any(|(known, _)| *known == number) {
                legs.push((number, found.get(0).map_or(0, |m| m.start())));
            }
        }
        legs
    }

    fn airports(&self, text: &str) -> (Option<String>, Option<String>) {
        let real = |code: &str| !NOT_AN_AIRPORT.contains(&code);
        if let Some(c) = self.rules.route.captures_iter(text).find(|c| real(&c[1]) && real(&c[2])) {
            return (Some(c[1].to_string()), Some(c[2].to_string()));
        }
        let mut codes = self.rules.paren_code.captures_iter(text).map(|c| c[1].to_string()).filter(|c| real(c));
        let from = codes.next();
        let to = codes.find(|code| Some(code) != from.as_ref());
        match (from, to) {
            (Some(from), Some(to)) => (Some(from), Some(to)),
            _ => (None, None),
        }
    }

    fn stay(&self) -> Option<ContextEvent> {
        if !self.rules.hotel_context.is_match(&self.text) {
            return None;
        }
        let reference = self.reference()?;
        let check_in = labelled(&self.rules.check_in, &self.text);
        // A hotel name is not enough, and "free cancellation" appears in every
        // booking mail, so a new stay needs its dates and a cancellation its reference.
        if check_in.is_none() && !self.cancelled {
            return None;
        }
        let check_out = labelled(&self.rules.check_out, &self.text);
        let name = self.rules.hotel_name.captures(&self.text).map(|c| c[1].trim().to_string());
        let score = confidence(2 + usize::from(check_in.is_some()) + usize::from(check_out.is_some()) + usize::from(name.is_some()));
        let facts = StayFacts {
            reference: Some(reference),
            status: self.status(),
            name,
            check_in,
            check_out,
            ..Default::default()
        };
        facts.into_event(self.message, score)
    }

    /// An amount on a line that says what it is. The first figure in a mail is
    /// as likely to be "free shipping over $50" as the thing being charged.
    fn amount_beside(&self, labels: &[&str]) -> Option<String> {
        let beside_label = |line: &&str| {
            let lowered = line.to_lowercase();
            labels.iter().any(|label| lowered.contains(label))
        };
        self.text.lines().filter(beside_label).find_map(|line| self.rules.amount.find(line)).map(|m| m.as_str().to_string())
    }

    fn order_number(&self) -> Option<String> {
        self.rules
            .order_number
            .captures_iter(&self.text)
            .map(|c| c[1].to_string())
            .find(|value| value.chars().any(|c| c.is_ascii_digit()))
    }

    fn order(&self) -> Option<ContextEvent> {
        if !self.rules.order_context.is_match(&self.text) {
            return None;
        }
        let number = self.order_number()?;
        let merchant = sender_name(&self.message.from);
        let total = self.amount_beside(&["total"]);
        let score = confidence(3 + usize::from(total.is_some()));
        let facts =
            OrderFacts { number: Some(number), merchant, total, status: self.status(), ..Default::default() };
        facts.into_event(self.message, score)
    }

    fn delivery_status(&self) -> Option<(&'static str, Option<EventStatus>)> {
        let rules = self.rules;
        let any_line = |rule: &Regex| self.text.lines().any(|line| rule.is_match(line));
        if any_line(&rules.delivered) {
            Some(("Delivered", Some(EventStatus::Completed)))
        } else if rules.out_for_delivery.is_match(&self.text) {
            Some(("Out for delivery", None))
        } else if rules.delivery_problem.is_match(&self.text) {
            Some(("Delivery problem", None))
        } else if rules.in_transit.is_match(&self.text) {
            Some(("In transit", None))
        } else if rules.shipped.is_match(&self.text) {
            Some(("Shipped", None))
        } else {
            None
        }
    }

    fn parcel(&self) -> Option<ContextEvent> {
        let tracking = self
            .rules
            .tracking_number
            .captures_iter(&self.text)
            .map(|c| c[1].to_string())
            .find(|value| value.chars().any(|c| c.is_ascii_digit()))?;
        let (delivery_status, status) = self.delivery_status()?;
        let carrier = self.rules.carrier.captures(&self.text).map(|c| c[1].to_string());
        let expected = labelled(&self.rules.expected, &self.text);
        let link = self.tracking_link(&tracking);
        let corroborating = 2 + usize::from(carrier.is_some()) + usize::from(expected.is_some()) + usize::from(link.is_some());
        let facts = ParcelFacts {
            order_number: self.order_number(),
            tracking: Some(tracking),
            delivery_status: Some(delivery_status.to_string()),
            expected_until: expected,
            carrier,
            link,
            status,
            ..Default::default()
        };
        facts.into_event(self.message, confidence(corroborating))
    }

    /// A URL is only taken as the tracking link if it names the parcel or sits
    /// on a carrier's own site, not because it is the first link in the mail.
    fn tracking_link(&self, tracking: &str) -> Option<String> {
        let html = self.message.html.as_deref().unwrap_or("").replace("&amp;", "&");
        let urls: Vec<&str> = [self.text.as_str(), html.as_str()]
            .into_iter()
            .flat_map(|source| self.rules.url.find_iter(source))
            .map(|m| m.as_str().trim_end_matches(['.', ',', ';']))
            .collect();
        let names_parcel = urls.iter().find(|url| url.contains(tracking));
        let on_carrier_site = urls.iter().find(|url| {
            let lowered = url.to_ascii_lowercase();
            lowered.contains("track") && CARRIER_LINK_HOSTS.iter().any(|host| lowered.contains(host))
        });
        names_parcel.or(on_carrier_site).map(|url| url.to_string())
    }

    fn return_deadline(&self) -> Option<ContextEvent> {
        let deadline = labelled(&self.rules.return_by, &self.text)?;
        let order = self.order_number();
        let id = order.clone().unwrap_or_else(|| deadline.to_string());
        let dedupe_key = format!("return:{}:{id}", sender_org(&self.message.from));
        let title = order.as_ref().map_or_else(|| "Return deadline".to_string(), |o| format!("Return deadline for order {o}"));
        let mut event = draft(self.message, EventKind::ReturnDeadline, title, dedupe_key, confidence(3 + usize::from(order.is_some())));
        event.priority = Priority::Important;
        event.starts_at = Some(deadline);
        put(&mut event.metadata, "orderNumber", order);
        Some(event)
    }

    fn renewal(&self) -> Option<ContextEvent> {
        if !self.rules.renewal_context.is_match(&self.message.subject) {
            return None;
        }
        let renews = labelled(&self.rules.renewal_date, &self.text)?;
        let plan = self.rules.plan.captures(&self.text).map(|c| c[1].trim().to_string());
        let amount = self.amount_beside(&["charged", "price", "amount", "renew"]);
        let org = sender_org(&self.message.from);
        let dedupe_key = match &plan {
            Some(plan) => format!("subscription:{org}:{}", plan.to_lowercase()),
            None => format!("subscription:{org}"),
        };
        let name = sender_name(&self.message.from).unwrap_or(org);
        let score = confidence(2 + usize::from(plan.is_some()) + usize::from(amount.is_some()));
        let mut event = draft(self.message, EventKind::SubscriptionRenewal, format!("{name} renewal"), dedupe_key, score);
        event.starts_at = Some(renews);
        put(&mut event.metadata, "plan", plan);
        put(&mut event.metadata, "amount", amount);
        Some(event)
    }

    fn payment(&self) -> Option<ContextEvent> {
        if !self.rules.payment_context.is_match(&self.text) {
            return None;
        }
        let due = labelled(&self.rules.due_date, &self.text)?;
        let invoice = self.rules.invoice.captures(&self.text).map(|c| c[1].to_string());
        let amount = self.amount_beside(&["due", "amount", "balance", "total"]);
        // A due date alone reads the same in a generic explainer; a real bill
        // has a number or an amount too.
        if invoice.is_none() && amount.is_none() {
            return None;
        }
        let org = sender_org(&self.message.from);
        let id = invoice.clone().unwrap_or_else(|| due.to_string());
        let dedupe_key = format!("payment:{org}:{id}");
        let name = sender_name(&self.message.from).unwrap_or(org);
        let score = confidence(2 + usize::from(invoice.is_some()) + usize::from(amount.is_some()));
        let mut event = draft(self.message, EventKind::PaymentReminder, format!("{name} payment due"), dedupe_key, score);
        event.priority = Priority::Important;
        event.status = self.status().unwrap_or(EventStatus::Active);
        event.starts_at = Some(due);
        put(&mut event.metadata, "invoice", invoice);
        put(&mut event.metadata, "amount", amount);
        Some(event)
    }

    fn appointment(&self) -> Option<ContextEvent> {
        if !self.rules.appointment_subject.is_match(&self.message.subject) {
            return None;
        }
        let when = labelled(&self.rules.appointment_time, &self.text)?;
        let when = match (when, self.rules.time_line.captures(&self.text).and_then(|c| clock(&c[1]))) {
            (EventTime::Date(date), Some((time, None))) => EventTime::Naive(date.and_time(time)),
            (other, _) => other,
        };
        let reference = self.reference();
        let org = sender_org(&self.message.from);
        let id = reference.clone().unwrap_or_else(|| when.to_string());
        let dedupe_key = format!("appointment:{org}:{id}");
        let name = sender_name(&self.message.from).unwrap_or(org);
        let score = confidence(2 + usize::from(reference.is_some()));
        let mut event = draft(self.message, EventKind::Appointment, format!("Appointment with {name}"), dedupe_key, score);
        event.priority = Priority::Important;
        event.status = self.status().unwrap_or(EventStatus::Active);
        event.starts_at = Some(when);
        put(&mut event.metadata, "reference", reference);
        Some(event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_rule_compiles() {
        Rules::new().unwrap();
    }

    #[test]
    fn html_becomes_readable_lines() {
        let rules = Rules::new().unwrap();
        let html = "<html><head><style>p{}</style></head><body><p>Order&nbsp;#A1234</p><!-- x --><script>var a=1</script>\
                    <table><tr><td>Total</td><td>&pound;5 &amp; tax</td></tr></table></body></html>";
        let text = html_to_text(html, &rules);
        assert!(text.contains("Order #A1234\n"), "{text}");
        assert!(text.contains("Total £5 & tax"), "{text}");
        assert!(!text.contains("var a"), "{text}");
    }

    #[test]
    fn confidence_falls_with_fewer_fields_and_stays_below_structured() {
        assert!(confidence(2) < confidence(5));
        assert!(confidence(50) <= 0.8);
    }
}
