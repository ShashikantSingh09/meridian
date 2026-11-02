//! Turns timed words from the two recordings into lines and people. The microphone is you, and the
//! PC's sound is everyone else, told apart by the speakers the hearing service marks.

use std::collections::{HashMap, HashSet};

use crate::{new_id, Line, Speaker};

/// The speaker who is always you.
pub const ME: &str = "me";
/// Who a word goes to when the service marks no speaker on the PC's sound.
const OTHERS: &str = "others";
/// A silence this long starts a new line.
const PAUSE_SECONDS: f64 = 1.4;
/// A line never runs longer, so the transcript stays easy to read.
const LONGEST_LINE_SECONDS: f64 = 40.0;
/// Fewer words than this on the PC's sound is not a call.
const CALL_WORDS: usize = 5;
/// Without headphones the others come back through the microphone. A line of yours is taken for
/// that echo when this share of its words were said by them at the same moment.
const ECHO_SHARE: f64 = 0.6;
const ECHO_NEAR_SECONDS: f64 = 1.5;
const ECHO_NEAR_ONE_WORD_SECONDS: f64 = 0.8;

/// A word and when it was said. `speaker` is only set when the service was asked to tell people apart.
#[derive(Debug, Clone, PartialEq)]
pub struct Word {
    pub text: String,
    pub start: f64,
    pub end: f64,
    pub speaker: Option<String>,
}

fn lines_of(words: &[Word], who: impl Fn(&Word) -> String) -> Vec<Line> {
    let mut lines: Vec<Line> = Vec::new();
    for word in words {
        let speaker = who(word);
        match lines.last_mut() {
            Some(last) if last.speaker == speaker && word.start - last.end < PAUSE_SECONDS && word.end - last.start < LONGEST_LINE_SECONDS => {
                last.text.push(' ');
                last.text.push_str(&word.text);
                last.end = word.end;
            }
            _ => lines.push(Line { id: new_id(), speaker, start: word.start, end: word.end, text: word.text.clone() }),
        }
    }
    lines
}

fn plain_words(text: &str) -> Vec<String> {
    text.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|word| !word.is_empty()).map(String::from).collect()
}

fn is_echo(line: &Line, others: &[Line]) -> bool {
    let words = plain_words(&line.text);
    let margin = if words.len() < 2 { ECHO_NEAR_ONE_WORD_SECONDS } else { ECHO_NEAR_SECONDS };
    let heard: HashSet<String> = others.iter().filter(|other| other.start < line.end + margin && line.start < other.end + margin).flat_map(|other| plain_words(&other.text)).collect();
    let shared = words.iter().filter(|word| heard.contains(*word)).count();
    !words.is_empty() && shared as f64 / words.len() as f64 >= ECHO_SHARE
}

fn by_time(lines: &mut [Line]) {
    lines.sort_by(|a, b| a.start.total_cmp(&b.start));
}

/// Gives each voice the service marked its own number, in the order they first speak.
fn number_people(lines: &mut [Line], speakers: &mut Vec<Speaker>, first: usize) {
    let mut ids: HashMap<String, String> = HashMap::new();
    for line in lines.iter_mut().filter(|line| line.speaker != ME) {
        let next = first + ids.len();
        let id = ids.entry(line.speaker.clone()).or_insert_with(|| {
            let id = format!("p{next}");
            speakers.push(Speaker { id: id.clone(), name: format!("Person {next}"), color: next - 1, you: false });
            id
        });
        line.speaker = id.clone();
    }
}

/// You on the microphone, and everyone else on the PC's sound.
fn call(mine: &[Word], theirs: &[Word], you: &str) -> (Vec<Speaker>, Vec<Line>) {
    let my_lines = lines_of(mine, |_| ME.to_string());
    let their_lines = lines_of(theirs, |word| word.speaker.clone().unwrap_or_else(|| OTHERS.to_string()));
    let mut lines: Vec<Line> = my_lines.iter().filter(|line| !is_echo(line, &their_lines)).cloned().collect();
    lines.extend(their_lines);
    by_time(&mut lines);
    let mut speakers = Vec::new();
    if !my_lines.is_empty() || theirs.is_empty() {
        speakers.push(Speaker { id: ME.to_string(), name: you.to_string(), color: 0, you: true });
    }
    number_people(&mut lines, &mut speakers, 2);
    (speakers, lines)
}

