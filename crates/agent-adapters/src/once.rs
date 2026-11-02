//! One question to Claude Code, apart from any session. Hooks and session history are off, so what
//! the question held lands nowhere on this PC, and with no tools the run can do nothing but answer.

use std::time::Duration;

use serde_json::{json, Value};

use crate::process::{self, Agent};
use crate::{claude, detect};

pub(crate) fn args(model: &str, most_usd: &str) -> Vec<String> {
    let args = [
        "-p", "--model", model, "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--permission-mode", "dontAsk", "--max-budget-usd", most_usd,
        "--tools", "",
    ];
    args.map(String::from).to_vec()
}

/// Starts a run in a folder of its own, and hands it the question.
pub(crate) async fn start(name: &str, settings: &str, mut args: Vec<String>, message: &str) -> Result<Agent, String> {
    let exe = detect::locate("claude").ok_or("Claude Code is not installed on this PC.")?;
    let folder = std::env::temp_dir().join("meridian-once");
    std::fs::create_dir_all(&folder).map_err(|err| err.to_string())?;
    // A file, because a shim from an npm install would mangle the quotes in JSON on a command line.
    let file = folder.join(format!("{name}.json"));
    std::fs::write(&file, settings).map_err(|err| err.to_string())?;
    args.extend(["--settings".to_string(), file.display().to_string()]);
    let mut agent = process::spawn(&exe, &args, &folder.to_string_lossy()).map_err(|err| err.to_string())?;
    agent.write_line(&claude::user_message(message, &[])).await.map_err(|err| err.to_string())?;
    Ok(agent)
}

pub(crate) fn reply_of(result: &Value) -> Result<String, String> {
    let text = result["result"].as_str().unwrap_or_default().trim();
    if result["is_error"] == true || text.is_empty() {
        return Err(if text.is_empty() { result["subtype"].as_str().unwrap_or("Claude Code gave no answer.") } else { text }.to_string());
    }
    Ok(text.to_string())
}

async fn answer(agent: &mut Agent) -> Result<String, String> {
    while let Ok(Some(line)) = agent.lines.next_line().await {
        let Ok(record) = serde_json::from_str::<Value>(&line) else { continue };
        if record["type"] == "result" {
            return reply_of(&record);
        }
    }
    Err(format!("Claude Code stopped before answering. {}", agent.stderr_tail()))
}

/// Asks and returns the reply. No server of any kind loads for this.
pub async fn ask(system: &str, message: &str, model: &str, most_usd: &str, longest: Duration) -> Result<String, String> {
    let mut args = args(model, most_usd);
    args.extend(["--strict-mcp-config".to_string(), "--system-prompt".to_string(), system.to_string()]);
    let settings = json!({ "disableAllHooks": true }).to_string();
    let mut agent = start("quiet", &settings, args, message).await?;
    let reply = tokio::time::timeout(longest, answer(&mut agent)).await.unwrap_or_else(|_| Err("Claude Code took too long to answer.".to_string()));
    agent.kill_tree().await;
    reply
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_can_do_nothing_but_answer_and_leaves_nothing_behind() {
        let args = args("haiku", "0.5");
        let after = |flag: &str| &args[args.iter().position(|arg| arg == flag).unwrap() + 1];
        assert_eq!(after("--tools"), "");
        assert_eq!(after("--permission-mode"), "dontAsk");
        assert_eq!(after("--model"), "haiku");
        assert_eq!(after("--max-budget-usd"), "0.5");
        assert!(args.iter().any(|arg| arg == "--no-session-persistence"));
    }

    #[test]
    fn a_failed_run_says_why() {
        assert_eq!(reply_of(&json!({ "result": " Two emails. ", "is_error": false })), Ok("Two emails.".to_string()));
        assert_eq!(reply_of(&json!({ "result": "Not logged in", "is_error": true })), Err("Not logged in".to_string()));
        assert_eq!(reply_of(&json!({ "subtype": "error_max_budget_usd", "is_error": true })), Err("error_max_budget_usd".to_string()));
    }

    #[tokio::test]
    #[ignore = "asks the real Claude Code, on the user's plan"]
    async fn a_real_question_gets_a_real_answer() {
        let started = std::time::Instant::now();
        let reply = ask("Reply with the single word ready.", "Are you there?", "haiku", "0.1", Duration::from_secs(60)).await;
        println!("{reply:?} in {:?}", started.elapsed());
        assert!(reply.unwrap().to_lowercase().contains("ready"));
    }
}
