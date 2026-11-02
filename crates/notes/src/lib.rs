//! Notes of a call: what was said, by whom, and what came of it. This crate knows nothing of audio,
//! services or the app, so all of it can be tested with plain values.
//!
//! Each note is `<folder>/<id>/note.json`. While a call is being written up its recordings sit
//! beside that file, and they are deleted once the transcript is safe.

mod summary;
mod transcript;

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub use summary::{apply_summary, summary_request, SUMMARY_INSTRUCTIONS};
pub use transcript::{build, Word, ME};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Recording,
    Writing,
    Ready,
    Failed,
}

/// Someone in a call. You are always `ME`. The others are numbered until the user names them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Speaker {
    pub id: String,
    pub name: String,
    /// A place in the interface's list of colours.
    pub color: usize,
    pub you: bool,
}

/// One turn of speech, with its times in seconds from the start of the recording.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Line {
    pub id: String,
    pub speaker: String,
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Todo {
    pub id: String,
    pub text: String,
    pub owner: Option<String>,
    pub due: Option<String>,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub title: String,
    /// Renamed by the user, so a summary keeps their title.
    pub title_edited: bool,
    /// Milliseconds since 1970.
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub status: Status,
    pub speakers: Vec<Speaker>,
    pub lines: Vec<Line>,
    pub summary: Option<String>,
    pub key_points: Vec<String>,
    pub todos: Vec<Todo>,
    /// Why it could not be written.
    pub error: Option<String>,
}

pub(crate) fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

impl Note {
    pub fn new(title: String, started_at: i64) -> Self {
        Self {
            id: new_id(),
            title,
            title_edited: false,
            started_at,
            ended_at: None,
            status: Status::Recording,
            speakers: Vec::new(),
            lines: Vec::new(),
            summary: None,
            key_points: Vec::new(),
            todos: Vec::new(),
            error: None,
        }
    }

    pub fn rename(&mut self, title: &str) {
        let title = title.trim();
        if !title.is_empty() {
            self.title = title.to_string();
            self.title_edited = true;
        }
    }

    /// Names someone. A name already in the call means one voice was split in two, so they join.
    pub fn rename_speaker(&mut self, id: &str, name: &str) {
        let name = name.trim();
        let Some(index) = self.speakers.iter().position(|speaker| speaker.id == id).filter(|_| !name.is_empty()) else { return };
        let same = self.speakers.iter().find(|other| other.id != id && !other.you && !self.speakers[index].you && other.name.eq_ignore_ascii_case(name)).map(|other| other.id.clone());
        match same {
            Some(other) => {
                self.lines.iter_mut().filter(|line| line.speaker == id).for_each(|line| line.speaker = other.clone());
                self.speakers.remove(index);
            }
            None => self.speakers[index].name = name.to_string(),
        }
    }

    pub fn toggle_todo(&mut self, id: &str) {
        if let Some(todo) = self.todos.iter_mut().find(|todo| todo.id == id) {
            todo.done = !todo.done;
        }
    }

    fn speaker_name<'a>(&'a self, id: &'a str) -> &'a str {
        self.speakers.iter().find(|speaker| speaker.id == id).map_or(id, |speaker| speaker.name.as_str())
    }

    /// The transcript as text, one "Name: words" to a line.
    pub fn transcript(&self) -> String {
        self.lines.iter().map(|line| format!("{}: {}", self.speaker_name(&line.speaker), line.text)).collect::<Vec<_>>().join("\n")
    }

    /// The whole note as Markdown. `when` is its date in the user's own words and time zone.
    pub fn markdown(&self, when: &str) -> String {
        let minutes = (self.ended_at.unwrap_or(self.started_at) - self.started_at).max(0) as f64 / 60_000.0;
        let mut out = format!("# {}\n\n_{when} · {} min_\n", self.title, (minutes.round() as u64).max(1));
        if !self.speakers.is_empty() {
            out += &format!("\n_{}_\n", self.speakers.iter().map(|s| s.name.as_str()).collect::<Vec<_>>().join(", "));
        }
        if let Some(summary) = self.summary.as_deref().filter(|text| !text.is_empty()) {
            out += &format!("\n## Summary\n\n{summary}\n");
        }
        if !self.key_points.is_empty() {
            out += &format!("\n## Key points\n\n{}\n", self.key_points.iter().map(|point| format!("- {point}")).collect::<Vec<_>>().join("\n"));
        }
        if !self.todos.is_empty() {
            let todos = self.todos.iter().map(|todo| {
                let extra = [todo.owner.as_deref(), todo.due.as_deref()].into_iter().flatten().collect::<Vec<_>>().join(", ");
                let mark = if todo.done { "x" } else { " " };
                if extra.is_empty() { format!("- [{mark}] {}", todo.text) } else { format!("- [{mark}] {} ({extra})", todo.text) }
            });
            out += &format!("\n## To do\n\n{}\n", todos.collect::<Vec<_>>().join("\n"));
        }
        if !self.lines.is_empty() {
            let lines = self.lines.iter().map(|line| format!("**{}** ({}): {}", self.speaker_name(&line.speaker), clock(line.start), line.text));
            out += &format!("\n## Transcript\n\n{}\n", lines.collect::<Vec<_>>().join("\n\n"));
        }
        out
    }
}

