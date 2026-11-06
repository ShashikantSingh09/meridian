//! Date parsing that would rather return nothing than guess. A missing year, an
//! order that could be day-first or month-first, and a zone abbreviation all
//! stay unresolved, because a wrong date is worse than an absent one.

use std::sync::LazyLock;

use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime, TimeZone};
use chrono_tz::Tz;
use regex::{Captures, Regex};

use crate::event::EventTime;

struct Patterns {
    dmy: Regex,
    mdy: Regex,
    numeric: Regex,
    clock: Regex,
    iso: Regex,
}

impl Patterns {
    fn new() -> Result<Self, regex::Error> {
        const MONTH: &str = r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
        Ok(Self {
            dmy: Regex::new(&format!(r"(?i)\b(\d{{1,2}})(?:st|nd|rd|th)?\s+{MONTH}\.?,?\s+(\d{{4}})\b"))?,
            mdy: Regex::new(&format!(r"(?i)\b{MONTH}\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?,?\s+(\d{{4}})\b"))?,
            numeric: Regex::new(r"\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b")?,
            iso: Regex::new(r"\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?")?,
            // Only an explicit UTC or GMT counts as a zone. "EST" and "IST" each
            // mean more than one thing, and "09:00-10:00" is a range, not an offset.
            clock: Regex::new(
                r"(?i)\b(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap])\.?m\b\.?(?:\s*(?:UTC|GMT)\b([+-]\d{1,2}(?::?\d{2})?)?)?|\b(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*(UTC|GMT)\b([+-]\d{1,2}(?::?\d{2})?)?)?",
            )?,
        })
    }
}

static PATTERNS: LazyLock<Option<Patterns>> = LazyLock::new(|| Patterns::new().ok());

/// ISO 8601 as schema.org and the calendar APIs write it.
pub(crate) fn parse_iso(text: &str) -> Option<EventTime> {
    let text = text.trim();
    if let Ok(zoned) = DateTime::parse_from_rfc3339(text) {
        return Some(EventTime::Zoned(zoned));
    }
    // schema.org values often drop the seconds.
    if let Ok(zoned) = DateTime::parse_from_str(text, "%Y-%m-%dT%H:%M%#z") {
        return Some(EventTime::Zoned(zoned));
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(text, format) {
            return Some(EventTime::Naive(naive));
        }
    }
    NaiveDate::parse_from_str(text, "%Y-%m-%d").ok().map(EventTime::Date)
}

/// The date, and time if any, written somewhere in a line of mail.
pub fn parse_loose(line: &str) -> Option<EventTime> {
    let patterns = PATTERNS.as_ref()?;
    if let Some(found) = patterns.iso.find(line) {
        return parse_iso(&found.as_str().replacen(' ', "T", 1));
    }
    let (date, span) = if let Some(c) = patterns.dmy.captures(line) {
        (dated(&c[3], month(&c[2])?, &c[1])?, whole(&c))
    } else if let Some(c) = patterns.mdy.captures(line) {
        (dated(&c[3], month(&c[1])?, &c[2])?, whole(&c))
    } else {
        let c = patterns.numeric.captures(line)?;
        (numeric_date(&c[1], &c[2], &c[3])?, whole(&c))
    };
    let rest = format!("{} {}", &line[..span.0], &line[span.1..]);
    Some(match clock(&rest) {
        None => EventTime::Date(date),
        Some((time, None)) => EventTime::Naive(date.and_time(time)),
        Some((time, Some(offset))) => EventTime::Zoned(offset.from_local_datetime(&date.and_time(time)).single()?),
    })
}

fn whole(captures: &Captures) -> (usize, usize) {
    captures.get(0).map_or((0, 0), |m| (m.start(), m.end()))
}

