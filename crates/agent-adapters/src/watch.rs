//! Follows the user's own Claude Code sessions, whichever terminal they started
//! in. Opt-in hooks in their settings post here over loopback. This path makes
//! no model request and reads no credential, and it never works out where the
//! settings live: the path is always handed in.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::approvals::{decision_body, read_request, respond, READ_TIMEOUT};
use crate::claude::{code_change, command_output};
use crate::claude::tool_label;
use crate::{AgentEvent, Approval, Envelope, SessionStatus};

const EVENTS: [&str; 9] = [
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "Notification",
    "Stop",
    "StopFailure",
    "SessionEnd",
];
/// The URL path of every hook, and how ours are found again.
pub const HOOK_PATH: &str = "/meridian-hook";
const TOKEN_HEADER: &str = "X-Meridian-Token";
/// Set on every agent this app launches. Hooks in user settings fire for those
/// runs too, and they already have their own approvals and their own row, so
/// the hook echoes this variable back and the server steps aside.
pub(crate) const OWN_RUN_ENV: &str = "MERIDIAN_RUN";
const OWN_RUN_HEADER: &str = "X-Meridian-Run";
const SESSION_PREFIX: &str = "watch:";
const AGENT: &str = "Claude Code";

/// Written into the hook definition; the server gives up a little sooner so
/// Claude Code always hears from us.
const PERMISSION_TIMEOUT_SECS: u64 = 300;
const DECISION_WAIT: Duration = Duration::from_secs(PERMISSION_TIMEOUT_SECS - 5);
const HOOK_TIMEOUT_SECS: u64 = 5;
const MAX_BODY: usize = 4 << 20;
/// A killed terminal sends nothing, so silence is the only sign it has gone.
const STALE_AFTER: Duration = Duration::from_secs(30 * 60);
const SWEEP_EVERY: Duration = Duration::from_secs(60);
const STALE_MESSAGE: &str = "No word from this session";
const TITLE_CHARS: usize = 64;
const LABEL_CHARS: usize = 80;
const FAILURE_CHARS: usize = 300;

