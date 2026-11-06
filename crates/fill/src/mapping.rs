//! The AI's answer for a form: for each box, a key into Your details, a text with
//! where it came from, or "leave it". The AI proposes; [`check`] decides what may be
//! written, and Meridian looks up profile values itself, so the AI never sees them.
//!
//! ```json
//! {"fills": [
//!   {"field": 2, "use": "profile", "key": "phone"},
//!   {"field": 5, "use": "text", "text": "60 days", "source": "knowledge", "from": "Job search"},
//!   {"field": 8, "use": "text", "text": "I have spent four years…", "source": "written-by-ai"},
//!   {"field": 6, "use": "leave", "reason": "Not in Your details or Knowledge"}
//! ]}
//! ```

use serde::{Deserialize, Serialize};

use crate::model::{Field, FieldKind};
use crate::policy::{refusal, Refusal};
use crate::write::yes_no;

/// Your details keys that hold ID numbers. Off by default, kept in Credential
/// Manager, and used only when the user allowed them for this fill.
pub const ID_KEYS: &[&str] = &["pan", "aadhaar", "passport"];

/// The longest text one box takes from the AI.
pub const MAX_TEXT: usize = 5_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mapping {
    pub fills: Vec<Fill>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fill {
    pub field: u32,
    #[serde(flatten)]
    pub answer: Answer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "use", rename_all = "lowercase")]
