// End-to-end through the real app: real store, real Rust core, real CLIs.
//
// Start the app with a debug port, then pick a mode:
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
//   npm run dev
//   node tests/live/e2e.mjs claude | deny | cancel | resume | chat | codex
//
// claude, deny and resume run a cheap Claude Code session in a scratch folder under
// the system temp directory, and spend a little of your own usage.
// Never ship a build with the debug port on.
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\//, "");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-live-"));
const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const waiting = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  waiting.get(d.id)?.(d);
};
const ev = (expression) =>
  new Promise((resolve) => {
    const i = ++id;
    waiting.set(i, (d) => resolve(d.result?.result?.value));
    ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (expr, ms, label) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await ev(expr);
    if (v) return v;
    await sleep(120);
  }
  console.log("TIMEOUT", label, await ev("JSON.stringify(__meridian.getState().sessions.map(s=>({s:s.status,a:s.activity,log:s.log.slice(-3)})))"));
  return null;
};
const view = () => ev("document.querySelector('.island').dataset.view");
const pass = (name, ok, extra = "") => console.log(ok ? "PASS" : "FAIL", name, extra);

const mode = process.argv[2];
await ev("__meridian.showPreview(null); 'ok'");

if (mode === "chat") {
  const server = spawn("node", [`${here}/fake-llm.mjs`], { stdio: "ignore" });
  await sleep(600);
  await ev("__meridian.openPanel('providers'); 'ok'");
  const online = await until("__meridian.getState().localOnline.includes('lmstudio')", 4000, "discovery");
  pass("discovers local server on its default port", !!online);
  await ev("__meridian.showPreview(null); 'ok'");
  await ev("__meridian.sendChat('hello there'); 'ok'");
  await until("__meridian.getState().chatPending", 3000, "pending");
  pass("island shows thinking while a chat runs", (await view()) === "thinking");
  await until("!__meridian.getState().chatPending", 6000, "finish");
  const chat = await ev("JSON.stringify(__meridian.getState().chat)");
  const parsed = JSON.parse(chat);
  const reply = parsed.messages.at(-1).content;
  pass("reply streamed into the conversation", reply.startsWith("Hello from a local model"), reply.slice(0, 40));
  pass("model list hides embedding models", parsed.models.length === 1 && parsed.models[0].id === "local-test-model");
  pass("usage reported", parsed.usage?.input === 11, JSON.stringify(parsed.usage));
  pass("closed panel gets a completion notice", (await view()) === "notification");
  server.kill();
  await sleep(300);
  await ev("__meridian.sendChat('are you still there'); 'ok'");
  await until("__meridian.getState().errors.length > 0", 5000, "error");
  const err = await ev("__meridian.getState().errors[0]?.body");
  pass("a dead server becomes a retryable island error, not a crash", (await view()) === "error", err);
}

if (mode === "claude" || mode === "deny") {
  const work = path.join(scratch, `session-${mode}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const req = JSON.stringify({ agent: "claude-code", cwd: work, model: "claude-haiku-5-5", prompt: "Use the Bash tool to run exactly: echo hello > out.txt  Then reply with the single word done." });
  const sid = await ev(`__meridian.startSession(${req})`);
  pass("session started", !!sid, sid);
  await until(`__meridian.getState().sessions[0]?.status === 'running'`, 30000, "running");
  { const v = await view(); const st = await ev("JSON.stringify({n:__meridian.getState().notices.length,e:__meridian.getState().errors.map(x=>x.title),p:__meridian.getState().panelOpen,l:__meridian.getState().listening,sessions:__meridian.getState().sessions.map(x=>x.status)})"); pass("island shows working", ["working", "multitask"].includes(v), `${v} ${st}`); }
  const hasApproval = await until(`__meridian.getState().sessions[0]?.approval?.id`, 60000, "approval");
  pass("permission request reached the island", !!hasApproval);
  const summary = await ev(`__meridian.getState().sessions[0].approval.summary`);
  pass("approval names the real command", summary.includes("out.txt"), summary);
  await sleep(500);
  pass("file not written before approval", !fs.existsSync(path.join(work, "out.txt")));
  await ev(`__meridian.answerApproval('${sid}', '${hasApproval}', ${mode === "claude"}); 'ok'`);
  await until(`['completed','failed','cancelled'].includes(__meridian.getState().sessions[0]?.status)`, 60000, "finish");
  const s = JSON.parse(await ev(`JSON.stringify(__meridian.getState().sessions[0])`));
  pass("session finished", s.status === "completed", s.status);
  if (mode === "claude") {
    pass("approved command really ran", fs.existsSync(path.join(work, "out.txt")));
  } else {
    pass("denied command did not run", !fs.existsSync(path.join(work, "out.txt")));
  }
  pass("usage and cost reported", s.usage?.input > 0 && s.usage?.costUsd > 0, JSON.stringify(s.usage));
  pass("output captured", s.log.length > 0, s.log.map((l) => `${l.kind}:${l.text}`).join(" | ").slice(0, 120));
  if (mode === "claude") {
    pass("completion notice shown", (await view()) === "notification");
    await sleep(3500);
    const left = execSync(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name='claude.exe'\\" | Where-Object { $_.CommandLine -like '*perm/*' } | Measure-Object).Count"`).toString().trim();
    pass("no agent process left behind", left === "0", `left=${left}`);
  }
}