#[derive(Debug, thiserror::Error)]
pub enum WatchError {
    #[error("The Claude Code settings file is not valid JSON, so it was left as it is.")]
    InvalidJson,
    #[error("The Claude Code settings file has an unexpected layout, so it was left as it is.")]
    UnexpectedLayout,
    #[error("Could not update the Claude Code settings file: {0}")]
    Settings(#[from] std::io::Error),
    #[error("Could not listen for Claude Code: {0}")]
    Listen(std::io::Error),
}

/// True for a handler this module wrote. The whole path is compared, so a
/// stranger's URL that merely ends the same way is left alone.
fn ours(handler: &Value) -> bool {
    let rest = handler["url"].as_str().and_then(|url| url.split_once("://")).map(|(_, rest)| rest);
    let path = rest.and_then(|rest| rest.find('/').map(|slash| &rest[slash..]));
    handler["type"] == "http" && path == Some(HOOK_PATH)
}

/// Removes our handlers and whatever that leaves empty, and nothing else.
fn strip(settings: &mut Value) -> Result<(), WatchError> {
    let root = settings.as_object_mut().ok_or(WatchError::UnexpectedLayout)?;
    let Some(hooks) = root.get_mut("hooks") else { return Ok(()) };
    let hooks = hooks.as_object_mut().ok_or(WatchError::UnexpectedLayout)?;
    let mut emptied = Vec::new();
    for event in EVENTS {
        let Some(groups) = hooks.get_mut(event) else { continue };
        let groups = groups.as_array_mut().ok_or(WatchError::UnexpectedLayout)?;
        if groups.iter().any(|group| !group["hooks"].is_array()) {
            return Err(WatchError::UnexpectedLayout);
        }
        let before = groups.len();
        groups.retain_mut(|group| {
            let Some(handlers) = group["hooks"].as_array_mut() else { return true };
            let count = handlers.len();
            handlers.retain(|handler| !ours(handler));
            handlers.len() == count || !handlers.is_empty()
        });
        if before > 0 && groups.is_empty() {
            emptied.push(event);
        }
    }
    hooks.retain(|event, _| !emptied.contains(&event.as_str()));
    Ok(())
}

fn add(settings: &mut Value, url: &str, token: &str) -> Result<(), WatchError> {
    strip(settings)?;
    let root = settings.as_object_mut().ok_or(WatchError::UnexpectedLayout)?;
    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks.as_object_mut().ok_or(WatchError::UnexpectedLayout)?;
    for event in EVENTS {
        let timeout = if event == "PermissionRequest" { PERMISSION_TIMEOUT_SECS } else { HOOK_TIMEOUT_SECS };
        let handler = json!({
            "type": "http",
            "url": url,
            "headers": { TOKEN_HEADER: token, OWN_RUN_HEADER: format!("${OWN_RUN_ENV}") },
            "allowedEnvVars": [OWN_RUN_ENV],
            "timeout": timeout,
        });
        let groups = hooks.entry(event).or_insert_with(|| json!([]));
        let groups = groups.as_array_mut().ok_or(WatchError::UnexpectedLayout)?;
        groups.push(json!({ "hooks": [handler] }));
    }
    Ok(())
}

fn read(path: &Path) -> Result<Option<Value>, WatchError> {
    match fs::read_to_string(path) {
        // PowerShell 5 writes a byte order mark, and the file is still the user's JSON.
        Ok(text) => serde_json::from_str(text.trim_start_matches('\u{feff}')).map(Some).map_err(|_| WatchError::InvalidJson),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    name.into()
}

/// `create_new`, so whatever the first backup caught can never be overwritten.
fn back_up(path: &Path) -> Result<(), WatchError> {
    let original = fs::read(path)?;
    match OpenOptions::new().write(true).create_new(true).open(sibling(path, ".meridian-backup")) {
        Ok(mut backup) => Ok(backup.write_all(&original)?),
        Err(err) if err.kind() == ErrorKind::AlreadyExists => Ok(()),
        Err(err) => Err(err.into()),
    }
}

/// Goes through a temp file, so a crash leaves the old settings or the new
/// ones, never half of either.
fn save(path: &Path, before: Option<&Value>, after: &Value) -> Result<(), WatchError> {
    if before == Some(after) {
        return Ok(());
    }
    // Dotfile setups link this file. Renaming onto a link would replace the link.
    let path = &fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if before.is_some() {
        back_up(path)?;
    } else if let Some(folder) = path.parent() {
        fs::create_dir_all(folder)?;
    }
    let mut text = serde_json::to_string_pretty(after).map_err(std::io::Error::from)?;
    text.push('\n');
    let temp = sibling(path, ".meridian-tmp");
    let written = fs::write(&temp, text).and_then(|()| fs::rename(&temp, path));
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    Ok(written?)
}

/// Adds our hooks, replacing any earlier ones. `url` must end in [`HOOK_PATH`],
/// and `token` must hold no `$`: Claude Code expands header values.
pub fn install(settings_path: &Path, url: &str, token: &str) -> Result<(), WatchError> {
    let before = read(settings_path)?;
    let mut after = before.clone().unwrap_or_else(|| json!({}));
    add(&mut after, url, token)?;
    save(settings_path, before.as_ref(), &after)
}

/// Removes our hooks and leaves everything else.
pub fn uninstall(settings_path: &Path) -> Result<(), WatchError> {
    let Some(before) = read(settings_path)? else { return Ok(()) };
    let mut after = before.clone();
    strip(&mut after)?;
    save(settings_path, Some(&before), &after)
}

/// True only when every event is covered, so a partly removed install shows as
/// off and turning it on again repairs it.
pub fn installed(settings_path: &Path) -> bool {
    let Ok(Some(settings)) = read(settings_path) else { return false };
    EVENTS.iter().all(|event| {
        let groups = settings["hooks"][*event].as_array().into_iter().flatten();
        groups.flat_map(|group| group["hooks"].as_array().into_iter().flatten()).any(ours)
    })
}

/// The first line with something on it, shortened.
fn first_line(text: &str, limit: usize) -> String {
    text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or_default().chars().take(limit).collect()
}

/// Walks every byte, so the time taken says nothing about how close a guess was.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0, |diff, (x, y)| diff | (x ^ y)) == 0
}

fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

/// A browser always sends `Origin` on a cross-site POST, so refusing it keeps
/// web pages out even if one guesses the port.
fn allowed(head: &str, token: &str) -> bool {
    let target = format!("POST {HOOK_PATH} ");
    head.lines().next().is_some_and(|line| line.starts_with(&target))
        && header(head, "origin").is_none()
        && header(head, TOKEN_HEADER).is_some_and(|sent| same(sent, token))
}

/// One line for the island, with nothing raw from the tool input. A command can
/// outrun that line, and nobody should approve what they cannot see.
fn approval_summary(tool: &str, input: &Value) -> String {
    let label = tool_label(tool, input);
    let shown = label.chars().count().saturating_sub("$ ".len());
    match (input["command"].as_str(), input["file_path"].as_str()) {
        (Some(command), _) if command.trim().chars().count() > shown => format!("{label} ... (cut short, see the terminal)"),
        (Some(_), _) => label,
        // The folder is what makes a write dangerous: Startup, .ssh, a shell profile.
        (None, Some(path)) => format!("{tool}: {}", first_line(path, FAILURE_CHARS)),
        (None, None) => format!("{label} (details in the terminal)"),
    }
}

/// What one hook means for the island. Anything not listed only keeps the
/// session fresh.
fn events_for(name: &str, hook: &Value, running: bool) -> Vec<AgentEvent> {
    let tool = || tool_label(hook["tool_name"].as_str().unwrap_or("Tool"), &hook["tool_input"]);
    match name {
        "UserPromptSubmit" => vec![AgentEvent::status(SessionStatus::Running)],
        "PreToolUse" => {
            let change = code_change(hook["tool_name"].as_str().unwrap_or_default(), &hook["tool_input"]);
            [AgentEvent::status(SessionStatus::Running), AgentEvent::Activity { label: tool() }].into_iter().chain(change).collect()
        }
        "PostToolUse" => command_output(&hook["tool_input"], &hook["tool_response"]).into_iter().collect(),
        // The error text can quote tool output, so only the call is named.
        "PostToolUseFailure" => vec![AgentEvent::Activity { label: format!("Failed: {}", tool()) }],
        "Notification" => {
            vec![AgentEvent::Activity { label: first_line(hook["message"].as_str().unwrap_or_default(), LABEL_CHARS) }]
        }
        "Stop" => vec![AgentEvent::status(SessionStatus::Completed)],
        "StopFailure" => {
            // On this event the last message is the API's error, not Claude's reply.
            let detail = ["last_assistant_message", "error_details", "error"]
                .iter()
                .find_map(|key| hook[*key].as_str().filter(|text| !text.trim().is_empty()))
                .unwrap_or("The turn failed.");
            vec![AgentEvent::failed(first_line(detail, FAILURE_CHARS))]
        }
        "SessionEnd" if running => vec![AgentEvent::status(SessionStatus::Completed)],
        _ => vec![],
    }
}

fn is_stale(silent_for: Duration, open_approval: bool) -> bool {
    !open_approval && silent_for >= STALE_AFTER
}

struct Tracked {
    running: bool,
    last_hook: Instant,
}

#[derive(Default)]
struct State {
    sessions: HashMap<String, Tracked>,
    /// By approval id, so parallel requests in one session stay apart. Each
    /// names its session, so an answer cannot land on another one.
    waiting: HashMap<String, (String, oneshot::Sender<bool>)>,
}

struct Shared {
    state: Mutex<State>,
    token: String,
    events: mpsc::UnboundedSender<Envelope>,
    wait: Duration,
}

impl Shared {
    fn send(&self, session: &str, event: AgentEvent) {
        let _ = self.events.send(Envelope { session_id: session.to_string(), event });
    }

    /// Queued under the lock, so a parallel hook cannot overtake `watched`.
    fn observe(&self, session: &str, name: &str, hook: &Value) {
        let mut state = self.state.lock().unwrap();
        // Ending is the first we hear of it: there was never anything to show.
        if name == "SessionEnd" && !state.sessions.contains_key(session) {
            return;
        }
        let now = Instant::now();
        let tracked = state.sessions.entry(session.to_string()).or_insert_with(|| {
            let prompt = (name == "UserPromptSubmit").then(|| hook["prompt"].as_str().unwrap_or_default());
            let title = prompt.map(|p| first_line(p, TITLE_CHARS)).filter(|t| !t.is_empty());
            let cwd = hook["cwd"].as_str().unwrap_or_default().to_string();
            self.send(session, AgentEvent::Watched { agent: AGENT.to_string(), cwd, title });
            Tracked { running: true, last_hook: now }
        });
        tracked.last_hook = now;
        for event in events_for(name, hook, tracked.running) {
            self.send(session, event);
        }
        match name {
            "UserPromptSubmit" | "PreToolUse" | "PermissionRequest" => tracked.running = true,
            "Stop" | "StopFailure" => tracked.running = false,
            "SessionEnd" => {
                state.sessions.remove(session);
            }
            _ => {}
        }
    }

