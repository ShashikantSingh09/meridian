//! Claude Code through its documented print mode: stream-json both ways, prompt
//! on stdin so it never appears on a command line, and the user's own sign-in.
//! Sessions read no credential and write no config.

use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::approvals::{settings_json, Hook};
use crate::process::spawn;
use crate::{AgentEvent, Command, Emit, Launch, LimitWindow, SessionStatus, Todo};

/// Print mode keeps running after a result and takes the next message on the
/// same process: about 1.5 s to answer, against 6.7 s from cold. Each one holds
/// about 300 MB, so an idle session keeps it this long, then resumes from the
/// transcript if needed.
const IDLE_KEEP: Duration = Duration::from_secs(180);
/// How long a turn gets to acknowledge an interrupt before the process goes.
const INTERRUPT_GRACE: Duration = Duration::from_secs(4);
/// What the assistant may reach for. Commands and edits still stop on the island for a yes, and with
/// --strict-mcp-config none of the user's connectors come along.
const GENERAL_TOOLS: &str = "WebSearch,WebFetch,Read,Bash,Edit,Write";
/// Looking things up asks nothing of the PC, so a question about the weather needs no permission.
const GENERAL_ALLOWED: [&str; 2] = ["WebSearch", "WebFetch"];

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
    if launch.restricted {
        args.extend(["--tools".to_string(), GENERAL_TOOLS.to_string(), "--strict-mcp-config".to_string()]);
        let mut allowed: Vec<String> = GENERAL_ALLOWED.map(String::from).to_vec();
        if let Some(assistant) = &launch.assistant {
            let servers = json!({ "mcpServers": { assistant.server.clone(): { "type": "http", "url": assistant.tools_url } } });
            args.extend(["--mcp-config".to_string(), servers.to_string()]);
            args.extend(["--append-system-prompt".to_string(), assistant.instructions.clone()]);
            allowed.extend(assistant.allowed.iter().cloned());
        }
        args.extend(["--allowedTools".to_string(), allowed.join(",")]);
    }
    args
}

pub fn user_message(text: &str, images: &[String]) -> String {
    let mut content: Vec<Value> = images
        .iter()
        .filter_map(|url| url.strip_prefix("data:")?.split_once(";base64,"))
        .map(|(media, data)| json!({ "type": "image", "source": { "type": "base64", "media_type": media, "data": data } }))
        .collect();
    content.push(json!({ "type": "text", "text": text }));
    json!({ "type": "user", "message": { "role": "user", "content": content } }).to_string()
}

/// Stops the running turn and leaves the session able to continue.
fn interrupt_message() -> String {
    json!({ "type": "control_request", "request_id": "meridian-interrupt", "request": { "subtype": "interrupt" } }).to_string()
}

fn base_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// The end of a path: enough to tell two files of one name apart, and still fit on the island.
fn short_path(path: &str) -> String {
    let mut parts: Vec<&str> = path.rsplit(['/', '\\']).take(3).collect();
    parts.reverse();
    parts.join("/")
}

/// What a tool call is doing, in a few words.
const CHANGE_LINES: usize = 6;
/// Enough to reach a test runner's summary, which sits above its timings.
const OUTPUT_LINES: usize = 4;
const LINE_CHARS: usize = 200;

fn lines_of(text: &str, limit: usize) -> Vec<String> {
    text.lines().take(limit).map(|line| line.chars().take(LINE_CHARS).collect()).collect()
}

/// How many lines really differ. An edit quotes the lines around its change, which are not part of it.
fn lines_changed(old: &str, new: &str) -> (usize, usize) {
    let (old, new): (Vec<&str>, Vec<&str>) = (old.lines().collect(), new.lines().collect());
    let head = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
    let tail = old[head..].iter().rev().zip(new[head..].iter().rev()).take_while(|(a, b)| a == b).count();
    (old.len() - head - tail, new.len() - head - tail)
}

/// What an edit changes, so the work can be watched rather than taken on trust.
pub(crate) fn code_change(tool: &str, input: &Value) -> Option<AgentEvent> {
    let text = |key: &str| input[key].as_str().unwrap_or_default();
    let path = base_name(text("file_path")).to_string();
    match tool {
        "Edit" => {
            let (old, new) = (text("old_string"), text("new_string"));
            let (lines_removed, lines_added) = lines_changed(old, new);
            Some(AgentEvent::Diff { path, removed: lines_of(old, CHANGE_LINES), added: lines_of(new, CHANGE_LINES), lines_removed, lines_added })
        }
        // A whole file can hold anything, so only its length is shown.
        "Write" => Some(AgentEvent::Diff { path, removed: vec![], added: vec![], lines_removed: 0, lines_added: text("content").lines().count() }),
        _ => None,
    }
}

