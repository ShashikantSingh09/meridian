//! Fill this form, once the AI has answered: what goes in each box, where it came from, and what is
//! left for the user and why. The app reads the boxes and asks the AI; this turns the checked answers
//! into values and writes them in page order, one box at a time, the same on every platform.
//!
//! A fact is kept only when it can be found in what the AI was given (the user's words, the page, a
//! Knowledge page, the mail read for this fill), so the AI cannot make one up and call it looked up.
//! Values from Your details come from the app by key, and ID numbers wait for the user's yes.
//!
//! The choices of one question are one row (see [`choices`]), with one answer and one write. After the
//! fill, a box that needs the user can be answered on the island, through the same writer and Undo.

use serde::Serialize;

use crate::choices;
use crate::mapping::{Answer, Checked, Problem, Source, MAX_TEXT};
use crate::model::{Field, FieldKind};
use crate::policy::refusal;
use crate::undo::{UndoLog, Undone};
use crate::write::{write, yes_no, Mode, Need, Writer};
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
    /// Typed or picked on the island by the user. It never goes to the AI.
    Typed,
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
    /// It needed the user, and they have been in it on the page since.
    ByYou,
}

/// One choice of a question, by its box.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Choice {
    pub field: u32,
    pub label: String,
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
    /// The page, mail or file it came from, as the AI named it. For a choice Your details answered,
    /// the detail that answered it, such as "company".
    pub from: String,
    /// What went in. Masked for an ID number, and empty for a box that is yours.
    pub value: String,
    /// Why a box was left.
    pub why: String,
    /// For a choice question, its choices. The row stands for them all, and its box is the one picked.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<Choice>,
    /// The Your details key for a box Your details had nothing for, so what the user types can be kept.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
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
    /// A row a box. [`Form::questions`] is what the island and the outlines show.
    pub rows: Vec<Row>,
    undo: UndoLog,
    todo: Vec<Job>,
    /// ID numbers waiting for a yes: the box and the key.
    asks: Vec<(u32, String)>,
    /// The groups of choices that are one question each, by their boxes' places.
    groups: Vec<Vec<usize>>,
    /// What each box that needs the user held when first looked at after the fill, so a change shows
    /// they have been in it.
    seen: Vec<(u32, String)>,
    /// Boxes that are the user's that have had the cursor since the fill.
    been_in: Vec<u32>,
}

/// Said for every box a run did not reach.
const STOPPED: &str = "Meridian stopped before this box.";
const WINDOW: &str = "You moved to another window, so Meridian stopped.";
const KEPT: &str = "It held something already, so it was kept.";
const CLEARED: &str = "The page emptied it after it went in. Pick or type it yourself.";

impl Form {
    /// The boxes read, in page order. The ones that are yours are set aside before the AI hears of any.
    pub fn new(fields: Vec<Field>) -> Self {
        let groups = choices::groups(&fields);
        let mut rows: Vec<Row> = fields
            .iter()
            .map(|field| {
                let (state, why) = match refusal(field) {
                    Some(refused) => (State::Yours, refused.to_string()),
                    None if holds_text(field) => (State::Kept, KEPT.to_string()),
                    None => (State::Waiting, String::new()),
                };
                Row { field: field.id, label: field.label.clone(), kind: field.kind, state, origin: None, from: String::new(), value: String::new(), why, choices: Vec::new(), key: None }
            })
            .collect();
        // A question the user has picked a choice for already keeps that choice.
        for group in groups.iter().filter(|group| group.iter().any(|&at| fields[at].value == "true")) {
            for &at in group {
                if rows[at].state == State::Waiting {
                    rows[at].state = State::Kept;
                    rows[at].why = KEPT.into();
                }
            }
        }
        Self { fields, rows, undo: UndoLog::new(Mode::Form), todo: Vec::new(), asks: Vec::new(), groups, seen: Vec::new(), been_in: Vec::new() }
    }

