//! Decides what interrupts and what waits. Pure logic: the app passes in the
//! clock, the events and what has already been shown, records what comes back,
//! and calls again on its next tick.

use std::collections::HashMap;

use chrono::{DateTime, FixedOffset, NaiveTime, TimeDelta, Utc};
use serde::{Deserialize, Serialize};

use crate::event::{Category, ContextEvent, EventKind, EventStatus, EventTime, Priority};

const DAY_MINUTES: u32 = 24 * 60;
/// Nearer than this a flight is Critical: a 6am departure's 3h stage falls
/// inside most quiet hours and is the one that actually gets you to the airport.
const FLIGHT_CRITICAL_MINUTES: i64 = 3 * 60;
/// A first sync imports months of mail, and none of that is news.
const NEWS_WINDOW_HOURS: i64 = 24;
const AT_TIME_GRACE_MINUTES: i64 = 10;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuietHours {
    pub start: NaiveTime,
    pub end: NaiveTime,
}

impl QuietHours {
    /// 22:00 to 07:00 wraps midnight. Equal ends mean quiet hours are off.
    fn contains(&self, time: NaiveTime) -> bool {
        if self.start <= self.end {
            self.start <= time && time < self.end
        } else {
            time >= self.start || time < self.end
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryPreferences {
    pub enabled: bool,
    /// Minutes before the start. Empty means the category is news-driven and
    /// reminds on change instead.
    pub lead_minutes: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub categories: HashMap<Category, CategoryPreferences>,
    pub quiet_hours: Option<QuietHours>,
    /// Non-critical reminders surfaced per rolling hour.
    pub max_per_hour: Option<u32>,
}

impl Default for Preferences {
    fn default() -> Self {
        let enabled = |lead_minutes: &[u32]| CategoryPreferences { enabled: true, lead_minutes: lead_minutes.to_vec() };
        Self {
            categories: HashMap::from([
                (Category::Travel, enabled(&[24 * 60, 3 * 60, 15])),
                (Category::Meetings, enabled(&[15, 5])),
                (Category::ImportantDates, enabled(&[24 * 60, 0])),
                (Category::Deliveries, enabled(&[])),
                (Category::Orders, enabled(&[])),
            ]),
            quiet_hours: None,
            max_per_hour: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterruptionContext {
    pub agent_session_active: bool,
    pub in_call: bool,
    pub media_playing: bool,
    pub screen_assist_active: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Stage {
    Lead { minutes: u32 },
    Changed,
    Rescheduled,
    Cancelled,
    SnoozeEnded,
}

/// Why a reminder sits in the activity centre for now. It may still surface
/// later, unlike one routed there outright.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Hold {
    QuietHours,
    Busy,
    FrequencyCap,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    /// Identifies this event at this stage for this time, so firing is once-only
    /// and a reschedule naturally starts a new set.
    pub key: String,
    pub event_id: String,
    pub stage: Stage,
    pub priority: Priority,
    pub title: String,
    pub starts_at: Option<EventTime>,
    /// The start has no zone and was read on the user's own clock, so the UI
    /// should not promise an exact countdown.
    pub approximate_time: bool,
    /// The earlier reminder this one takes the place of in the UI.
    pub replaces: Option<String>,
    pub hold: Option<Hold>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub surface: Vec<Reminder>,
    pub activity_centre: Vec<Reminder>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Disposition {
    Surfaced,
    Centre,
    Held,
}

/// What the app recorded from an earlier [`Decision`], via `Store::record_decision`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub key: String,
    pub event_id: String,
    pub stage: Stage,
    pub starts_at: Option<EventTime>,
    pub disposition: Disposition,
    pub at: DateTime<Utc>,
}

/// One pass over `events`. `now` carries the user's UTC offset, which is what
/// quiet hours and date-only events are read against. Each event yields at most
/// one reminder, so a change replaces rather than stacks.
pub fn decide(
    events: &[ContextEvent],
    now: DateTime<FixedOffset>,
    preferences: &Preferences,
    context: &InterruptionContext,
    log: &[LogEntry],
) -> Decision {
    let mut candidates: Vec<(Reminder, DateTime<Utc>)> = events
        .iter()
        .filter_map(|event| {
            let reminder = candidate(event, now, preferences, log)?;
            Some((reminder, event.timeline_at(*now.offset())))
        })
        .collect();
    candidates.sort_by(|a, b| b.0.priority.cmp(&a.0.priority).then(a.1.cmp(&b.1)));

    let quiet = preferences.quiet_hours.as_ref().is_some_and(|q| q.contains(now.time()));
    let hour_ago = now.to_utc() - TimeDelta::hours(1);
    let mut surfaced_this_hour =
        log.iter().filter(|e| e.disposition == Disposition::Surfaced && e.at > hour_ago).count();
    let mut decision = Decision::default();
    for (mut reminder, _) in candidates {
        match route(reminder.priority, quiet, context) {
            Route::Surface => {
                let capped = reminder.priority != Priority::Critical
                    && preferences.max_per_hour.is_some_and(|cap| surfaced_this_hour >= cap as usize);
                if capped {
                    reminder.hold = Some(Hold::FrequencyCap);
                    push_held(&mut decision, reminder, log);
                } else {
                    surfaced_this_hour += 1;
                    decision.surface.push(reminder);
                }
            }
            Route::Hold(hold) => {
                reminder.hold = Some(hold);
                push_held(&mut decision, reminder, log);
            }
            Route::Centre => decision.activity_centre.push(reminder),
        }
    }
    decision
}

/// A held reminder comes back every tick until it can surface, but the activity
/// centre only needs telling once.
fn push_held(decision: &mut Decision, reminder: Reminder, log: &[LogEntry]) {
    if !log.iter().any(|e| e.key == reminder.key) {
        decision.activity_centre.push(reminder);
    }
}

enum Route {
    Surface,
    Hold(Hold),
    Centre,
}

fn route(priority: Priority, quiet: bool, context: &InterruptionContext) -> Route {
    let focused = context.agent_session_active || context.screen_assist_active || context.in_call;
    match priority {
        Priority::Critical => Route::Surface,
        Priority::Low => Route::Centre,
        _ if quiet => Route::Hold(Hold::QuietHours),
        Priority::Important if context.in_call => Route::Hold(Hold::Busy),
        Priority::Important => Route::Surface,
        Priority::Informational if focused => Route::Centre,
        Priority::Informational => Route::Surface,
    }
}

fn candidate(
    event: &ContextEvent,
    now: DateTime<FixedOffset>,
    preferences: &Preferences,
    log: &[LogEntry],
) -> Option<Reminder> {
    let utc_now = now.to_utc();
    let snoozed = event.snoozed_until.is_some_and(|until| until > utc_now);
    let expired = event.expires_at.is_some_and(|at| at <= utc_now);
    let declined = event.metadata.get("responseStatus").is_some_and(|r| r == "declined");
    if event.status == EventStatus::Dismissed || snoozed || expired || declined {
        return None;
    }
    let category = preferences.categories.get(&event.home_category()?).filter(|c| c.enabled)?;

    let history: Vec<&LogEntry> = log.iter().filter(|e| e.event_id == event.id).collect();
    // Held reminders were never seen, so they do not count as delivered.
    let delivered = |key: &str| history.iter().any(|e| e.key == key && e.disposition != Disposition::Held);
    let last_seen = history.iter().filter(|e| e.disposition == Disposition::Surfaced).max_by_key(|e| e.at);
    let is_news = event.occurred_at >= utc_now - TimeDelta::hours(NEWS_WINDOW_HOURS);
    let build = |key: String, stage: Stage, priority: Priority, replaces: Option<String>| {
        (!delivered(&key)).then(|| Reminder {
            key,
            event_id: event.id.clone(),
            stage,
            priority,
            title: event.title.clone(),
            starts_at: event.starts_at,
            approximate_time: event.starts_at.is_some_and(|t| !t.is_exact()),
            replaces,
            hold: None,
        })
    };

    if event.status == EventStatus::Cancelled {
        // A cancellation only needs telling if it undoes a reminder or is new.
        if last_seen.is_none() && !is_news {
            return None;
        }
        let replaces = last_seen.map(|e| e.key.clone());
        return build(format!("{}:cancelled", event.id), Stage::Cancelled, event.priority.max(Priority::Important), replaces);
    }

    let replaced = last_seen.map(|e| e.key.clone());
    // The stage log can only spot a move it reminded about, so a move the
    // source just announced counts too, even with no reminder yet.
    let moved = event.starts_at.filter(|start| {
        let reminded_at = last_seen.filter(|e| matches!(e.stage, Stage::Lead { .. } | Stage::Rescheduled));
        let announced = !category.lead_minutes.is_empty()
            && is_news
            && event.changed_fields.iter().any(|field| field == "startsAt");
        announced || reminded_at.and_then(|e| e.starts_at).is_some_and(|before| before.to_string() != start.to_string())
    });

    if event.status != EventStatus::Completed {
        if let Some((minutes, start)) = due_lead(event, &category.lead_minutes, now) {
            let key = format!("{}:lead:{minutes}:{start}", event.id);
            let replaces = moved.and(replaced.clone());
            if let Some(reminder) = build(key, Stage::Lead { minutes }, lead_priority(event, start, now), replaces) {
                return Some(reminder);
            }
        }
        // Snoozing means "remind me again", so its end fires with no stage due.
        // Only a personal reminder is still worth repeating once its time has passed.
        let local = *now.offset();
        let over = event.ends_at.or(event.starts_at).is_some_and(|t| t.instant(local) < utc_now);
        if let Some(until) = event.snoozed_until.filter(|_| !over || event.kind == EventKind::UserReminder) {
            if utc_now - until < TimeDelta::hours(NEWS_WINDOW_HOURS) {
                let key = format!("{}:snooze:{}", event.id, until.timestamp());
                let priority = event.priority.max(Priority::Important);
                if let Some(reminder) = build(key, Stage::SnoozeEnded, priority, replaced.clone()) {
                    return Some(reminder);
                }
            }
        }
    }
    if let Some(start) = moved {
        let priority = event.priority.max(Priority::Important);
        return build(format!("{}:rescheduled:{start}", event.id), Stage::Rescheduled, priority, replaced);
    }
    if category.lead_minutes.is_empty() && is_news {
        return build(format!("{}:changed:{}", event.id, event.revision), Stage::Changed, event.priority, None);
    }
    None
}

/// The nearest stage already reached. Stages passed while the app was closed
/// are skipped rather than fired late, so a restart ten minutes before a flight
/// says "15 minutes", not all three at once.
fn due_lead(event: &ContextEvent, lead_minutes: &[u32], now: DateTime<FixedOffset>) -> Option<(u32, EventTime)> {
    // A news-driven category has no countdown, not even the day itself.
    if lead_minutes.is_empty() {
        return None;
    }
    let start = event.starts_at?;
    let at = start.instant(*now.offset());
    let reached = |minutes: &u32| now.to_utc() >= at - TimeDelta::minutes((*minutes).into());
    let nearest = if let EventTime::Date(date) = start {
        if now.date_naive() > date {
            return None;
        }
        // A date has no hour to count back from, so only whole days apply, plus
        // the day itself. Quiet hours carry a midnight firing to the morning.
        let whole_days = lead_minutes.iter().copied().filter(|m| m % DAY_MINUTES == 0);
        whole_days.chain([0]).filter(|m| reached(m)).min()
    } else {
        // A zero lead means "at the time", and a tick rarely lands exactly on it.
        let at_time_open = lead_minutes.contains(&0) && now.to_utc() < at + TimeDelta::minutes(AT_TIME_GRACE_MINUTES);
        if now.to_utc() >= at && !at_time_open {
            return None;
        }
        lead_minutes.iter().copied().filter(|m| reached(m)).min()
    };
    nearest.map(|minutes| (minutes, start))
}

fn lead_priority(event: &ContextEvent, start: EventTime, now: DateTime<FixedOffset>) -> Priority {
    let remaining = start.instant(*now.offset()) - now.to_utc();
    match event.kind {
        EventKind::Flight if !matches!(start, EventTime::Date(_)) && remaining.num_minutes() <= FLIGHT_CRITICAL_MINUTES => {
            Priority::Critical
        }
        EventKind::Flight | EventKind::Meeting => event.priority.max(Priority::Important),
        _ => event.priority,
    }
}

/// The one thing the island shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", content = "reminder", rename_all = "camelCase")]
pub enum IslandItem {
    Reminder(Reminder),
    ScreenAssist,
    AgentSession,
    Media,
    Idle,
}

/// Urgent reminders first, then whatever the user is actively doing, then
/// passing news, then media, which only ever fills an otherwise empty island.
/// `surface` is already ordered by urgency, then soonest.
pub fn decide_island(decision: &Decision, context: &InterruptionContext) -> IslandItem {
    let best = decision.surface.first();
    if let Some(reminder) = best.filter(|r| r.priority >= Priority::Important) {
        return IslandItem::Reminder(reminder.clone());
    }
    if context.screen_assist_active {
        return IslandItem::ScreenAssist;
    }
    if context.agent_session_active {
        return IslandItem::AgentSession;
    }
    if let Some(reminder) = best {
        return IslandItem::Reminder(reminder.clone());
    }
    if context.media_playing {
        return IslandItem::Media;
    }
    IslandItem::Idle
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::EventSource;
    use chrono::{NaiveDate, TimeZone};

    fn at(day: u32, hour: u32, minute: u32) -> DateTime<FixedOffset> {
        FixedOffset::east_opt(0).unwrap().with_ymd_and_hms(2026, 11, day, hour, minute, 0).unwrap()
    }

    fn event(kind: EventKind, key: &str, starts_at: Option<DateTime<FixedOffset>>) -> ContextEvent {
        let mut event = ContextEvent::new(kind, EventSource::Email, key, key, at(1, 0, 0).to_utc());
        event.starts_at = starts_at.map(EventTime::Zoned);
        event.priority = Priority::Important;
        event
    }

    fn package(now: DateTime<FixedOffset>) -> ContextEvent {
        let mut event = ContextEvent::new(EventKind::Delivery, EventSource::Email, "Parcel", "parcel:1", now.to_utc());
        event.priority = Priority::Informational;
        event
    }

    fn run(events: &[ContextEvent], now: DateTime<FixedOffset>, context: InterruptionContext, log: &[LogEntry]) -> Decision {
        decide(events, now, &Preferences::default(), &context, log)
    }

    /// Plays a decision into the log, the way `Store::record_decision` would.
    fn record(decision: &Decision, now: DateTime<FixedOffset>, log: &mut Vec<LogEntry>) {
        let mut add = |reminder: &Reminder, disposition| {
            log.push(LogEntry {
                key: reminder.key.clone(),
                event_id: reminder.event_id.clone(),
                stage: reminder.stage,
                starts_at: reminder.starts_at,
                disposition,
                at: now.to_utc(),
            });
        };
        for reminder in &decision.surface {
            add(reminder, Disposition::Surfaced);
        }
        for reminder in &decision.activity_centre {
            add(reminder, if reminder.hold.is_some() { Disposition::Held } else { Disposition::Centre });
        }
    }

    #[test]
    fn a_meeting_starting_soon_outranks_media() {
        let meeting = event(EventKind::Meeting, "ical:1", Some(at(5, 12, 0)));
        let context = InterruptionContext { media_playing: true, ..Default::default() };
        let decision = run(&[meeting], at(5, 11, 50), context, &[]);
        assert_eq!(decision.surface.len(), 1);
        assert!(matches!(decide_island(&decision, &context), IslandItem::Reminder(r) if r.title == "ical:1"));
    }

    #[test]
    fn the_island_falls_back_to_media_with_nothing_else_to_show() {
        let context = InterruptionContext { media_playing: true, ..Default::default() };
        assert_eq!(decide_island(&Decision::default(), &context), IslandItem::Media);
        assert_eq!(decide_island(&Decision::default(), &InterruptionContext::default()), IslandItem::Idle);
    }

    #[test]
    fn an_informational_package_update_does_not_interrupt_a_coding_session() {
        let now = at(5, 11, 0);
        let context = InterruptionContext { agent_session_active: true, ..Default::default() };
        let decision = run(&[package(now)], now, context, &[]);
        assert!(decision.surface.is_empty());
        assert_eq!(decision.activity_centre.len(), 1);
        assert_eq!(decision.activity_centre[0].hold, None);
        assert_eq!(decide_island(&decision, &context), IslandItem::AgentSession);
    }

    #[test]
    fn a_package_update_routed_to_the_centre_does_not_surface_after_the_session_ends() {
        let now = at(5, 11, 0);
        let mut log = Vec::new();
        let busy = InterruptionContext { agent_session_active: true, ..Default::default() };
        record(&run(&[package(now)], now, busy, &log), now, &mut log);
        let later = run(&[package(now)], at(5, 11, 30), InterruptionContext::default(), &log);
        assert_eq!(later, Decision::default());
    }

    #[test]
    fn a_package_update_surfaces_when_nothing_is_going_on() {
        let now = at(5, 11, 0);
        assert_eq!(run(&[package(now)], now, InterruptionContext::default(), &[]).surface.len(), 1);
    }

    #[test]
    fn a_nearby_flight_is_critical_and_outranks_a_meeting_and_an_agent_session() {
        let flight = event(EventKind::Flight, "flight:ABC123:JFK-LHR", Some(at(5, 12, 0)));
        let meeting = event(EventKind::Meeting, "ical:1", Some(at(5, 11, 58)));
        let context = InterruptionContext { agent_session_active: true, in_call: true, ..Default::default() };
        let decision = run(&[meeting, flight], at(5, 11, 50), context, &[]);
        assert_eq!(decision.surface[0].priority, Priority::Critical);
        assert_eq!(decision.surface[0].stage, Stage::Lead { minutes: 15 });
        assert!(matches!(decide_island(&decision, &context), IslandItem::Reminder(r) if r.priority == Priority::Critical));
    }

    #[test]
    fn a_flight_a_day_out_is_important_not_critical() {
        let flight = event(EventKind::Flight, "flight:ABC123:JFK-LHR", Some(at(6, 12, 0)));
        let decision = run(&[flight], at(5, 13, 0), InterruptionContext::default(), &[]);
        assert_eq!(decision.surface[0].priority, Priority::Important);
        assert_eq!(decision.surface[0].stage, Stage::Lead { minutes: 24 * 60 });
    }

    #[test]
    fn a_flight_with_no_stated_zone_still_reminds_but_says_it_is_approximate() {
        let mut flight = event(EventKind::Flight, "flight:ABC123:JFK-LHR", None);
        let wall = NaiveDate::from_ymd_opt(2026, 11, 5).unwrap().and_hms_opt(12, 0, 0).unwrap();
        flight.starts_at = Some(EventTime::Naive(wall));
        let decision = run(&[flight], at(5, 11, 50), InterruptionContext::default(), &[]);
        assert!(decision.surface[0].approximate_time);
    }

    #[test]
    fn quiet_hours_hold_back_everything_except_critical() {
        let preferences = Preferences {
            quiet_hours: Some(QuietHours {
                start: NaiveTime::from_hms_opt(22, 0, 0).unwrap(),
                end: NaiveTime::from_hms_opt(7, 0, 0).unwrap(),
            }),
            ..Default::default()
        };
        let context = InterruptionContext::default();
        let now = at(5, 23, 30);
        let meeting = event(EventKind::Meeting, "ical:1", Some(at(5, 23, 40)));
        let flight = event(EventKind::Flight, "flight:A", Some(at(6, 1, 0)));
        let decision = decide(&[meeting, flight.clone(), package(now)], now, &preferences, &context, &[]);
        assert_eq!(decision.surface.len(), 1);
        assert_eq!(decision.surface[0].event_id, flight.id);
        assert_eq!(decision.activity_centre.len(), 2);
        assert!(decision.activity_centre.iter().all(|r| r.hold == Some(Hold::QuietHours)));
    }

    #[test]
    fn quiet_hours_wrap_midnight() {
        let wrapped = QuietHours {
            start: NaiveTime::from_hms_opt(22, 0, 0).unwrap(),
            end: NaiveTime::from_hms_opt(7, 0, 0).unwrap(),
        };
        assert!(wrapped.contains(NaiveTime::from_hms_opt(23, 0, 0).unwrap()));
        assert!(wrapped.contains(NaiveTime::from_hms_opt(6, 59, 0).unwrap()));
        assert!(!wrapped.contains(NaiveTime::from_hms_opt(7, 0, 0).unwrap()));
        assert!(!wrapped.contains(NaiveTime::from_hms_opt(12, 0, 0).unwrap()));
    }

    #[test]
    fn quiet_hours_are_read_on_the_users_clock_not_utc() {
        let preferences = Preferences {
            quiet_hours: Some(QuietHours {
                start: NaiveTime::from_hms_opt(22, 0, 0).unwrap(),
                end: NaiveTime::from_hms_opt(7, 0, 0).unwrap(),
            }),
            ..Default::default()
        };
        // 18:00 UTC is 23:30 in India, so this is quiet for the user.
        let now = FixedOffset::east_opt(5 * 3600 + 1800).unwrap().with_ymd_and_hms(2026, 11, 5, 23, 30, 0).unwrap();
        let meeting = event(EventKind::Meeting, "ical:1", Some(now + TimeDelta::minutes(10)));
        let decision = decide(&[meeting], now, &preferences, &InterruptionContext::default(), &[]);
        assert!(decision.surface.is_empty());
    }

    #[test]
    fn a_reminder_held_by_quiet_hours_surfaces_when_they_end() {
        let preferences = Preferences {
            quiet_hours: Some(QuietHours {
                start: NaiveTime::from_hms_opt(22, 0, 0).unwrap(),
                end: NaiveTime::from_hms_opt(7, 0, 0).unwrap(),
            }),
            ..Default::default()
        };
        let context = InterruptionContext::default();
        let mut log = Vec::new();
        let meeting = event(EventKind::Meeting, "ical:1", Some(at(6, 7, 10)));
        let quiet_tick = at(6, 6, 58);
        let held = decide(std::slice::from_ref(&meeting), quiet_tick, &preferences, &context, &log);
        assert_eq!(held.activity_centre.len(), 1);
        record(&held, quiet_tick, &mut log);

        let repeat = decide(std::slice::from_ref(&meeting), at(6, 6, 59), &preferences, &context, &log);
        assert_eq!(repeat, Decision::default(), "the centre is told once");

        let morning = decide(&[meeting], at(6, 7, 0), &preferences, &context, &log);
        assert_eq!(morning.surface.len(), 1);
    }

    #[test]
    fn each_flight_stage_fires_once() {
        let flight = event(EventKind::Flight, "flight:A", Some(at(6, 12, 0)));
        let context = InterruptionContext::default();
        let mut log = Vec::new();
        let mut fired = Vec::new();
        let mut tick = at(5, 11, 0);
        while tick < at(6, 12, 30) {
            let decision = run(std::slice::from_ref(&flight), tick, context, &log);
            fired.extend(decision.surface.iter().map(|r| r.stage));
            record(&decision, tick, &mut log);
            tick += TimeDelta::minutes(5);
        }
        assert_eq!(
            fired,
            [Stage::Lead { minutes: 24 * 60 }, Stage::Lead { minutes: 3 * 60 }, Stage::Lead { minutes: 15 }]
        );
    }

    #[test]
    fn each_meeting_stage_fires_once() {
        let meeting = event(EventKind::Meeting, "ical:1", Some(at(5, 12, 0)));
        let context = InterruptionContext::default();
        let mut log = Vec::new();
        let mut fired = Vec::new();
        let mut tick = at(5, 11, 30);
        while tick < at(5, 12, 10) {
            let decision = run(std::slice::from_ref(&meeting), tick, context, &log);
            fired.extend(decision.surface.iter().map(|r| r.stage));
            record(&decision, tick, &mut log);
            tick += TimeDelta::minutes(1);
        }
        assert_eq!(fired, [Stage::Lead { minutes: 15 }, Stage::Lead { minutes: 5 }]);
    }

    #[test]
    fn a_late_start_fires_only_the_nearest_stage() {
        let flight = event(EventKind::Flight, "flight:A", Some(at(5, 12, 0)));
        let decision = run(&[flight], at(5, 11, 50), InterruptionContext::default(), &[]);
        assert_eq!(decision.surface.len(), 1);
        assert_eq!(decision.surface[0].stage, Stage::Lead { minutes: 15 });
    }

    #[test]
    fn nothing_fires_once_the_event_has_started() {
        let meeting = event(EventKind::Meeting, "ical:1", Some(at(5, 12, 0)));
        assert_eq!(run(&[meeting], at(5, 12, 1), InterruptionContext::default(), &[]), Decision::default());
    }

    #[test]
    fn snooze_silences_until_it_ends() {
        let mut meeting = event(EventKind::Meeting, "ical:1", Some(at(5, 12, 0)));
        meeting.snoozed_until = Some(at(5, 11, 56).to_utc());
        assert_eq!(run(std::slice::from_ref(&meeting), at(5, 11, 50), InterruptionContext::default(), &[]), Decision::default());
        assert_eq!(run(&[meeting], at(5, 11, 56), InterruptionContext::default(), &[]).surface.len(), 1);
    }

    #[test]
    fn a_snoozed_reminder_comes_back_once_when_the_snooze_ends() {
        let mut reminder = event(EventKind::UserReminder, "reminder:1", Some(at(5, 15, 0)));
        let context = InterruptionContext::default();
        let mut log = Vec::new();
        let fired = run(std::slice::from_ref(&reminder), at(5, 15, 1), context, &log);
        assert_eq!(fired.surface[0].stage, Stage::Lead { minutes: 0 });
        record(&fired, at(5, 15, 1), &mut log);

        reminder.snoozed_until = Some(at(5, 15, 30).to_utc());
        assert_eq!(run(std::slice::from_ref(&reminder), at(5, 15, 10), context, &log), Decision::default());

        let back = run(std::slice::from_ref(&reminder), at(5, 15, 31), context, &log);
        assert_eq!(back.surface[0].stage, Stage::SnoozeEnded);
        assert_eq!(back.surface[0].replaces, Some(fired.surface[0].key.clone()));
        record(&back, at(5, 15, 31), &mut log);
        assert_eq!(run(&[reminder], at(5, 15, 40), context, &log), Decision::default());
    }

    #[test]
    fn snoozing_past_the_start_of_a_meeting_means_no_more_about_it() {
        let mut meeting = event(EventKind::Meeting, "ical:1", Some(at(5, 12, 0)));
        meeting.snoozed_until = Some(at(5, 12, 30).to_utc());
        assert_eq!(run(&[meeting], at(5, 12, 31), InterruptionContext::default(), &[]), Decision::default());
    }

    #[test]
    fn a_timed_reminder_fires_at_its_time_and_not_long_after() {
        let reminder = event(EventKind::UserReminder, "reminder:1", Some(at(5, 15, 0)));
        let context = InterruptionContext::default();
        let on_time = run(std::slice::from_ref(&reminder), at(5, 15, 2), context, &[]);
        assert_eq!(on_time.surface[0].stage, Stage::Lead { minutes: 0 });
        assert_eq!(run(&[reminder], at(5, 15, 30), context, &[]), Decision::default());
    }

    #[test]
    fn a_move_announced_by_new_mail_is_news_even_with_no_earlier_reminder() {
        let now = at(5, 9, 0);
        let mut flight = event(EventKind::Flight, "flight:A", Some(at(20, 12, 0)));
        flight.occurred_at = now.to_utc();
        flight.changed_fields = vec!["startsAt".to_string()];
        let decision = run(&[flight], now, InterruptionContext::default(), &[]);
        assert_eq!(decision.surface[0].stage, Stage::Rescheduled);
        assert_eq!(decision.surface[0].replaces, None);
    }

    #[test]
    fn an_old_change_from_a_first_sync_is_not_news() {
        let mut flight = event(EventKind::Flight, "flight:A", Some(at(20, 12, 0)));
        flight.changed_fields = vec!["startsAt".to_string()];
        assert_eq!(run(&[flight], at(5, 9, 0), InterruptionContext::default(), &[]), Decision::default());
    }

    #[test]
    fn a_new_delivery_date_stays_routine_news() {
        let now = at(5, 9, 0);
        let mut parcel = package(now);
        parcel.starts_at = Some(EventTime::Date(NaiveDate::from_ymd_opt(2026, 11, 8).unwrap()));
        parcel.changed_fields = vec!["startsAt".to_string()];
        let decision = run(&[parcel], now, InterruptionContext::default(), &[]);
        assert_eq!(decision.surface[0].stage, Stage::Changed);
        assert_eq!(decision.surface[0].priority, Priority::Informational);
    }

    #[test]
    fn dismissed_events_stay_silent() {
        let mut meeting = event(EventKind::Meeting, "ical:1", Some(at(5, 12, 0)));
        meeting.status = EventStatus::Dismissed;
        assert_eq!(run(&[meeting], at(5, 11, 50), InterruptionContext::default(), &[]), Decision::default());
    }

    #[test]
    fn declined_meetings_stay_silent() {
        let mut meeting = event(EventKind::Meeting, "ical:1", Some(at(5, 12, 0)));
        meeting.metadata.insert("responseStatus".into(), "declined".into());
        assert_eq!(run(&[meeting], at(5, 11, 50), InterruptionContext::default(), &[]), Decision::default());
    }

    #[test]
    fn a_cancellation_replaces_the_old_reminder_once() {
        let mut flight = event(EventKind::Flight, "flight:A", Some(at(5, 12, 0)));
        let context = InterruptionContext::default();
        let mut log = Vec::new();
        let first = run(std::slice::from_ref(&flight), at(5, 8, 0), context, &log);
        let old_key = first.surface[0].key.clone();
        record(&first, at(5, 8, 0), &mut log);

        flight.status = EventStatus::Cancelled;
        let decision = run(std::slice::from_ref(&flight), at(5, 8, 30), context, &log);
        assert_eq!(decision.surface.len(), 1);
        assert_eq!(decision.surface[0].stage, Stage::Cancelled);
        assert_eq!(decision.surface[0].replaces.as_deref(), Some(old_key.as_str()));
        record(&decision, at(5, 8, 30), &mut log);

        assert_eq!(run(&[flight], at(5, 11, 50), context, &log), Decision::default());
    }

    #[test]
    fn an_old_cancellation_nobody_was_told_about_stays_quiet() {
        let mut flight = event(EventKind::Flight, "flight:A", Some(at(9, 12, 0)));
        flight.status = EventStatus::Cancelled;
        assert_eq!(run(&[flight], at(5, 8, 0), InterruptionContext::default(), &[]), Decision::default());
    }

    #[test]
    fn a_reschedule_replaces_the_old_reminder_and_rearms_the_stages() {
        let mut meeting = event(EventKind::Meeting, "ical:1", Some(at(5, 12, 0)));
        let context = InterruptionContext::default();
        let mut log = Vec::new();
        let first = run(std::slice::from_ref(&meeting), at(5, 11, 50), context, &log);
        let old_key = first.surface[0].key.clone();
        record(&first, at(5, 11, 50), &mut log);

        meeting.starts_at = Some(EventTime::Zoned(at(5, 16, 0)));
        let moved = run(std::slice::from_ref(&meeting), at(5, 11, 52), context, &log);
        assert_eq!(moved.surface.len(), 1, "replaces, does not add");
        assert_eq!(moved.surface[0].stage, Stage::Rescheduled);
        assert_eq!(moved.surface[0].replaces.as_deref(), Some(old_key.as_str()));
        record(&moved, at(5, 11, 52), &mut log);

        assert_eq!(run(std::slice::from_ref(&meeting), at(5, 12, 30), context, &log), Decision::default());
        let rearmed = run(std::slice::from_ref(&meeting), at(5, 15, 50), context, &log);
        assert_eq!(rearmed.surface[0].stage, Stage::Lead { minutes: 15 });
    }

    #[test]
    fn a_reschedule_landing_inside_a_stage_is_one_reminder_not_two() {
        let mut meeting = event(EventKind::Meeting, "ical:1", Some(at(5, 12, 0)));
        let context = InterruptionContext::default();
        let mut log = Vec::new();
        let first = run(std::slice::from_ref(&meeting), at(5, 11, 50), context, &log);
        let old_key = first.surface[0].key.clone();
        record(&first, at(5, 11, 50), &mut log);

        meeting.starts_at = Some(EventTime::Zoned(at(5, 11, 58)));
        let moved = run(&[meeting], at(5, 11, 52), context, &log);
        assert_eq!(moved.surface.len(), 1);
        assert_eq!(moved.surface[0].stage, Stage::Lead { minutes: 15 });
        assert_eq!(moved.surface[0].replaces.as_deref(), Some(old_key.as_str()));
    }

    #[test]
    fn the_frequency_cap_holds_routine_reminders_but_never_critical() {
        let preferences = Preferences { max_per_hour: Some(1), ..Default::default() };
        let now = at(5, 11, 50);
        let flight = event(EventKind::Flight, "flight:A", Some(at(5, 12, 0)));
        let one = event(EventKind::Meeting, "ical:1", Some(at(5, 12, 0)));
        let two = event(EventKind::Meeting, "ical:2", Some(at(5, 12, 1)));
        let log = vec![LogEntry {
            key: "earlier".into(),
            event_id: "other".into(),
            stage: Stage::Changed,
            starts_at: None,
            disposition: Disposition::Surfaced,
            at: at(5, 11, 30).to_utc(),
        }];
        let decision = decide(&[one, two, flight], now, &preferences, &InterruptionContext::default(), &log);
        assert_eq!(decision.surface.len(), 1);
        assert_eq!(decision.surface[0].priority, Priority::Critical);
        assert!(decision.activity_centre.iter().all(|r| r.hold == Some(Hold::FrequencyCap)));
        assert_eq!(decision.activity_centre.len(), 2);
    }

    #[test]
    fn a_disabled_category_stays_silent() {
        let mut preferences = Preferences::default();
        preferences.categories.insert(Category::Meetings, CategoryPreferences { enabled: false, lead_minutes: vec![15] });
        let meeting = event(EventKind::Meeting, "ical:1", Some(at(5, 12, 0)));
        let decision = decide(&[meeting], at(5, 11, 50), &preferences, &InterruptionContext::default(), &[]);
        assert_eq!(decision, Decision::default());
    }

    #[test]
    fn per_category_lead_times_apply() {
        let mut preferences = Preferences::default();
        preferences.categories.insert(Category::Meetings, CategoryPreferences { enabled: true, lead_minutes: vec![60] });
        let meeting = event(EventKind::Meeting, "ical:1", Some(at(5, 12, 0)));
        let decision = decide(&[meeting], at(5, 11, 30), &preferences, &InterruptionContext::default(), &[]);
        assert_eq!(decision.surface[0].stage, Stage::Lead { minutes: 60 });
    }

    #[test]
    fn a_date_only_deadline_reminds_the_day_before_and_on_the_day() {
        let mut deadline = event(EventKind::ReturnDeadline, "return:1", None);
        deadline.starts_at = Some(EventTime::Date(NaiveDate::from_ymd_opt(2026, 11, 6).unwrap()));
        let context = InterruptionContext::default();
        assert_eq!(run(std::slice::from_ref(&deadline), at(4, 12, 0), context, &[]), Decision::default());
        let before = run(std::slice::from_ref(&deadline), at(5, 9, 0), context, &[]);
        assert_eq!(before.surface[0].stage, Stage::Lead { minutes: 24 * 60 });
        let on_the_day = run(std::slice::from_ref(&deadline), at(6, 9, 0), context, &[]);
        assert_eq!(on_the_day.surface[0].stage, Stage::Lead { minutes: 0 });
        assert_eq!(run(&[deadline], at(7, 0, 1), context, &[]), Decision::default());
    }

    #[test]
    fn a_news_driven_category_has_no_countdown_even_on_the_day() {
        let mut parcel = package(at(1, 0, 0));
        parcel.starts_at = Some(EventTime::Date(NaiveDate::from_ymd_opt(2026, 11, 5).unwrap()));
        assert_eq!(run(&[parcel], at(5, 0, 1), InterruptionContext::default(), &[]), Decision::default());
    }

    #[test]
    fn a_first_sync_of_old_mail_stays_quiet() {
        let old = package(at(1, 0, 0));
        assert_eq!(run(&[old], at(5, 12, 0), InterruptionContext::default(), &[]), Decision::default());
    }

    #[test]
    fn a_changed_delivery_reminds_again_for_its_new_revision() {
        let now = at(5, 11, 0);
        let mut parcel = package(now);
        let mut log = Vec::new();
        let first = run(std::slice::from_ref(&parcel), now, InterruptionContext::default(), &log);
        record(&first, now, &mut log);
        assert_eq!(run(std::slice::from_ref(&parcel), now, InterruptionContext::default(), &log), Decision::default());

        parcel.revision += 1;
        assert_eq!(run(&[parcel], now, InterruptionContext::default(), &log).surface.len(), 1);
    }

    #[test]
    fn an_important_reminder_waits_out_a_call() {
        let meeting = event(EventKind::Meeting, "ical:1", Some(at(5, 12, 0)));
        let context = InterruptionContext { in_call: true, ..Default::default() };
        let decision = run(&[meeting], at(5, 11, 50), context, &[]);
        assert!(decision.surface.is_empty());
        assert_eq!(decision.activity_centre[0].hold, Some(Hold::Busy));
    }
}