/// Tools that only keep the agent's list. They are bookkeeping, not a step of the work.
pub(crate) fn keeps_list(tool: &str) -> bool {
    matches!(tool, "TodoWrite" | "TaskCreate" | "TaskUpdate" | "TaskGet" | "TaskList")
}

/// What a call does to the agent's list. Print mode has TodoWrite and a terminal has the Task tools,
/// so both are read. A new task arrives with its result, which is where it gets its id.
pub(crate) fn todo_change(tool: &str, input: &Value) -> Option<AgentEvent> {
    match tool {
        "TodoWrite" => {
            let items = input["todos"].as_array()?.iter().enumerate().filter_map(|(i, todo)| {
                let text = todo["content"].as_str()?.to_string();
                Some(Todo { id: i.to_string(), text, status: todo["status"].as_str().unwrap_or("pending").to_string() })
            });
            Some(AgentEvent::Todos { items: items.collect() })
        }
        "TaskUpdate" => Some(AgentEvent::TodoChanged {
            id: input["taskId"].as_str()?.to_string(),
            text: input["subject"].as_str().map(String::from),
            status: input["status"].as_str().map(String::from),
        }),
        _ => None,
    }
}

pub(crate) fn task_created(result: &Value) -> Option<AgentEvent> {
    let task = &result["task"];
    Some(AgentEvent::TodoChanged { id: task["id"].as_str()?.to_string(), text: task["subject"].as_str().map(String::from), status: None })
}

/// The end of what a finished command printed.
pub(crate) fn command_output(input: &Value, response: &Value) -> Option<AgentEvent> {
    let command = input["command"].as_str()?;
    let stdout = response["stdout"].as_str().unwrap_or_default();
    let stderr = response["stderr"].as_str().unwrap_or_default();
    let failed = stdout.trim().is_empty() && !stderr.trim().is_empty();
    // The CLI adds a note about the working folder, which nothing printed.
    let printed: Vec<&str> = if failed { stderr } else { stdout }.lines().filter(|line| !line.trim().is_empty() && !line.starts_with("Shell cwd was reset")).collect();
    let tail = printed[printed.len().saturating_sub(OUTPUT_LINES)..].join("\n");
    (!tail.is_empty()).then(|| AgentEvent::Output {
        command: lines_of(command, 1).concat(),
        lines: lines_of(&tail, OUTPUT_LINES),
        failed,
    })
}

pub fn tool_label(name: &str, input: &Value) -> String {
    let text = |key: &str| input[key].as_str().unwrap_or_default();
    let line = |s: &str| s.lines().next().unwrap_or_default().chars().take(80).collect::<String>();
    match name {
        "Bash" | "PowerShell" => format!("$ {}", line(text("command"))),
        "Read" => format!("Reading {}", short_path(text("file_path"))),
        "Edit" | "MultiEdit" => format!("Editing {}", short_path(text("file_path"))),
        "Write" => format!("Writing {}", short_path(text("file_path"))),
        "Grep" | "Glob" => format!("Searching {}", line(text("pattern"))),
        "WebFetch" => format!("Fetching {}", line(text("url"))),
        "WebSearch" => format!("Searching the web: {}", line(text("query"))),
        "Agent" | "Task" => format!("Subagent: {}", line(text("description"))),
        other => match connector_tool(other) {
            Some(tool) => format!("Tool: {tool}"),
            None => other.to_string(),
        },
    }
}

/// A connector's tool in plain words, as mcp__meridian__open_app reads Open app.
pub(crate) fn connector_tool(name: &str) -> Option<String> {
    let tool = name.strip_prefix("mcp__")?.rsplit("__").next()?.replace(['_', '-'], " ");
    let mut letters = tool.chars();
    Some(letters.next()?.to_uppercase().chain(letters).collect())
}

pub struct Parsed {
    pub events: Vec<AgentEvent>,
    pub finished: bool,
}

fn input_tokens(usage: &Value) -> u64 {
    ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].iter().filter_map(|k| usage[*k].as_u64()).sum()
}