if (mode === "cancel") {
  const work = path.join(scratch, "session-cancel");
  fs.mkdirSync(work, { recursive: true });
  const req = JSON.stringify({ agent: "claude-code", cwd: work, model: "claude-haiku-5-5", prompt: "Count slowly from 1 to 500 in words, one per line." });
  const sid = await ev(`__meridian.startSession(${req})`);
  await until(`__meridian.getState().sessions[0]?.status === 'running'`, 30000, "running");
  await ev(`window.__TAURI_INTERNALS__.invoke('session_cancel', { id: '${sid}' }).then(() => 'ok')`);
  await until(`__meridian.getState().sessions[0]?.status === 'cancelled'`, 15000, "cancel");
  pass("cancel stops a running agent", (await ev(`__meridian.getState().sessions[0].status`)) === "cancelled");
  await sleep(1500);
  const left = execSync(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name='claude.exe'\\" | Where-Object { $_.CommandLine -like '*perm/*' } | Measure-Object).Count"`).toString().trim();
  pass("cancel leaves no process behind", left === "0", `left=${left}`);
}

if (mode === "resume") {
  const work = path.join(scratch, "session-resume");
  fs.mkdirSync(work, { recursive: true });
  const req = JSON.stringify({ agent: "claude-code", cwd: work, model: "claude-haiku-5-5", prompt: "Remember the word heron. Reply with just: ok" });
  const sid = await ev(`__meridian.startSession(${req})`);
  await until(`__meridian.getState().sessions[0]?.status === 'completed'`, 60000, "first turn");
  pass("first turn completed", (await ev(`__meridian.getState().sessions[0].status`)) === "completed");
  await ev(`window.__TAURI_INTERNALS__.invoke('session_send', { id: '${sid}', text: 'What word did I ask you to remember? Reply with just that word.' }).then(() => 'ok')`);
  await until(`__meridian.getState().sessions[0]?.status === 'running'`, 30000, "resumed");
  await until(`__meridian.getState().sessions[0]?.status === 'completed'`, 60000, "second turn");
  const text = await ev(`__meridian.getState().sessions[0].log.map(l => l.text).join(' ')`);
  pass("resumed session kept its context", /heron/i.test(text.split("ok").pop()), text.slice(-60));
}

if (mode === "codex") {
  const work = path.join(scratch, "session-codex");
  fs.mkdirSync(work, { recursive: true });
  const req = JSON.stringify({ agent: "codex", cwd: work, model: null, prompt: "Reply with the single word done." });
  await ev(`__meridian.startSession(${req})`);
  await until(`['completed','failed','cancelled'].includes(__meridian.getState().sessions[0]?.status)`, 45000, "finish");
  const s = JSON.parse(await ev(`JSON.stringify(__meridian.getState().sessions[0])`));
  console.log("codex outcome:", s.status, "|", s.activity || s.log.at(-1)?.text);
  pass("expired sign-in surfaces as a clear failure", s.status === "failed" && /sign in/i.test(JSON.stringify(s.log) + s.activity), "");
  pass("failure reaches the island", (await view()) === "error");
}

await ev("__meridian.showPreview(null); 'ok'");
ws.close();
process.exit(0);