/// People round one PC: one recording, and nobody can be known to be you.
fn room(mine: &[Word]) -> (Vec<Speaker>, Vec<Line>) {
    let mut lines = lines_of(mine, |word| word.speaker.clone().unwrap_or_else(|| OTHERS.to_string()));
    let mut speakers = Vec::new();
    number_people(&mut lines, &mut speakers, 1);
    (speakers, lines)
}

/// The speakers and lines of a call, in time order, from the words of each recording.
pub fn build(mine: &[Word], theirs: &[Word], you: &str) -> (Vec<Speaker>, Vec<Line>) {
    let voices: HashSet<&str> = mine.iter().filter_map(|word| word.speaker.as_deref()).collect();
    if theirs.len() < CALL_WORDS && voices.len() > 1 {
        room(mine)
    } else {
        call(mine, theirs, you)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(text: &str, start: f64, end: f64) -> Word {
        Word { text: text.into(), start, end, speaker: None }
    }

    fn said_by(speaker: &str, text: &str, start: f64, end: f64) -> Word {
        Word { speaker: Some(speaker.into()), ..word(text, start, end) }
    }

    fn texts(lines: &[Line]) -> Vec<&str> {
        lines.iter().map(|line| line.text.as_str()).collect()
    }

    #[test]
    fn a_pause_or_a_new_voice_starts_a_new_line() {
        let words = [word("good", 0.0, 0.4), word("morning", 0.5, 0.9), word("everyone", 1.0, 1.4), word("so", 3.0, 3.2)];
        let lines = lines_of(&words, |_| ME.to_string());
        assert_eq!(texts(&lines), ["good morning everyone", "so"]);
        assert_eq!((lines[0].start, lines[0].end), (0.0, 1.4));
        let words = [said_by("a", "hello", 0.0, 0.4), said_by("b", "hi", 0.5, 0.7)];
        assert_eq!(lines_of(&words, |w| w.speaker.clone().unwrap()).len(), 2);
    }

    #[test]
    fn a_line_stops_growing_at_forty_seconds() {
        let words: Vec<Word> = (0..50).map(|i| word("yes", f64::from(i), f64::from(i) + 0.9)).collect();
        let lines = lines_of(&words, |_| ME.to_string());
        assert_eq!(lines.len(), 2);
        assert!(lines.iter().all(|line| line.end - line.start < 40.0));
    }

    #[test]
    fn a_call_is_you_then_the_people_in_the_order_they_speak() {
        let mine = [word("hello", 0.0, 0.5)];
        let theirs = [said_by("speaker_1", "hi", 2.0, 2.3), said_by("speaker_1", "there", 2.4, 2.7), said_by("speaker_0", "hey", 6.0, 6.3), said_by("speaker_0", "all", 6.4, 6.6), said_by("speaker_1", "good", 9.0, 9.3)];
        let (speakers, lines) = build(&mine, &theirs, "You");
        let names: Vec<&str> = speakers.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["You", "Person 2", "Person 3"]);
        assert!(speakers[0].you);
        assert_eq!(speakers.iter().map(|s| s.color).collect::<Vec<_>>(), [0, 1, 2]);
        assert_eq!(lines.iter().map(|l| l.speaker.as_str()).collect::<Vec<_>>(), ["me", "p2", "p3", "p2"]);
        assert_eq!(texts(&lines), ["hello", "hi there", "hey all", "good"]);
    }

    #[test]
    fn lines_are_in_time_order_across_both_recordings() {
        let mine = [word("second", 5.0, 5.4)];
        let theirs: Vec<Word> = ["one", "two", "three", "four", "five"].iter().enumerate().map(|(i, text)| said_by("a", text, i as f64, i as f64 + 0.5)).chain([said_by("a", "third", 9.0, 9.4)]).collect();
        let (_, lines) = build(&mine, &theirs, "You");
        assert!(lines.windows(2).all(|pair| pair[0].start <= pair[1].start));
        assert_eq!(lines[1].text, "second");
    }

    #[test]
    fn the_others_coming_back_through_the_microphone_are_dropped() {
        let mine = [word("see", 1.0, 1.2), word("you", 1.3, 1.5), word("tomorrow", 1.6, 2.0), word("okay", 10.0, 10.3)];
        let theirs = [said_by("a", "see", 1.05, 1.25), said_by("a", "you", 1.35, 1.55), said_by("a", "tomorrow", 1.65, 2.05), said_by("a", "then", 2.1, 2.3), said_by("a", "bye", 2.4, 2.6)];
        let (_, lines) = build(&mine, &theirs, "You");
        assert_eq!(lines.iter().filter(|line| line.speaker == ME).map(|line| line.text.as_str()).collect::<Vec<_>>(), ["okay"]);
    }

    #[test]
    fn the_same_words_said_later_are_not_an_echo() {
        let mine = [word("see", 30.0, 30.2), word("you", 30.3, 30.5), word("tomorrow", 30.6, 31.0)];
        let theirs: Vec<Word> = ["see", "you", "tomorrow", "okay", "bye"].iter().enumerate().map(|(i, text)| said_by("a", text, i as f64, i as f64 + 0.5)).collect();
        let (_, lines) = build(&mine, &theirs, "You");
        assert!(lines.iter().any(|line| line.speaker == ME));
    }

    #[test]
    fn hindi_counts_as_words_when_looking_for_an_echo() {
        let line = Line { id: "a".into(), speaker: ME.into(), start: 1.0, end: 2.0, text: "ठीक है".into() };
        let other = Line { id: "b".into(), speaker: "a".into(), start: 1.1, end: 2.1, text: "ठीक है।".into() };
        assert!(is_echo(&line, &[other]));
    }

    #[test]
    fn people_round_one_pc_are_numbered_from_one() {
        let mine = [said_by("x", "hello", 0.0, 0.5), said_by("y", "hi", 2.0, 2.3), said_by("x", "so", 5.0, 5.2)];
        let (speakers, lines) = build(&mine, &[], "You");
        assert_eq!(speakers.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["Person 1", "Person 2"]);
        assert!(speakers.iter().all(|s| !s.you));
        assert_eq!(lines.iter().map(|l| l.speaker.as_str()).collect::<Vec<_>>(), ["p1", "p2", "p1"]);
    }

    #[test]
    fn one_voice_alone_is_you() {
        let mine = [said_by("x", "a", 0.0, 0.5), said_by("x", "memo", 0.6, 1.0)];
        let (speakers, lines) = build(&mine, &[], "You");
        assert_eq!(speakers.len(), 1);
        assert!(speakers[0].you);
        assert_eq!(texts(&lines), ["a memo"]);
    }

    #[test]
    fn nobody_heard_is_no_lines_and_you_alone() {
        let (speakers, lines) = build(&[], &[], "You");
        assert!(lines.is_empty());
        assert_eq!(speakers.len(), 1);
    }

    #[test]
    fn only_listening_leaves_you_out() {
        let theirs: Vec<Word> = ["one", "two", "three", "four", "five"].iter().enumerate().map(|(i, text)| said_by("a", text, i as f64, i as f64 + 0.5)).collect();
        let (speakers, _) = build(&[], &theirs, "You");
        assert_eq!(speakers.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["Person 2"]);
    }

    #[test]
    fn a_service_that_marks_nobody_still_gives_one_other_person() {
        let theirs: Vec<Word> = ["one", "two", "three", "four", "five"].iter().enumerate().map(|(i, text)| word(text, i as f64, i as f64 + 0.5)).collect();
        let (speakers, lines) = build(&[word("yes", 9.0, 9.2)], &theirs, "You");
        assert_eq!(speakers.len(), 2);
        assert_eq!(lines[0].speaker, "p2");
    }
}
