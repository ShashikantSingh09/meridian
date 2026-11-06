//! One run's log of what Meridian wrote, so Undo can put each box back. A box the
//! user has changed since keeps what they typed.

use serde::Serialize;

use crate::model::{Field, FieldKind};
use crate::write::{keys_ready, same, settle, yes_no, Method, Mode, Need, Settled, Written, Writer};
use crate::FillError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "result", content = "message", rename_all = "kebab-case")]
pub enum Undone {
    PutBack,
    /// The user changed the box after it was filled, so it keeps their words.
    Kept,
    Gone,
    /// The box could not be read when it was written, or now.
    CannotCheck,
    Failed(String),
}

#[derive(Debug, Clone)]
struct Entry {
    field: u32,
    kind: FieldKind,
    written: Written,
}

#[derive(Debug, Clone)]
pub struct UndoLog {
    mode: Mode,
    entries: Vec<Entry>,
}

impl UndoLog {
    pub fn new(mode: Mode) -> Self {
        Self { mode, entries: Vec::new() }
    }

    pub fn record(&mut self, field: &Field, written: Written) {
        self.entries.push(Entry { field: field.id, kind: field.kind, written });
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Puts boxes back, newest first, and empties the log.
    pub fn undo<W: Writer>(&mut self, w: &mut W) -> Vec<(u32, Undone)> {
        let mode = self.mode;
        self.entries.drain(..).rev().map(|entry| (entry.field, undo_one(w, mode, &entry))).collect()
    }

    /// Puts one box back, through every write to it, newest first, and forgets them. None when
    /// Meridian did not write in it. The answer is how the oldest write went back: what the box held
    /// before Meridian came.
    pub fn undo_field<W: Writer>(&mut self, w: &mut W, field: u32) -> Option<Undone> {
        let mode = self.mode;
        let (mine, rest) = std::mem::take(&mut self.entries).into_iter().partition::<Vec<_>, _>(|entry| entry.field == field);
        self.entries = rest;
        let mut last = None;
        for entry in mine.iter().rev() {
            let undone = undo_one(w, mode, entry);
            let stop = undone != Undone::PutBack;
            last = Some(undone);
            if stop {
                break;
            }
        }
        last
    }
}

fn undo_one<W: Writer>(w: &mut W, mode: Mode, entry: &Entry) -> Undone {
    let id = entry.field;
    let (Some(before), Some(after)) = (&entry.written.before, &entry.written.after) else {
        return Undone::CannotCheck;
    };
    match w.check(id, Need::Exists) {
        Err(FillError::Gone) => return Undone::Gone,
        Err(error) => return Undone::Failed(error.to_string()),
        Ok(()) => {}
    }
    let Ok(now) = w.value(id) else {
        return Undone::CannotCheck;
    };
    if !same(&now, after) {
        return Undone::Kept;
    }
    let put_back = match (entry.written.method, entry.kind) {
        (Method::Set, FieldKind::Checkbox | FieldKind::Radio) => match yes_no(before) {
            Some(on) => w.set_checked(id, on),
            None => Err(FillError::NeedsYou("It could not be put back.".into())),
        },
        (Method::Set, FieldKind::List) if before.trim().is_empty() => {
            Err(FillError::NeedsYou("A list cannot be put back to empty.".into()))
        }
        (Method::Set, FieldKind::List) => w.choose(id, before),
        (Method::Set, _) => w.set_value(id, before),
        // A paste or typing is undone the way a person would, so the editor's own
        // history stays right.
        (Method::Paste | Method::Type, _) => keys_ready(w, id, mode).and_then(|()| w.undo_keys(id)),
    };
    if let Err(error) = put_back {
        return Undone::Failed(error.to_string());
    }
    match settle(w, id, Some(after), |value| same(value, before)) {
        Settled::Done(_) => Undone::PutBack,
        _ => Undone::Failed("It could not be put back.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{Behaviour, Fake};
    use crate::model::field;
    use crate::write::write;

    #[test]
    fn undo_puts_back_a_box_that_still_holds_what_meridian_wrote() {
        let mut w = Fake::one(Behaviour { value: "R".into(), ..Default::default() });
        let name = field(0, "Full name", FieldKind::PlainText);
        let mut log = UndoLog::new(Mode::Form);
        log.record(&name, write(&mut w, &name, "Ravi Sharma", Mode::Form).unwrap());
        assert_eq!(log.undo(&mut w), vec![(0, Undone::PutBack)]);
        assert_eq!(w.boxes[0].value, "R");
        assert!(log.is_empty());
    }

    #[test]
    fn undo_keeps_a_box_the_user_changed_since() {
        let mut w = Fake::one(Behaviour::default());
        let email = field(0, "Email", FieldKind::Email);
        let mut log = UndoLog::new(Mode::Form);
        log.record(&email, write(&mut w, &email, "ravi.sharma84@gmail.com", Mode::Form).unwrap());
        w.boxes[0].value = "ravi@ravisharma.design".into();
        assert_eq!(log.undo(&mut w), vec![(0, Undone::Kept)]);
        assert_eq!(w.boxes[0].value, "ravi@ravisharma.design");
    }

    #[test]
    fn a_paste_is_undone_with_ctrl_z_in_its_own_box() {
        let mut w = Fake::one(Behaviour { value: "Thanks".into(), ..Default::default() });
        w.focus = Some(0);
        let body = field(0, "Message body", FieldKind::RichText);
        let mut log = UndoLog::new(Mode::Here);
        log.record(&body, write(&mut w, &body, "Hi Carl", Mode::Here).unwrap());
        assert_eq!(log.undo(&mut w), vec![(0, Undone::PutBack)]);
        assert_eq!(w.boxes[0].value, "Thanks");
        assert_eq!(w.calls.last().map(String::as_str), Some("ctrl z"));
    }

    #[test]
    fn a_paste_is_not_undone_after_the_cursor_left_the_box() {
        let mut w = Fake::one(Behaviour::default());
        w.focus = Some(0);
        let body = field(0, "Message body", FieldKind::RichText);
        let mut log = UndoLog::new(Mode::Here);
        log.record(&body, write(&mut w, &body, "Hi Carl", Mode::Here).unwrap());
        w.focus = None;
        assert_eq!(log.undo(&mut w), vec![(0, Undone::Failed(FillError::Moved.to_string()))]);
        assert_eq!(w.boxes[0].value, "Hi Carl");
    }

    #[test]
    fn a_box_that_could_not_be_read_is_left_alone() {
        let mut w = Fake::one(Behaviour { readable: false, ..Default::default() });
        w.focus = Some(0);
        let body = field(0, "Body", FieldKind::RichText);
        let mut log = UndoLog::new(Mode::Here);
        log.record(&body, write(&mut w, &body, "Hello", Mode::Here).unwrap());
        assert_eq!(log.undo(&mut w), vec![(0, Undone::CannotCheck)]);
        assert!(!w.calls.contains(&"ctrl z".to_string()));
    }

    #[test]
    fn one_box_is_put_back_alone_through_every_write_to_it() {
        let mut w = Fake::new(vec![Behaviour { value: "R".into(), ..Default::default() }, Behaviour::default()]);
        let name = field(0, "Full name", FieldKind::PlainText);
        let email = field(1, "Email", FieldKind::Email);
        let mut log = UndoLog::new(Mode::Form);
        log.record(&name, write(&mut w, &name, "Ravi", Mode::Form).unwrap());
        log.record(&email, write(&mut w, &email, "ravi@gmail.com", Mode::Form).unwrap());
        log.record(&name, write(&mut w, &name, "Ravi Sharma", Mode::Form).unwrap());
        assert_eq!(log.undo_field(&mut w, 0), Some(Undone::PutBack));
        assert_eq!((w.boxes[0].value.as_str(), w.boxes[1].value.as_str()), ("R", "ravi@gmail.com"));
        assert_eq!(log.len(), 1, "the other box can still be put back");
        assert_eq!(log.undo_field(&mut w, 0), None, "nothing more to put back there");
    }

    #[test]
    fn undo_runs_newest_first_and_skips_boxes_that_are_gone() {
        let mut w = Fake::new(vec![Behaviour::default(), Behaviour { value: "false".into(), ..Default::default() }]);
        let name = field(0, "Full name", FieldKind::PlainText);
        let tick = field(1, "Same as billing address", FieldKind::Checkbox);
        let mut log = UndoLog::new(Mode::Form);
        log.record(&name, write(&mut w, &name, "Ravi", Mode::Form).unwrap());
        log.record(&tick, write(&mut w, &tick, "yes", Mode::Form).unwrap());
        assert_eq!(log.len(), 2);
        w.boxes[0].behaviour.gone = true;
        assert_eq!(log.undo(&mut w), vec![(1, Undone::PutBack), (0, Undone::Gone)]);
        assert_eq!(w.boxes[1].value, "false");
    }
}