fn usage_of(message: &Value) -> AgentEvent {
    let usage = &message["usage"];
    AgentEvent::Usage {
        input: input_tokens(usage),
        output: usage["output_tokens"].as_u64().unwrap_or(0),
        cost_usd: message["total_cost_usd"].as_f64(),
    }
}

/// Each window of the plan, which the CLI reports as a fraction used.
fn limits_of(message: &Value) -> Option<AgentEvent> {
    let windows: Vec<LimitWindow> = message["rate_limit_info"]["unifiedWindows"]
        .as_object()?
        .iter()
        .filter_map(|(window, info)| {
            let used_percent = info["utilization"].as_f64()? * 100.0;
            Some(LimitWindow { window: window.clone(), used_percent, resets_at: info["resetsAt"].as_i64() })
        })
        .collect();
    (!windows.is_empty()).then_some(AgentEvent::Limits { windows })
}

/// What finished commands printed, which print mode reports only by the id of the call. Each call is
/// noted here on its way past, so that its result can name the command.
fn command_results(line: &str, running: &mut HashMap<String, String>) -> Vec<AgentEvent> {
    let mut events = Vec::new();
    let Ok(message) = serde_json::from_str::<Value>(line) else { return events };
    for block in message["message"]["content"].as_array().into_iter().flatten() {
        match block["type"].as_str() {
            Some("tool_use") => {
                if let (Some(id), Some(command)) = (block["id"].as_str(), block["input"]["command"].as_str()) {
                    running.insert(id.to_string(), command.to_string());
                }
            }
            Some("tool_result") => {
                let Some(command) = block["tool_use_id"].as_str().and_then(|id| running.remove(id)) else { continue };
                let printed = match &block["content"] {
                    Value::String(text) => text.clone(),
                    parts => parts.as_array().into_iter().flatten().filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join("\n"),
                };
                let stream = if block["is_error"] == true { "stderr" } else { "stdout" };
                events.extend(command_output(&json!({ "command": command }), &json!({ stream: printed })));
            }
            _ => {}
        }
    }
    events
}

/// One stream-json line. Types not listed here, including ones newer CLI
/// versions add, are ignored rather than treated as errors. An interrupted turn
/// ends in an error result, which is the outcome the user asked for.
pub fn parse(line: &str, interrupted: bool) -> Parsed {
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
        (Some("rate_limit_event"), _) => events.extend(limits_of(&message)),
        (Some("assistant"), _) => {
            // Each reply starts from the whole conversation, so its input is how full that is.
            let used = input_tokens(&message["message"]["usage"]);
            if used > 0 && !subagent {
                events.push(AgentEvent::Context { used: Some(used), size: None });
            }
            for block in message["message"]["content"].as_array().into_iter().flatten() {
                if block["type"] == "tool_use" {
                    let (tool, input) = (block["name"].as_str().unwrap_or("Tool"), &block["input"]);
                    if !keeps_list(tool) {
                        events.push(AgentEvent::Activity { label: tool_label(tool, input) });
                    }
                    // A helper's list is its own, and would replace the one on show.
                    events.extend(todo_change(tool, input).filter(|_| !subagent));
                    events.extend(code_change(tool, input));
                }
            }
        }
        (Some("user"), _) if !subagent => events.extend(task_created(&message["tool_use_result"])),
        (Some("result"), subtype) => {
            finished = true;
            events.push(usage_of(&message));
            let size = message["modelUsage"].as_object().and_then(|models| models.values().filter_map(|m| m["contextWindow"].as_u64()).max());
            if size.is_some() {
                events.push(AgentEvent::Context { used: None, size });
            }
            let failed = message["is_error"].as_bool().unwrap_or(false) || subtype != Some("success");
            events.push(if interrupted {
                AgentEvent::status(SessionStatus::Cancelled)
            } else if failed {
                let detail = message["result"].as_str().filter(|d| !d.is_empty()).or(subtype).unwrap_or("The run failed.");
                AgentEvent::failed(detail.chars().take(300).collect::<String>())
            } else {
                AgentEvent::status(SessionStatus::Completed)
            });
        }
        _ => {}
    }
    Parsed { events, finished }
}

pub async fn run(launch: Launch, emit: Emit, commands: mpsc::UnboundedReceiver<Command>, hook: &Hook) {
    let args = args(&launch, &hook.url);
    drive(launch, args, emit, commands).await;
}

