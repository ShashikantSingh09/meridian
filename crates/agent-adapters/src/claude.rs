//! Claude Code through its documented print mode: stream-json both ways, prompt
//! on stdin so it never appears on a command line, and the user's own sign-in.
//! Sessions read no credential and write no config.

use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::approvals::{settings_json, Hook};
use crate::process::{spawn, Agent};
use crate::{AgentEvent, Command, Emit, Launch, SessionStatus};

/// Print mode stays alive after its result, even with stdin closed.
const EXIT_GRACE: Duration = Duration::from_secs(2);

pub fn args(launch: &Launch, hook_url: &str) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
    ]
    .map(String::from)
    .to_vec();
    args.extend(["--settings".to_string(), settings_json(hook_url)]);
    if let Some(model) = &launch.model {
        args.extend(["--model".to_string(), model.clone()]);
    }
    if let Some(id) = &launch.resume {
        args.extend(["--resume".to_string(), id.clone()]);
    }
    args
}

pub fn user_message(text: &str) -> String {
    json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "text", "text": text }] } }).to_string()
}

fn base_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// What a tool call is doing, in a few words.
pub fn tool_label(name: &str, input: &Value) -> String {
    let text = |key: &str| input[key].as_str().unwrap_or_default();
    let line = |s: &str| s.lines().next().unwrap_or_default().chars().take(80).collect::<String>();
    match name {
        "Bash" | "PowerShell" => format!("$ {}", line(text("command"))),
        "Read" => format!("Reading {}", base_name(text("file_path"))),
        "Edit" | "MultiEdit" => format!("Editing {}", base_name(text("file_path"))),
        "Write" => format!("Writing {}", base_name(text("file_path"))),
        "Grep" | "Glob" => format!("Searching {}", line(text("pattern"))),
        "WebFetch" => format!("Fetching {}", line(text("url"))),
        "WebSearch" => format!("Searching the web: {}", line(text("query"))),
        "Agent" | "Task" => format!("Subagent: {}", line(text("description"))),
        other => other.to_string(),
    }
}

pub struct Parsed {
    pub events: Vec<AgentEvent>,
    pub finished: bool,
}

fn usage_of(message: &Value) -> AgentEvent {
    let usage = &message["usage"];
    let input = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
        .iter()
        .filter_map(|k| usage[*k].as_u64())
        .sum();
    AgentEvent::Usage {
        input,
        output: usage["output_tokens"].as_u64().unwrap_or(0),
        cost_usd: message["total_cost_usd"].as_f64(),
    }
}

/// One stream-json line. Types not listed here, including ones newer CLI
/// versions add, are ignored rather than treated as errors.
pub fn parse(line: &str) -> Parsed {
    let mut events = Vec::new();
    let mut finished = false;
    let Ok(message) = serde_json::from_str::<Value>(line) else { return Parsed { events, finished } };
    let subagent = !message["parent_tool_use_id"].is_null();

    match (message["type"].as_str(), message["subtype"].as_str()) {
        (Some("system"), Some("init")) => {
            events.push(AgentEvent::Started {
                native_id: message["session_id"].as_str().map(String::from),
                model: message["model"].as_str().map(String::from),
            });
            events.push(AgentEvent::status(SessionStatus::Running));
        }
        (Some("system"), Some("api_retry")) => {
            let attempt = message["attempt"].as_u64().unwrap_or(1);
            events.push(AgentEvent::Activity { label: format!("Retrying the API, attempt {attempt}") });
        }
        (Some("stream_event"), _) if !subagent => {
            let delta = &message["event"]["delta"];
            if delta["type"] == "text_delta" {
                if let Some(text) = delta["text"].as_str() {
                    events.push(AgentEvent::Text { text: text.to_string() });
                }
            }
        }
        (Some("assistant"), _) => {
            for block in message["message"]["content"].as_array().into_iter().flatten() {
                if block["type"] == "tool_use" {
                    let label = tool_label(block["name"].as_str().unwrap_or("Tool"), &block["input"]);
                    events.push(AgentEvent::Activity { label });
                }
            }
        }
        (Some("result"), subtype) => {
            finished = true;
            events.push(usage_of(&message));
            let failed = message["is_error"].as_bool().unwrap_or(false) || subtype != Some("success");
            events.push(if failed {
                let detail = message["result"].as_str().or(subtype).unwrap_or("The run failed.");
                AgentEvent::failed(detail.chars().take(300).collect::<String>())
            } else {
                AgentEvent::status(SessionStatus::Completed)
            });
        }
        _ => {}
    }
    Parsed { events, finished }
}

