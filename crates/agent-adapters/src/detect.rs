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
    fn serialises_the_ids_the_interface_expects() {
        assert_eq!(serde_json::to_string(&AgentKind::ClaudeCode).unwrap(), r#""claude-code""#);
        assert_eq!(serde_json::to_string(&AgentKind::Codex).unwrap(), r#""codex""#);
    }
}
