//! Finds installed agent CLIs. Reads only PATH and each CLI's own `--version`,
//! never credential or config files.

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;

use crate::process::{hide_console, path_with_parent};
use crate::AgentKind;

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Capabilities {
    pub approvals: bool,
    pub resume: bool,
    pub usage: bool,
    /// Neither agent reports measurable progress, and none is ever invented.
    pub progress: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentInfo {
    pub id: AgentKind,
    pub name: &'static str,
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub capabilities: Capabilities,
}

fn candidates(stem: &str) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT".into());
    let names: Vec<String> = if cfg!(windows) {
        exts.split(';').filter(|e| !e.is_empty()).map(|e| format!("{stem}{}", e.to_lowercase())).collect()
    } else {
        vec![stem.to_string()]
    };
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            found.extend(names.iter().map(|n| dir.join(n)));
        }
    }
    // A desktop app launched from the shell can miss PATH edits made by installers.
    let var = |k: &str| std::env::var_os(k).map(PathBuf::from);
    if let Some(appdata) = var("APPDATA") {
        found.push(appdata.join("npm").join(format!("{stem}.cmd")));
    }
    if let Some(home) = var("USERPROFILE").or_else(|| var("HOME")) {
        found.push(home.join(".local").join("bin").join(format!("{stem}.exe")));
        found.push(home.join(".local").join("bin").join(stem));
    }
    found.retain(|p| p.is_file());
    found
}

pub fn locate(stem: &str) -> Option<PathBuf> {
    candidates(stem).into_iter().next()
}

async fn version(exe: &PathBuf) -> Option<String> {
    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg("--version").kill_on_drop(true);
    hide_console(&mut cmd);
    path_with_parent(&mut cmd, exe);
    let output = tokio::time::timeout(Duration::from_secs(6), cmd.output()).await.ok()?.ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
}

/// What the CLI itself says about its sign-in. Never read from its files, and
/// the account's email and organization are deliberately not carried over.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    /// None when the CLI could not say.
    pub signed_in: Option<bool>,
    pub method: Option<String>,
    pub plan: Option<String>,
}

fn parse_claude_auth(json: &str) -> AuthStatus {
    let value: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
    AuthStatus {
        signed_in: value["loggedIn"].as_bool(),
        method: value["authMethod"].as_str().map(String::from),
        plan: value["subscriptionType"].as_str().map(String::from),
    }
}

fn parse_codex_auth(text: &str) -> AuthStatus {
    let line = text.lines().next().unwrap_or_default().trim();
    let method = line.strip_prefix("Logged in using ").map(String::from);
    AuthStatus { signed_in: Some(method.is_some()), method, plan: None }
}

fn stem(agent: AgentKind) -> &'static str {
    match agent {
        AgentKind::ClaudeCode => "claude",
        AgentKind::Codex => "codex",
    }
}

/// Asks the CLI through its supported status command.
pub async fn auth_status(agent: AgentKind) -> Option<AuthStatus> {
    let exe = locate(stem(agent))?;
    let mut cmd = tokio::process::Command::new(&exe);
    match agent {
        AgentKind::ClaudeCode => cmd.args(["auth", "status", "--json"]),
        AgentKind::Codex => cmd.args(["login", "status"]),
    };
    cmd.kill_on_drop(true);
    hide_console(&mut cmd);
    path_with_parent(&mut cmd, &exe);
    let output = tokio::time::timeout(Duration::from_secs(10), cmd.output()).await.ok()?.ok()?;
    Some(read_auth(agent, &output.stdout, &output.stderr))
}

/// Claude Code's stdout is JSON, which a warning on stderr would spoil if the two were joined.
/// codex prints its status on stderr in some versions.
fn read_auth(agent: AgentKind, stdout: &[u8], stderr: &[u8]) -> AuthStatus {
    match agent {
        AgentKind::ClaudeCode => parse_claude_auth(&String::from_utf8_lossy(stdout)),
        AgentKind::Codex => parse_codex_auth(&String::from_utf8_lossy(&[stdout, stderr].concat())),
    }
}

/// Starts the CLI's own sign-in in its own window. The whole flow belongs to the
/// CLI and its vendor: this app never sees a credential.
pub fn open_login(agent: AgentKind) -> Result<(), crate::AgentError> {
    let exe = locate(stem(agent)).ok_or(crate::AgentError::NotInstalled(stem(agent)))?;
    let mut cmd = std::process::Command::new(&exe);
    match agent {
        AgentKind::ClaudeCode => cmd.args(["auth", "login"]),
        AgentKind::Codex => cmd.arg("login"),
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0000_0010); // CREATE_NEW_CONSOLE
    }
    cmd.spawn().map(|_| ()).map_err(|e| crate::AgentError::Spawn(e.to_string()))
}

pub async fn detect() -> Vec<AgentInfo> {
    let probe = |id, name, stem: &'static str, capabilities| async move {
        let exe = locate(stem);
        let version = match &exe {
            Some(exe) => version(exe).await,
            None => None,
        };
        AgentInfo {
            id,
            name,
            installed: exe.is_some(),
            path: exe.map(|p| p.to_string_lossy().into_owned()),
            version,
            capabilities,
        }
    };
    let caps = Capabilities { approvals: true, resume: true, usage: true, progress: false };
    let (claude, codex) = tokio::join!(
        probe(AgentKind::ClaudeCode, "Claude Code", "claude", caps),
        probe(AgentKind::Codex, "Codex CLI", "codex", caps),
    );
    vec![claude, codex]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_cli_is_not_found_rather_than_an_error() {
        assert!(locate("definitely-not-an-agent-cli").is_none());
    }

    #[test]
    fn claude_status_keeps_the_plan_and_drops_the_account() {
        let json = r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"a@b.c","orgId":"x","orgName":"y","subscriptionType":"max"}"#;
        let status = parse_claude_auth(json);
        assert_eq!(status.signed_in, Some(true));
        assert_eq!(status.plan.as_deref(), Some("max"));
        assert!(!serde_json::to_string(&status).unwrap().contains("a@b.c"));
    }

    #[test]
    fn claude_signed_out_and_garbage_are_told_apart() {
        assert_eq!(parse_claude_auth(r#"{"loggedIn":false}"#).signed_in, Some(false));
        assert_eq!(parse_claude_auth("not json").signed_in, None);
    }

    #[test]
    fn a_warning_on_stderr_does_not_hide_claudes_status() {
        let status = read_auth(AgentKind::ClaudeCode, br#"{"loggedIn":true}"#, b"(node:1) DeprecationWarning: x\n");
        assert_eq!(status.signed_in, Some(true));
        assert_eq!(read_auth(AgentKind::Codex, b"", b"Logged in using ChatGPT\n").method.as_deref(), Some("ChatGPT"));
    }

    #[test]
    fn codex_status_is_read_from_its_one_line() {
        assert_eq!(parse_codex_auth("Logged in using ChatGPT\n").method.as_deref(), Some("ChatGPT"));
        assert_eq!(parse_codex_auth("Not logged in\n").signed_in, Some(false));
    }

    #[test]
    fn serialises_the_ids_the_interface_expects() {
        assert_eq!(serde_json::to_string(&AgentKind::ClaudeCode).unwrap(), r#""claude-code""#);
        assert_eq!(serde_json::to_string(&AgentKind::Codex).unwrap(), r#""codex""#);
    }
}