pub enum Answer {
    /// A key into Your details, such as `phone`, `name.en` or `address.city`.
    Profile { key: String },
    /// Text the AI found or wrote. `from` names the page, mail or file, for the Show list.
    Text {
        text: String,
        source: Source,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        from: String,
    },
    /// Left empty. The reason is shown to the user.
    Leave {
        #[serde(default)]
        reason: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    Knowledge,
    Mail,
    Notes,
    File,
    Page,
    Said,
    WrittenByAi,
}

/// Why one answer was not kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Problem {
    UnknownField,
    Twice,
    Hidden,
    Refused(Refusal),
    /// An ID number the user did not allow for this fill.
    IdNumber,
    BadKey,
    /// A tick box takes yes or no.
    NotYesNo,
    /// Written by AI, in a box that wants a fact.
    MadeUp,
    TooLong,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Checked {
    /// In the AI's order. Leave answers are kept, so the reasons can be shown.
    pub fills: Vec<Fill>,
    pub problems: Vec<(u32, Problem)>,
}

/// The first part of a key names what it is: `pan`, `passport.expiry`.
fn root(key: &str) -> &str {
    key.split('.').next().unwrap_or_default()
}

pub fn is_id_key(key: &str) -> bool {
    ID_KEYS.contains(&root(key))
}

fn good_key(key: &str) -> bool {
    key.len() <= 64
        && key.starts_with(|c: char| c.is_ascii_lowercase())
        && !key.ends_with('.')
        && !key.contains("..")
        && key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.')
}

/// Keeps the answers Meridian may write and lists the rest. `allowed_ids` are the ID
/// keys the user said yes to for this fill, such as `["pan"]`; usually none.
pub fn check(mapping: Mapping, fields: &[Field], allowed_ids: &[&str]) -> Checked {
    let mut checked = Checked::default();
    let mut seen = Vec::new();
    for fill in mapping.fills {
        let problem = problem(&fill, fields, allowed_ids, &seen);
        seen.push(fill.field);
        match problem {
            Some(problem) => checked.problems.push((fill.field, problem)),
            None => checked.fills.push(fill),
        }
    }
    checked
}

fn problem(fill: &Fill, fields: &[Field], allowed_ids: &[&str], seen: &[u32]) -> Option<Problem> {
    let Some(field) = fields.iter().find(|field| field.id == fill.field) else {
        return Some(Problem::UnknownField);
    };
    if seen.contains(&fill.field) {
        return Some(Problem::Twice);
    }
    if matches!(fill.answer, Answer::Leave { .. }) {
        return None;
    }
    if !field.visible {
        return Some(Problem::Hidden);
    }
    if let Some(refusal) = refusal(field) {
        return Some(Problem::Refused(refusal));
    }
    let tick = matches!(field.kind, FieldKind::Checkbox | FieldKind::Radio);
    match &fill.answer {
        Answer::Profile { key } if !good_key(key) => Some(Problem::BadKey),
        Answer::Profile { key } if is_id_key(key) && !allowed_ids.contains(&root(key)) => Some(Problem::IdNumber),
        Answer::Text { text, .. } if text.chars().count() > MAX_TEXT => Some(Problem::TooLong),
        Answer::Text { text, .. } if tick && yes_no(text).is_none() => Some(Problem::NotYesNo),
        // ponytail: free-text answers go only in long-answer boxes, so the AI cannot
        // make up a name or a number for a one-line box. Relax per kind if it is too strict.
        Answer::Text { source: Source::WrittenByAi, .. }
            if !matches!(field.kind, FieldKind::MultiLine | FieldKind::RichText) =>
        {
            Some(Problem::MadeUp)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::field;

    fn form() -> Vec<Field> {
        let mut hidden = field(5, "Fax", FieldKind::PlainText);
        hidden.visible = false;
        vec![
            field(0, "Full name", FieldKind::PlainText),
            field(1, "Phone", FieldKind::Phone),
            field(2, "Create a password", FieldKind::Password),
            field(3, "Why do you want to join?", FieldKind::MultiLine),
            field(4, "I agree to the privacy policy", FieldKind::Checkbox),
            hidden,
            field(6, "Same as billing address", FieldKind::Checkbox),
            field(7, "PAN", FieldKind::PlainText),
        ]
    }

    fn one(answer: Answer, field: u32) -> Mapping {
        Mapping { fills: vec![Fill { field, answer }] }
    }

    fn text(text: &str, source: Source) -> Answer {
        Answer::Text { text: text.into(), source, from: String::new() }
    }

    fn profile(key: &str) -> Answer {
        Answer::Profile { key: key.into() }
    }

    #[test]
    fn the_ai_shape_parses() {
        let json = r#"{"fills": [
            {"field": 1, "use": "profile", "key": "phone"},
            {"field": 3, "use": "text", "text": "Because", "source": "written-by-ai"},
            {"field": 0, "use": "text", "text": "Ravi", "source": "said"},
            {"field": 6, "use": "leave"}
        ]}"#;
        let mapping: Mapping = serde_json::from_str(json).unwrap();
        assert_eq!(mapping.fills[0].answer, profile("phone"));
        assert_eq!(mapping.fills[1].answer, text("Because", Source::WrittenByAi));
        assert_eq!(mapping.fills[3].answer, Answer::Leave { reason: String::new() });
        let checked = check(mapping, &form(), &[]);
        assert_eq!(checked.fills.len(), 4);
        assert!(checked.problems.is_empty());
    }

    #[test]
    fn an_unknown_source_is_a_parse_error() {
        let json = r#"{"fills": [{"field": 0, "use": "text", "text": "x", "source": "guess"}]}"#;
        assert!(serde_json::from_str::<Mapping>(json).is_err());
    }

    #[test]
    fn answers_for_boxes_meridian_never_fills_are_refused() {
        let password = check(one(text("hunter2", Source::Said), 2), &form(), &[]);
        assert_eq!(password.problems, vec![(2, Problem::Refused(Refusal::Password))]);
        let consent = check(one(text("yes", Source::Said), 4), &form(), &[]);
        assert_eq!(consent.problems, vec![(4, Problem::Refused(Refusal::Consent))]);
        assert!(consent.fills.is_empty());
    }

    #[test]
    fn unknown_hidden_and_repeated_boxes_are_refused() {
        let mapping = Mapping {
            fills: vec![
                Fill { field: 99, answer: profile("phone") },
                Fill { field: 5, answer: profile("phone") },
                Fill { field: 0, answer: profile("name.en") },
                Fill { field: 0, answer: profile("name.hi") },
            ],
        };
        let checked = check(mapping, &form(), &[]);
        assert_eq!(checked.problems, vec![(99, Problem::UnknownField), (5, Problem::Hidden), (0, Problem::Twice)]);
        assert_eq!(checked.fills, vec![Fill { field: 0, answer: profile("name.en") }]);
    }

    #[test]
    fn id_numbers_need_a_yes_for_this_fill() {
        assert_eq!(check(one(profile("pan"), 7), &form(), &[]).problems, vec![(7, Problem::IdNumber)]);
        assert_eq!(check(one(profile("passport.number"), 7), &form(), &["pan"]).problems, vec![(7, Problem::IdNumber)]);
        assert!(check(one(profile("pan"), 7), &form(), &["pan"]).problems.is_empty());
    }

    #[test]
    fn profile_keys_must_look_like_keys() {
        let long = "x".repeat(65);
        for key in ["", "Phone", "phone number", "a..b", "phone.", "../secrets", long.as_str()] {
            assert_eq!(check(one(profile(key), 1), &form(), &[]).problems, vec![(1, Problem::BadKey)], "{key}");
        }
        assert!(check(one(profile("address.line_1"), 0), &form(), &[]).problems.is_empty());
    }

    #[test]
    fn written_by_ai_goes_only_in_long_answer_boxes() {
        let made_up = check(one(text("+91 90000 00000", Source::WrittenByAi), 1), &form(), &[]);
        assert_eq!(made_up.problems, vec![(1, Problem::MadeUp)]);
        assert!(check(one(text("I like UPI.", Source::WrittenByAi), 3), &form(), &[]).problems.is_empty());
    }

    #[test]
    fn a_tick_box_takes_yes_or_no() {
        assert_eq!(check(one(text("maybe", Source::Page), 6), &form(), &[]).problems, vec![(6, Problem::NotYesNo)]);
        assert!(check(one(text("yes", Source::Page), 6), &form(), &[]).problems.is_empty());
    }

    #[test]
    fn a_very_long_text_is_refused() {
        let long = "a".repeat(MAX_TEXT + 1);
        assert_eq!(check(one(text(&long, Source::WrittenByAi), 3), &form(), &[]).problems, vec![(3, Problem::TooLong)]);
    }

    #[test]
    fn leaving_a_box_is_always_fine() {
        let leave = Answer::Leave { reason: "Yours to fill".into() };
        assert!(check(one(leave, 2), &form(), &[]).problems.is_empty());
    }
}
