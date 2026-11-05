//! Claude Code sessions at work right now, found without changing anything. Claude Code keeps a
//! small record for each running session, and its transcript says what it is doing. That is
//! enough to show a session on the island, including one started before this app or with following
//! turned off. Answering one needs the hooks in `watch`, which a running session does not pick up.
//!
//! These files are Claude Code's own and not a promised format, so anything unexpected only means
//! a session is not shown. Only records named for a process are read, never the key files beside
//! them. Runs started by tools are skipped, and that includes this app's own.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde_json::Value;

use crate::claude::tool_label;
use crate::watch;

/// Enough of the end of a transcript to find the last tool. They reach tens of megabytes.
const TAIL_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Running {
    /// The Claude Code process, which the record is named for.
    pub pid: u32,
    pub session: String,
    pub cwd: String,
    pub title: Option<String>,
    pub activity: Option<String>,
}

/// Claude Code names a project's folder after its path.
fn project_folder(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

fn tail(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(size.saturating_sub(TAIL_BYTES))).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// The tool in use, from the end of a transcript. A new prompt means none has started yet.
fn last_tool(transcript: &str) -> Option<String> {
    for line in transcript.lines().rev() {
        let Ok(record) = serde_json::from_str::<Value>(line) else { continue };
        let content = &record["message"]["content"];
        if record["type"] == "user" && content.is_string() {
            return None;
        }
        if record["type"] != "assistant" {
            continue;
        }
        let blocks = content.as_array().into_iter().flatten().rev();
        if let Some(tool) = blocks.into_iter().find(|block| block["type"] == "tool_use") {
            return Some(tool_label(tool["name"].as_str()?, &tool["input"]));
        }
    }
    None
}

/// Each live process's record, with its process id. Only a `<pid>.json` is opened, never a key.
fn records(claude_dir: &Path, alive: impl Fn(u32) -> bool) -> impl Iterator<Item = (u32, Value)> {
    let entries = fs::read_dir(claude_dir.join("sessions")).into_iter().flatten().flatten();
    entries.filter_map(move |entry| {
        let record = entry.path();
        let pid = record.file_stem()?.to_str()?.parse().ok()?;
        if record.extension()? != "json" || !alive(pid) {
            return None;
        }
        Some((pid, serde_json::from_slice(&fs::read(&record).ok()?).ok()?))
    })
}

fn read(pid: u32, session: &Value, claude_dir: &Path) -> Option<Running> {
    if session["entrypoint"].as_str()?.starts_with("sdk") || session["status"].as_str()? == "idle" {
        return None;
    }
    let (id, cwd) = (session["sessionId"].as_str()?, session["cwd"].as_str()?);
    let transcript = claude_dir.join("projects").join(project_folder(cwd)).join(format!("{id}.jsonl"));
    Some(Running {
        pid,
        session: watch::session_id(id),
        cwd: cwd.to_string(),
        title: session["name"].as_str().map(str::to_string),
        activity: tail(&transcript).as_deref().and_then(last_tool),
    })
}

/// Every session busy right now. `alive` is asked about each process, because a record can
/// outlive a crash, and a dead session must not sit on the island.
pub fn busy(claude_dir: &Path, alive: impl Fn(u32) -> bool) -> Vec<Running> {
    records(claude_dir, alive).filter_map(|(pid, session)| read(pid, &session, claude_dir)).collect()
}

/// The process behind a session the interface shows, as `watch::session_id` names it. Idle
/// counts: a session waiting for its next prompt is still open in its terminal.
pub fn pid_of(claude_dir: &Path, session: &str, alive: impl Fn(u32) -> bool) -> Option<u32> {
    let mut found = records(claude_dir, alive);
    found.find(|(_, record)| record["sessionId"].as_str().is_some_and(|id| watch::session_id(id) == session)).map(|(pid, _)| pid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Claude(std::path::PathBuf);

    impl Claude {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("meridian-running-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(dir.join("sessions")).unwrap();
            Self(dir)
        }

        fn session(&self, pid: u32, record: Value) {
            fs::write(self.0.join("sessions").join(format!("{pid}.json")), record.to_string()).unwrap();
        }

        fn transcript(&self, cwd: &str, id: &str, lines: &[Value]) {
            let folder = self.0.join("projects").join(project_folder(cwd));
            fs::create_dir_all(&folder).unwrap();
            let text = lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
            fs::write(folder.join(format!("{id}.jsonl")), text).unwrap();
        }
    }

    impl Drop for Claude {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn record(id: &str, status: &str, entrypoint: &str) -> Value {
        json!({ "sessionId": id, "cwd": "G:\\Work\\shop", "status": status, "entrypoint": entrypoint, "name": "Fix the cart" })
    }

    #[test]
    fn a_busy_session_shows_what_it_is_doing() {
        let claude = Claude::new("busy");
        claude.session(10, record("a", "busy", "cli"));
        claude.transcript("G:\\Work\\shop", "a", &[
            json!({ "type": "user", "message": { "content": "fix it" } }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "name": "Edit", "input": { "file_path": "src/cart.ts" } }] } }),
            json!({ "type": "user", "message": { "content": [{ "type": "tool_result" }] } }),
            json!({ "type": "mode" }),
        ]);
        let found = busy(&claude.0, |_| true);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].pid, 10);
        assert_eq!(found[0].session, "watch:a");
        assert_eq!(found[0].cwd, "G:\\Work\\shop");
        assert_eq!(found[0].title.as_deref(), Some("Fix the cart"));
        assert_eq!(found[0].activity.as_deref(), Some("Editing src/cart.ts"));
    }

    #[test]
    fn a_new_prompt_has_no_tool_yet() {
        let lines = [
            json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "name": "Read", "input": {} }] } }),
            json!({ "type": "user", "message": { "content": "and now this" } }),
        ];
        let text = lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        assert_eq!(last_tool(&text), None);
    }

    #[test]
    fn only_a_live_session_at_work_counts() {
        let claude = Claude::new("filter");
        claude.session(1, record("idle", "idle", "cli"));
        claude.session(2, record("tool", "busy", "sdk-cli"));
        claude.session(3, record("gone", "busy", "cli"));
        claude.session(4, record("here", "busy", "claude-vscode"));
        let found = busy(&claude.0, |pid| pid != 3);
        assert_eq!(found.iter().map(|r| r.session.as_str()).collect::<Vec<_>>(), ["watch:here"]);
    }

    #[test]
    fn anything_unexpected_only_means_it_is_not_shown() {
        let claude = Claude::new("odd");
        let sessions = claude.0.join("sessions");
        fs::write(sessions.join("7.json"), "not json").unwrap();
        fs::write(sessions.join("8.json"), "{}").unwrap();
        fs::write(sessions.join("notes.json"), record("x", "busy", "cli").to_string()).unwrap();
        // The key beside a record is never opened, or even parsed as a name.
        fs::write(sessions.join("9.abcdef.key"), "secret").unwrap();
        assert!(busy(&claude.0, |_| true).is_empty());
        assert!(busy(Path::new("Z:\\nowhere"), |_| true).is_empty());
    }

    #[test]
    fn a_session_is_traced_to_its_live_process_even_when_idle() {
        let claude = Claude::new("pid");
        claude.session(21, record("old", "busy", "cli"));
        // A crash leaves a record behind, and the same session can be resumed in a new process.
        claude.session(22, record("calm", "idle", "cli"));
        claude.session(23, record("calm", "idle", "cli"));
        fs::write(claude.0.join("sessions").join("24.abcdef.key"), "secret").unwrap();
        let alive = |pid| pid != 22;
        assert_eq!(pid_of(&claude.0, "watch:calm", alive), Some(23));
        assert_eq!(pid_of(&claude.0, "watch:old", alive), Some(21));
        assert_eq!(pid_of(&claude.0, "calm", alive), None, "only the interface's name is looked up");
        assert_eq!(pid_of(&claude.0, "watch:gone", alive), None);
        assert_eq!(pid_of(Path::new("Z:\\nowhere"), "watch:calm", alive), None);
    }

    #[test]
    fn a_session_with_no_transcript_yet_still_shows() {
        let claude = Claude::new("fresh");
        claude.session(5, record("new", "busy", "cli"));
        assert_eq!(busy(&claude.0, |_| true)[0].activity, None);
    }
}
