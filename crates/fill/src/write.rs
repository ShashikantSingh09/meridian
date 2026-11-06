//! How words get into a box, the same way every time:
//! 1. set the value directly, then read it back;
//! 2. else paste, for rich editors and boxes that ignore a direct set;
//! 3. else type, as a last resort, and only text with no line breaks.
//!
//! A rung is skipped only when the box is still exactly as it was. Once a box shows
//! something unexpected the ladder stops, so nothing is ever written twice. Enter,
//! Tab and newlines are never sent as keys.

use std::time::Duration;

use serde::Serialize;

use crate::model::{Field, FieldKind};
use crate::policy::refusal;
use crate::FillError;

/// What the user asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    /// Write here: the box must still have the cursor, and a paste goes in at the cursor.
    Here,
    /// Fill this form: the box must still be there, and its content is replaced.
    Form,
}

/// What a writer checks right before it acts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Need {
    /// Same box, same window, and it has the keyboard focus.
    Focus,
    /// Same box, same window, still on the page.
    Exists,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Method {
    Set,
    Paste,
    Type,
}

/// What one write did, for the undo log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Written {
    pub method: Method,
    /// None when the box could not be read, which also means it cannot be undone.
    pub before: Option<String>,
    pub after: Option<String>,
}

/// The platform's hands. Windows uses UI Automation, the clipboard and SendInput;
/// a Mac writer would use AX, the pasteboard and CGEvent. Ids are [`Field::id`].
pub trait Writer {
    /// Fails unless the box is still there in the same window, and has the focus when `need` says so.
    fn check(&mut self, id: u32, need: Need) -> Result<(), FillError>;
    /// What the box holds now: its text, "true" or "false" for a tick, the chosen item for a list.
    fn value(&mut self, id: u32) -> Result<String, FillError>;
    fn set_value(&mut self, id: u32, text: &str) -> Result<(), FillError>;
    fn set_checked(&mut self, id: u32, on: bool) -> Result<(), FillError>;
    fn choose(&mut self, id: u32, item: &str) -> Result<(), FillError>;
    fn focus(&mut self, id: u32) -> Result<(), FillError>;
    /// Pastes into the box, which has the focus, and puts the user's clipboard back.
    /// `replace` selects the box's content first. Like typing and undo, it checks
    /// the focus again right before keys go out.
    fn paste(&mut self, id: u32, text: &str, replace: bool) -> Result<(), FillError>;
    /// Types into the box, which has the focus. Never given control characters.
    fn type_text(&mut self, id: u32, text: &str, replace: bool) -> Result<(), FillError>;
    /// Ctrl+Z in the box, which has the focus.
    fn undo_keys(&mut self, id: u32) -> Result<(), FillError>;
    /// Lets the app catch up before a read back.
    fn wait(&mut self, ms: u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }
}

// ponytail: about 300 ms for a read back to settle, since a browser updates its
// accessibility tree a moment after the page changes. Measure on slow pages.
const SETTLE_TRIES: u32 = 7;
const SETTLE_MS: u64 = 50;

/// Yes or no, the way the AI or the user writes it.
pub fn yes_no(text: &str) -> Option<bool> {
    match text.trim().to_lowercase().as_str() {
        "true" | "yes" | "on" | "checked" | "tick" | "हाँ" | "हां" => Some(true),
        "false" | "no" | "off" | "unchecked" | "untick" | "नहीं" => Some(false),
        _ => None,
    }
}

