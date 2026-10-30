//! Codex through `codex app-server`: newline-delimited JSON-RPC, no `jsonrpc`
//! header. The protocol is marked experimental upstream, so anything unknown is
//! ignored, and unknown server requests get an error reply so a turn never hangs.

use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::process::{spawn, Agent};
use crate::{AgentEvent, Approval, Command, Emit, Launch, SessionStatus};

const INTERRUPT_GRACE: Duration = Duration::from_secs(4);

#[derive(Clone, Copy)]
enum Pending {
    Initialize,
    Thread,
    Turn,
    Other,
}

/// What a notification means for the session.
pub struct Parsed {
    pub events: Vec<AgentEvent>,
    pub finished: bool,
}

fn base_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn item_label(item: &Value) -> Option<String> {
    match item["type"].as_str()? {
        "commandExecution" => {
            let command = item["command"].as_str().unwrap_or_default();
            Some(format!("$ {}", command.lines().next().unwrap_or_default().chars().take(80).collect::<String>()))
        }
        "fileChange" => {
            let path = item["changes"][0]["path"].as_str().unwrap_or("files");
            Some(format!("Editing {}", base_name(path)))
        }
        "mcpToolCall" | "dynamicToolCall" => Some(format!("Tool: {}", item["tool"].as_str().unwrap_or("call"))),
        "webSearch" => Some("Searching the web".to_string()),
        _ => None,
    }
}

pub fn parse_notification(method: &str, params: &Value, last_error: &mut Option<String>) -> Parsed {
    let mut events = Vec::new();
    let mut finished = false;
    match method {
        "turn/started" => events.push(AgentEvent::status(SessionStatus::Running)),
        "item/started" => {
            if let Some(label) = item_label(&params["item"]) {
                events.push(AgentEvent::Activity { label });
            }
        }
        "item/agentMessage/delta" => {
            if let Some(text) = params["delta"].as_str() {
                events.push(AgentEvent::Text { text: text.to_string() });
            }
        }
        "thread/tokenUsage/updated" => {
            let total = &params["tokenUsage"]["total"];
            events.push(AgentEvent::Usage {
                input: total["inputTokens"].as_u64().unwrap_or(0),
                output: total["outputTokens"].as_u64().unwrap_or(0),
                cost_usd: None,
            });
        }
        "error" if params["willRetry"] != true => {
            *last_error = params["error"]["message"].as_str().map(String::from);
        }
        "turn/completed" => {
            finished = true;
            let turn = &params["turn"];
            events.push(match turn["status"].as_str() {
                Some("completed") => AgentEvent::status(SessionStatus::Completed),
                Some("interrupted") => AgentEvent::status(SessionStatus::Cancelled),
                _ => {
                    let message = turn["error"]["message"].as_str().map(String::from).or(last_error.take());
                    AgentEvent::failed(message.unwrap_or_else(|| "The turn failed.".to_string()))
                }
            });
        }
        _ => {}
    }
    Parsed { events, finished }
}

pub fn approval_for(method: &str, params: &Value, id: &str) -> Option<Approval> {
    let reason = params["reason"].as_str();
    match method {
        "item/commandExecution/requestApproval" => Some(Approval {
            id: id.to_string(),
            tool: "Shell".to_string(),
            summary: params["command"].as_str().or(reason).unwrap_or("Run a command").chars().take(240).collect(),
        }),
        "item/fileChange/requestApproval" => Some(Approval {
            id: id.to_string(),
            tool: "File change".to_string(),
            summary: reason.or(params["grantRoot"].as_str()).unwrap_or("Change files").chars().take(240).collect(),
        }),
        _ => None,
    }
}

struct Rpc {
    agent: Agent,
    next: u64,
    pending: HashMap<u64, Pending>,
}

impl Rpc {
    async fn call(&mut self, method: &str, params: Value, kind: Pending) -> std::io::Result<()> {
        self.next += 1;
        self.pending.insert(self.next, kind);
        self.agent.write_line(&json!({ "method": method, "id": self.next, "params": params }).to_string()).await
    }

    async fn notify(&mut self, method: &str) -> std::io::Result<()> {
        self.agent.write_line(&json!({ "method": method, "params": {} }).to_string()).await
    }

    async fn reply(&mut self, id: &Value, result: Value) -> std::io::Result<()> {
        self.agent.write_line(&json!({ "id": id, "result": result }).to_string()).await
    }

    async fn reject(&mut self, id: &Value, message: &str) -> std::io::Result<()> {
        self.agent.write_line(&json!({ "id": id, "error": { "code": -32601, "message": message } }).to_string()).await
    }
}

fn turn_input(text: &str) -> Value {
    json!([{ "type": "text", "text": text }])
}

