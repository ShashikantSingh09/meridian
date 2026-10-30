//! Real Claude Code against the watcher. Its hooks are loaded from a temporary
//! file with `--settings`, so the user's own settings are never touched. Spends a
//! little of the signed-in plan, which is why it is ignored by default:
//!
//! cargo test -p agent-adapters --test live_watch -- --ignored --nocapture

use std::process::Stdio;
use std::time::Duration;

use agent_adapters::watch::{self, Watcher, HOOK_PATH};
use agent_adapters::{detect, AgentEvent, AgentKind, SessionStatus};
use tokio::process::Command;
use tokio::sync::mpsc;

#[tokio::test]
#[ignore = "runs the real claude CLI and spends a little of the signed-in plan"]
async fn real_hooks_reach_the_island_and_an_answer_reaches_the_terminal() {
    let claude = detect().await.into_iter().find(|a| matches!(a.id, AgentKind::ClaudeCode) && a.installed).expect("claude is installed");

    let dir = std::env::temp_dir().join(format!("meridian-live-watch-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let settings = dir.join("settings.json");

    let (sender, mut events) = mpsc::unbounded_channel();
    let token = "live-token".to_string();
    let watcher = Watcher::start(0, token.clone(), move |envelope| drop(sender.send(envelope))).await.unwrap();
    watch::install(&settings, &format!("http://127.0.0.1:{}{HOOK_PATH}", watcher.port()), &token).unwrap();

    // Writing a file is what makes Claude Code ask. Reading or echoing does not.
    let child = Command::new(claude.path.unwrap())
        .args(["-p", "Use the Write tool to create a file named note.txt in this folder containing the word hi. Then reply with the single word done."])
        .args(["--model", "haiku", "--settings"])
        .arg(&settings)
        .current_dir(&dir)
        .env_remove("CLAUDECODE")
        .env_remove("MERIDIAN_RUN")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let mut seen = Vec::new();
    let mut approved = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        let next = tokio::select! {
            envelope = events.recv() => envelope,
            _ = tokio::time::sleep_until(deadline) => None,
        };
        let Some(envelope) = next else { break };
        println!("{:?}", envelope.event);
        if let AgentEvent::Approval { approval } = &envelope.event {
            assert!(watcher.answer(&envelope.session_id, &approval.id, true));
            approved = true;
        }
        let finished = matches!(&envelope.event, AgentEvent::Status { status: SessionStatus::Completed | SessionStatus::Failed, .. });
        seen.push(envelope.event);
        if finished {
            break;
        }
    }
    let output = child.wait_with_output().await.unwrap();
    println!("{}", String::from_utf8_lossy(&output.stdout));
    watcher.stop();
    let written = dir.join("note.txt").exists();
    let _ = std::fs::remove_dir_all(&dir);

    assert!(matches!(seen.first(), Some(AgentEvent::Watched { .. })), "first event was {:?}", seen.first());
    assert!(seen.iter().any(|e| matches!(e, AgentEvent::Activity { .. })), "no activity was seen");
    assert!(approved, "Claude Code never asked, so the permission path was not exercised");
    assert!(written, "the allow did not reach Claude Code");
}