    /// The boxes the AI may hear about: every one that is not the user's, with whether it holds
    /// something already.
    pub fn open(&self) -> impl Iterator<Item = (&Field, bool)> {
        self.fields.iter().zip(&self.rows).filter(|(_, row)| row.state != State::Yours).map(|(field, row)| (field, matches!(row.state, State::Kept | State::Filled | State::ByYou)))
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

    fn group_of(&self, at: usize) -> Option<&[usize]> {
        self.groups.iter().find(|group| group.contains(&at)).map(Vec::as_slice)
    }

    /// The box, or the choices of its question.
    fn question_of(&self, at: usize) -> Vec<usize> {
        self.group_of(at).map_or_else(|| vec![at], <[usize]>::to_vec)
    }

    /// A box of the same question, or the box itself, is to be written already.
    fn planned(&self, at: usize) -> bool {
        self.question_of(at).iter().any(|&other| self.todo.iter().any(|job| job.field == self.fields[other].id))
    }

    /// The box, or a choice of its question, holds something: Meridian's, or the user's.
    fn holds(&self, at: usize) -> bool {
        self.question_of(at).iter().any(|&other| matches!(self.rows[other].state, State::Kept | State::Filled | State::ByYou))
    }

    /// Takes the AI's checked answers. `details` looks a key up in Your details on this PC.
    pub fn plan(&mut self, checked: Checked, details: impl Fn(&str) -> Lookup, given: &Given) {
        self.todo.clear();
        let not_found = given.not_found();
        for fill in checked.fills {
            let Some(at) = self.at(fill.field) else { continue };
            let (field, state) = (&self.fields[at], self.rows[at].state);
            // A box that holds something, the user's or Meridian's, changes only with the user's own words.
            let holds = self.holds(at);
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
                    Lookup::Missing => {
                        self.need(at, not_found);
                        // What the user types for it on the island can be kept under this key.
                        self.rows[at].key = Some(key);
                    }
                    Lookup::Off => self.need(at, "Your details are off in Settings."),
                },
                Answer::Text { text, source, from } => {
                    if holds && source != Source::Said {
                        continue;
                    }
                    // A question of choices takes one answer: a yes, for one of them. A no picks nothing.
                    if field.kind == FieldKind::Radio && (yes_no(&text) != Some(true) || self.planned(at)) {
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
        self.work_status(&details);
        // Every box the AI said nothing it may write about.
        for at in 0..self.rows.len() {
            if self.rows[at].state == State::Waiting && !self.planned(at) {
                self.need(at, not_found);
            }
        }
        self.todo.sort_by_key(|job| job.field);
    }

    /// A work status question nobody answered: with a company or a job title in Your details, the user
    /// is working. Only whether the detail has a value is asked, here in Rust.
    fn work_status(&mut self, details: &impl Fn(&str) -> Lookup) {
        for group in self.groups.clone() {
            let open = group.iter().all(|&at| matches!(self.rows[at].state, State::Waiting | State::NeedsYou)) && !self.planned(group[0]);
            let words: Vec<&str> = group.iter().map(|&at| choices::split(&self.fields[at].label).map_or("", |(_, words)| words)).collect();
            let Some(pick) = open.then(|| choices::working(&words)).flatten() else { continue };
            let Some(detail) = choices::working_detail(details) else { continue };
            self.todo.push(Job { field: self.fields[group[pick]].id, text: "yes".into(), origin: Origin::Details, from: detail.into() });
        }
    }

    /// Boxes that will be written.
    pub fn todo(&self) -> usize {
        self.todo.len()
    }

    /// Writes what was planned, in page order. `each` hears of each box just before it is written,
    /// with the questions so far, the box's place in the run, the run's length and the box. `stop` is
    /// asked between boxes. The answer is why the run ended early, if it did.
    pub fn put<W: Writer>(&mut self, w: &mut W, mut each: impl FnMut(&[Row], usize, usize, u32), stop: impl Fn() -> bool) -> Result<(), String> {
        let jobs = std::mem::take(&mut self.todo);
        let total = jobs.len();
        for (done, job) in jobs.iter().enumerate() {
            let Some(at) = self.at(job.field) else { continue };
            if stop() {
                return Err(self.end_early(&jobs[done..], STOPPED));
            }
            each(&self.questions(), done + 1, total, job.field);
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
        self.recheck(w);
        Ok(())
    }

    /// A picker the page built can take the text, then empty itself once the cursor moves on. Each
    /// written one-line box is read again once all are in, so the list never says Filled over an empty box.
    fn recheck<W: Writer>(&mut self, w: &mut W) {
        for at in 0..self.rows.len() {
            let field = &self.fields[at];
            let text_box = matches!(field.kind, FieldKind::PlainText | FieldKind::Email | FieldKind::Phone | FieldKind::Number);
            if self.rows[at].state != State::Filled || !text_box || self.rows[at].value.trim().is_empty() {
                continue;
            }
            if matches!(w.value(field.id), Ok(now) if now.trim().is_empty()) {
                self.need(at, CLEARED);
            }
        }
    }

    fn end_early(&mut self, left: &[Job], why: &str) -> String {
        for job in left {
            if let Some(at) = self.at(job.field).filter(|at| self.rows[*at].state != State::Filled) {
                self.need(at, why);
            }
        }
        why.to_string()
    }

    /// The user's own answer for a box that needs them, typed or picked on the island: a choice takes
    /// "yes". It goes in through the same writer, checks and Undo as the fill. Never into a box that is
    /// theirs, one filled or kept, or an ID number waiting for its yes. The answer is why it stopped.
    pub fn answer<W: Writer>(&mut self, w: &mut W, field: u32, text: &str) -> Result<(), String> {
        let at = self.at(field).ok_or("That box is no longer there.")?;
        match self.rows[at].state {
            // Waiting: a choice of a question whose other choice could not be picked.
            State::NeedsYou | State::Waiting if !self.holds(at) => {}
            State::Yours => return Err(self.rows[at].why.clone()),
            _ => return Err("That box does not need you now.".into()),
        }
        let text = text.trim();
        if text.is_empty() {
            return Err("Type something first.".into());
        }
        if text.chars().count() > MAX_TEXT {
            return Err("That is too long for this box.".into());
        }
        self.todo = vec![Job { field, text: text.to_string(), origin: Origin::Typed, from: String::new() }];
        self.put(w, |_, _, _, _| {}, || false)
    }

    /// Looks at the boxes that need the user, after the fill, for ones they have been in on the page: a
    /// box or a choice that shows something new, or a box of theirs they have been in and left. Those
    /// need them no more. A box of theirs is never read: only whether the cursor is in it. True when one
    /// changed.
    pub fn noticed<W: Writer>(&mut self, w: &mut W) -> bool {
        let mut changed = false;
        for at in 0..self.rows.len() {
            let id = self.rows[at].field;
            match self.rows[at].state {
                State::Yours => {
                    if w.check(id, Need::Focus).is_ok() {
                        if !self.been_in.contains(&id) {
                            self.been_in.push(id);
                        }
                    } else if self.been_in.contains(&id) {
                        self.by_you(at);
                        changed = true;
                    }
                }
                // A choice of a question already answered is not watched.
                State::NeedsYou | State::Waiting if !self.holds(at) => {
                    let Ok(now) = w.value(id) else { continue };
                    let new = self.seen.iter().find(|(seen, _)| *seen == id).map(|(_, before)| before.trim() != now.trim());
                    match new {
                        None => self.seen.push((id, now)),
                        Some(true) if !now.trim().is_empty() && now != "false" => {
                            self.by_you(at);
                            changed = true;
                        }
                        Some(_) => {}
                    }
                }
                _ => {}
            }
        }
        changed
    }

    /// The user has been in it. A choice picked answers its whole question, and is the one marked.
    fn by_you(&mut self, at: usize) {
        for other in self.question_of(at) {
            let row = &mut self.rows[other];
            if matches!(row.state, State::NeedsYou | State::Waiting | State::Yours) {
                row.state = State::ByYou;
                row.why.clear();
                row.value = if other == at && row.kind == FieldKind::Radio { "true".into() } else { String::new() };
            }
        }
    }

    /// The rows as the island and the outlines show them: a box a row, and one row for each question of
    /// choices, standing for its choices, whose box is the one picked.
    pub fn questions(&self) -> Vec<Row> {
        let mut out = Vec::new();
        for (at, row) in self.rows.iter().enumerate() {
            match self.group_of(at) {
                None => out.push(row.clone()),
                Some(group) if group[0] == at => out.push(self.question(group)),
                Some(_) => {}
            }
        }
        out
    }

    fn question(&self, group: &[usize]) -> Row {
        let words = |at: usize| choices::split(&self.fields[at].label).map_or_else(|| self.fields[at].label.clone(), |(_, words)| words.to_string());
        // What the question is up to: the most settled of its choices.
        let rank = |state: State| match state {
            State::Filled => 0,
            State::ByYou => 1,
            State::Kept => 2,
            State::PutBack => 3,
            State::AskFirst => 4,
            State::NeedsYou => 5,
            State::Yours => 6,
            State::Waiting => 7,
        };
        let lead = *group.iter().min_by_key(|&&at| rank(self.rows[at].state)).expect("a group has choices");
        let picked = group.iter().copied().find(|&at| match self.rows[at].state {
            State::Filled => true,
            State::ByYou => self.rows[at].value == "true",
            State::Kept => self.fields[at].value == "true",
            _ => false,
        });
        let shown = &self.rows[picked.unwrap_or(lead)];
        Row {
            field: self.rows[picked.unwrap_or(group[0])].field,
            label: choices::split(&self.fields[group[0]].label).map_or_else(|| self.fields[group[0]].label.clone(), |(question, _)| question.to_string()),
            kind: FieldKind::Radio,
            state: self.rows[lead].state,
            origin: shown.origin,
            from: shown.from.clone(),
            value: picked.map(words).unwrap_or_default(),
            why: self.rows[lead].why.clone(),
            choices: group.iter().map(|&at| Choice { field: self.rows[at].field, label: words(at) }).collect(),
            key: None,
        }
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

    /// Questions filled: a box each, and one for a question of choices.
    pub fn filled(&self) -> usize {
        self.questions().iter().filter(|row| row.state == State::Filled).count()
    }

    /// Questions left for the user: theirs, ones with no value, and ID numbers not yet allowed.
    pub fn need_you(&self) -> usize {
        self.questions().iter().filter(|row| matches!(row.state, State::Yours | State::NeedsYou | State::AskFirst)).count()
    }

    /// Questions on the form, as the island counts them.
    pub fn total(&self) -> usize {
        self.questions().len()
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
    fn a_box_the_page_empties_after_it_went_in_needs_you_again() {
        let mut form = planned(application(), vec![profile(0, "name"), profile(1, "email"), profile(2, "phone")], ravi, &Given::default());
        let mut w = boxes(8);
        // The email box is a picker the page built: it keeps only its own choices, so it empties once left.
        w.boxes[1].behaviour.empties_when_left = true;
        form.put(&mut w, |_, _, _, _| {}, || false).unwrap();
        assert_eq!(state(&form, 1), (State::NeedsYou, CLEARED));
        assert_eq!((form.rows[0].state, form.rows[2].state), (State::Filled, State::Filled), "the boxes that kept their value stay filled");
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

    /// Naukri's sign-up form, as the owner tried it: two choice cards for one Work status question.
    fn sign_up(experienced: &str, fresher: &str) -> Vec<Field> {
        let mut fields = vec![
            field(0, "Full name", FieldKind::PlainText),
            field(1, "Email ID", FieldKind::Email),
            field(2, "Password", FieldKind::Password),
            field(3, "Mobile number", FieldKind::Phone),
            field(4, experienced, FieldKind::Radio),
            field(5, fresher, FieldKind::Radio),
        ];
        fields[4].value = "false".into();
        fields[5].value = "false".into();
        fields
    }

    fn naukri() -> Vec<Field> {
        sign_up("Work status: I'm experienced", "Work status: I'm a fresher")
    }

    fn sign_up_boxes() -> Fake {
        let choice = Behaviour { value: "false".into(), ..Default::default() };
        Fake::new(vec![Behaviour::default(), Behaviour::default(), Behaviour::default(), Behaviour::default(), choice.clone(), choice])
    }

    fn working(key: &str) -> Lookup {
        match key {
            "work.company" => Lookup::Plain("Northwind Software".into()),
            other => ravi(other),
        }
    }

    fn question<'a>(rows: &'a [Row], label: &str) -> &'a Row {
        rows.iter().find(|row| row.label == label).unwrap_or_else(|| panic!("no row {label}"))
    }

    #[test]
    fn the_choices_of_one_question_are_one_row_with_a_button_each() {
        let form = planned(naukri(), vec![profile(0, "name"), profile(3, "phone")], ravi, &Given::default());
        let rows = form.questions();
        assert_eq!(rows.iter().map(|row| row.label.as_str()).collect::<Vec<_>>(), ["Full name", "Email ID", "Password", "Mobile number", "Work status"]);
        let status = question(&rows, "Work status");
        assert_eq!(status.state, State::NeedsYou);
        assert_eq!(status.choices, [Choice { field: 4, label: "I'm experienced".into() }, Choice { field: 5, label: "I'm a fresher".into() }]);
        assert_eq!((form.total(), form.need_you()), (5, 3), "Email ID, Password and Work status: one question, not two");
        let json = serde_json::to_value(status).unwrap();
        assert_eq!(json["choices"][1], serde_json::json!({ "field": 5, "label": "I'm a fresher" }));
        assert!(serde_json::to_value(&rows[0]).unwrap().get("choices").is_none());
    }

    #[test]
    fn a_question_of_choices_takes_one_answer_and_one_write() {
        let given = Given { said: "I'm a fresher".into(), ..Given::default() };
        let fills = vec![text(4, "no", Source::Said, ""), text(5, "yes", Source::Said, "")];
        let mut form = planned(naukri(), fills, ravi, &given);
        assert_eq!(form.todo(), 1, "a no picks nothing");
        let mut w = sign_up_boxes();
        form.put(&mut w, |_, _, _, _| {}, || false).unwrap();
        assert_eq!(w.calls, ["tick 5"]);
        let rows = form.questions();
        let status = question(&rows, "Work status");
        assert_eq!((status.state, status.field, status.value.as_str()), (State::Filled, 5, "I'm a fresher"));

        let both = planned(naukri(), vec![text(4, "yes", Source::Said, ""), text(5, "yes", Source::Said, "")], ravi, &given);
        assert_eq!(both.todo(), 1, "two yeses for one question: only the first goes in");
    }

    #[test]
    fn a_work_status_follows_from_a_company_in_your_details_without_the_ai() {
        let mut form = planned(naukri(), vec![profile(0, "name")], working, &Given::default());
        assert_eq!(form.todo(), 2);
        let mut w = sign_up_boxes();
        form.put(&mut w, |_, _, _, _| {}, || false).unwrap();
        assert_eq!((w.boxes[4].value.as_str(), w.boxes[5].value.as_str()), ("true", "false"));
        let rows = form.questions();
        let status = question(&rows, "Work status");
        assert_eq!((status.state, status.origin, status.from.as_str(), status.value.as_str()), (State::Filled, Some(Origin::Details), "company", "I'm experienced"));
    }

    #[test]
    fn a_work_status_in_hindi_follows_from_a_job_title() {
        let title = |key: &str| if key == "work.title" { Lookup::Plain("Senior Product Designer".into()) } else { Lookup::Missing };
        let mut form = planned(sign_up("कार्य स्थिति: मैं अनुभवी हूँ", "कार्य स्थिति: मैं फ्रेशर हूँ"), vec![], title, &Given::default());
        let mut w = sign_up_boxes();
        form.put(&mut w, |_, _, _, _| {}, || false).unwrap();
        let rows = form.questions();
        let status = question(&rows, "कार्य स्थिति");
        assert_eq!((status.state, status.from.as_str(), status.field), (State::Filled, "job title", 4));
    }

    #[test]
    fn with_no_work_details_the_work_status_is_left_for_the_user() {
        let form = planned(naukri(), vec![], ravi, &Given::default());
        assert_eq!(form.todo(), 0);
        assert_eq!(question(&form.questions(), "Work status").state, State::NeedsYou);
        let off = planned(naukri(), vec![], |_| Lookup::Off, &Given::default());
        assert_eq!(off.todo(), 0, "Your details off in Settings");
    }

    #[test]
    fn the_users_own_choice_and_the_ais_answer_win_over_the_rule() {
        let mut picked = naukri();
        picked[5].value = "true".into();
        let form = planned(picked, vec![], working, &Given::default());
        assert_eq!(form.todo(), 0, "the user picked fresher already");
        let status = question(&form.questions(), "Work status").clone();
        assert_eq!((status.state, status.value.as_str(), status.field), (State::Kept, "I'm a fresher", 5));

        let said = Given { said: "I'm a fresher".into(), ..Given::default() };
        let mut form = planned(naukri(), vec![text(5, "yes", Source::Said, "")], working, &said);
        let mut w = sign_up_boxes();
        form.put(&mut w, |_, _, _, _| {}, || false).unwrap();
        assert_eq!(w.calls, ["tick 5"], "what the AI answered from the user's words");
    }

    #[test]
    fn a_box_the_ai_named_a_key_for_keeps_it_when_your_details_has_nothing() {
        let form = planned(naukri(), vec![profile(1, "work.email"), profile(0, "name")], ravi, &Given::default());
        assert_eq!((form.rows[1].state, form.rows[1].key.as_deref()), (State::NeedsYou, Some("work.email")));
        assert_eq!(form.rows[0].key, None);
    }

    #[test]
    fn an_answer_typed_on_the_island_goes_in_marked_typed_and_can_be_undone() {
        let mut form = planned(naukri(), vec![profile(0, "name")], ravi, &Given::default());
        let mut w = sign_up_boxes();
        form.put(&mut w, |_, _, _, _| {}, || false).unwrap();
        form.answer(&mut w, 1, "  ravi.sharma84@gmail.com ").unwrap();
        assert_eq!(w.boxes[1].value, "ravi.sharma84@gmail.com");
        assert_eq!((form.rows[1].state, form.rows[1].origin, form.rows[1].value.as_str()), (State::Filled, Some(Origin::Typed), "ravi.sharma84@gmail.com"));
        assert_eq!(serde_json::to_value(Origin::Typed).unwrap(), "typed");
        assert_eq!(form.undo_one(&mut w, 1), Some(Undone::PutBack));
        assert_eq!(w.boxes[1].value, "");
    }

    #[test]
    fn a_choice_answered_on_the_island_picks_that_one() {
        let mut form = planned(naukri(), vec![], ravi, &Given::default());
        let mut w = sign_up_boxes();
        form.answer(&mut w, 5, "yes").unwrap();
        assert_eq!(w.calls, ["tick 5"]);
        let status = question(&form.questions(), "Work status").clone();
        assert_eq!((status.state, status.origin, status.value.as_str()), (State::Filled, Some(Origin::Typed), "I'm a fresher"));
        assert_eq!(form.answer(&mut w, 4, "yes"), Err("That box does not need you now.".into()), "one answer for one question");
    }

    #[test]
    fn the_island_never_answers_for_a_box_that_is_yours_or_one_already_filled() {
        let mut form = planned(naukri(), vec![profile(0, "name")], ravi, &Given::default());
        let mut w = sign_up_boxes();
        form.put(&mut w, |_, _, _, _| {}, || false).unwrap();
        w.calls.clear();
        assert_eq!(form.answer(&mut w, 2, "hunter2"), Err("Password boxes are yours to fill.".into()));
        assert_eq!(form.answer(&mut w, 0, "Someone Else"), Err("That box does not need you now.".into()));
        assert_eq!(form.answer(&mut w, 1, "   "), Err("Type something first.".into()));
        assert_eq!(form.answer(&mut w, 1, &"a".repeat(MAX_TEXT + 1)), Err("That is too long for this box.".into()));
        assert!(w.calls.is_empty(), "nothing was written: {:?}", w.calls);
    }

    #[test]
    fn boxes_the_user_fills_on_the_page_need_them_no_more() {
        let mut form = planned(naukri(), vec![profile(0, "name"), profile(3, "phone")], ravi, &Given::default());
        let mut w = sign_up_boxes();
        form.put(&mut w, |_, _, _, _| {}, || false).unwrap();
        w.focus = None;
        assert!(!form.noticed(&mut w), "the first look only sees how they are");
        w.boxes[1].value = "ravi@example.com".into();
        assert!(form.noticed(&mut w));
        assert_eq!((form.rows[1].state, form.rows[1].value.as_str()), (State::ByYou, ""), "what the user typed is not kept");

        // The password is never read: being in it and leaving is enough.
        w.focus = Some(2);
        assert!(!form.noticed(&mut w));
        assert_eq!(form.rows[2].state, State::Yours, "still in it");
        w.focus = None;
        assert!(form.noticed(&mut w));
        assert_eq!(form.rows[2].state, State::ByYou);

        w.boxes[5].value = "true".into();
        assert!(form.noticed(&mut w));
        let status = question(&form.questions(), "Work status").clone();
        assert_eq!((status.state, status.value.as_str()), (State::ByYou, "I'm a fresher"));
        assert_eq!(form.need_you(), 0);
        assert!(!form.noticed(&mut w), "nothing more changed");
    }
}
