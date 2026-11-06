//! Choices that are one question: the radio buttons of a group, which the reader names
//! "Work status: I'm experienced", "Work status: I'm a fresher". The island shows them as one row with
//! a button each, they take one answer and one write, and the outlines draw one box round them.
//!
//! And the one choice Your details can answer without the AI: a work status. When Your details has a
//! company or a job title, the user is working, so "I'm experienced" fits. Rust checks only that the
//! detail has a value; the value goes nowhere.

use crate::form::Lookup;
use crate::model::{has_any, words, Field, FieldKind};

/// The question and the choice's own words, from the reader's "Work status: I'm experienced".
// ponytail: split at the first ": ", so choices of one group always share their question even when a
// choice's own words hold a colon. A question that holds one ("Step 2: Work status") still groups, under "Step 2".
pub fn split(label: &str) -> Option<(&str, &str)> {
    let (question, choice) = label.split_once(": ")?;
    let (question, choice) = (question.trim(), choice.trim());
    (!question.is_empty() && !choice.is_empty()).then_some((question, choice))
}

/// The groups of choices on the form, as places in page order: radio buttons next to each other that
/// share a question, two or more of them. A lone radio button stays a box of its own.
pub fn groups(fields: &[Field]) -> Vec<Vec<usize>> {
    let question = |at: usize| if fields[at].kind == FieldKind::Radio { split(&fields[at].label).map(|(q, _)| q) } else { None };
    let mut groups: Vec<Vec<usize>> = Vec::new();
    for at in 0..fields.len() {
        let Some(asked) = question(at) else { continue };
        // The one before had a question too, so it is in the last group.
        match groups.last_mut() {
            Some(group) if at > 0 && question(at - 1) == Some(asked) => group.push(at),
            _ => groups.push(vec![at]),
        }
    }
    groups.retain(|group| group.len() > 1);
    groups
}

/// Words for the choice that means working now, and for the ones that mean not yet, in English and Hindi.
const WORKING: &[&str] = &["experienced", "working professional", "professional", "employed", "अनुभवी", "कार्यरत", "नौकरीपेशा"];
const NOT_YET: &[&str] = &["fresher", "student", "fresh graduate", "फ्रेशर", "फ्रेशर्स", "छात्र", "विद्यार्थी"];

/// The details that say the user is working, and how a tip names each.
pub const WORK_KEYS: &[(&str, &str)] = &[("work.company", "company"), ("work.title", "job title")];

/// For a work status question, the choice that means working, by its place among `choices`. Only when
/// exactly one choice says working and another says fresher or student, so "Are you experienced in
/// Rust? Yes / No" is never taken for one.
pub fn working(choices: &[&str]) -> Option<usize> {
    let said: Vec<String> = choices.iter().map(|choice| words(choice)).collect();
    let yes: Vec<usize> = (0..said.len()).filter(|&i| has_any(&said[i], WORKING) && !has_any(&said[i], NOT_YET)).collect();
    let not_yet = said.iter().any(|choice| has_any(choice, NOT_YET));
    (yes.len() == 1 && not_yet).then(|| yes[0])
}

/// Which detail says the user is working, named as a tip says it, or None. Only whether it has a value
/// is asked: the value itself is dropped here.
pub fn working_detail(details: impl Fn(&str) -> Lookup) -> Option<&'static str> {
    WORK_KEYS.iter().find(|(key, _)| matches!(details(key), Lookup::Plain(_))).map(|(_, name)| *name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::field;

    #[test]
    fn a_choice_label_splits_into_its_question_and_its_words() {
        assert_eq!(split("Work status: I'm experienced"), Some(("Work status", "I'm experienced")));
        assert_eq!(split("Notice: 30 days: or less"), Some(("Notice", "30 days: or less")));
        assert_eq!(split("I'm a fresher"), None);
        assert_eq!(split(": Yes"), None);
    }

    #[test]
    fn choices_next_to_each_other_with_one_question_are_one_group() {
        let fields = vec![
            field(0, "Full name", FieldKind::PlainText),
            field(1, "Work status: I'm experienced", FieldKind::Radio),
            field(2, "Work status: I'm a fresher", FieldKind::Radio),
            field(3, "Relocate: Yes", FieldKind::Radio),
            field(4, "Relocate: No", FieldKind::Radio),
            field(5, "Lone: Only", FieldKind::Radio),
            field(6, "Phone", FieldKind::Phone),
            field(7, "Relocate: Maybe", FieldKind::Radio),
            field(8, "Terms: Yes", FieldKind::Checkbox),
        ];
        assert_eq!(groups(&fields), vec![vec![1, 2], vec![3, 4]], "a lone choice, one apart from its group, and tick boxes stay boxes");
    }

    #[test]
    fn a_work_status_question_is_known_by_its_choices_in_english_and_hindi() {
        assert_eq!(working(&["I'm experienced", "I'm a fresher"]), Some(0));
        assert_eq!(working(&["Student", "Working professional"]), Some(1));
        assert_eq!(working(&["मैं फ्रेशर हूँ", "मैं अनुभवी हूँ"]), Some(1));
        assert_eq!(working(&["Yes", "No"]), None, "not a work status");
        assert_eq!(working(&["Experienced", "Very experienced", "Fresher"]), None, "two could be meant");
        assert_eq!(working(&["Experienced", "Not sure"]), None, "nothing to set it against");
    }

    #[test]
    fn only_whether_a_work_detail_has_a_value_is_asked() {
        let title_only = |key: &str| if key == "work.title" { Lookup::Plain("Senior Product Designer".into()) } else { Lookup::Missing };
        assert_eq!(working_detail(title_only), Some("job title"));
        assert_eq!(working_detail(|_| Lookup::Plain("Northwind".into())), Some("company"));
        assert_eq!(working_detail(|_| Lookup::Missing), None);
        assert_eq!(working_detail(|_| Lookup::Off), None);
    }
}