/// The session loop, separated from `args` so tests can drive a stand-in agent.
pub async fn drive(launch: Launch, args: Vec<String>, emit: Emit, commands: mpsc::UnboundedReceiver<Command>) {
    drive_with(launch, args, emit, commands, IDLE_KEEP).await;
}

async fn drive_with(
    launch: Launch,
    args: Vec<String>,
    emit: Emit,
    mut commands: mpsc::UnboundedReceiver<Command>,
    idle_keep: Duration,
) {
    let mut agent = match spawn(&launch.exe, &args, &launch.cwd) {
        Ok(agent) => agent,
        Err(err) => return emit(AgentEvent::failed(format!("Could not start Claude Code: {err}"))),
    };
    if let Err(err) = agent.write_line(&user_message(&launch.prompt, &launch.images)).await {
        agent.kill_tree().await;
        return emit(AgentEvent::failed(format!("Could not reach Claude Code: {err}")));
    }

    // Set between turns. Expiry ends the process, not the session.
    let mut idle_until: Option<Instant> = None;
    let mut interrupt_by: Option<Instant> = None;
    let mut running = HashMap::new();

    loop {
        let deadline = interrupt_by.or(idle_until);
        tokio::select! {
            _ = async { tokio::time::sleep_until(deadline.unwrap()).await }, if deadline.is_some() => {
                // Closed first, so a racing follow-up resumes instead of landing here.
                commands.close();
                agent.kill_tree().await;
                if interrupt_by.is_some() {
                    emit(AgentEvent::status(SessionStatus::Cancelled));
                }
                return;
            }
            line = agent.lines.next_line() => match line {
                Ok(Some(line)) => {
                    let parsed = parse(&line, interrupt_by.is_some());
                    let failed = parsed.events.iter().any(|e| {
                        matches!(e, AgentEvent::Status { status: SessionStatus::Failed, .. })
                    });
                    let opened = parsed.events.iter().any(|e| matches!(e, AgentEvent::Started { .. }));
                    parsed.events.into_iter().for_each(|e| emit(e));
                    command_results(&line, &mut running).into_iter().for_each(|e| emit(e));
                    if failed {
                        return agent.kill_tree().await;
                    }
                    if parsed.finished {
                        interrupt_by = None;
                        idle_until = Some(Instant::now() + idle_keep);
                    } else if opened {
                        // A message sent during a turn runs after it, and every turn opens with
                        // its own init. Anything less would keep an idle process for good.
                        idle_until = None;
                    }
                }
                // Out of output with no result: a crash, or a CLI killed from outside.
                _ => {
                    let code = agent.exit_code().await;
                    if idle_until.is_some() {
                        return; // Already finished its turn. Nothing was lost.
                    }
                    let detail = agent.stderr_tail();
                    let detail = if detail.is_empty() { format!("exit code {code:?}") } else { detail };
                    return emit(AgentEvent::failed(format!("Claude Code stopped unexpectedly: {detail}")));
                }
            },
            command = commands.recv() => match command {
                Some(Command::Send { text, images }) => {
                    idle_until = None;
                    if agent.write_line(&user_message(&text, &images)).await.is_err() {
                        emit(AgentEvent::failed("Claude Code is no longer accepting input."));
                        return agent.kill_tree().await;
                    }
                }
                // Claude Code's approvals are answered at the hook, not here.
                Some(Command::Answer { .. }) => {}
                Some(Command::Cancel) => {
                    if idle_until.is_none() && interrupt_by.is_none() {
                        interrupt_by = Some(Instant::now() + INTERRUPT_GRACE);
                        if agent.write_line(&interrupt_message()).await.is_err() {
                            agent.kill_tree().await;
                            return emit(AgentEvent::status(SessionStatus::Cancelled));
                        }
                    }
                }
                Some(Command::Kill) | None => {
                    agent.kill_tree().await;
                    if idle_until.is_none() {
                        emit(AgentEvent::status(SessionStatus::Cancelled));
                    }
                    return;
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
        let events = parse(INIT, false).events;
        assert_eq!(
            events[0],
            AgentEvent::Started { native_id: Some("0781dc44".into()), model: Some("claude-haiku-5-5".into()) }
        );
        assert_eq!(events[1], AgentEvent::status(SessionStatus::Running));
    }

    #[test]
    fn tool_calls_become_activity() {
        assert_eq!(parse(TOOL, false).events, [AgentEvent::Activity { label: "$ echo hello > out.txt".into() }]);
    }

    #[test]
    fn only_top_level_text_reaches_the_output() {
        assert_eq!(parse(TEXT, false).events, [AgentEvent::Text { text: "done".into() }]);
        assert!(parse(THINKING, false).events.is_empty());
        assert!(parse(SUB_TEXT, false).events.is_empty());
    }

    #[test]
    fn a_result_finishes_with_usage_and_cost() {
        let parsed = parse(RESULT, false);
        assert!(parsed.finished);
        assert_eq!(parsed.events[0], AgentEvent::Usage { input: 113_036, output: 159, cost_usd: Some(0.00930859) });
        assert_eq!(parsed.events[1], AgentEvent::status(SessionStatus::Completed));
    }

    #[test]
    fn a_failed_result_says_why() {
        let parsed = parse(FAILED, false);
        assert!(parsed.finished);
        assert_eq!(parsed.events[1], AgentEvent::failed("Not logged in"));
    }

    #[test]
    fn an_interrupted_turn_is_cancelled_not_failed() {
        let line = r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"","usage":{}}"#;
        let parsed = parse(line, true);
        assert!(parsed.finished);
        assert_eq!(parsed.events[1], AgentEvent::status(SessionStatus::Cancelled));
        assert!(matches!(&parse(line, false).events[1], AgentEvent::Status { status: SessionStatus::Failed, .. }));
    }

    #[test]
    fn general_mode_removes_the_shell_and_connectors() {
        let launch = Launch { exe: "claude".into(), cwd: ".".into(), prompt: "p".into(), model: None, resume: None, restricted: true, images: vec![], assistant: None };
        let args = args(&launch, "http://127.0.0.1:1/perm/t");
        assert!(args.windows(2).any(|w| w == ["--tools", GENERAL_TOOLS]));
        assert!(args.iter().any(|a| a == "--strict-mcp-config"));
        // Commands and edits may be reached for, but only ever by asking first.
        let allowed = args.windows(2).find(|w| w[0] == "--allowedTools").map(|w| w[1].as_str()).unwrap();
        assert!(["Bash", "Edit", "Write"].iter().all(|tool| !allowed.contains(tool)), "{allowed}");
    }

    #[test]
    fn an_approved_image_travels_before_the_question() {
        let line = user_message("what is this", &["data:image/jpeg;base64,AAAA".to_string()]);
        let value: Value = serde_json::from_str(&line).unwrap();
        let content = &value["message"]["content"];
        assert_eq!(content[0]["source"]["media_type"], "image/jpeg");
        assert_eq!(content[1]["text"], "what is this");
    }

    #[test]
    fn plan_limits_are_read_as_percentages() {
        let line = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.83,"resetsAt":1793464200,"status":"allowed"},"seven_day":{"utilization":0.48,"resetsAt":1793649600,"status":"allowed"}}}}"#;
        let parsed = parse(line, false);
        let [AgentEvent::Limits { windows }] = parsed.events.as_slice() else { panic!("{:?}", parsed.events) };
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].window, "five_hour");
        assert!((windows[0].used_percent - 83.0).abs() < 0.001);
        assert_eq!(windows[1].resets_at, Some(1793649600));
    }

    #[test]
    fn a_limit_line_with_nothing_usable_says_nothing() {
        let line = r#"{"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"five_hour":{"status":"allowed"}}}}"#;
        assert!(parse(line, false).events.is_empty());
    }

    #[test]
    fn the_size_of_the_conversation_comes_from_two_lines() {
        let reply = r#"{"type":"assistant","parent_tool_use_id":null,"message":{"usage":{"input_tokens":10,"cache_read_input_tokens":990},"content":[]}}"#;
        assert!(matches!(parse(reply, false).events.as_slice(), [AgentEvent::Context { used: Some(1000), size: None }]));
        let helper = r#"{"type":"assistant","parent_tool_use_id":"x","message":{"usage":{"input_tokens":10},"content":[]}}"#;
        assert!(parse(helper, false).events.is_empty(), "a helper's own conversation is a different one");
        let done = r#"{"type":"result","subtype":"success","usage":{},"modelUsage":{"m":{"contextWindow":200000}}}"#;
        assert!(parse(done, false).events.iter().any(|e| matches!(e, AgentEvent::Context { used: None, size: Some(200000) })));
    }

    #[test]
    fn unknown_lines_are_ignored() {
        for line in ["not json", r#"{"type":"rate_limit_event"}"#, r#"{"type":"brand_new_thing"}"#] {
            let parsed = parse(line, false);
            assert!(parsed.events.is_empty() && !parsed.finished);
        }
    }

    #[test]
    fn labels_shorten_paths_and_commands() {
        assert_eq!(tool_label("Edit", &json!({"file_path": "C:\\work\\src\\island\\main.rs"})), "Editing src/island/main.rs");
        assert_eq!(tool_label("Read", &json!({"file_path": "main.rs"})), "Reading main.rs");
        assert_eq!(tool_label("Bash", &json!({"command": "ls\nrm x"})), "$ ls");
        assert_eq!(tool_label("SomeMcpTool", &json!({})), "SomeMcpTool");
        assert_eq!(tool_label("mcp__meridian__open_app", &json!({})), "Tool: Open app");
        assert_eq!(tool_label("mcp__plugin_claude-mem_mcp-search__work_state_write", &json!({})), "Tool: Work state write");
    }

    #[test]
    fn a_to_do_list_comes_through_whole_and_is_not_a_step() {
        let line = r#"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","name":"TodoWrite","input":{"todos":[{"content":"Fix the resize","status":"completed","activeForm":"Fixing"},{"content":"Add a test","status":"in_progress"}]}}]}}"#;
        let items = vec![
            Todo { id: "0".into(), text: "Fix the resize".into(), status: "completed".into() },
            Todo { id: "1".into(), text: "Add a test".into(), status: "in_progress".into() },
        ];
        assert_eq!(parse(line, false).events, [AgentEvent::Todos { items }]);
    }

    #[test]
    fn a_helpers_list_stays_its_own() {
        let line = r#"{"type":"assistant","parent_tool_use_id":"x","message":{"content":[{"type":"tool_use","name":"TodoWrite","input":{"todos":[]}}]}}"#;
        assert!(parse(line, false).events.is_empty());
    }

    // Shaped like a real terminal transcript, where TaskCreate replaced TodoWrite.
    #[test]
    fn tasks_arrive_one_at_a_time() {
        let made = r#"{"type":"user","parent_tool_use_id":null,"tool_use_result":{"task":{"id":"1","subject":"Add a test"}}}"#;
        assert_eq!(parse(made, false).events, [AgentEvent::TodoChanged { id: "1".into(), text: Some("Add a test".into()), status: None }]);
        let moved = r#"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","name":"TaskUpdate","input":{"taskId":"1","status":"in_progress"}}]}}"#;
        assert_eq!(parse(moved, false).events, [AgentEvent::TodoChanged { id: "1".into(), text: None, status: Some("in_progress".into()) }]);
        let other = r#"{"type":"user","parent_tool_use_id":null,"tool_use_result":{"stdout":"hi"}}"#;
        assert!(parse(other, false).events.is_empty());
    }

    #[test]
    fn an_edit_counts_the_lines_it_changes_and_not_the_ones_it_quotes() {
        let edit = code_change("Edit", &json!({ "file_path": "a.ts", "old_string": "a\nb\nc", "new_string": "a\nX\nY\nc" })).unwrap();
        assert!(matches!(edit, AgentEvent::Diff { lines_removed: 1, lines_added: 2, .. }), "{edit:?}");
        let long: String = (0..40).map(|n| format!("{n}\n")).collect();
        let edit = code_change("Edit", &json!({ "file_path": "a.ts", "old_string": "", "new_string": long })).unwrap();
        let AgentEvent::Diff { added, lines_added: 40, .. } = edit else { panic!("{edit:?}") };
        assert_eq!(added.len(), CHANGE_LINES);
    }

    #[test]
    fn a_written_file_counts_as_changed_without_showing_what_is_in_it() {
        let write = code_change("Write", &json!({ "file_path": "C:\\a\\new.ts", "content": "one\ntwo" })).unwrap();
        assert_eq!(write, AgentEvent::Diff { path: "new.ts".into(), removed: vec![], added: vec![], lines_removed: 0, lines_added: 2 });
        assert_eq!(code_change("Read", &json!({})), None);
    }

    #[test]
    fn a_result_is_matched_to_the_command_that_ran() {
        let call = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test"}}]}}"#;
        let done = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok\nTests  3 passed (3)\n\n"}]}}"#;
        let mut running = HashMap::new();
        assert!(command_results(call, &mut running).is_empty());
        assert_eq!(
            command_results(done, &mut running),
            [AgentEvent::Output { command: "npm test".into(), lines: vec!["ok".into(), "Tests  3 passed (3)".into()], failed: false }]
        );
        assert!(command_results(done, &mut running).is_empty(), "each result is reported once");

        let call = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"npm test"}}]}}"#;
        let failed = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","is_error":true,"content":[{"type":"text","text":"Exit code 1"}]}]}}"#;
        command_results(call, &mut running);
        assert!(matches!(&command_results(failed, &mut running)[..], [AgentEvent::Output { failed: true, .. }]));
    }

    #[test]
    fn the_prompt_stays_off_the_command_line() {
        let launch = Launch {
            exe: "claude".into(),
            cwd: ".".into(),
            prompt: "SECRET PROMPT".into(),
            model: Some("m".into()),
            resume: Some("abc".into()),
            restricted: false,
            images: vec![],
            assistant: None,
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
            restricted: false,
            images: vec![],
            assistant: None,
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
    async fn an_agent_that_ignores_an_interrupt_is_ended() {
        let (launch, args) = launch("setInterval(() => {}, 1000)");
        let (emit, events) = recorder();
        let (tx, rx) = mpsc::unbounded_channel();
        tx.send(Command::Cancel).unwrap();
        tokio::time::timeout(Duration::from_secs(10), drive(launch, args, emit, rx)).await.unwrap();
        assert_eq!(last_status(&events.lock().unwrap()), Some(SessionStatus::Cancelled));
    }

    #[tokio::test]
    async fn killing_ends_a_running_agent_at_once() {
        let (launch, args) = launch("setInterval(() => {}, 1000)");
        let (emit, events) = recorder();
        let (tx, rx) = mpsc::unbounded_channel();
        tx.send(Command::Kill).unwrap();
        tokio::time::timeout(Duration::from_secs(3), drive(launch, args, emit, rx)).await.unwrap();
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
        tokio::time::timeout(Duration::from_secs(10), drive_with(launch, args, emit, rx, Duration::from_millis(100))).await.unwrap();
        assert_eq!(last_status(&events.lock().unwrap()), Some(SessionStatus::Completed));
    }

    #[tokio::test]
    async fn a_queued_turn_outlasting_the_idle_window_is_not_ended() {
        // The first result, then a turn that was already queued and takes longer than the window.
        let script = format!("console.log(String.raw`{RESULT}`); console.log(String.raw`{INIT}`); setTimeout(() => console.log(String.raw`{RESULT}`), 700); setInterval(() => {{}}, 1000)");
        let (launch, args) = launch(&script);
        let (emit, events) = recorder();
        let (_tx, rx) = mpsc::unbounded_channel();
        tokio::time::timeout(Duration::from_secs(10), drive_with(launch, args, emit, rx, Duration::from_millis(300))).await.unwrap();
        let events = events.lock().unwrap();
        assert_eq!(events.iter().filter(|e| **e == AgentEvent::status(SessionStatus::Completed)).count(), 2);
    }

    #[tokio::test]
    async fn a_follow_up_reaches_the_same_process_between_turns() {
        let script = format!(
            "let n = 0; require(`readline`).createInterface({{ input: process.stdin }}).on(`line`, () => {{ n += 1; console.log(String.raw`{RESULT}`); if (n === 2) console.log(JSON.stringify({{ type: `system`, subtype: `api_retry`, attempt: 99 }})); }});"
        );
        let (launch, args) = launch(&script);
        let (emit, events) = recorder();
        let (tx, rx) = mpsc::unbounded_channel();
        let run = tokio::spawn(drive_with(launch, args, emit, rx, Duration::from_millis(600)));
        tokio::time::sleep(Duration::from_millis(400)).await;
        tx.send(Command::Send { text: "again".into(), images: vec![] }).unwrap();
        tokio::time::timeout(Duration::from_secs(10), run).await.unwrap().unwrap();
        let events = events.lock().unwrap();
        let completed = events.iter().filter(|e| **e == AgentEvent::status(SessionStatus::Completed)).count();
        assert_eq!(completed, 2);
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Activity { label } if label.contains("99"))));
    }
}
