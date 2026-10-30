//! Contextual screen awareness: an optional, off-by-default loop that reads the
//! active window on this machine and looks for visible errors. Frames are
//! dropped as soon as they are read. What leaves here is a local event with the
//! matched line, and only a click on a suggestion can lead to anything being sent.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::{take_capture, Core};
use crate::island;

/// How often settings are checked while the mode is off or paused.
const IDLE_CHECK: Duration = Duration::from_secs(3);
/// The same problem is not raised again for this long.
const COOLDOWN: Duration = Duration::from_secs(600);
const MIN_INTERVAL_SECS: u64 = 5;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Suggestion {
    /// Stable for one problem, so Ignore can silence it.
    key: String,
    title: String,
    evidence: String,
    app: String,
    /// How many times this has been seen. Observed, not inferred.
    seen: u32,
}

struct Seen {
    count: u32,
    raised: Option<Instant>,
}

#[derive(Default)]
pub struct Ignored(pub Mutex<Vec<String>>);

#[tauri::command]
pub fn screen_ignore(ignored: tauri::State<'_, Ignored>, key: String) {
    ignored.0.lock().unwrap().push(key);
}

/// Whether a sighting should reach the user. Pure, so the interruption rules
/// have tests.
fn should_raise(seen: &Seen, now: Instant, muted: bool) -> bool {
    !muted && seen.raised.is_none_or(|at| now.duration_since(at) >= COOLDOWN)
}

fn tick(app: &AppHandle, core: &Core, history: &mut HashMap<String, Seen>) {
    let Ok((frame, window)) = take_capture(app, core, "window") else { return };
    let text = screen::ocr(&frame).unwrap_or_default();
    drop(frame);

    let ignored = app.state::<Ignored>();
    for signal in screen::detect(&text) {
        let key = format!("{:?}:{}", signal.kind, signal.evidence);
        let seen = history.entry(key.clone()).or_insert(Seen { count: 0, raised: None });
        seen.count += 1;
        let muted = ignored.0.lock().unwrap().contains(&key);
        if should_raise(seen, Instant::now(), muted) {
            seen.raised = Some(Instant::now());
            let suggestion = Suggestion {
                key,
                title: signal.title,
                evidence: signal.evidence,
                app: window.process.clone(),
                seen: seen.count,
            };
            let _ = app.emit_to(island::LABEL, "screen-suggestion", suggestion);
        }
    }
}

pub fn spawn(app: AppHandle) {
    app.manage(Ignored::default());
    std::thread::spawn(move || {
        let mut history = HashMap::new();
        loop {
            let core = app.state::<Core>();
            let (mode, paused, interval) = {
                let s = core.settings.lock().unwrap();
                (s.screen_mode.clone(), s.monitoring_paused, s.screen_interval_secs)
            };
            if mode != "contextual" || paused {
                std::thread::sleep(IDLE_CHECK);
                continue;
            }
            tick(&app, &core, &mut history);
            std::thread::sleep(Duration::from_secs(interval.max(MIN_INTERVAL_SECS)));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_problem_is_raised() {
        assert!(should_raise(&Seen { count: 1, raised: None }, Instant::now(), false));
    }

    #[test]
    fn a_problem_is_not_repeated_within_the_cooldown() {
        let now = Instant::now();
        assert!(!should_raise(&Seen { count: 2, raised: Some(now) }, now + Duration::from_secs(30), false));
        assert!(should_raise(&Seen { count: 9, raised: Some(now) }, now + COOLDOWN, false));
    }

    #[test]
    fn an_ignored_problem_stays_quiet() {
        assert!(!should_raise(&Seen { count: 1, raised: None }, Instant::now(), true));
    }
}