/// A time of day alone, for mail that puts the date on a separate line.
pub(crate) fn clock(text: &str) -> Option<(NaiveTime, Option<FixedOffset>)> {
    let patterns = PATTERNS.as_ref()?;
    patterns.clock.captures_iter(text).find_map(|c| {
        if let Some(hour) = c.get(1) {
            let hour: u32 = hour.as_str().parse().ok()?;
            let minute = c.get(2).map_or(Some(0), |m| m.as_str().parse().ok())?;
            if !(1..=12).contains(&hour) {
                return None;
            }
            let hour = hour % 12 + if c[3].eq_ignore_ascii_case("p") { 12 } else { 0 };
            let offset = zone(c.get(0).map_or("", |m| m.as_str()), c.get(4).map(|m| m.as_str()))?;
            Some((NaiveTime::from_hms_opt(hour, minute, 0)?, offset))
        } else {
            let hour = c.get(5)?.as_str().parse().ok()?;
            let minute = c.get(6)?.as_str().parse().ok()?;
            let offset = zone(c.get(0).map_or("", |m| m.as_str()), c.get(8).map(|m| m.as_str()))?;
            Some((NaiveTime::from_hms_opt(hour, minute, 0)?, offset))
        }
    })
}

/// `None` means the text is unusable; `Some(None)` means no zone was stated.
fn zone(matched: &str, shift: Option<&str>) -> Option<Option<FixedOffset>> {
    let upper = matched.to_ascii_uppercase();
    if !upper.contains("UTC") && !upper.contains("GMT") {
        return Some(None);
    }
    let Some(shift) = shift else { return Some(FixedOffset::east_opt(0)) };
    let negative = shift.starts_with('-');
    let digits: String = shift[1..].chars().filter(char::is_ascii_digit).collect();
    let (hours, minutes) = if digits.len() > 2 { digits.split_at(digits.len() - 2) } else { (digits.as_str(), "0") };
    let seconds = hours.parse::<i32>().ok()? * 3600 + minutes.parse::<i32>().ok()? * 60;
    Some(FixedOffset::east_opt(if negative { -seconds } else { seconds }))
}

fn dated(year: &str, month: u32, day: &str) -> Option<NaiveDate> {
    NaiveDate::from_ymd_opt(year.parse().ok()?, month, day.parse().ok()?)
}

fn month(name: &str) -> Option<u32> {
    const NAMES: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let prefix = name.get(..3)?.to_ascii_lowercase();
    NAMES.iter().position(|n| *n == prefix).and_then(|i| u32::try_from(i + 1).ok())
}

/// 25/11/2026 can only be day-first and 11/25/2026 only month-first, but
/// 03/04/2026 could be either, so it resolves to nothing.
fn numeric_date(first: &str, second: &str, year: &str) -> Option<NaiveDate> {
    let (a, b): (u32, u32) = (first.parse().ok()?, second.parse().ok()?);
    let (month, day) = match (a > 12, b > 12) {
        (true, false) => (b, a),
        (false, true) => (a, b),
        (false, false) if a == b => (a, b),
        _ => return None,
    };
    NaiveDate::from_ymd_opt(year.parse().ok()?, month, day)
}

/// Resolves a named zone to an instant. Returns `None` for a zone nobody can
/// identify or a wall-clock time that never happened, and the caller keeps the
/// naive value rather than picking an offset.
pub(crate) fn in_zone(naive: NaiveDateTime, tzid: &str) -> Option<EventTime> {
    let zone = named_zone(tzid.trim().trim_matches('"'))?;
    let resolved = zone.from_local_datetime(&naive).earliest()?;
    Some(EventTime::Zoned(resolved.fixed_offset()))
}

fn named_zone(tzid: &str) -> Option<Tz> {
    if let Ok(zone) = tzid.parse() {
        return Some(zone);
    }
    if let Some((_, iana)) = WINDOWS_ZONES.iter().find(|(windows, _)| *windows == tzid) {
        return iana.parse().ok();
    }
    // Some producers prefix the IANA name, e.g. /example.org/America/New_York.
    let mut tail = tzid.rsplit('/');
    let (city, region) = (tail.next()?, tail.next()?);
    format!("{region}/{city}").parse().ok()
}

