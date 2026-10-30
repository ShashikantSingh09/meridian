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

pub use detect::{detect, Capabilities, AgentInfo};

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Approval {
    pub id: String,
    pub tool: String,
    pub summary: String,
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
    Send(String),
    Answer { id: String, allow: bool },
    Cancel,
}

pub(crate) type Emit = Arc<dyn Fn(AgentEvent) + Send + Sync>;

/// What an adapter needs to run or resume one session.
pub(crate) struct Launch {
    pub exe: PathBuf,
    pub cwd: String,
    pub prompt: String,
    pub model: Option<String>,
    pub resume: Option<String>,
}

/// How to pick a finished session up again.
#[derive(Clone)]
struct Finished {
    agent: AgentKind,
    cwd: String,
    model: Option<String>,
    native_id: String,
}

struct Inner {
    live: HashMap<String, mpsc::UnboundedSender<Command>>,
    native: HashMap<String, String>,
    finished: HashMap<String, Finished>,
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
        let inner = Inner { live: HashMap::new(), native: HashMap::new(), finished: HashMap::new() };
        Ok(Self { inner: Arc::new(Mutex::new(inner)), emit, approvals })
    }

    pub fn start(&self, request: StartRequest) -> Result<String, AgentError> {
        if !std::path::Path::new(&request.cwd).is_dir() {
            return Err(AgentError::BadFolder(request.cwd));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let launch = Launch {
            exe: locate(request.agent)?,
            cwd: request.cwd,
            prompt: request.prompt,
            model: request.model,
            resume: None,
        };
        self.launch(id.clone(), request.agent, launch);
        Ok(id)
    }

    fn launch(&self, id: String, agent: AgentKind, launch: Launch) {
        let (tx, rx) = mpsc::unbounded_channel();
        self.inner.lock().unwrap().live.insert(id.clone(), tx);

        let this = self.clone();
        let cwd = launch.cwd.clone();
        let model = launch.model.clone();
        let session = id;
        let emit: Emit = Arc::new(move |event| {
            let mut inner = this.inner.lock().unwrap();
            match &event {
                AgentEvent::Started { native_id: Some(native), .. } => {
                    inner.native.insert(session.clone(), native.clone());
                }
                // Retired here, not when the task ends: the process may take a
                // moment to go, and by then a follow-up may have resumed this id.
                AgentEvent::Status { status: SessionStatus::Completed | SessionStatus::Failed | SessionStatus::Cancelled, .. } => {
                    inner.live.remove(&session);
                    if let Some(native_id) = inner.native.get(&session).cloned() {
                        let finished = Finished { agent, cwd: cwd.clone(), model: model.clone(), native_id };
                        inner.finished.insert(session.clone(), finished);
                    }
                }
                _ => {}
            }
            drop(inner);
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
        });
    }

    /// Delivers an instruction: straight to a live session, or by resuming a
    /// finished one under the same id.
    pub fn send(&self, id: &str, text: String) -> Result<(), AgentError> {
        let finished = {
            let inner = self.inner.lock().unwrap();
            if let Some(tx) = inner.live.get(id) {
                let _ = tx.send(Command::Send(text));
                return Ok(());
            }
            inner.finished.get(id).cloned().ok_or(AgentError::UnknownSession)?
        };
        let launch = Launch {
            exe: locate(finished.agent)?,
            cwd: finished.cwd,
            prompt: text,
            model: finished.model,
            resume: Some(finished.native_id),
        };
        (self.emit)(Envelope { session_id: id.to_string(), event: AgentEvent::status(SessionStatus::Starting) });
        self.launch(id.to_string(), finished.agent, launch);
        Ok(())
    }

    pub fn cancel(&self, id: &str) -> Result<(), AgentError> {
        let inner = self.inner.lock().unwrap();
        let tx = inner.live.get(id).ok_or(AgentError::UnknownSession)?;
        let _ = tx.send(Command::Cancel);
        Ok(())
    }

    pub fn answer(&self, id: &str, approval: &str, allow: bool) -> Result<(), AgentError> {
        if self.approvals.answer(approval, allow) {
            return Ok(());
        }
        let inner = self.inner.lock().unwrap();
        let tx = inner.live.get(id).ok_or(AgentError::UnknownSession)?;
        let _ = tx.send(Command::Answer { id: approval.to_string(), allow });
        Ok(())
    }

    /// Ends every live session. Called on quit, so no agent outlives the app.
    pub fn shutdown(&self) {
        for tx in self.inner.lock().unwrap().live.values() {
            let _ = tx.send(Command::Cancel);
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
