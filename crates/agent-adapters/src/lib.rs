//! Coding agents behind one session model. Each adapter speaks its agent's own
//! documented protocol and owns its process; nothing assumes two agents work
//! alike. Everything reaches the app as an [`Envelope`] through one callback.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

mod approvals;
mod claude;
mod codex;
mod detect;
mod process;
pub mod watch;

pub use detect::{auth_status, detect, open_login, AgentInfo, AuthStatus, Capabilities};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentKind {
    #[serde(rename = "claude-code")]
    ClaudeCode,
    #[serde(rename = "codex")]
    Codex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    Starting,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Approval {
    pub id: String,
    pub tool: String,
    pub summary: String,
    /// What Claude Code is asking the user to choose, for AskUserQuestion.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub questions: Vec<Question>,
    /// The plan to approve, for ExitPlanMode.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Question {
    pub text: String,
    pub options: Vec<String>,
    pub multi: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentEvent {
    Started { native_id: Option<String>, model: Option<String> },
    Status { status: SessionStatus, message: Option<String> },
    Text { text: String },
    Activity { label: String },
    Approval { approval: Approval },
    ApprovalResolved { id: String },
    Usage { input: u64, output: u64, cost_usd: Option<f64> },
    /// A session this app did not start, heard from for the first time.
    Watched { agent: String, cwd: String, title: Option<String> },
    /// Lines an edit takes out and puts in, shown while it happens and never saved.
    Diff { path: String, removed: Vec<String>, added: Vec<String> },
    /// The end of what a command printed, on the same terms.
    Output { command: String, lines: Vec<String>, failed: bool },
}

impl AgentEvent {
    pub(crate) fn status(status: SessionStatus) -> Self {
        Self::Status { status, message: None }
    }

    pub(crate) fn failed(message: impl Into<String>) -> Self {
        Self::Status { status: SessionStatus::Failed, message: Some(message.into()) }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub session_id: String,
    pub event: AgentEvent,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StartRequest {
    pub agent: AgentKind,
    pub cwd: String,
    pub prompt: String,
    pub model: Option<String>,
    /// General assistant: no shell, no file edits, no connectors.
    #[serde(default)]
    pub restricted: bool,
    /// Data URLs the user approved for sharing.
    #[serde(default)]
    pub images: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("{0} is not installed, or was not found on PATH.")]
    NotInstalled(&'static str),
    #[error("That project folder does not exist: {0}")]
    BadFolder(String),
    #[error("No session with that id.")]
    UnknownSession,
    #[error("Could not start the agent: {0}")]
    Spawn(String),
}

pub(crate) enum Command {
    Send { text: String, images: Vec<String> },
    Answer { id: String, allow: bool },
    /// Stop the current turn, keeping the session where the agent allows it.
    Cancel,
    /// End everything now: the app is quitting.
    Kill,
}

pub(crate) type Emit = Arc<dyn Fn(AgentEvent) + Send + Sync>;

/// What an adapter needs to run or resume one session.
pub(crate) struct Launch {
    pub exe: PathBuf,
    pub cwd: String,
    pub prompt: String,
    pub model: Option<String>,
    pub resume: Option<String>,
    pub restricted: bool,
    pub images: Vec<String>,
}

/// A conversation from an earlier run of the app, which is enough to pick it up again.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Earlier {
    pub id: String,
    pub agent: AgentKind,
    pub cwd: String,
    pub model: Option<String>,
    pub restricted: bool,
    pub native_id: String,
}

/// The id goes to the agent as a command-line value, so it must not be able to read as a flag.
fn plain_id(id: &str) -> bool {
    !id.is_empty() && !id.starts_with('-') && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

struct Record {
    agent: AgentKind,
    cwd: String,
    model: Option<String>,
    restricted: bool,
    /// The agent's own id, needed to resume after the process has gone.
    native_id: Option<String>,
    /// The running process, tagged so a finishing run cannot retire its successor.
    live: Option<(u64, mpsc::UnboundedSender<Command>)>,
}

#[derive(Default)]
struct Inner {
    records: HashMap<String, Record>,
    runs: u64,
}

#[derive(Clone)]
pub struct Sessions {
    inner: Arc<Mutex<Inner>>,
    emit: Arc<dyn Fn(Envelope) + Send + Sync>,
    approvals: approvals::ApprovalServer,
}

fn locate(agent: AgentKind) -> Result<PathBuf, AgentError> {
    let (stem, name) = match agent {
        AgentKind::ClaudeCode => ("claude", "Claude Code"),
        AgentKind::Codex => ("codex", "Codex CLI"),
    };
    detect::locate(stem).ok_or(AgentError::NotInstalled(name))
}

impl Sessions {
    pub async fn new(emit: impl Fn(Envelope) + Send + Sync + 'static) -> std::io::Result<Self> {
        let emit: Arc<dyn Fn(Envelope) + Send + Sync> = Arc::new(emit);
        let approvals = approvals::ApprovalServer::start().await?;
        Ok(Self { inner: Arc::default(), emit, approvals })
    }

    pub fn start(&self, request: StartRequest) -> Result<String, AgentError> {
        if !std::path::Path::new(&request.cwd).is_dir() {
            return Err(AgentError::BadFolder(request.cwd));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let launch = Launch {
            exe: locate(request.agent)?,
            cwd: request.cwd.clone(),
            prompt: request.prompt,
            model: request.model.clone(),
            resume: None,
            restricted: request.restricted,
            images: request.images,
        };
        let record = Record {
            agent: request.agent,
            cwd: request.cwd,
            model: request.model,
            restricted: request.restricted,
            native_id: None,
            live: None,
        };
        self.inner.lock().unwrap().records.insert(id.clone(), record);
        self.launch(id.clone(), request.agent, launch);
        Ok(id)
    }

    fn launch(&self, id: String, agent: AgentKind, launch: Launch) {
        let (tx, rx) = mpsc::unbounded_channel();
        let run = {
            let mut inner = self.inner.lock().unwrap();
            inner.runs += 1;
            let run = inner.runs;
            if let Some(record) = inner.records.get_mut(&id) {
                record.live = Some((run, tx));
            }
            run
        };

        let this = self.clone();
        let session = id.clone();
        let emit: Emit = Arc::new(move |event| {
            if let AgentEvent::Started { native_id: Some(native), .. } = &event {
                if let Some(record) = this.inner.lock().unwrap().records.get_mut(&session) {
                    record.native_id = Some(native.clone());
                }
            }
            (this.emit)(Envelope { session_id: session.clone(), event });
        });

        let this = self.clone();
        tokio::spawn(async move {
            match agent {
                AgentKind::ClaudeCode => {
                    let hook = this.approvals.register(emit.clone());
                    claude::run(launch, emit, rx, &hook).await;
                    this.approvals.unregister(&hook);
                }
                AgentKind::Codex => codex::run(launch, emit, rx).await,
            }
            if let Some(record) = this.inner.lock().unwrap().records.get_mut(&id) {
                if matches!(record.live, Some((current, _)) if current == run) {
                    record.live = None;
                }
            }
        });
    }

    /// Takes back a conversation from before a restart, so that `send` can resume it.
    /// A session this run already knows is left as it is.
    pub fn adopt(&self, earlier: Earlier) -> Result<(), AgentError> {
        if !plain_id(&earlier.native_id) {
            return Err(AgentError::UnknownSession);
        }
        let record = Record {
            agent: earlier.agent,
            cwd: earlier.cwd,
            model: earlier.model,
            restricted: earlier.restricted,
            native_id: Some(earlier.native_id),
            live: None,
        };
        self.inner.lock().unwrap().records.entry(earlier.id).or_insert(record);
        Ok(())
    }

    /// Delivers an instruction: straight to a running process, or by resuming
    /// the session if its process has gone.
    pub fn send(&self, id: &str, text: String, images: Vec<String>) -> Result<(), AgentError> {
        let launch = {
            let inner = self.inner.lock().unwrap();
            let record = inner.records.get(id).ok_or(AgentError::UnknownSession)?;
            if let Some((_, tx)) = &record.live {
                if tx.send(Command::Send { text: text.clone(), images: images.clone() }).is_ok() {
                    return Ok(());
                }
            }
            Launch {
                exe: locate(record.agent)?,
                cwd: record.cwd.clone(),
                prompt: text,
                model: record.model.clone(),
                resume: Some(record.native_id.clone().ok_or(AgentError::UnknownSession)?),
                restricted: record.restricted,
                images,
            }
        };
        let agent = self.inner.lock().unwrap().records[id].agent;
        (self.emit)(Envelope { session_id: id.to_string(), event: AgentEvent::status(SessionStatus::Starting) });
        self.launch(id.to_string(), agent, launch);
        Ok(())
    }

    fn command(&self, id: &str, command: Command) -> Result<(), AgentError> {
        let inner = self.inner.lock().unwrap();
        let live = inner.records.get(id).and_then(|r| r.live.as_ref());
        let (_, tx) = live.ok_or(AgentError::UnknownSession)?;
        let _ = tx.send(command);
        Ok(())
    }

    pub fn cancel(&self, id: &str) -> Result<(), AgentError> {
        self.command(id, Command::Cancel)
    }

    pub fn answer(&self, id: &str, approval: &str, allow: bool) -> Result<(), AgentError> {
        if self.approvals.answer(approval, allow) {
            return Ok(());
        }
        self.command(id, Command::Answer { id: approval.to_string(), allow })
    }

    /// Ends every live session. Called on quit, so no agent outlives the app.
    pub fn shutdown(&self) {
        for record in self.inner.lock().unwrap().records.values() {
            if let Some((_, tx)) = &record.live {
                let _ = tx.send(Command::Kill);
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    /// An `Emit` that records into a shared vector.
    pub fn recorder() -> (Emit, Arc<Mutex<Vec<AgentEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let log = events.clone();
        (Arc::new(move |e| log.lock().unwrap().push(e)), events)
    }

    pub fn last_status(events: &[AgentEvent]) -> Option<SessionStatus> {
        events.iter().rev().find_map(|e| match e {
            AgentEvent::Status { status, .. } => Some(*status),
            _ => None,
        })
    }
}
