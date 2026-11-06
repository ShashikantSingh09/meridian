//! Fill this form, once the AI has answered: what goes in each box, where it came from, and what is
//! left for the user and why. The app reads the boxes and asks the AI; this turns the checked answers
//! into values and writes them in page order, one box at a time, the same on every platform.
//!
//! A fact is kept only when it can be found in what the AI was given (the user's words, the page, a
//! Knowledge page, the mail read for this fill), so the AI cannot make one up and call it looked up.
//! Values from Your details come from the app by key, and ID numbers wait for the user's yes.

use serde::Serialize;

use crate::mapping::{Answer, Checked, Problem, Source};
use crate::model::{Field, FieldKind};
use crate::policy::refusal;
use crate::undo::{UndoLog, Undone};
use crate::write::{write, Mode, Writer};
use crate::FillError;

/// Where a value came from, as the Show list and the outlines say it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Origin {
    Details,
    Knowledge,
    Mail,
    Notes,
    File,
    Clipboard,
    Page,
    Said,
    WrittenByAi,
}

impl From<Source> for Origin {
    fn from(source: Source) -> Self {
        match source {
            Source::Knowledge => Self::Knowledge,
            Source::Mail => Self::Mail,
            Source::Notes => Self::Notes,
            Source::File => Self::File,
            Source::Clipboard => Self::Clipboard,
            Source::Page => Self::Page,
            Source::Said => Self::Said,
            Source::WrittenByAi => Self::WrittenByAi,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    /// Not reached yet.
    Waiting,
    Filled,
    /// Never Meridian's: a password, card, code, CAPTCHA, "I agree" or upload.
    Yours,
    /// Left empty, with why: no value for it, or a box Meridian could not write.
    NeedsYou,
    /// It held something already, so it was kept.
    Kept,
    /// An ID number, waiting for the user's yes.
    AskFirst,
    PutBack,
}

/// One box, for the Show list and the outlines.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub field: u32,
    pub label: String,
    pub kind: FieldKind,
    pub state: State,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
    /// The page, mail or file it came from, as the AI named it.
    pub from: String,
    /// What went in. Masked for an ID number, and empty for a box that is yours.
    pub value: String,
    /// Why a box was left.
    pub why: String,
}

/// What Your details holds for a key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lookup {
    Plain(String),
    /// An ID number: read and written only after the user says yes, naming the site.
    AskFirst,
    Missing,
    /// Your details are turned off as a source.
    Off,
}

/// What the AI was given from each source, to find a quoted fact in. None: not given this time.
#[derive(Debug, Clone, Default)]
pub struct Given {
    pub said: String,
    pub page: String,
    pub knowledge: Option<String>,
    pub mail: Option<String>,
    pub notes: Option<String>,
    pub file: Option<String>,
    pub clipboard: Option<String>,
}

impl Given {
    fn of(&self, source: Source) -> Option<&str> {
        match source {
            Source::Said => Some(&self.said),
            Source::Page => Some(&self.page),
            Source::Knowledge => self.knowledge.as_deref(),
            Source::Mail => self.mail.as_deref(),
            Source::Notes => self.notes.as_deref(),
            Source::File => self.file.as_deref(),
            Source::Clipboard => self.clipboard.as_deref(),
            Source::WrittenByAi => None,
        }
    }

    /// Why a box got nothing, in fixed words: never the AI's, since a page can steer what it says.
    pub fn not_found(&self) -> &'static str {
        if self.knowledge.is_some() {
            "Not in Your details or Knowledge"
        } else {
            "Not in Your details"
        }
    }
}