// ponytail: the zones Outlook writes for most users, from CLDR windowsZones. An
// unlisted name stays naive with its TZID recorded; add a row when one turns up.
const WINDOWS_ZONES: &[(&str, &str)] = &[
    ("Hawaiian Standard Time", "Pacific/Honolulu"),
    ("Alaskan Standard Time", "America/Anchorage"),
    ("Pacific Standard Time", "America/Los_Angeles"),
    ("US Mountain Standard Time", "America/Phoenix"),
    ("Mountain Standard Time", "America/Denver"),
    ("Central Standard Time", "America/Chicago"),
    ("Canada Central Standard Time", "America/Regina"),
    ("Eastern Standard Time", "America/New_York"),
    ("Atlantic Standard Time", "America/Halifax"),
    ("Newfoundland Standard Time", "America/St_Johns"),
    ("SA Pacific Standard Time", "America/Bogota"),
    ("Central Standard Time (Mexico)", "America/Mexico_City"),
    ("E. South America Standard Time", "America/Sao_Paulo"),
    ("Argentina Standard Time", "America/Argentina/Buenos_Aires"),
    ("GMT Standard Time", "Europe/London"),
    ("Greenwich Standard Time", "Atlantic/Reykjavik"),
    ("W. Europe Standard Time", "Europe/Berlin"),
    ("Central Europe Standard Time", "Europe/Budapest"),
    ("Romance Standard Time", "Europe/Paris"),
    ("Central European Standard Time", "Europe/Warsaw"),
    ("W. Central Africa Standard Time", "Africa/Lagos"),
    ("GTB Standard Time", "Europe/Bucharest"),
    ("FLE Standard Time", "Europe/Kiev"),
    ("Israel Standard Time", "Asia/Jerusalem"),
    ("Egypt Standard Time", "Africa/Cairo"),
    ("South Africa Standard Time", "Africa/Johannesburg"),
    ("Turkey Standard Time", "Europe/Istanbul"),
    ("Russian Standard Time", "Europe/Moscow"),
    ("Arab Standard Time", "Asia/Riyadh"),
    ("Arabian Standard Time", "Asia/Dubai"),
    ("Pakistan Standard Time", "Asia/Karachi"),
    ("India Standard Time", "Asia/Kolkata"),
    ("Sri Lanka Standard Time", "Asia/Colombo"),
    ("Nepal Standard Time", "Asia/Kathmandu"),
    ("Bangladesh Standard Time", "Asia/Dhaka"),
    ("SE Asia Standard Time", "Asia/Bangkok"),
    ("China Standard Time", "Asia/Shanghai"),
    ("Singapore Standard Time", "Asia/Singapore"),
    ("Taipei Standard Time", "Asia/Taipei"),
    ("Tokyo Standard Time", "Asia/Tokyo"),
    ("Korea Standard Time", "Asia/Seoul"),
    ("AUS Eastern Standard Time", "Australia/Sydney"),
    ("E. Australia Standard Time", "Australia/Brisbane"),
    ("New Zealand Standard Time", "Pacific/Auckland"),
];

#[cfg(test)]
mod tests {
    use super::*;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    fn naive(y: i32, m: u32, d: u32, h: u32, min: u32) -> EventTime {
        EventTime::Naive(date(y, m, d).and_hms_opt(h, min, 0).unwrap())
    }

    #[test]
    fn iso_keeps_the_precision_it_was_given() {
        assert!(matches!(parse_iso("2026-11-20T08:45:00-05:00"), Some(EventTime::Zoned(_))));
        assert!(matches!(parse_iso("2026-11-20T08:45-05:00"), Some(EventTime::Zoned(_))));
        assert!(matches!(parse_iso("2026-11-20T08:45Z"), Some(EventTime::Zoned(_))));
        assert_eq!(parse_iso("2026-11-20T08:45:00"), Some(naive(2026, 11, 20, 8, 45)));
        assert_eq!(parse_iso("2026-11-20"), Some(EventTime::Date(date(2026, 11, 20))));
        assert_eq!(parse_iso("tomorrow"), None);
    }