/// 75 seconds is 1:15, and 3725 is 1:02:05.
pub fn clock(seconds: f64) -> String {
    let whole = seconds.max(0.0) as u64;
    if whole >= 3600 {
        format!("{}:{:02}:{:02}", whole / 3600, whole / 60 % 60, whole % 60)
    } else {
        format!("{}:{:02}", whole / 60, whole % 60)
    }
}

/// One folder per note. Only ids from notes this store loaded or made ever reach a path.
pub struct Store {
    folder: PathBuf,
}

impl Store {
    pub fn new(folder: PathBuf) -> Self {
        Self { folder }
    }

    pub fn folder_of(&self, id: &str) -> PathBuf {
        self.folder.join(id)
    }

    /// Every note that can be read, newest first. One damaged file costs only that note.
    pub fn load(&self) -> Vec<Note> {
        let mut notes: Vec<Note> = fs::read_dir(&self.folder)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| serde_json::from_slice(&fs::read(entry.path().join("note.json")).ok()?).ok())
            .collect();
        notes.sort_by_key(|note| std::cmp::Reverse(note.started_at));
        notes
    }

    /// Written beside the old copy and swapped in, so a crash cannot leave half a note.
    pub fn save(&self, note: &Note) -> io::Result<()> {
        let folder = self.folder_of(&note.id);
        fs::create_dir_all(&folder)?;
        let temporary = folder.join("note.json.tmp");
        fs::write(&temporary, serde_json::to_vec_pretty(note)?)?;
        fs::rename(temporary, folder.join("note.json"))
    }

    pub fn remove(&self, id: &str) -> io::Result<()> {
        fs::remove_dir_all(self.folder_of(id))
    }

    /// Deletes the recordings of a note, once its transcript is safe.
    pub fn remove_audio(&self, id: &str) {
        for name in AUDIO {
            let _ = fs::remove_file(self.folder_of(id).join(name));
        }
    }

    pub fn has_audio(&self, id: &str) -> bool {
        AUDIO.iter().any(|name| Path::exists(&self.folder_of(id).join(name)))
    }
}