fn plain(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

// ponytail: the fact must appear as it was given, so "32 lakh" given and "32,00,000" answered is
// left for the user. Loosen to digits-only for numbers if that proves too strict.
fn found(material: &str, text: &str) -> bool {
    let text = plain(text);
    !text.is_empty() && plain(material).contains(&text)
}

fn holds_text(field: &Field) -> bool {
    !matches!(field.kind, FieldKind::Checkbox | FieldKind::Radio | FieldKind::List) && !field.value.trim().is_empty()
}

#[derive(Debug, Clone)]
struct Job {
    field: u32,
    text: String,
    origin: Origin,
    from: String,
}

/// One form, from the boxes read to their Undo.
#[derive(Debug, Clone)]
pub struct Form {
    pub fields: Vec<Field>,
    pub rows: Vec<Row>,
    undo: UndoLog,
    todo: Vec<Job>,
    /// ID numbers waiting for a yes: the box and the key.
    asks: Vec<(u32, String)>,
}

/// Said for every box a run did not reach.
const STOPPED: &str = "Meridian stopped before this box.";
const WINDOW: &str = "You moved to another window, so Meridian stopped.";

impl Form {
    /// The boxes read, in page order. The ones that are yours are set aside before the AI hears of any.
    pub fn new(fields: Vec<Field>) -> Self {
        let rows = fields
            .iter()
            .map(|field| {
                let (state, why) = match refusal(field) {
                    Some(refused) => (State::Yours, refused.to_string()),
                    None if holds_text(field) => (State::Kept, "It held something already, so it was kept.".to_string()),
                    None => (State::Waiting, String::new()),
                };
                Row { field: field.id, label: field.label.clone(), kind: field.kind, state, origin: None, from: String::new(), value: String::new(), why }
            })
            .collect();
        Self { fields, rows, undo: UndoLog::new(Mode::Form), todo: Vec::new(), asks: Vec::new() }
    }

    /// The boxes the AI may hear about: every one that is not the user's, with whether it holds
    /// something already.
    pub fn open(&self) -> impl Iterator<Item = (&Field, bool)> {
        self.fields.iter().zip(&self.rows).filter(|(_, row)| row.state != State::Yours).map(|(field, row)| (field, matches!(row.state, State::Kept | State::Filled)))
    }

    /// Boxes Meridian may fill: none means there is no form here to ask the AI about.
    pub fn fillable(&self) -> usize {
        self.rows.iter().filter(|row| row.state != State::Yours).count()
    }

    fn at(&self, field: u32) -> Option<usize> {
        self.fields.iter().position(|known| known.id == field)
    }

    fn need(&mut self, at: usize, why: impl Into<String>) {
        let row = &mut self.rows[at];
        row.state = State::NeedsYou;
        row.why = why.into();
    }

    /// Takes the AI's checked answers. `details` looks a key up in Your details on this PC.
    pub fn plan(&mut self, checked: Checked, details: impl Fn(&str) -> Lookup, given: &Given) {
        self.todo.clear();
        let not_found = given.not_found();
        for fill in checked.fills {
            let Some(at) = self.at(fill.field) else { continue };
            let (field, state) = (&self.fields[at], self.rows[at].state);
            // A box that holds something, the user's or Meridian's, changes only with the user's own words.
            let holds = matches!(state, State::Kept | State::Filled);
            if matches!(state, State::Yours | State::AskFirst) {
                continue;
            }
            match fill.answer {
                Answer::Leave { .. } => {
                    if !holds {
                        self.need(at, not_found);
                    }
                }
                Answer::Profile { .. } if holds => {}
                Answer::Profile { key } => match details(&key) {
                    Lookup::Plain(text) => self.todo.push(Job { field: field.id, text, origin: Origin::Details, from: String::new() }),
                    Lookup::AskFirst => {
                        self.asks.retain(|(asked, _)| *asked != fill.field);
                        self.asks.push((fill.field, key));
                        self.rows[at].state = State::AskFirst;
                        self.rows[at].why = "ID numbers ask first, every time.".into();
                    }
                    Lookup::Missing => self.need(at, not_found),
                    Lookup::Off => self.need(at, "Your details are off in Settings."),
                },
                Answer::Text { text, source, from } => {
                    if holds && source != Source::Said {
                        continue;
                    }
                    let tick = matches!(field.kind, FieldKind::Checkbox | FieldKind::Radio);
                    let real = source == Source::WrittenByAi || tick || given.of(source).is_some_and(|material| found(material, &text));
                    if real {
                        self.todo.push(Job { field: field.id, text, origin: source.into(), from });
                    } else if !holds {
                        self.need(at, not_found);
                    }
                }
            }
        }
        for (field, problem) in checked.problems {
            let Some(at) = self.at(field).filter(|at| self.rows[*at].state == State::Waiting) else { continue };
            match problem {
                Problem::IdNumber => self.need(at, "ID numbers are off in Your details."),
                Problem::TooLong => self.need(at, "The answer was too long for this box."),
                _ => {}
            }
        }
        // Every box the AI said nothing it may write about.
        for at in 0..self.rows.len() {
            let field = self.rows[at].field;
            if self.rows[at].state == State::Waiting && !self.todo.iter().any(|job| job.field == field) {
                self.need(at, not_found);
            }
        }
        self.todo.sort_by_key(|job| job.field);
    }

    /// Boxes that will be written.
    pub fn todo(&self) -> usize {
        self.todo.len()
    }

    /// Writes what was planned, in page order. `each` hears of each box just before it is written,
    /// with the rows so far, the box's place in the run, the run's length and the box. `stop` is
    /// asked between boxes. The answer is why the run ended early, if it did.
    pub fn put<W: Writer>(&mut self, w: &mut W, mut each: impl FnMut(&[Row], usize, usize, u32), stop: impl Fn() -> bool) -> Result<(), String> {
        let jobs = std::mem::take(&mut self.todo);
        let total = jobs.len();
        for (done, job) in jobs.iter().enumerate() {
            let Some(at) = self.at(job.field) else { continue };
            if stop() {
                return Err(self.end_early(&jobs[done..], STOPPED));
            }
            each(&self.rows, done + 1, total, job.field);
            let field = self.fields[at].clone();
            match write(w, &field, &job.text, Mode::Form) {
                Ok(written) => {
                    self.undo.record(&field, written);
                    let row = &mut self.rows[at];
                    *row = Row { state: State::Filled, origin: Some(job.origin), from: job.from.clone(), value: job.text.clone(), why: String::new(), ..row.clone() };
                }
                Err(FillError::WindowChanged) => return Err(self.end_early(&jobs[done..], WINDOW)),
                Err(FillError::Refused(refused)) => {
                    self.rows[at].state = State::Yours;
                    self.rows[at].why = refused.to_string();
                }
                Err(FillError::NeedsYou(why)) => self.need(at, why),
                Err(FillError::Uncertain) => self.need(at, "It shows something else after writing. Check it."),
                Err(error) => self.need(at, error.to_string()),
            }
        }
        Ok(())
    }

    fn end_early(&mut self, left: &[Job], why: &str) -> String {
        for job in left {
            if let Some(at) = self.at(job.field).filter(|at| self.rows[*at].state != State::Filled) {
                self.need(at, why);
            }
        }
        why.to_string()
    }

    /// The ID numbers waiting for a yes, as the box and its key.
    pub fn asks(&self) -> &[(u32, String)] {
        &self.asks
    }

    /// The user said yes, naming the site. `number` reads each one only now, with how it is shown.
    pub fn put_ids<W: Writer>(&mut self, w: &mut W, number: impl Fn(&str) -> Option<(String, String)>) -> Result<(), String> {
        let mut masked = Vec::new();
        for (field, key) in std::mem::take(&mut self.asks) {
            let Some(at) = self.at(field) else { continue };
            match number(&key) {
                Some((text, shown)) => {
                    self.todo.push(Job { field, text, origin: Origin::Details, from: String::new() });
                    masked.push((at, shown));
                }
                None => self.need(at, "That number is not kept in Your details."),
            }
        }
        let result = self.put(w, |_, _, _, _| {}, || false);
        for (at, shown) in masked {
            if self.rows[at].state == State::Filled {
                self.rows[at].value = shown;
            }
        }
        result
    }

    /// Not this time.
    pub fn skip_ids(&mut self) {
        for (field, _) in std::mem::take(&mut self.asks) {
            if let Some(at) = self.at(field) {
                self.need(at, "Left for you this time.");
            }
        }
    }

    fn undone(&mut self, field: u32, undone: Undone) {
        let Some(at) = self.at(field) else { return };
        let row = &mut self.rows[at];
        match undone {
            Undone::PutBack => {
                row.state = State::PutBack;
                row.why.clear();
            }
            Undone::Kept => row.why = "You changed it after it was filled, so it keeps what you typed.".into(),
            Undone::Gone => row.why = "That box is no longer there.".into(),
            Undone::CannotCheck => row.why = "It could not be read, so it was left as it is.".into(),
            Undone::Failed(why) => row.why = why,
        }
    }

    /// Puts every box back, unless the user changed it since. The answer is each box and how it went.
    pub fn undo_all<W: Writer>(&mut self, w: &mut W) -> Vec<(u32, Undone)> {
        let mut results: Vec<(u32, Undone)> = Vec::new();
        // Newest first, so a box written twice ends with how its first write went back.
        for (field, undone) in self.undo.undo(w) {
            match results.iter_mut().find(|(known, _)| *known == field) {
                Some(known) => known.1 = undone,
                None => results.push((field, undone)),
            }
        }
        for (field, undone) in &results {
            self.undone(*field, undone.clone());
        }
        results
    }

    /// Puts one box back, unless the user changed it since.
    pub fn undo_one<W: Writer>(&mut self, w: &mut W, field: u32) -> Option<Undone> {
        let undone = self.undo.undo_field(w, field)?;
        self.undone(field, undone.clone());
        Some(undone)
    }

    pub fn filled(&self) -> usize {
        self.rows.iter().filter(|row| row.state == State::Filled).count()
    }

    /// Boxes left for the user: theirs, ones with no value, and ID numbers not yet allowed.
    pub fn need_you(&self) -> usize {
        self.rows.iter().filter(|row| matches!(row.state, State::Yours | State::NeedsYou | State::AskFirst)).count()
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{Behaviour, Fake};
    use crate::mapping::{check, Fill, Mapping};
    use crate::model::field;

    /// The job application on the board, as Meridian reads it.
    fn application() -> Vec<Field> {
        vec![
            field(0, "Full name", FieldKind::PlainText),
            field(1, "Email", FieldKind::Email),
            field(2, "Phone", FieldKind::Phone),
            field(3, "Notice period", FieldKind::PlainText),
            field(4, "Create a password", FieldKind::Password),
            field(5, "Why do you want to join Kestrel Labs?", FieldKind::MultiLine),
            field(6, "Your CV", FieldKind::File),
            field(7, "I agree to the privacy policy", FieldKind::Checkbox),
        ]
    }

    fn boxes(n: usize) -> Fake {
        Fake::new(vec![Behaviour::default(); n])
    }

    fn profile(field: u32, key: &str) -> Fill {
        Fill { field, answer: Answer::Profile { key: key.into() } }
    }

    fn text(field: u32, text: &str, source: Source, from: &str) -> Fill {
        Fill { field, answer: Answer::Text { text: text.into(), source, from: from.into() } }
    }

    fn ravi(key: &str) -> Lookup {
        match key {
            "name" => Lookup::Plain("Ravi Sharma".into()),
            "email" => Lookup::Plain("ravi.sharma84@gmail.com".into()),
            "phone" => Lookup::Plain("+91 98201 44317".into()),
            "id.pan" => Lookup::AskFirst,
            _ => Lookup::Missing,
        }
    }

    fn knowledge() -> Given {
        Given { knowledge: Some("Job search (project page)\n- Notice period: 60 days (the user wrote this)".into()), ..Given::default() }
    }

    fn planned(fields: Vec<Field>, fills: Vec<Fill>, details: impl Fn(&str) -> Lookup, given: &Given) -> Form {
        let checked = check(Mapping { fills }, &fields, crate::ID_KEYS);
        let mut form = Form::new(fields);
        form.plan(checked, details, given);
        form
    }

    fn state(form: &Form, field: u32) -> (State, &str) {
        let row = &form.rows[field as usize];
        (row.state, row.why.as_str())
    }

    #[test]
    fn the_boxes_that_are_yours_are_set_aside_before_the_ai_hears_of_any() {
        let form = Form::new(application());
        let open: Vec<&str> = form.open().map(|(field, _)| field.label.as_str()).collect();
        assert_eq!(open, ["Full name", "Email", "Phone", "Notice period", "Why do you want to join Kestrel Labs?"]);
        assert_eq!(form.fillable(), 5);
        assert_eq!(state(&form, 4), (State::Yours, "Password boxes are yours to fill."));
        assert_eq!(state(&form, 7).0, State::Yours);
    }

    #[test]
    fn the_mapping_becomes_writes_in_page_order_each_with_where_it_came_from() {
        let fills = vec![
            text(5, "I have spent four years designing payment screens.", Source::WrittenByAi, ""),
            profile(0, "name"),
            text(3, "60 days", Source::Knowledge, "Job search"),
            profile(2, "phone"),
            profile(1, "email"),
        ];
        let mut form = planned(application(), fills, ravi, &knowledge());
        assert_eq!(form.todo(), 5);
        let mut w = boxes(8);
        let mut seen = Vec::new();
        form.put(&mut w, |_, done, total, field| seen.push((done, total, field)), || false).unwrap();
        assert_eq!(seen, [(1, 5, 0), (2, 5, 1), (3, 5, 2), (4, 5, 3), (5, 5, 5)], "top to bottom, one by one");
        assert_eq!(w.boxes[2].value, "+91 98201 44317");
        let row = |field: usize| (&form.rows[field].state, form.rows[field].origin, form.rows[field].from.as_str());
        assert_eq!(row(0), (&State::Filled, Some(Origin::Details), ""));
        assert_eq!(row(3), (&State::Filled, Some(Origin::Knowledge), "Job search"));
        assert_eq!(row(5), (&State::Filled, Some(Origin::WrittenByAi), ""));
        assert_eq!((form.filled(), form.need_you(), form.rows.len()), (5, 3, 8), "Filled 5 of 8 · 3 need you");
        assert!(!w.calls.iter().any(|call| call.contains(" 4") || call.contains(" 6") || call.contains(" 7")), "the password, the CV and I agree were never touched: {:?}", w.calls);
    }

    #[test]
    fn answers_for_boxes_that_are_yours_are_refused_whatever_the_ai_says() {
        let fills = vec![text(4, "hunter2", Source::Said, ""), text(7, "yes", Source::Said, ""), profile(6, "name")];
        let mut form = planned(application(), fills, ravi, &Given { said: "my password is hunter2".into(), ..Given::default() });
        assert_eq!(form.todo(), 0);
        let mut w = boxes(8);
        form.put(&mut w, |_, _, _, _| {}, || false).unwrap();
        assert!(w.calls.is_empty());
        assert_eq!([state(&form, 4).0, state(&form, 6).0, state(&form, 7).0], [State::Yours; 3]);
    }

    #[test]
    fn a_fact_that_is_not_in_what_was_given_is_left_empty_and_says_why() {
        let fills = vec![
            text(3, "90 days", Source::Knowledge, "Job search"),
            text(0, "Ravi Sharma", Source::Mail, "Uber receipt"),
            text(1, "ravi@example.com", Source::Page, ""),
        ];
        let form = planned(application(), fills, ravi, &knowledge());
        assert_eq!(form.todo(), 0, "never guesses a fact");
        assert_eq!(state(&form, 3), (State::NeedsYou, "Not in Your details or Knowledge"));
        assert_eq!(state(&form, 0).0, State::NeedsYou, "no mail was read for this fill");
        let without_knowledge = planned(application(), vec![], ravi, &Given::default());
        assert_eq!(state(&without_knowledge, 3), (State::NeedsYou, "Not in Your details"));
    }

    #[test]
    fn a_source_that_is_off_gives_nothing() {
        let off = planned(application(), vec![profile(0, "name")], |_| Lookup::Off, &Given::default());
        assert_eq!(state(&off, 0), (State::NeedsYou, "Your details are off in Settings."));
        let mail_off = planned(application(), vec![text(0, "Ravi", Source::Mail, "")], ravi, &Given { said: "use my mail".into(), ..Given::default() });
        assert_eq!(mail_off.todo(), 0);
        let mail_read = planned(application(), vec![text(0, "Ravi", Source::Mail, "")], ravi, &Given { mail: Some("From Ravi".into()), ..Given::default() });
        assert_eq!(mail_read.todo(), 1);
    }

    #[test]
    fn what_the_user_said_fills_a_box_and_wins_over_what_is_there() {
        let mut fields = application();
        fields[1].value = "ravi@ravisharma.design".into();
        let said = Given { said: "Notice period 60 days, email ravi@work.in".into(), ..Given::default() };
        let mut form = planned(fields.clone(), vec![profile(1, "email"), text(3, "60 days", Source::Said, "")], ravi, &said);
        assert_eq!(state(&form, 1).0, State::Kept, "a box that held something keeps it");
        let mut w = boxes(8);
        form.put(&mut w, |_, _, _, _| {}, || false).unwrap();
        assert_eq!(form.rows[3].origin, Some(Origin::Said));

        let checked = check(Mapping { fills: vec![text(1, "ravi@work.in", Source::Said, "")] }, &fields, &[]);
        form.plan(checked, ravi, &said);
        form.put(&mut w, |_, _, _, _| {}, || false).unwrap();
        assert_eq!((form.rows[1].state, w.boxes[1].value.as_str()), (State::Filled, "ravi@work.in"));
    }

    #[test]
    fn an_id_number_waits_for_a_yes_and_is_read_only_then() {
        let mut fields = application();
        fields.push(field(8, "PAN", FieldKind::PlainText));
        let mut form = planned(fields, vec![profile(8, "id.pan")], ravi, &Given::default());
        assert_eq!(form.asks(), [(8, "id.pan".to_string())]);
        assert_eq!(state(&form, 8).0, State::AskFirst);
        let mut w = boxes(9);
        form.put(&mut w, |_, _, _, _| {}, || false).unwrap();
        assert!(w.calls.is_empty(), "nothing is written before the yes");
        form.put_ids(&mut w, |key| (key == "id.pan").then(|| ("ABCDE1234K".to_string(), "•••••1234K".to_string()))).unwrap();
        assert_eq!(w.boxes[8].value, "ABCDE1234K");
        assert_eq!((form.rows[8].state, form.rows[8].value.as_str()), (State::Filled, "•••••1234K"), "the Show list has the masked number");
        assert!(form.asks().is_empty());
    }

    #[test]
    fn not_this_time_leaves_the_id_number_for_the_user() {
        let mut fields = application();
        fields.push(field(8, "Aadhaar number", FieldKind::PlainText));
        let mut form = planned(fields, vec![profile(8, "id.aadhaar")], |_| Lookup::AskFirst, &Given::default());
        form.skip_ids();
        assert_eq!(state(&form, 8), (State::NeedsYou, "Left for you this time."));
    }

    #[test]
    fn id_numbers_that_are_off_are_left_for_the_user() {
        let mut fields = application();
        fields.push(field(8, "PAN", FieldKind::PlainText));
        let checked = check(Mapping { fills: vec![profile(8, "id.pan")] }, &fields, &[]);
        let mut form = Form::new(fields);
        form.plan(checked, ravi, &Given::default());
        assert_eq!(state(&form, 8), (State::NeedsYou, "ID numbers are off in Your details."));
    }

    #[test]
    fn a_box_that_cannot_be_written_needs_you_and_the_rest_go_on() {
        let mut fields = application();
        fields[3] = field(3, "Start date", FieldKind::Date);
        let given = Given { said: "starting 2026-12-01".into(), ..Given::default() };
        let mut form = planned(fields, vec![profile(0, "name"), text(3, "2026-12-01", Source::Said, ""), profile(1, "email")], ravi, &given);
        let mut w = Fake::new(vec![Behaviour::default(), Behaviour::default(), Behaviour::default(), Behaviour { sticks: false, ..Default::default() }]);
        form.put(&mut w, |_, _, _, _| {}, || false).unwrap();
        assert_eq!(state(&form, 3), (State::NeedsYou, "Date boxes need you."));
        assert_eq!((form.rows[0].state, form.rows[1].state), (State::Filled, State::Filled));
    }

    #[test]
    fn leaving_the_window_stops_the_run_and_says_so_on_each_box_left() {
        let mut form = planned(application(), vec![profile(0, "name"), profile(1, "email"), profile(2, "phone")], ravi, &Given::default());
        let mut w = Fake::new(vec![Behaviour::default(), Behaviour { elsewhere: true, ..Default::default() }, Behaviour::default()]);
        assert_eq!(form.put(&mut w, |_, _, _, _| {}, || false), Err(WINDOW.to_string()));
        assert_eq!(form.rows[0].state, State::Filled);
        assert_eq!(state(&form, 1), (State::NeedsYou, WINDOW));
        assert_eq!(state(&form, 2), (State::NeedsYou, WINDOW));
        assert_eq!(w.boxes[2].value, "", "nothing after it was written");
    }

    #[test]
    fn esc_stops_between_boxes() {
        let mut form = planned(application(), vec![profile(0, "name"), profile(1, "email")], ravi, &Given::default());
        let mut w = boxes(8);
        let asked = std::cell::Cell::new(0);
        let stop = || {
            asked.set(asked.get() + 1);
            asked.get() > 1
        };
        assert_eq!(form.put(&mut w, |_, _, _, _| {}, stop), Err(STOPPED.to_string()));
        assert_eq!((form.rows[0].state, state(&form, 1)), (State::Filled, (State::NeedsYou, STOPPED)));
    }

    #[test]
    fn undo_puts_every_box_back_except_one_the_user_changed() {
        let mut form = planned(application(), vec![profile(0, "name"), profile(1, "email"), profile(2, "phone")], ravi, &Given::default());
        let mut w = boxes(8);
        form.put(&mut w, |_, _, _, _| {}, || false).unwrap();
        w.boxes[1].value = "ravi@ravisharma.design".into();
        let undone = form.undo_all(&mut w);
        assert_eq!(undone.iter().filter(|(_, how)| *how == Undone::PutBack).count(), 2, "Put back 2 boxes");
        assert_eq!(form.rows[1].why, "You changed it after it was filled, so it keeps what you typed.");
        assert_eq!(w.boxes[1].value, "ravi@ravisharma.design");
        assert_eq!((w.boxes[0].value.as_str(), form.rows[0].state), ("", State::PutBack));
        assert!(!form.can_undo());
    }

    #[test]
    fn one_box_can_be_put_back_alone() {
        let mut form = planned(application(), vec![profile(0, "name"), profile(1, "email")], ravi, &Given::default());
        let mut w = boxes(8);
        form.put(&mut w, |_, _, _, _| {}, || false).unwrap();
        assert_eq!(form.undo_one(&mut w, 1), Some(Undone::PutBack));
        assert_eq!((form.rows[1].state, form.rows[0].state), (State::PutBack, State::Filled));
        assert_eq!(form.undo_one(&mut w, 4), None, "Meridian never wrote in the password box");
        assert!(form.can_undo());
    }

    #[test]
    fn a_tick_box_takes_the_users_yes_without_a_quote() {
        let mut fields = application();
        fields.push(field(8, "Same as billing address", FieldKind::Checkbox));
        let mut form = planned(fields, vec![text(8, "yes", Source::Said, "")], ravi, &Given { said: "billing is the same".into(), ..Given::default() });
        let mut w = Fake::new(vec![Behaviour { value: "false".into(), ..Default::default() }; 9]);
        form.put(&mut w, |_, _, _, _| {}, || false).unwrap();
        assert_eq!(w.boxes[8].value, "true");
    }

    #[test]
    fn rows_reach_the_island_in_its_words() {
        let form = planned(application(), vec![profile(0, "name")], ravi, &Given::default());
        let json = serde_json::to_value(&form.rows[0]).unwrap();
        assert_eq!((json["state"].as_str(), json["kind"].as_str()), (Some("waiting"), Some("plain-text")));
        assert_eq!(serde_json::to_value(Origin::WrittenByAi).unwrap(), "written-by-ai");
        assert_eq!(serde_json::to_value(&form.rows[4]).unwrap()["state"], "yours");
    }
}