fn squash(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Equal, ignoring spaces and line breaks, which editors add and drop freely.
pub(crate) fn same(a: &str, b: &str) -> bool {
    squash(a) == squash(b)
}

fn contains(haystack: &str, needle: &str) -> bool {
    squash(haystack).contains(&squash(needle))
}

fn digits(text: &str) -> String {
    text.chars().filter(char::is_ascii_digit).collect()
}

/// A box that formats what it is given, like "+91 98201 44317" shown as
/// "+919820144317", still holds the right number.
fn holds(kind: FieldKind, value: &str, text: &str) -> bool {
    same(value, text) || (matches!(kind, FieldKind::Phone | FieldKind::Number) && !digits(text).is_empty() && digits(value) == digits(text))
}

pub(crate) enum Settled {
    /// The box shows what was wanted. None: it could not be read, so the write call's word is all there is.
    Done(Option<String>),
    /// Exactly as before: safe to try the next rung.
    Unchanged,
    /// Something else: stop.
    Other,
}

pub(crate) fn settle<W: Writer>(w: &mut W, id: u32, before: Option<&str>, wanted: impl Fn(&str) -> bool) -> Settled {
    let mut last = None;
    for attempt in 0..SETTLE_TRIES {
        if attempt > 0 {
            w.wait(SETTLE_MS);
        }
        match w.value(id) {
            Ok(value) if wanted(&value) => return Settled::Done(Some(value)),
            Ok(value) => last = Some(value),
            Err(_) => {}
        }
    }
    match (last, before) {
        (None, _) => Settled::Done(None),
        (Some(value), Some(before)) if same(&value, before) => Settled::Unchanged,
        _ => Settled::Other,
    }
}

/// Keys go only to a box that has the cursor, checked right before they are sent.
pub(crate) fn keys_ready<W: Writer>(w: &mut W, id: u32, mode: Mode) -> Result<(), FillError> {
    if mode == Mode::Form {
        w.focus(id)?;
    }
    w.check(id, Need::Focus)
}

/// Writes `text` into the box, refusing what policy refuses, whatever the caller says.
pub fn write<W: Writer>(w: &mut W, field: &Field, text: &str, mode: Mode) -> Result<Written, FillError> {
    if let Some(refused) = refusal(field) {
        return Err(FillError::Refused(refused));
    }
    if !field.visible {
        return Err(FillError::Hidden);
    }
    let (id, kind) = (field.id, field.kind);
    w.check(id, if mode == Mode::Here { Need::Focus } else { Need::Exists })?;
    let before = w.value(id).ok();
    let was = before.as_deref();
    let done = |method, after| Ok(Written { method, before: before.clone(), after });

    match kind {
        FieldKind::Checkbox | FieldKind::Radio => {
            let on = yes_no(text).ok_or_else(|| FillError::NeedsYou("A tick box takes yes or no.".into()))?;
            w.set_checked(id, on)?;
            let want = if on { "true" } else { "false" };
            return match settle(w, id, was, |value| value == want) {
                Settled::Done(after) => done(Method::Set, after),
                _ => Err(FillError::Uncertain),
            };
        }
        FieldKind::List => {
            w.choose(id, text)?;
            return match settle(w, id, was, |value| same(value, text)) {
                Settled::Done(after) => done(Method::Set, after),
                _ => Err(FillError::Uncertain),
            };
        }
        // Typing into a date box depends on the locale's order of day and month,
        // and pasting is no better, so a date is set directly or left to the user.
        FieldKind::Date => {
            if w.set_value(id, text).is_ok() {
                if let Settled::Done(after) = settle(w, id, was, |value| same(value, text)) {
                    return done(Method::Set, after);
                }
            }
            return Err(FillError::NeedsYou("Date boxes need you.".into()));
        }
        // A direct set on a rich editor changes the page but not the editor's own
        // model, so the words would look written and then vanish. Paste instead.
        FieldKind::RichText => {}
        _ => {
            if w.set_value(id, text).is_ok() {
                match settle(w, id, was, |value| holds(kind, value, text)) {
                    Settled::Done(after) => return done(Method::Set, after),
                    Settled::Other => return Err(FillError::Uncertain),
                    Settled::Unchanged => {}
                }
            }
        }
    }

    let landed = |value: &str| match mode {
        Mode::Here => contains(value, text) && !was.is_some_and(|was| same(was, value)),
        Mode::Form => holds(kind, value, text) || (kind == FieldKind::RichText && contains(value, text)),
    };

    keys_ready(w, id, mode)?;
    w.paste(id, text, mode == Mode::Form)?;
    match settle(w, id, was, landed) {
        Settled::Done(after) => return done(Method::Paste, after),
        Settled::Other => return Err(FillError::Uncertain),
        Settled::Unchanged => {}
    }

    // A typed newline is Enter, and Enter sends in chat apps.
    if text.chars().any(char::is_control) {
        return Err(FillError::NeedsYou("Text with line breaks can only be pasted, and the paste did not work here.".into()));
    }
    keys_ready(w, id, mode)?;
    w.type_text(id, text, mode == Mode::Form)?;
    match settle(w, id, was, landed) {
        Settled::Done(after) => done(Method::Type, after),
        _ => Err(FillError::Uncertain),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{Behaviour, Fake};
    use crate::model::field;

    fn plain(label: &str) -> Field {
        field(0, label, FieldKind::PlainText)
    }

    #[test]
    fn a_plain_box_is_set_directly_and_read_back() {
        let mut w = Fake::one(Behaviour::default());
        let written = write(&mut w, &plain("Full name"), "Ravi Sharma", Mode::Form).unwrap();
        assert_eq!(written.method, Method::Set);
        assert_eq!(written.before.as_deref(), Some(""));
        assert_eq!(written.after.as_deref(), Some("Ravi Sharma"));
        assert_eq!(w.calls, ["set 0"]);
    }

    #[test]
    fn a_box_that_ignores_a_direct_set_gets_a_paste() {
        let mut w = Fake::one(Behaviour { sticks: false, ..Default::default() });
        let written = write(&mut w, &plain("Full name"), "Ravi Sharma", Mode::Form).unwrap();
        assert_eq!(written.method, Method::Paste);
        assert_eq!(w.boxes[0].value, "Ravi Sharma");
        assert_eq!(w.calls, ["set 0", "focus 0", "paste 0 replace"]);
    }

    #[test]
    fn a_rich_box_is_pasted_without_a_direct_set() {
        let mut w = Fake::one(Behaviour { value: "Thanks, Ravi".into(), ..Default::default() });
        w.focus = Some(0);
        let reply = field(0, "Message body", FieldKind::RichText);
        let written = write(&mut w, &reply, "Hi Carl,\n\nI'll send it today.\n\n", Mode::Here).unwrap();
        assert_eq!(written.method, Method::Paste);
        assert_eq!(w.calls, ["paste 0 at cursor"]);
        assert!(w.boxes[0].value.starts_with("Thanks, Ravi"), "write here adds at the cursor, it does not replace");
    }

    #[test]
    fn typing_is_the_last_resort() {
        let mut w = Fake::one(Behaviour { sticks: false, pastes: false, ..Default::default() });
        let written = write(&mut w, &plain("पूरा नाम"), "रवि शर्मा", Mode::Form).unwrap();
        assert_eq!(written.method, Method::Type);
        assert_eq!(w.boxes[0].value, "रवि शर्मा");
        assert_eq!(w.calls, ["set 0", "focus 0", "paste 0 replace", "focus 0", "type replace"]);
    }

    #[test]
    fn text_with_line_breaks_is_never_typed() {
        let mut w = Fake::one(Behaviour { sticks: false, pastes: false, ..Default::default() });
        let multi = field(0, "Address", FieldKind::MultiLine);
        let error = write(&mut w, &multi, "12 MG Road\nPune", Mode::Form).unwrap_err();
        assert!(matches!(error, FillError::NeedsYou(_)));
        assert!(!w.calls.iter().any(|call| call.starts_with("type")));
    }

    #[test]
    fn write_here_refuses_a_box_that_lost_the_cursor() {
        let mut w = Fake::one(Behaviour::default());
        w.focus = None;
        let error = write(&mut w, &plain("Search"), "invoice", Mode::Here).unwrap_err();
        assert_eq!(error, FillError::Moved);
        assert!(w.calls.is_empty(), "nothing was written");
    }

    #[test]
    fn keys_are_not_sent_when_the_cursor_moves_away_before_a_paste() {
        let mut w = Fake::one(Behaviour { sticks: false, ..Default::default() });
        w.focus = Some(0);
        w.steal_focus_on_set = true;
        let error = write(&mut w, &plain("Search"), "invoice", Mode::Here).unwrap_err();
        assert_eq!(error, FillError::Moved);
        assert_eq!(w.calls, ["set 0"]);
    }

    #[test]
    fn a_box_gone_from_the_page_is_refused() {
        let mut w = Fake::one(Behaviour { gone: true, ..Default::default() });
        assert_eq!(write(&mut w, &plain("Name"), "Ravi", Mode::Form).unwrap_err(), FillError::Gone);
        assert!(w.calls.is_empty());
    }

    #[test]
    fn a_password_box_is_refused_whatever_the_caller_says() {
        let mut w = Fake::one(Behaviour::default());
        let error = write(&mut w, &field(0, "Choose one", FieldKind::Password), "x", Mode::Form).unwrap_err();
        assert_eq!(error, FillError::Refused(crate::Refusal::Password));
        let error = write(&mut w, &plain("Enter OTP"), "123456", Mode::Form).unwrap_err();
        assert_eq!(error, FillError::Refused(crate::Refusal::OneTimeCode));
        assert!(w.calls.is_empty());
    }

    #[test]
    fn a_hidden_box_is_refused() {
        let mut w = Fake::one(Behaviour::default());
        let mut trap = plain("Phone");
        trap.visible = false;
        assert_eq!(write(&mut w, &trap, "98201", Mode::Form).unwrap_err(), FillError::Hidden);
    }

    #[test]
    fn a_box_that_shows_something_else_is_not_written_again() {
        let mut w = Fake::one(Behaviour { mangles: true, ..Default::default() });
        let error = write(&mut w, &plain("Name"), "Ravi", Mode::Form).unwrap_err();
        assert_eq!(error, FillError::Uncertain);
        assert_eq!(w.calls, ["set 0"], "no paste on top of it");
    }

    #[test]
    fn a_reformatted_phone_number_counts_as_written() {
        let mut w = Fake::one(Behaviour { strips_spaces: true, ..Default::default() });
        let phone = field(0, "Phone", FieldKind::Phone);
        let written = write(&mut w, &phone, "+91 98201 44317", Mode::Form).unwrap();
        assert_eq!((written.method, written.after.as_deref()), (Method::Set, Some("+919820144317")));
    }

    #[test]
    fn a_date_box_that_refuses_a_direct_set_needs_you() {
        let mut w = Fake::one(Behaviour { sticks: false, ..Default::default() });
        let error = write(&mut w, &field(0, "Expense date", FieldKind::Date), "04-11-2026", Mode::Form).unwrap_err();
        assert_eq!(error, FillError::NeedsYou("Date boxes need you.".into()));
        assert_eq!(w.calls, ["set 0"]);
    }

    #[test]
    fn ticks_and_lists_are_set_directly() {
        let mut w = Fake::one(Behaviour { value: "false".into(), ..Default::default() });
        let tick = field(0, "Same as billing address", FieldKind::Checkbox);
        assert_eq!(write(&mut w, &tick, "yes", Mode::Form).unwrap().after.as_deref(), Some("true"));

        let mut w = Fake::one(Behaviour { items: vec!["Travel · Cab".into(), "Meals".into()], ..Default::default() });
        let list = field(0, "Category", FieldKind::List);
        assert_eq!(write(&mut w, &list, "Meals", Mode::Form).unwrap().method, Method::Set);
        assert!(write(&mut w, &list, "Lunch", Mode::Form).is_err());
    }

    #[test]
    fn a_box_that_cannot_be_read_back_is_pasted_once_and_never_typed_into() {
        let mut w = Fake::one(Behaviour { readable: false, ..Default::default() });
        w.focus = Some(0);
        let written = write(&mut w, &field(0, "Body", FieldKind::RichText), "Hello", Mode::Here).unwrap();
        assert_eq!(written, Written { method: Method::Paste, before: None, after: None });
        assert_eq!(w.calls, ["paste 0 at cursor"]);
    }

    #[test]
    fn yes_and_no_are_read_in_english_and_hindi() {
        assert_eq!(yes_no(" Yes "), Some(true));
        assert_eq!(yes_no("हाँ"), Some(true));
        assert_eq!(yes_no("false"), Some(false));
        assert_eq!(yes_no("maybe"), None);
    }
}