    #[test]
    fn reads_written_dates() {
        assert_eq!(parse_loose("Fri, 20 Nov 2026 08:45"), Some(naive(2026, 11, 20, 8, 45)));
        assert_eq!(parse_loose("November 20th, 2026 at 8:45 PM"), Some(naive(2026, 11, 20, 20, 45)));
        assert_eq!(parse_loose("Nov 20, 2026"), Some(EventTime::Date(date(2026, 11, 20))));
        assert_eq!(parse_loose("12 Sept 2026, 12:05 am"), Some(naive(2026, 9, 12, 0, 5)));
        assert_eq!(parse_loose("3 Dec 2026 2pm"), Some(naive(2026, 12, 3, 14, 0)));
    }

    #[test]
    fn never_guesses_a_year() {
        assert_eq!(parse_loose("Nov 20"), None);
        assert_eq!(parse_loose("20 November at 08:45"), None);
        assert_eq!(parse_loose("11/20/26"), None);
    }

    #[test]
    fn leaves_ambiguous_day_month_order_alone() {
        assert_eq!(parse_loose("03/04/2026"), None);
        assert_eq!(parse_loose("25/11/2026"), Some(EventTime::Date(date(2026, 11, 25))));
        assert_eq!(parse_loose("11/25/2026"), Some(EventTime::Date(date(2026, 11, 25))));
        assert_eq!(parse_loose("04/04/2026"), Some(EventTime::Date(date(2026, 4, 4))));
    }

    #[test]
    fn rejects_dates_that_do_not_exist() {
        assert_eq!(parse_loose("30 Feb 2026"), None);
    }

    #[test]
    fn a_zone_abbreviation_stays_naive_but_utc_is_exact() {
        assert_eq!(parse_loose("20 Nov 2026 08:45 EST"), Some(naive(2026, 11, 20, 8, 45)));
        assert_eq!(parse_loose("20 Nov 2026 08:45 IST"), Some(naive(2026, 11, 20, 8, 45)));
        let utc = parse_loose("20 Nov 2026 08:45 UTC").unwrap();
        assert_eq!(utc.to_string(), "2026-11-20T08:45:00Z");
        let shifted = parse_loose("20 Nov 2026 08:45 GMT+5:30").unwrap();
        assert_eq!(shifted.to_string(), "2026-11-20T03:15:00Z");
    }

    #[test]
    fn a_time_range_is_not_an_offset() {
        assert_eq!(parse_loose("20 Nov 2026 09:00-10:00"), Some(naive(2026, 11, 20, 9, 0)));
    }

    #[test]
    fn resolves_iana_windows_and_prefixed_zones() {
        let wall = date(2026, 11, 5).and_hms_opt(10, 0, 0).unwrap();
        for zone in ["America/New_York", "Eastern Standard Time", "/example.org/America/New_York"] {
            assert_eq!(in_zone(wall, zone).unwrap().to_string(), "2026-11-05T15:00:00Z", "{zone}");
        }
        assert_eq!(in_zone(wall, "India Standard Time").unwrap().to_string(), "2026-11-05T04:30:00Z");
    }

    #[test]
    fn an_unknown_zone_resolves_to_nothing() {
        let wall = date(2026, 11, 5).and_hms_opt(10, 0, 0).unwrap();
        assert_eq!(in_zone(wall, "Customized Time Zone"), None);
    }

    #[test]
    fn a_wall_clock_time_skipped_by_dst_resolves_to_nothing() {
        let skipped = date(2026, 3, 8).and_hms_opt(2, 30, 0).unwrap();
        assert_eq!(in_zone(skipped, "America/New_York"), None);
    }
}