    fn sweep(&self, now: Instant) {
        let mut state = self.state.lock().unwrap();
        let State { sessions, waiting } = &mut *state;
        sessions.retain(|session, tracked| {
            let open = waiting.values().any(|(owner, _)| owner == session);
            let stale = is_stale(now.duration_since(tracked.last_hook), open);
            if stale {
                let message = Some(STALE_MESSAGE.to_string());
                self.send(session, AgentEvent::Status { status: SessionStatus::Completed, message });
            }
            !stale
        });
    }
}

/// Resolves when the other end hangs up.
async fn closed(socket: &mut TcpStream) {
    let mut buf = [0u8; 256];
    while matches!(socket.read(&mut buf).await, Ok(n) if n > 0) {}
}

async fn ask(mut socket: TcpStream, shared: &Shared, session: String, hook: &Value) {
    let id = uuid::Uuid::new_v4().to_string();
    let tool = hook["tool_name"].as_str().unwrap_or("Tool").to_string();
    let summary = approval_summary(&tool, &hook["tool_input"]);
    let (tx, rx) = oneshot::channel();
    shared.observe(&session, "PermissionRequest", hook);
    // Waiting before the app hears of it, so even a fast click finds it.
    shared.state.lock().unwrap().waiting.insert(id.clone(), (session.clone(), tx));
    shared.send(&session, AgentEvent::Approval { approval: Approval { id: id.clone(), tool, summary } });

    let decision = tokio::select! {
        decision = tokio::time::timeout(shared.wait, rx) => decision.ok().and_then(Result::ok),
        // The user answered in the terminal, or the terminal has gone.
        () = closed(&mut socket) => None,
    };
    shared.state.lock().unwrap().waiting.remove(&id);
    // No decision leaves Claude Code's own dialog in charge.
    let body = decision.map(decision_body).unwrap_or_default();
    respond(&mut socket, "200 OK", &body).await;
    shared.send(&session, AgentEvent::ApprovalResolved { id });
}

async fn handle(mut socket: TcpStream, shared: Arc<Shared>) {
    let Ok(Some((head, body))) = tokio::time::timeout(READ_TIMEOUT, read_request(&mut socket, MAX_BODY)).await else {
        return;
    };
    if !allowed(&head, &shared.token) {
        return respond(&mut socket, "403 Forbidden", "").await;
    }
    if header(&head, OWN_RUN_HEADER) == Some("1") {
        return respond(&mut socket, "200 OK", "").await;
    }
    let Ok(hook) = serde_json::from_slice::<Value>(&body) else {
        return respond(&mut socket, "400 Bad Request", "").await;
    };
    let (Some(native), Some(name)) = (hook["session_id"].as_str(), hook["hook_event_name"].as_str()) else {
        return respond(&mut socket, "200 OK", "").await;
    };
    let session = format!("{SESSION_PREFIX}{native}");
    if name == "PermissionRequest" {
        return ask(socket, &shared, session, &hook).await;
    }
    shared.observe(&session, name, &hook);
    respond(&mut socket, "200 OK", "").await;
}

async fn serve(listener: TcpListener, shared: Arc<Shared>) {
    let mut sweep = tokio::time::interval(SWEEP_EVERY);
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((socket, _)) => {
                    tokio::spawn(handle(socket, shared.clone()));
                }
                // Out of sockets, most likely. Waiting beats spinning.
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            },
            _ = sweep.tick() => shared.sweep(Instant::now()),
        }
    }
}

pub struct Watcher {
    shared: Arc<Shared>,
    server: JoinHandle<()>,
    port: u16,
}

impl Watcher {
    /// Binds 127.0.0.1:<port>; 0 picks a free port. Returns once listening.
    pub async fn start(
        port: u16,
        token: String,
        emit: impl Fn(Envelope) + Send + Sync + 'static,
    ) -> Result<Self, WatchError> {
        Self::start_with(port, token, emit, DECISION_WAIT).await
    }