/// Raw 16-bit audio, so a recording cut short by a crash has no header left unfinished.
pub const MIC_FILE: &str = "mic.pcm";
pub const SYSTEM_FILE: &str = "system.pcm";
const AUDIO: [&str; 2] = [MIC_FILE, SYSTEM_FILE];

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn sample() -> Note {
        let mut note = Note::new("Launch".into(), 1_000);
        note.ended_at = Some(1_000 + 32 * 60_000);
        note.status = Status::Ready;
        note.speakers = vec![
            Speaker { id: ME.into(), name: "You".into(), color: 0, you: true },
            Speaker { id: "p2".into(), name: "Person 2".into(), color: 1, you: false },
            Speaker { id: "p3".into(), name: "Person 3".into(), color: 2, you: false },
        ];
        note.lines = vec![
            Line { id: "a".into(), speaker: ME.into(), start: 4.0, end: 6.0, text: "Is Friday okay?".into() },
            Line { id: "b".into(), speaker: "p2".into(), start: 75.0, end: 77.0, text: "Friday works.".into() },
            Line { id: "c".into(), speaker: "p3".into(), start: 3725.0, end: 3726.0, text: "Agreed.".into() },
        ];
        note
    }

    #[test]
    fn a_name_the_user_gives_sticks() {
        let mut note = sample();
        note.rename("  Launch date  ");
        assert_eq!(note.title, "Launch date");
        assert!(note.title_edited);
        note.rename("   ");
        assert_eq!(note.title, "Launch date", "an empty name changes nothing");
    }

    #[test]
    fn naming_someone_changes_only_their_name() {
        let mut note = sample();
        note.rename_speaker("p2", " Priya ");
        assert_eq!(note.speakers[1].name, "Priya");
        assert_eq!(note.lines[1].speaker, "p2");
        note.rename_speaker("p2", "  ");
        assert_eq!(note.speakers[1].name, "Priya");
    }

    #[test]
    fn a_name_already_in_the_call_joins_two_voices_into_one() {
        let mut note = sample();
        note.rename_speaker("p2", "Priya");
        note.rename_speaker("p3", "priya");
        assert_eq!(note.speakers.len(), 2);
        assert_eq!(note.lines[2].speaker, "p2");
    }

    #[test]
    fn you_never_join_someone_else() {
        let mut note = sample();
        note.rename_speaker("p2", "Sam");
        note.rename_speaker(ME, "Sam");
        assert_eq!(note.speakers.len(), 3);
        assert_eq!(note.speakers[0].name, "Sam");
        assert_eq!(note.lines[0].speaker, ME);
    }

    #[test]
    fn a_to_do_ticks_and_unticks() {
        let mut note = sample();
        note.todos = vec![Todo { id: "t".into(), text: "Send it".into(), owner: None, due: None, done: false }];
        note.toggle_todo("t");
        assert!(note.todos[0].done);
        note.toggle_todo("t");
        assert!(!note.todos[0].done);
        note.toggle_todo("nothing");
    }

    #[test]
    fn the_clock_reads_like_a_clock() {
        assert_eq!(clock(0.0), "0:00");
        assert_eq!(clock(75.0), "1:15");
        assert_eq!(clock(3725.0), "1:02:05");
        assert_eq!(clock(-3.0), "0:00");
    }

    #[test]
    fn markdown_has_everything_in_order_and_leaves_out_what_is_empty() {
        let mut note = sample();
        let bare = note.markdown("Monday 2 November");
        assert!(bare.starts_with("# Launch\n\n_Monday 2 November · 32 min_\n"));
        assert!(!bare.contains("## Summary"));
        assert!(!bare.contains("## To do"));
        note.summary = Some("It moves to Friday.".into());
        note.key_points = vec!["Friday".into()];
        note.todos = vec![
            Todo { id: "1".into(), text: "Tell the client".into(), owner: Some("You".into()), due: Some("today".into()), done: true },
            Todo { id: "2".into(), text: "Check the invoice".into(), owner: None, due: None, done: false },
        ];
        let full = note.markdown("Monday 2 November");
        let order = ["_You, Person 2, Person 3_", "## Summary", "## Key points", "- Friday", "## To do", "- [x] Tell the client (You, today)", "- [ ] Check the invoice\n", "## Transcript", "**Person 2** (1:15): Friday works."];
        let found: Vec<usize> = order.iter().map(|part| full.find(part).unwrap_or_else(|| panic!("{part}"))).collect();
        assert!(found.windows(2).all(|pair| pair[0] < pair[1]), "{found:?}");
    }

    fn temporary_store(name: &str) -> Store {
        let folder = std::env::temp_dir().join(format!("meridian-notes-test-{name}-{}", new_id()));
        Store::new(folder)
    }

    #[test]
    fn notes_survive_on_disk_newest_first() {
        let store = temporary_store("order");
        let (mut old, new) = (sample(), Note::new("New".into(), 9_000));
        old.title = "Old".into();
        store.save(&old).unwrap();
        store.save(&new).unwrap();
        let loaded = store.load();
        assert_eq!(loaded[0], new);
        assert_eq!(loaded[1], old);
        fs::remove_dir_all(&store.folder).unwrap();
    }

    #[test]
    fn a_damaged_note_costs_only_itself() {
        let store = temporary_store("damaged");
        let note = sample();
        store.save(&note).unwrap();
        let bad = store.folder.join("bad");
        fs::create_dir_all(&bad).unwrap();
        fs::write(bad.join("note.json"), "{ half a note").unwrap();
        assert_eq!(store.load(), vec![note]);
        fs::remove_dir_all(&store.folder).unwrap();
    }

    #[test]
    fn a_missing_folder_is_just_no_notes() {
        assert!(temporary_store("missing").load().is_empty());
    }

    #[test]
    fn recordings_go_and_the_note_stays() {
        let store = temporary_store("audio");
        let note = sample();
        store.save(&note).unwrap();
        fs::write(store.folder_of(&note.id).join(MIC_FILE), [0u8; 4]).unwrap();
        fs::write(store.folder_of(&note.id).join(SYSTEM_FILE), [0u8; 4]).unwrap();
        assert!(store.has_audio(&note.id));
        store.remove_audio(&note.id);
        assert!(!store.has_audio(&note.id));
        assert_eq!(store.load().len(), 1);
        store.remove(&note.id).unwrap();
        assert!(store.load().is_empty());
        fs::remove_dir_all(&store.folder).unwrap();
    }
}