pub async fn run(launch: Launch, emit: Emit, mut commands: mpsc::UnboundedReceiver<Command>) {
    let agent = match spawn(&launch.exe, &["app-server", "--listen", "stdio://"], &launch.cwd) {
        Ok(agent) => agent,
        Err(err) => return emit(AgentEvent::failed(format!("Could not start Codex: {err}"))),
    };
    let mut rpc = Rpc { agent, next: 0, pending: HashMap::new() };
    let info = json!({ "clientInfo": { "name": "meridian", "title": "Meridian", "version": env!("CARGO_PKG_VERSION") } });
    if rpc.call("initialize", info, Pending::Initialize).await.is_err() {
        rpc.agent.kill_tree().await;
        return emit(AgentEvent::failed("Could not reach Codex."));
    }

    let mut thread_id: Option<String> = launch.resume.clone();
    let mut turn_id: Option<String> = None;
    let mut last_error = None;
    let mut approvals: HashMap<String, Value> = HashMap::new();
    let mut interrupted_at: Option<tokio::time::Instant> = None;

    loop {
        let deadline = interrupted_at.map(|t| t + INTERRUPT_GRACE);
        tokio::select! {
            _ = async { tokio::time::sleep_until(deadline.unwrap()).await }, if deadline.is_some() => {
                rpc.agent.kill_tree().await;
                return emit(AgentEvent::status(SessionStatus::Cancelled));
            }
            line = rpc.agent.lines.next_line() => {
                let line = match line {
                    Ok(Some(line)) => line,
                    _ => {
                        let detail = rpc.agent.stderr_tail();
                        return emit(AgentEvent::failed(format!("Codex stopped unexpectedly: {detail}")));
                    }
                };
                let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                let method = message["method"].as_str();
                match (method, message.get("id")) {
                    // A request from the server, which is waiting for our reply.
                    (Some(method), Some(id)) => {
                        let key = id.to_string();
                        if let Some(approval) = approval_for(method, &message["params"], &key) {
                            approvals.insert(key, id.clone());
                            emit(AgentEvent::Approval { approval });
                        } else {
                            let _ = rpc.reject(id, "Not supported by this client.").await;
                        }
                    }
                    (Some(method), None) => {
                        let parsed = parse_notification(method, &message["params"], &mut last_error);
                        parsed.events.into_iter().for_each(|e| emit(e));
                        if parsed.finished {
                            return rpc.agent.kill_tree().await;
                        }
                    }
                    // The reply to one of our calls.
                    (None, Some(id)) => {
                        let kind = id.as_u64().and_then(|n| rpc.pending.remove(&n)).unwrap_or(Pending::Other);
                        if let Some(error) = message.get("error") {
                            rpc.agent.kill_tree().await;
                            let text = error["message"].as_str().unwrap_or("Codex refused the request.");
                            return emit(AgentEvent::failed(text.to_string()));
                        }
                        let step = match kind {
                            Pending::Initialize => {
                                let _ = rpc.notify("initialized").await;
                                match &launch.resume {
                                    Some(id) => {
                                        rpc.call("thread/resume", json!({ "threadId": id }), Pending::Thread).await
                                    }
                                    None => {
                                        let params = json!({
                                            "cwd": launch.cwd,
                                            "model": launch.model,
                                            "approvalPolicy": "on-request",
                                            "sandbox": "workspace-write",
                                        });
                                        rpc.call("thread/start", params, Pending::Thread).await
                                    }
                                }
                            }
                            Pending::Thread => {
                                let id = message["result"]["thread"]["id"].as_str().map(String::from);
                                let model = message["result"]["model"].as_str().map(String::from);
                                thread_id = id.or(thread_id);
                                emit(AgentEvent::Started { native_id: thread_id.clone(), model });
                                let params = json!({ "threadId": thread_id, "input": turn_input(&launch.prompt) });
                                rpc.call("turn/start", params, Pending::Turn).await
                            }
                            Pending::Turn => {
                                turn_id = message["result"]["turn"]["id"].as_str().map(String::from);
                                Ok(())
                            }
                            Pending::Other => Ok(()),
                        };
                        if step.is_err() {
                            rpc.agent.kill_tree().await;
                            return emit(AgentEvent::failed("Lost contact with Codex."));
                        }
                    }
                    _ => {}
                }
            }
            command = commands.recv() => match command {
                Some(Command::Send(text)) => {
                    if let (Some(thread), Some(turn)) = (&thread_id, &turn_id) {
                        let params = json!({ "threadId": thread, "expectedTurnId": turn, "input": turn_input(&text) });
                        let _ = rpc.call("turn/steer", params, Pending::Other).await;
                    }
                }
                Some(Command::Answer { id, allow }) => {
                    if let Some(rpc_id) = approvals.remove(&id) {
                        let decision = if allow { "accept" } else { "decline" };
                        let _ = rpc.reply(&rpc_id, json!({ "decision": decision })).await;
                        emit(AgentEvent::ApprovalResolved { id });
                    }
                }
                Some(Command::Kill) => {
                    rpc.agent.kill_tree().await;
                    return emit(AgentEvent::status(SessionStatus::Cancelled));
                }
                Some(Command::Cancel) | None => {
                    match (&thread_id, &turn_id) {
                        (Some(thread), Some(turn)) if interrupted_at.is_none() => {
                            let params = json!({ "threadId": thread, "turnId": turn });
                            let _ = rpc.call("turn/interrupt", params, Pending::Other).await;
                            interrupted_at = Some(tokio::time::Instant::now());
                        }
                        _ => {
                            rpc.agent.kill_tree().await;
                            return emit(AgentEvent::status(SessionStatus::Cancelled));
                        }
                    }
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str, last_error: &mut Option<String>) -> Parsed {
        let v: Value = serde_json::from_str(line).unwrap();
        parse_notification(v["method"].as_str().unwrap(), &v["params"], last_error)
    }

    // Recorded from codex-cli 0.142.4 with an expired sign-in.
    const AUTH_ERROR: &str = r#"{"method":"error","params":{"error":{"message":"Your access token could not be refreshed. Please log out and sign in again.","codexErrorInfo":"unauthorized","additionalDetails":null},"willRetry":false,"threadId":"t","turnId":"u"}}"#;
    const TURN_FAILED: &str = r#"{"method":"turn/completed","params":{"threadId":"t","turn":{"id":"u","items":[],"status":"failed","error":{"message":"Your access token could not be refreshed. Please log out and sign in again.","codexErrorInfo":"unauthorized"}}}}"#;

    #[test]
    fn an_expired_sign_in_fails_the_session_with_codexs_own_words() {
        let mut last = None;
        assert!(parse(AUTH_ERROR, &mut last).events.is_empty());
        let parsed = parse(TURN_FAILED, &mut last);
        assert!(parsed.finished);
        assert!(format!("{:?}", parsed.events[0]).contains("sign in again"));
    }

    #[test]
    fn a_retrying_error_is_not_remembered() {
        let mut last = None;
        parse(r#"{"method":"error","params":{"error":{"message":"blip"},"willRetry":true}}"#, &mut last);
        assert_eq!(last, None);
    }

    #[test]
    fn turn_outcomes_map_to_session_status() {
        let done = r#"{"method":"turn/completed","params":{"turn":{"status":"completed"}}}"#;
        let stopped = r#"{"method":"turn/completed","params":{"turn":{"status":"interrupted"}}}"#;
        assert_eq!(parse(done, &mut None).events[0], AgentEvent::status(SessionStatus::Completed));
        assert_eq!(parse(stopped, &mut None).events[0], AgentEvent::status(SessionStatus::Cancelled));
    }

    #[test]
    fn items_become_activity_and_user_messages_do_not() {
        let cmd = r#"{"method":"item/started","params":{"item":{"type":"commandExecution","id":"1","command":"cargo test\nmore","cwd":"."}}}"#;
        let edit = r#"{"method":"item/started","params":{"item":{"type":"fileChange","id":"2","changes":[{"path":"src\\main.rs","kind":"update"}]}}}"#;
        let user = r#"{"method":"item/started","params":{"item":{"type":"userMessage","id":"3","content":[]}}}"#;
        assert_eq!(parse(cmd, &mut None).events, [AgentEvent::Activity { label: "$ cargo test".into() }]);
        assert_eq!(parse(edit, &mut None).events, [AgentEvent::Activity { label: "Editing main.rs".into() }]);
        assert!(parse(user, &mut None).events.is_empty());
    }

    #[test]
    fn deltas_and_usage_pass_through() {
        let delta = r#"{"method":"item/agentMessage/delta","params":{"delta":"hi","itemId":"1"}}"#;
        let usage = r#"{"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"total":{"inputTokens":10,"outputTokens":4,"cachedInputTokens":0,"reasoningOutputTokens":0,"totalTokens":14}}}}"#;
        assert_eq!(parse(delta, &mut None).events, [AgentEvent::Text { text: "hi".into() }]);
        assert_eq!(parse(usage, &mut None).events, [AgentEvent::Usage { input: 10, output: 4, cost_usd: None }]);
    }

    #[test]
    fn approvals_describe_the_command_and_unknown_requests_get_none() {
        let params = json!({ "itemId": "i", "threadId": "t", "turnId": "u", "command": "rm -rf build" });
        let approval = approval_for("item/commandExecution/requestApproval", &params, "7").unwrap();
        assert_eq!((approval.id.as_str(), approval.summary.as_str()), ("7", "rm -rf build"));
        assert!(approval_for("item/tool/requestUserInput", &params, "8").is_none());
    }

    #[test]
    fn unknown_notifications_are_ignored() {
        assert!(parse(r#"{"method":"fuzzyFileSearch/sessionUpdated","params":{}}"#, &mut None).events.is_empty());
    }
}