    async fn start_with(
        port: u16,
        token: String,
        emit: impl Fn(Envelope) + Send + Sync + 'static,
        wait: Duration,
    ) -> Result<Self, WatchError> {
        let listener = TcpListener::bind(("127.0.0.1", port)).await.map_err(WatchError::Listen)?;
        let port = listener.local_addr().map_err(WatchError::Listen)?.port();
        // One task delivers everything, so order holds and the app's callback
        // never runs under the lock.
        let (events, mut queue) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Some(envelope) = queue.recv().await {
                emit(envelope);
            }
        });
        let shared = Arc::new(Shared { state: Mutex::default(), token, events, wait });
        let server = tokio::spawn(serve(listener, shared.clone()));
        Ok(Self { shared, server, port })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// True if this session id belongs to the watcher.
    pub fn owns(session_id: &str) -> bool {
        session_id.starts_with(SESSION_PREFIX)
    }

    /// True when that session was waiting on that approval here.
    pub fn answer(&self, session_id: &str, approval_id: &str, allow: bool) -> bool {
        let mut state = self.shared.state.lock().unwrap();
        if !matches!(state.waiting.get(approval_id), Some((owner, _)) if owner == session_id) {
            return false;
        }
        state.waiting.remove(approval_id).is_some_and(|(_, tx)| tx.send(allow).is_ok())
    }

    /// Stops listening. Held hooks are let go without a decision, so each one
    /// goes back to the terminal's own dialog.
    pub fn stop(&self) {
        self.server.abort();
        self.shared.state.lock().unwrap().waiting.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    #[test]
    fn an_edit_shows_its_lines_and_a_command_shows_its_end() {
        let edit = json!({ "tool_name": "Edit", "tool_input": { "file_path": "C:\\a\\tax.ts", "old_string": "const VAT = 0.19", "new_string": "const VAT = 0.21" } });
        let events = events_for("PreToolUse", &edit, true);
        assert!(events.contains(&AgentEvent::Diff { path: "tax.ts".into(), removed: vec!["const VAT = 0.19".into()], added: vec!["const VAT = 0.21".into()] }));

        let run = json!({ "tool_input": { "command": "npm test" }, "tool_response": { "stdout": "a\nb\nc\nPASS 48" } });
        let events = events_for("PostToolUse", &run, true);
        assert_eq!(events, [AgentEvent::Output { command: "npm test".into(), lines: vec!["b".into(), "c".into(), "PASS 48".into()], failed: false }]);
    }

    #[test]
    fn a_command_that_only_wrote_errors_is_marked_failed() {
        let run = json!({ "tool_input": { "command": "npm test" }, "tool_response": { "stdout": "", "stderr": "boom" } });
        assert!(matches!(&events_for("PostToolUse", &run, true)[..], [AgentEvent::Output { failed: true, .. }]));
    }

    #[test]
    fn a_file_approval_shows_the_whole_path() {
        let summary = approval_summary("Edit", &json!({ "file_path": "C:\\Users\\me\\Startup\\update.bat" }));
        assert!(summary.contains("Startup"), "{summary}");
    }

    #[test]
    fn an_approval_with_hidden_input_points_at_the_terminal() {
        let summary = approval_summary("mcp__db__run", &json!({ "query": "drop table users" }));
        assert!(summary.contains("details in the terminal"), "{summary}");
        assert!(!summary.contains("drop table"), "{summary}");
    }

    #[test]
    fn a_byte_order_mark_does_not_make_a_settings_file_invalid() {
        let dir = std::env::temp_dir().join(format!("meridian-bom-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        fs::write(&path, "\u{feff}{\"model\":\"x\"}").unwrap();
        install(&path, "http://127.0.0.1:1/meridian-hook", "t").unwrap();
        assert!(installed(&path));
        let kept: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(kept["model"], "x");
    }

    const URL: &str = "http://127.0.0.1:4599/meridian-hook";
    const TOKEN: &str = "test-token";
    const LONG_WAIT: Duration = Duration::from_secs(30);

    /// A throwaway folder. No test here goes near a real settings file.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("meridian-watch-{}", uuid::Uuid::new_v4().simple()));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn settings(&self) -> PathBuf {
            self.0.join("settings.json")
        }

        fn backup(&self) -> PathBuf {
            self.0.join("settings.json.meridian-backup")
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn foreign() -> Value {
        json!({
            "model": "opus",
            "permissions": { "allow": ["Bash(ls)"] },
            "hooks": {
                "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "audit.sh" }] }],
                "SessionStart": [{ "hooks": [{ "type": "command", "command": "hello.sh" }] }]
            }
        })
    }

    fn load(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    fn handlers(settings: &Value, event: &str) -> Vec<Value> {
        let groups = settings["hooks"][event].as_array().unwrap();
        groups.iter().flat_map(|g| g["hooks"].as_array().unwrap().clone()).collect()
    }

    #[test]
    fn install_keeps_other_tools_hooks_and_every_other_key() {
        let dir = Scratch::new();
        let path = dir.settings();
        fs::write(&path, foreign().to_string()).unwrap();

        install(&path, URL, TOKEN).unwrap();

        let saved = load(&path);
        assert_eq!(saved["model"], "opus");
        assert_eq!(saved["permissions"], foreign()["permissions"]);
        assert_eq!(saved["hooks"]["SessionStart"], foreign()["hooks"]["SessionStart"]);
        let tools = handlers(&saved, "PreToolUse");
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0]["command"], "audit.sh");
        assert_eq!(tools[1]["url"], URL);
        assert!(installed(&path));
    }

    #[test]
    fn install_leaves_the_users_keys_in_their_order() {
        let dir = Scratch::new();
        let path = dir.settings();
        fs::write(&path, r#"{"zebra":1,"mango":2,"apple":3}"#).unwrap();
        install(&path, URL, TOKEN).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        let at = |key: &str| text.find(key).unwrap();
        assert!(at("zebra") < at("mango") && at("mango") < at("apple"), "{text}");
    }

    #[test]
    fn every_event_posts_with_the_token_and_only_permissions_wait_long() {
        let dir = Scratch::new();
        let path = dir.settings();
        install(&path, URL, TOKEN).unwrap();
        let saved = load(&path);
        for event in EVENTS {
            let all = handlers(&saved, event);
            assert_eq!(all.len(), 1, "{event}");
            assert_eq!(all[0]["type"], "http");
            assert_eq!(all[0]["url"], URL);
            assert_eq!(all[0]["headers"]["X-Meridian-Token"], TOKEN);
            assert_eq!(all[0]["timeout"], if event == "PermissionRequest" { 300 } else { 5 }, "{event}");
        }
    }

    #[test]
    fn reinstalling_replaces_rather_than_duplicates() {
        let dir = Scratch::new();
        let path = dir.settings();
        fs::write(&path, foreign().to_string()).unwrap();
        install(&path, URL, TOKEN).unwrap();
        install(&path, "http://127.0.0.1:7777/meridian-hook", "new-token").unwrap();

        let saved = load(&path);
        let tools = handlers(&saved, "PreToolUse");
        assert_eq!(tools.len(), 2, "{tools:?}");
        assert_eq!(tools[1]["url"], "http://127.0.0.1:7777/meridian-hook");
        assert_eq!(tools[1]["headers"]["X-Meridian-Token"], "new-token");
        assert_eq!(handlers(&saved, "Stop").len(), 1);
    }

    #[test]
    fn uninstall_restores_the_settings_it_found() {
        let dir = Scratch::new();
        let path = dir.settings();
        fs::write(&path, foreign().to_string()).unwrap();
        install(&path, URL, TOKEN).unwrap();
        uninstall(&path).unwrap();
        // Stop and the rest were ours alone, so their keys go too.
        assert_eq!(load(&path), foreign());
        assert!(!installed(&path));
    }

    #[test]
    fn only_our_handler_leaves_a_group_it_shares() {
        let dir = Scratch::new();
        let path = dir.settings();
        let shared = json!({ "hooks": { "Stop": [{ "hooks": [
            { "type": "command", "command": "keep.sh" },
            { "type": "http", "url": URL },
        ] }] } });
        fs::write(&path, shared.to_string()).unwrap();
        uninstall(&path).unwrap();
        let left = handlers(&load(&path), "Stop");
        assert_eq!(left.len(), 1);
        assert_eq!(left[0]["command"], "keep.sh");
    }

    #[test]
    fn a_lookalike_url_and_an_already_empty_event_are_not_ours_to_touch() {
        let dir = Scratch::new();
        let path = dir.settings();
        let settings = json!({ "hooks": {
            "PreToolUse": [{ "hooks": [{ "type": "http", "url": "https://example.com/tools/meridian-hook" }] }],
            "Stop": [],
            "Notification": [{ "hooks": [] }],
        } });
        fs::write(&path, settings.to_string()).unwrap();
        install(&path, URL, TOKEN).unwrap();
        uninstall(&path).unwrap();
        assert_eq!(handlers(&load(&path), "PreToolUse").len(), 1);
        assert_eq!(load(&path)["hooks"]["Notification"], json!([{ "hooks": [] }]));
    }

    #[test]
    fn invalid_json_is_refused_and_left_untouched() {
        let dir = Scratch::new();
        let path = dir.settings();
        let text = "{ \"model\": \"opus\", oops";
        fs::write(&path, text).unwrap();

        assert!(matches!(install(&path, URL, TOKEN), Err(WatchError::InvalidJson)));
        assert!(matches!(uninstall(&path), Err(WatchError::InvalidJson)));
        assert!(!installed(&path));
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
        assert!(!dir.backup().exists());
    }

    #[test]
    fn an_unexpected_layout_is_refused_and_left_untouched() {
        let dir = Scratch::new();
        let path = dir.settings();
        let layouts = [
            "[]",
            r#"{"hooks":[]}"#,
            r#"{"hooks":{"Stop":{}}}"#,
            r#"{"hooks":{"Stop":[1]}}"#,
            r#"{"hooks":{"Stop":[{"hooks":"x"}]}}"#,
            r#"{"hooks":{"Stop":[{"matcher":"x"}]}}"#,
        ];
        for text in layouts {
            fs::write(&path, text).unwrap();
            assert!(matches!(install(&path, URL, TOKEN), Err(WatchError::UnexpectedLayout)), "{text}");
            assert!(matches!(uninstall(&path), Err(WatchError::UnexpectedLayout)), "{text}");
            assert_eq!(fs::read_to_string(&path).unwrap(), text);
            assert!(!dir.backup().exists(), "{text}");
        }
    }

    #[test]
    fn the_first_backup_is_exact_and_never_overwritten() {
        let dir = Scratch::new();
        let path = dir.settings();
        let original = "{\n    \"model\":   \"opus\"\n}\n";
        fs::write(&path, original).unwrap();

        install(&path, URL, TOKEN).unwrap();
        assert_eq!(fs::read_to_string(dir.backup()).unwrap(), original);

        fs::write(&path, r#"{"model":"changed since"}"#).unwrap();
        install(&path, URL, TOKEN).unwrap();
        uninstall(&path).unwrap();
        assert_eq!(fs::read_to_string(dir.backup()).unwrap(), original);
    }

    #[test]
    fn a_missing_file_is_created_along_with_its_folder() {
        let dir = Scratch::new();
        let path = dir.0.join("not-yet").join("settings.json");
        assert!(!installed(&path));
        install(&path, URL, TOKEN).unwrap();
        assert!(installed(&path));
        assert!(!sibling(&path, ".meridian-backup").exists());
    }

    #[test]
    fn uninstalling_a_missing_file_succeeds_and_creates_nothing() {
        let dir = Scratch::new();
        let path = dir.settings();
        uninstall(&path).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn a_change_that_changes_nothing_does_not_touch_the_file() {
        let dir = Scratch::new();
        let path = dir.settings();
        // Nothing of ours here, so the already empty event is not ours to drop.
        let text = "{   \"hooks\": {\"Stop\":[]}   }";
        fs::write(&path, text).unwrap();
        uninstall(&path).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
        assert!(!dir.backup().exists());
    }

    #[test]
    fn writing_leaves_only_the_settings_and_the_backup_behind() {
        let dir = Scratch::new();
        let path = dir.settings();
        fs::write(&path, "{}").unwrap();
        install(&path, URL, TOKEN).unwrap();
        let mut names: Vec<_> = fs::read_dir(&dir.0).unwrap().map(|e| e.unwrap().file_name()).collect();
        names.sort();
        assert_eq!(names, ["settings.json", "settings.json.meridian-backup"]);
    }

    #[test]
    fn a_partly_removed_install_does_not_count() {
        let dir = Scratch::new();
        let path = dir.settings();
        install(&path, URL, TOKEN).unwrap();
        let mut settings = load(&path);
        settings["hooks"].as_object_mut().unwrap().retain(|event, _| event != "Stop");
        fs::write(&path, settings.to_string()).unwrap();
        assert!(!installed(&path));
    }

    type Log = Arc<Mutex<Vec<Envelope>>>;

    async fn watcher(wait: Duration) -> (Watcher, Log) {
        let log: Log = Arc::default();
        let sink = log.clone();
        let emit = move |envelope| sink.lock().unwrap().push(envelope);
        (Watcher::start_with(0, TOKEN.to_string(), emit, wait).await.unwrap(), log)
    }

    async fn request(port: u16, line: &str, headers: &str, body: &str) -> TcpStream {
        let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let text = format!("{line}\r\nhost: 127.0.0.1\r\n{headers}content-length: {}\r\n\r\n{body}", body.len());
        // Ignored because the server may hang up partway through an oversized body.
        let _ = socket.write_all(text.as_bytes()).await;
        socket
    }

    fn token_header() -> String {
        format!("x-meridian-token: {TOKEN}\r\n")
    }

    /// Posts the way an installed hook does.
    async fn hook(watcher: &Watcher, body: Value) -> TcpStream {
        let line = format!("POST {HOOK_PATH} HTTP/1.1");
        request(watcher.port(), &line, &token_header(), &body.to_string()).await
    }

    async fn reply(socket: &mut TcpStream) -> String {
        let mut text = String::new();
        let _ = socket.read_to_string(&mut text).await;
        text
    }

    fn body_of(reply: &str) -> &str {
        reply.split_once("\r\n\r\n").unwrap().1
    }

    /// A hook that must come straight back with 200 and nothing else.
    async fn deliver(watcher: &Watcher, body: Value) {
        let text = reply(&mut hook(watcher, body).await).await;
        assert!(text.starts_with("HTTP/1.1 200"), "{text}");
        assert_eq!(body_of(&text), "");
    }

    async fn until(log: &Log, done: impl Fn(&[Envelope]) -> bool) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !done(&log.lock().unwrap()) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the events never arrived");
    }

    async fn settled(log: &Log) -> Vec<AgentEvent> {
        // Delivery is one queue, so a short pause is enough for it to drain.
        tokio::time::sleep(Duration::from_millis(50)).await;
        log.lock().unwrap().iter().map(|e| e.event.clone()).collect()
    }

    fn approvals(log: &Log) -> Vec<Approval> {
        let events = log.lock().unwrap();
        events
            .iter()
            .filter_map(|e| match &e.event {
                AgentEvent::Approval { approval } => Some(approval.clone()),
                _ => None,
            })
            .collect()
    }

    fn has_approvals(count: usize) -> impl Fn(&[Envelope]) -> bool {
        move |events| events.iter().filter(|e| matches!(e.event, AgentEvent::Approval { .. })).count() == count
    }

    fn resolved(id: String) -> impl Fn(&[Envelope]) -> bool {
        move |events| events.iter().any(|e| e.event == AgentEvent::ApprovalResolved { id: id.clone() })
    }

    fn event(name: &str) -> Value {
        json!({ "session_id": "s1", "cwd": "C:\\w", "hook_event_name": name })
    }

    fn tool_event(name: &str, tool: &str, input: Value) -> Value {
        let mut body = event(name);
        body["tool_name"] = json!(tool);
        body["tool_input"] = input;
        body
    }

    fn permission() -> Value {
        tool_event("PermissionRequest", "Bash", json!({ "command": "rm -rf build" }))
    }

    #[tokio::test]
    async fn the_first_event_is_watched_and_carries_the_prompt_as_a_title() {
        let (watcher, log) = watcher(LONG_WAIT).await;
        let mut body = event("UserPromptSubmit");
        body["prompt"] = json!(format!("\n  {}\nsecond line", "t".repeat(100)));
        deliver(&watcher, body).await;

        let events = settled(&log).await;
        assert_eq!(
            events,
            [
                AgentEvent::Watched {
                    agent: "Claude Code".into(),
                    cwd: "C:\\w".into(),
                    title: Some("t".repeat(64)),
                },
                AgentEvent::status(SessionStatus::Running),
            ]
        );
        assert_eq!(log.lock().unwrap()[0].session_id, "watch:s1");
    }

    #[tokio::test]
    async fn watched_is_announced_once_and_only_a_prompt_gives_a_title() {
        let (watcher, log) = watcher(LONG_WAIT).await;
        deliver(&watcher, tool_event("PreToolUse", "Read", json!({ "file_path": "C:\\a\\main.rs" }))).await;
        deliver(&watcher, event("UserPromptSubmit")).await;
        let events = settled(&log).await;
        assert!(matches!(&events[0], AgentEvent::Watched { title: None, .. }), "{events:?}");
        assert_eq!(events.iter().filter(|e| matches!(e, AgentEvent::Watched { .. })).count(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn parallel_first_hooks_cannot_overtake_watched() {
        let (watcher, log) = watcher(LONG_WAIT).await;
        let port = watcher.port();
        let posts: Vec<_> = (0..16)
            .map(|_| {
                let body = tool_event("PreToolUse", "Read", json!({ "file_path": "a.rs" })).to_string();
                tokio::spawn(async move {
                    let line = format!("POST {HOOK_PATH} HTTP/1.1");
                    reply(&mut request(port, &line, &token_header(), &body).await).await
                })
            })
            .collect();
        for post in posts {
            post.await.unwrap();
        }
        let events = settled(&log).await;
        assert!(matches!(events[0], AgentEvent::Watched { .. }), "{events:?}");
        assert_eq!(events.iter().filter(|e| matches!(e, AgentEvent::Watched { .. })).count(), 1);
    }

    #[tokio::test]
    async fn a_session_reads_as_a_story() {
        let (watcher, log) = watcher(LONG_WAIT).await;
        let bash = json!({ "command": "npm test\nnpm run lint" });
        let mut notice = event("Notification");
        notice["message"] = json!("Claude needs your attention");

        deliver(&watcher, event("UserPromptSubmit")).await;
        deliver(&watcher, tool_event("PreToolUse", "Grep", json!({ "pattern": "todo" }))).await;
        deliver(&watcher, tool_event("PostToolUse", "Grep", json!({ "pattern": "todo" }))).await;
        deliver(&watcher, tool_event("PostToolUseFailure", "Bash", bash)).await;
        deliver(&watcher, notice).await;
        deliver(&watcher, event("Stop")).await;
        deliver(&watcher, event("SessionEnd")).await;

        let events = settled(&log).await;
        assert_eq!(
            events[1..],
            [
                AgentEvent::status(SessionStatus::Running),
                AgentEvent::status(SessionStatus::Running),
                AgentEvent::Activity { label: "Searching todo".into() },
                AgentEvent::Activity { label: "Failed: $ npm test".into() },
                AgentEvent::Activity { label: "Claude needs your attention".into() },
                AgentEvent::status(SessionStatus::Completed),
            ]
        );
        assert!(watcher.shared.state.lock().unwrap().sessions.is_empty());
    }

    #[tokio::test]
    async fn ending_mid_turn_completes_the_session_then_forgets_it() {
        let (watcher, log) = watcher(LONG_WAIT).await;
        deliver(&watcher, event("UserPromptSubmit")).await;
        deliver(&watcher, event("SessionEnd")).await;
        assert_eq!(settled(&log).await.last(), Some(&AgentEvent::status(SessionStatus::Completed)));
        assert!(watcher.shared.state.lock().unwrap().sessions.is_empty());
    }

    #[tokio::test]
    async fn ending_unheard_of_shows_nothing() {
        let (watcher, log) = watcher(LONG_WAIT).await;
        deliver(&watcher, event("SessionEnd")).await;
        assert!(settled(&log).await.is_empty());
    }

    #[tokio::test]
    async fn a_failed_turn_gives_the_api_error_not_the_error_kind() {
        let (watcher, log) = watcher(LONG_WAIT).await;
        let mut body = event("StopFailure");
        body["error"] = json!("rate_limit");
        body["last_assistant_message"] = json!("API Error: Rate limit reached");
        deliver(&watcher, body).await;
        assert_eq!(settled(&log).await.last(), Some(&AgentEvent::failed("API Error: Rate limit reached")));

        let mut bare = event("StopFailure");
        bare["error"] = json!("overloaded");
        deliver(&watcher, bare).await;
        assert_eq!(settled(&log).await.last(), Some(&AgentEvent::failed("overloaded")));
    }

    #[tokio::test]
    async fn nothing_secret_leaves_the_module() {
        let (watcher, log) = watcher(Duration::from_millis(20)).await;
        let secret = "sk-SECRET-VALUE";
        let mut prompt = event("UserPromptSubmit");
        prompt["prompt"] = json!(format!("Deploy it\nthe key is {secret}"));
        deliver(&watcher, prompt).await;
        deliver(&watcher, tool_event("PreToolUse", "Write", json!({ "file_path": "a.txt", "content": secret }))).await;
        let mut failure = tool_event("PostToolUseFailure", "Bash", json!({ "command": "ls" }));
        failure["error"] = json!(secret);
        deliver(&watcher, failure).await;
        let mut stop = event("Stop");
        stop["last_assistant_message"] = json!(secret);
        deliver(&watcher, stop).await;
        let mystery = tool_event("PermissionRequest", "mcp__vault__put", json!({ "value": secret }));
        reply(&mut hook(&watcher, mystery).await).await;

        let text = serde_json::to_string(&settled(&log).await).unwrap();
        assert!(!text.contains(secret), "{text}");
    }

    #[tokio::test]
    async fn a_wrong_or_missing_token_is_refused_and_raises_nothing() {
        let (watcher, log) = watcher(LONG_WAIT).await;
        let line = format!("POST {HOOK_PATH} HTTP/1.1");
        let body = event("Stop").to_string();
        for headers in ["x-meridian-token: test-tokem\r\n", "x-meridian-token: test\r\n", ""] {
            let text = reply(&mut request(watcher.port(), &line, headers, &body).await).await;
            assert!(text.starts_with("HTTP/1.1 403"), "{headers}: {text}");
        }
        assert!(settled(&log).await.is_empty());
    }

    #[tokio::test]
    async fn a_web_page_is_refused_even_with_the_token() {
        let (watcher, log) = watcher(LONG_WAIT).await;
        let line = format!("POST {HOOK_PATH} HTTP/1.1");
        let headers = format!("{}Origin: https://example.com\r\n", token_header());
        let text = reply(&mut request(watcher.port(), &line, &headers, &event("Stop").to_string()).await).await;
        assert!(text.starts_with("HTTP/1.1 403"), "{text}");
        assert!(settled(&log).await.is_empty());
    }

    #[tokio::test]
    async fn only_a_post_to_the_hook_path_is_accepted() {
        let (watcher, log) = watcher(LONG_WAIT).await;
        let body = event("Stop").to_string();
        let lines = [
            format!("GET {HOOK_PATH} HTTP/1.1"),
            format!("OPTIONS {HOOK_PATH} HTTP/1.1"),
            format!("POST {HOOK_PATH}/more HTTP/1.1"),
            "POST / HTTP/1.1".to_string(),
        ];
        for line in lines {
            let text = reply(&mut request(watcher.port(), &line, &token_header(), &body).await).await;
            assert!(text.starts_with("HTTP/1.1 403"), "{line}: {text}");
        }
        assert!(settled(&log).await.is_empty());
    }

    #[tokio::test]
    async fn the_body_cap_is_held_to_but_a_big_payload_under_it_gets_through() {
        let (watcher, log) = watcher(LONG_WAIT).await;
        let line = format!("POST {HOOK_PATH} HTTP/1.1");
        let mut big = event("PostToolUse");
        big["tool_response"] = json!("x".repeat(2 << 20));
        let text = reply(&mut request(watcher.port(), &line, &token_header(), &big.to_string()).await).await;
        assert!(text.starts_with("HTTP/1.1 200"), "{}", text.len());
        assert_eq!(settled(&log).await.len(), 1);

        log.lock().unwrap().clear();
        let mut huge = event("Stop");
        // Spelled out, so raising the cap fails here instead of raising the test.
        huge["tool_response"] = json!("x".repeat(4 << 20));
        let text = reply(&mut request(watcher.port(), &line, &token_header(), &huge.to_string()).await).await;
        assert_eq!(text, "");
        assert!(settled(&log).await.is_empty());
    }

    #[tokio::test]
    async fn this_apps_own_runs_are_left_to_their_own_hook() {
        let (watcher, log) = watcher(LONG_WAIT).await;
        let line = format!("POST {HOOK_PATH} HTTP/1.1");
        let own = format!("{}{OWN_RUN_HEADER}: 1\r\n", token_header());
        let text = reply(&mut request(watcher.port(), &line, &own, &permission().to_string()).await).await;
        assert!(text.starts_with("HTTP/1.1 200"), "{text}");
        assert_eq!(body_of(&text), "");
        assert!(settled(&log).await.is_empty());

        // In a terminal the variable is unset, however Claude Code renders that.
        for value in ["", "$MERIDIAN_RUN"] {
            let terminal = format!("{}{OWN_RUN_HEADER}: {value}\r\n", token_header());
            reply(&mut request(watcher.port(), &line, &terminal, &event("Stop").to_string()).await).await;
        }
        assert!(!settled(&log).await.is_empty());
    }

    #[test]
    fn installed_hooks_echo_the_own_run_variable() {
        let dir = Scratch::new();
        let path = dir.settings();
        install(&path, URL, TOKEN).unwrap();
        let handler = &handlers(&load(&path), "PermissionRequest")[0];
        assert_eq!(handler["headers"][OWN_RUN_HEADER], format!("${OWN_RUN_ENV}"));
        assert_eq!(handler["allowedEnvVars"], json!([OWN_RUN_ENV]));
    }

    #[tokio::test]
    async fn agents_this_app_launches_carry_the_own_run_variable() {
        let script = format!("console.log(process.env.{OWN_RUN_ENV})");
        let mut agent = crate::process::spawn(Path::new("node"), &["-e", script.as_str()], ".").unwrap();
        assert_eq!(agent.lines.next_line().await.unwrap().as_deref(), Some("1"));
    }

    #[tokio::test]
    async fn allowing_replies_with_the_per_run_decision_then_resolves() {
        let (watcher, log) = watcher(LONG_WAIT).await;
        let mut socket = hook(&watcher, permission()).await;
        until(&log, has_approvals(1)).await;

        let approval = &approvals(&log)[0];
        assert_eq!(approval.tool, "Bash");
        assert_eq!(approval.summary, "$ rm -rf build");
        assert!(matches!(log.lock().unwrap()[0].event, AgentEvent::Watched { .. }));

        assert!(watcher.answer("watch:s1", &approval.id, true));
        let text = reply(&mut socket).await;
        assert!(text.starts_with("HTTP/1.1 200"), "{text}");
        assert_eq!(body_of(&text), decision_body(true));
        until(&log, resolved(approval.id.clone())).await;
    }

    #[tokio::test]
    async fn denying_replies_with_the_per_run_decision_then_resolves() {
        let (watcher, log) = watcher(LONG_WAIT).await;
        let mut socket = hook(&watcher, permission()).await;
        until(&log, has_approvals(1)).await;
        let id = approvals(&log)[0].id.clone();

        assert!(watcher.answer("watch:s1", &id, false));
        assert_eq!(body_of(&reply(&mut socket).await), decision_body(false));
        until(&log, resolved(id)).await;
    }

    #[tokio::test]
    async fn an_answer_for_another_session_or_an_unknown_id_goes_nowhere() {
        let (watcher, log) = watcher(LONG_WAIT).await;
        let mut socket = hook(&watcher, permission()).await;
        until(&log, has_approvals(1)).await;
        let id = approvals(&log)[0].id.clone();

        assert!(!watcher.answer("watch:other", &id, true));
        assert!(!watcher.answer("watch:s1", "nope", true));
        assert!(watcher.answer("watch:s1", &id, true), "the wrong answers must not consume it");
        assert_eq!(body_of(&reply(&mut socket).await), decision_body(true));
    }

    #[tokio::test]
    async fn a_timeout_replies_empty_so_the_terminal_stays_in_charge() {
        let (watcher, log) = watcher(Duration::from_millis(50)).await;
        let mut socket = hook(&watcher, permission()).await;
        let text = reply(&mut socket).await;
        assert!(text.starts_with("HTTP/1.1 200"), "{text}");
        assert_eq!(body_of(&text), "");

        until(&log, has_approvals(1)).await;
        let id = approvals(&log)[0].id.clone();
        until(&log, resolved(id.clone())).await;
        assert!(!watcher.answer("watch:s1", &id, true));
    }

    #[tokio::test]
    async fn a_hook_that_hangs_up_clears_the_prompt() {
        let (watcher, log) = watcher(LONG_WAIT).await;
        let socket = hook(&watcher, permission()).await;
        until(&log, has_approvals(1)).await;
        let id = approvals(&log)[0].id.clone();

        drop(socket);
        until(&log, resolved(id.clone())).await;
        assert!(!watcher.answer("watch:s1", &id, true));
        assert!(watcher.shared.state.lock().unwrap().waiting.is_empty());
    }

    #[tokio::test]
    async fn two_open_approvals_are_answered_apart() {
        let (watcher, log) = watcher(LONG_WAIT).await;
        let mut first = hook(&watcher, permission()).await;
        until(&log, has_approvals(1)).await;
        let other = tool_event("PermissionRequest", "Bash", json!({ "command": "git push" }));
        let mut second = hook(&watcher, other).await;
        until(&log, has_approvals(2)).await;

        let open = approvals(&log);
        assert_ne!(open[0].id, open[1].id);
        let id_of = |summary: &str| open.iter().find(|a| a.summary == summary).unwrap().id.clone();
        assert!(watcher.answer("watch:s1", &id_of("$ git push"), false));
        assert_eq!(body_of(&reply(&mut second).await), decision_body(false));
        assert!(watcher.answer("watch:s1", &id_of("$ rm -rf build"), true));
        assert_eq!(body_of(&reply(&mut first).await), decision_body(true));
        for approval in open.iter() {
            until(&log, resolved(approval.id.clone())).await;
        }
    }

    #[tokio::test]
    async fn stopping_lets_held_hooks_go_and_closes_the_port() {
        let (watcher, log) = watcher(LONG_WAIT).await;
        let mut socket = hook(&watcher, permission()).await;
        until(&log, has_approvals(1)).await;

        watcher.stop();
        // Bounded, because a hook left to run out its wait would also reply empty.
        let text = tokio::time::timeout(Duration::from_secs(5), reply(&mut socket)).await.expect("the hook stayed held");
        assert_eq!(body_of(&text), "");
        until(&log, resolved(approvals(&log)[0].id.clone())).await;
        tokio::time::timeout(Duration::from_secs(5), async {
            while TcpStream::connect(("127.0.0.1", watcher.port())).await.is_ok() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the port stayed open");
    }

    #[test]
    fn staleness_needs_the_full_silence_and_no_open_approval() {
        assert!(is_stale(STALE_AFTER, false));
        assert!(!is_stale(STALE_AFTER - Duration::from_secs(1), false));
        assert!(!is_stale(STALE_AFTER * 2, true));
        assert_eq!(STALE_AFTER, Duration::from_secs(1800));
    }

    #[tokio::test]
    async fn a_silent_session_is_closed_with_a_reason_and_forgotten() {
        let (watcher, log) = watcher(LONG_WAIT).await;
        deliver(&watcher, event("UserPromptSubmit")).await;

        watcher.shared.sweep(Instant::now() + STALE_AFTER - Duration::from_secs(1));
        assert_eq!(settled(&log).await.len(), 2);

        watcher.shared.sweep(Instant::now() + STALE_AFTER);
        let message = Some("No word from this session".to_string());
        let closed = AgentEvent::Status { status: SessionStatus::Completed, message };
        assert_eq!(settled(&log).await.last(), Some(&closed));
        assert!(watcher.shared.state.lock().unwrap().sessions.is_empty());
    }

    #[tokio::test]
    async fn an_open_approval_keeps_a_silent_session_alive() {
        let (watcher, log) = watcher(LONG_WAIT).await;
        let _held = hook(&watcher, permission()).await;
        until(&log, has_approvals(1)).await;

        watcher.shared.sweep(Instant::now() + STALE_AFTER * 2);
        assert!(!settled(&log).await.iter().any(|e| matches!(e, AgentEvent::Status { .. })));
        assert_eq!(watcher.shared.state.lock().unwrap().sessions.len(), 1);
    }

    #[tokio::test]
    async fn binding_reports_a_taken_port_and_the_real_one_otherwise() {
        let first = Watcher::start(0, TOKEN.to_string(), |_| {}).await.unwrap();
        assert_ne!(first.port(), 0);
        let taken = Watcher::start(first.port(), TOKEN.to_string(), |_| {}).await;
        assert!(matches!(taken, Err(WatchError::Listen(_))));
    }

    #[test]
    fn the_prefix_marks_ownership() {
        assert!(Watcher::owns("watch:abc"));
        assert!(!Watcher::owns("0781dc44-watch:abc"));
    }

    #[test]
    fn watched_serialises_the_way_the_interface_expects() {
        let event = AgentEvent::Watched { agent: AGENT.into(), cwd: "C:\\w".into(), title: None };
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value, json!({ "type": "watched", "agent": "Claude Code", "cwd": "C:\\w", "title": null }));
    }

    #[test]
    fn a_summary_says_when_a_command_is_longer_than_it_shows() {
        let summary = |command: &str| approval_summary("Bash", &json!({ "command": command }));
        assert_eq!(summary("ls -la\n"), "$ ls -la");
        assert!(summary("echo hi\nrm -rf /").contains("cut short"));
        assert!(summary(&"x".repeat(81)).contains("cut short"));
        assert!(!summary(&"x".repeat(80)).contains("cut short"));
    }

    #[test]
    fn tokens_are_compared_whole() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "abcd"));
        assert!(!same("", "abc"));
    }

    #[test]
    fn head_lookups_ignore_case_and_skip_the_request_line() {
        let head = "POST /x:y HTTP/1.1\r\nX-Meridian-TOKEN:  abc \r\nHost: a";
        assert_eq!(header(head, "x-meridian-token"), Some("abc"));
        assert_eq!(header(head, "POST /x"), None);
    }
}