async fn stop(agent: &mut Agent) {
    let _ = tokio::time::timeout(EXIT_GRACE, agent.exit_code()).await;
    agent.kill_tree().await;
}

pub async fn run(launch: Launch, emit: Emit, commands: mpsc::UnboundedReceiver<Command>, hook: &Hook) {
    let args = args(&launch, &hook.url);
    drive(launch, args, emit, commands).await;
}

/// The session loop, separated from `args` so tests can drive a stand-in agent.
pub async fn drive(launch: Launch, args: Vec<String>, emit: Emit, mut commands: mpsc::UnboundedReceiver<Command>) {
    let mut agent = match spawn(&launch.exe, &args, &launch.cwd) {
        Ok(agent) => agent,
        Err(err) => return emit(AgentEvent::failed(format!("Could not start Claude Code: {err}"))),
    };
    if let Err(err) = agent.write_line(&user_message(&launch.prompt)).await {
        agent.kill_tree().await;
        return emit(AgentEvent::failed(format!("Could not reach Claude Code: {err}")));
    }

    loop {
        tokio::select! {
            line = agent.lines.next_line() => match line {
                Ok(Some(line)) => {
                    let parsed = parse(&line);
                    parsed.events.into_iter().for_each(|e| emit(e));
                    if parsed.finished {
                        return stop(&mut agent).await;
                    }
                }
                // Out of output with no result: a crash, or a CLI killed from outside.
                _ => {
                    let code = agent.exit_code().await;
                    let detail = agent.stderr_tail();
                    let detail = if detail.is_empty() { format!("exit code {code:?}") } else { detail };
                    return emit(AgentEvent::failed(format!("Claude Code stopped unexpectedly: {detail}")));
                }
            },
            command = commands.recv() => match command {
                Some(Command::Send(text)) => {
                    if agent.write_line(&user_message(&text)).await.is_err() {
                        emit(AgentEvent::failed("Claude Code is no longer accepting input."));
                        return agent.kill_tree().await;
                    }
                }
                // Claude Code's approvals are answered at the hook, not here.
                Some(Command::Answer { .. }) => {}
                Some(Command::Cancel) | None => {
                    agent.kill_tree().await;
                    return emit(AgentEvent::status(SessionStatus::Cancelled));
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{last_status, recorder};

    // Trimmed from a real run of Claude Code 2.1.314.
    const INIT: &str = r#"{"type":"system","subtype":"init","cwd":"C:\\w","session_id":"0781dc44","model":"claude-haiku-5-5","permissionMode":"default","claude_code_version":"2.1.314"}"#;
    const TOOL: &str = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"Bash","input":{"command":"echo hello > out.txt","description":"Write"}}]},"parent_tool_use_id":null,"session_id":"0781dc44"}"#;
    const THINKING: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"x"}},"parent_tool_use_id":null}"#;
    const TEXT: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"done"}},"parent_tool_use_id":null}"#;
    const SUB_TEXT: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"inner"}},"parent_tool_use_id":"toolu_1"}"#;
    const RESULT: &str = r#"{"type":"result","subtype":"success","is_error":false,"duration_api_ms":7031,"stop_reason":"end_turn","session_id":"0781dc44","total_cost_usd":0.00930859,"result":"done","usage":{"input_tokens":4,"cache_creation_input_tokens":42623,"cache_read_input_tokens":70409,"output_tokens":159}}"#;
    const FAILED: &str = r#"{"type":"result","subtype":"success","is_error":true,"result":"Not logged in","usage":{}}"#;

    #[test]
    fn init_starts_the_session_with_its_native_id() {
        let events = parse(INIT).events;
        assert_eq!(
            events[0],
            AgentEvent::Started { native_id: Some("0781dc44".into()), model: Some("claude-haiku-5-5".into()) }
        );
        assert_eq!(events[1], AgentEvent::status(SessionStatus::Running));
    }

    #[test]
    fn tool_calls_become_activity() {
        assert_eq!(parse(TOOL).events, [AgentEvent::Activity { label: "$ echo hello > out.txt".into() }]);
    }

    #[test]
    fn only_top_level_text_reaches_the_output() {
        assert_eq!(parse(TEXT).events, [AgentEvent::Text { text: "done".into() }]);
        assert!(parse(THINKING).events.is_empty());
        assert!(parse(SUB_TEXT).events.is_empty());
    }

    #[test]
    fn a_result_finishes_with_usage_and_cost() {
        let parsed = parse(RESULT);
        assert!(parsed.finished);
        assert_eq!(parsed.events[0], AgentEvent::Usage { input: 113_036, output: 159, cost_usd: Some(0.00930859) });
        assert_eq!(parsed.events[1], AgentEvent::status(SessionStatus::Completed));
    }

    #[test]
    fn a_failed_result_says_why() {
        let parsed = parse(FAILED);
        assert!(parsed.finished);
        assert_eq!(parsed.events[1], AgentEvent::failed("Not logged in"));
    }

    #[test]
    fn unknown_lines_are_ignored() {
        for line in ["not json", r#"{"type":"rate_limit_event"}"#, r#"{"type":"brand_new_thing"}"#] {
            let parsed = parse(line);
            assert!(parsed.events.is_empty() && !parsed.finished);
        }
    }

    #[test]
    fn labels_shorten_paths_and_commands() {
        assert_eq!(tool_label("Edit", &json!({"file_path": "C:\\a\\b\\main.rs"})), "Editing main.rs");
        assert_eq!(tool_label("Bash", &json!({"command": "ls\nrm x"})), "$ ls");
        assert_eq!(tool_label("SomeMcpTool", &json!({})), "SomeMcpTool");
    }

    #[test]
    fn the_prompt_stays_off_the_command_line() {
        let launch = Launch {
            exe: "claude".into(),
            cwd: ".".into(),
            prompt: "SECRET PROMPT".into(),
            model: Some("m".into()),
            resume: Some("abc".into()),
        };
        let args = args(&launch, "http://127.0.0.1:1/perm/t");
        assert!(!args.iter().any(|a| a.contains("SECRET")));
        assert!(args.windows(2).any(|w| w == ["--resume", "abc"]));
        assert!(args.windows(2).any(|w| w == ["--model", "m"]));
    }

    // Stand-in agents: node is a dev dependency of the repo already.
    fn launch(script: &str) -> (Launch, Vec<String>) {
        let launch = Launch {
            exe: "node".into(),
            cwd: ".".into(),
            prompt: "hi".into(),
            model: None,
            resume: None,
        };
        (launch, vec!["-e".to_string(), script.to_string()])
    }

    #[tokio::test]
    async fn a_crash_before_any_result_is_reported_as_failed() {
        let (launch, args) = launch("console.error('boom happened'); process.exit(3)");
        let (emit, events) = recorder();
        let (_tx, rx) = mpsc::unbounded_channel();
        drive(launch, args, emit, rx).await;
        let events = events.lock().unwrap();
        assert_eq!(last_status(&events), Some(SessionStatus::Failed));
        assert!(format!("{:?}", events.last()).contains("stopped unexpectedly"));
    }

    #[tokio::test]
    async fn cancelling_ends_a_running_agent() {
        let (launch, args) = launch("setInterval(() => {}, 1000)");
        let (emit, events) = recorder();
        let (tx, rx) = mpsc::unbounded_channel();
        tx.send(Command::Cancel).unwrap();
        tokio::time::timeout(Duration::from_secs(10), drive(launch, args, emit, rx)).await.unwrap();
        assert_eq!(last_status(&events.lock().unwrap()), Some(SessionStatus::Cancelled));
    }

    #[tokio::test]
    async fn a_missing_executable_fails_cleanly() {
        let (mut launch, args) = launch("");
        launch.exe = "no-such-agent-binary".into();
        let (emit, events) = recorder();
        let (_tx, rx) = mpsc::unbounded_channel();
        drive(launch, args, emit, rx).await;
        assert_eq!(last_status(&events.lock().unwrap()), Some(SessionStatus::Failed));
    }

    #[tokio::test]
    async fn a_lingering_process_is_ended_after_its_result() {
        let script = format!("console.log(String.raw`{RESULT}`); setInterval(() => {{}}, 1000)");
        let (launch, args) = launch(&script);
        let (emit, events) = recorder();
        let (_tx, rx) = mpsc::unbounded_channel();
        tokio::time::timeout(Duration::from_secs(10), drive(launch, args, emit, rx)).await.unwrap();
        assert_eq!(last_status(&events.lock().unwrap()), Some(SessionStatus::Completed));
    }
}
