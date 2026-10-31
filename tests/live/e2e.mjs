// End-to-end through the real app: real store, real Rust core, real CLIs.
//
// Start the app with a debug port, then pick a mode:
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
//   npm run dev
//   node tests/live/e2e.mjs claude | deny | cancel | resume | engine | vision | chat | screen | activity | codex
//
// claude, deny, resume, engine and vision run a cheap Claude Code session in a scratch folder under
// the system temp directory, and spend a little of your own usage.
// Never ship a build with the debug port on.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
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
// Followed sessions join the list ahead of ours, so always look a session up by its id.
const session = (sid) => `__meridian.getState().sessions.find((s) => s.id === ${JSON.stringify(sid)})`;
const view = () => ev("document.querySelector('.island').dataset.view");
const pass = (name, ok, extra = "") => console.log(ok ? "PASS" : "FAIL", name, extra);

const mode = process.argv[2];
// Each mode starts from a clean island, whatever the last one left behind.
await ev(`(() => { const s = __meridian.getState(); s.errors.forEach((e) => __meridian.dismissError(e.id)); s.notices.forEach((n) => __meridian.dismissNotice(n.id)); __meridian.closePanel(); return "ok"; })()`);

if (mode === "chat") {
  const server = spawn("node", [`${here}/fake-llm.mjs`], { stdio: "ignore" });
  await sleep(600);
  await ev("__meridian.openPanel('home'); 'ok'");
  const online = await until("__meridian.getState().localOnline.includes('lmstudio')", 4000, "discovery");
  pass("discovers local server on its default port", !!online);
  await ev("__meridian.closePanel(); 'ok'");
  await ev("__meridian.sendChat('hello there'); 'ok'");
  await until("__meridian.getState().chatPending", 3000, "pending");
  { const v = await view(); pass("island shows thinking while a chat runs", v === "thinking", `${v} ${await ev(`JSON.stringify({ p: __meridian.getState().panelOpen, s: __meridian.getState().sessions.map((x) => x.status), e: __meridian.getState().errors.length, n: __meridian.getState().notices.length, l: __meridian.getState().listening, c: __meridian.getState().screen.capturing, sug: __meridian.getState().suggestions.length })`)}`); }
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
  await until(`${session(sid)}?.status === 'running'`, 30000, "running");
  { const v = await view(); const st = await ev("JSON.stringify({n:__meridian.getState().notices.length,e:__meridian.getState().errors.map(x=>x.title),p:__meridian.getState().panelOpen,l:__meridian.getState().listening,sessions:__meridian.getState().sessions.map(x=>x.status)})"); pass("island shows working", ["working", "multitask"].includes(v), `${v} ${st}`); }
  const hasApproval = await until(`${session(sid)}?.approval?.id`, 60000, "approval");
  pass("permission request reached the island", !!hasApproval);
  const summary = await ev(`${session(sid)}.approval.summary`);
  pass("approval names the real command", summary.includes("out.txt"), summary);
  await sleep(500);
  pass("file not written before approval", !fs.existsSync(path.join(work, "out.txt")));
  await ev(`__meridian.answerApproval('${sid}', '${hasApproval}', ${mode === "claude"}); 'ok'`);
  await until(`['completed','failed','cancelled'].includes(${session(sid)}?.status)`, 60000, "finish");
  const s = JSON.parse(await ev(`JSON.stringify(${session(sid)})`));
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
  }
}

if (mode === "cancel") {
  const work = path.join(scratch, "session-cancel");
  fs.mkdirSync(work, { recursive: true });
  const req = JSON.stringify({ agent: "claude-code", cwd: work, model: "claude-haiku-5-5", prompt: "Count slowly from 1 to 500 in words, one per line." });
  const sid = await ev(`__meridian.startSession(${req})`);
  await until(`${session(sid)}?.status === 'running'`, 30000, "running");
  await ev(`window.__TAURI_INTERNALS__.invoke('session_cancel', { id: '${sid}' }).then(() => 'ok')`);
  await until(`${session(sid)}?.status === 'cancelled'`, 15000, "cancel");
  pass("cancel stops a running agent", (await ev(`${session(sid)}.status`)) === "cancelled");
}

if (mode === "resume") {
  const work = path.join(scratch, "session-resume");
  fs.mkdirSync(work, { recursive: true });
  const req = JSON.stringify({ agent: "claude-code", cwd: work, model: "claude-haiku-5-5", prompt: "Remember the word heron. Reply with just: ok" });
  const sid = await ev(`__meridian.startSession(${req})`);
  await until(`${session(sid)}?.status === 'completed'`, 60000, "first turn");
  pass("first turn completed", (await ev(`${session(sid)}.status`)) === "completed");
  await ev(`window.__TAURI_INTERNALS__.invoke('session_send', { id: '${sid}', text: 'What word did I ask you to remember? Reply with just that word.', images: [] }).then(() => 'ok')`);
  await until(`${session(sid)}?.status === 'running'`, 30000, "resumed");
  await until(`${session(sid)}?.status === 'completed'`, 60000, "second turn");
  const text = await ev(`${session(sid)}.log.map(l => l.text).join(' ')`);
  pass("resumed session kept its context", /heron/i.test(text.split("ok").pop()), text.slice(-60));
}

if (mode === "engine") {
  const auth = JSON.parse(await ev(`JSON.stringify(__meridian.getState().auth['claude-code'] ?? null)`));
  pass("sign-in comes from the CLI, with no API key", auth?.signedIn === true, JSON.stringify(auth));
  pass("no account details reach the interface", !/@/.test(JSON.stringify(auth)));
  const keys = await ev(`__meridian.getState().providers.find(p => p.id === 'anthropic').hasKey`);
  console.log("anthropic api key present:", keys);

  await ev(`__meridian.selectEngine('claude-code'); __meridian.setAgentMode('general'); 'ok'`);
  const state = (expr) => ev(`(() => { const a = __meridian.getState().agentChat; const s = __meridian.getState().sessions.find(x => x.id === a.sessionId); return ${expr}; })()`);
  const turn = async (text, label) => {
    const t0 = Date.now();
    await ev(`__meridian.sendAgentChat(${JSON.stringify(text)}); 'ok'`);
    await until(`(() => { const a = __meridian.getState().agentChat; const s = __meridian.getState().sessions.find(x => x.id === a.sessionId); return s && s.status === 'running' })()`, 20000, label + " start");
    const done = await until(`(() => { const a = __meridian.getState().agentChat; const s = __meridian.getState().sessions.find(x => x.id === a.sessionId); return s && ['completed','failed','cancelled'].includes(s.status) && s.status })()`, 60000, label);
    return { ms: Date.now() - t0, status: done };
  };

  const first = await turn("Remember the word heron. Reply with just: ok", "first");
  pass("first turn answered", first.status === "completed", `${first.ms} ms`);
  const sid = await state("a.sessionId");
  const second = await turn("What word did I ask you to remember? Reply with just that word.", "second");
  pass("follow-up kept the context", /heron/i.test(await state("s.log.map(l => l.text).join(' ')")), `${second.ms} ms`);
  pass("same conversation", (await state("a.sessionId")) === sid);
  pass("follow-up on the live process is faster", second.ms < first.ms, `${first.ms} -> ${second.ms} ms`);

  await ev(`__meridian.sendAgentChat('Use a shell command to create a file named shell-test.txt here. If you cannot, say: no shell'); 'ok'`);
  await sleep(600);
  await until(`(() => { const a = __meridian.getState().agentChat; const s = __meridian.getState().sessions.find(x => x.id === a.sessionId); return s && s.status === 'completed' })()`, 60000, "no shell");
  const cwd = await state("s.cwd");
  pass("general mode has no shell", !fs.existsSync(path.join(cwd, "shell-test.txt")), cwd.split(/[\\/]/).slice(-2).join("/"));

  await ev(`__meridian.sendAgentChat('Count from 1 to 400, one number per line, nothing else.'); 'ok'`);
  await until(`(() => { const a = __meridian.getState().agentChat; const s = __meridian.getState().sessions.find(x => x.id === a.sessionId); return s && s.status === 'running' && s.log.at(-1).kind === 'text' && s.log.at(-1).text.length > 40 })()`, 30000, "counting");
  const before = (await state("s.log.at(-1).text.length"));
  await ev(`__meridian.cancelSession(${JSON.stringify(sid)}); 'ok'`);
  await until(`(() => { const a = __meridian.getState().agentChat; const s = __meridian.getState().sessions.find(x => x.id === a.sessionId); return s && s.status === 'cancelled' })()`, 8000, "interrupt");
  pass("stop interrupts the turn", (await state("s.status")) === "cancelled", `stopped after ${before} chars`);
  const after = await turn("Reply with just the word still-here.", "after interrupt");
  const lastText = await state("s.log.at(-1).text");
  pass("the conversation survives an interrupt", after.status === "completed" && /still-here/i.test(lastText), `${after.status} ${after.ms} ms: ${lastText.slice(0, 60)}`);
  console.log(await state("JSON.stringify(s.log.slice(-5).map(l => [l.kind, l.text.slice(0, 70)]))"));
  await ev(`__meridian.selectEngine('anthropic'); 'ok'`);
}

if (mode === "screen") {
  // Captures whatever is in front, so nothing read here is ever printed. The real
  // OCR check is crates/screen/tests/live_capture.rs, against a window of its own.
  await ev(`__meridian.updateSettings({ screenMode: 'ondemand' }); 'ok'`);
  await ev(`__meridian.showPreview('notification'); 'ok'`);
  await sleep(700);
  const paint = await ev(`(() => { const s = document.createElement('style'); s.id = 'magenta'; s.textContent = '.island { background: #ff00ff !important; }'; document.head.append(s); const r = document.querySelector('.island').getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`);
  await sleep(300);
  await ev(`__meridian.captureScreen('screen')`);
  await until(`!__meridian.getState().screen.capturing`, 8000, "capture");
  const refused = await ev(`__meridian.getState().screen.refused`);
  if (refused) {
    console.log("SKIP island exclusion, window in front was refused:", refused);
  } else {
    const at = JSON.parse(paint);
    const sampled = await ev(`(async () => {
      const shot = __meridian.getState().screen.capture;
      const img = new Image(); img.src = shot.image; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const scale = img.width / screen.width;
      const left = (screen.width - innerWidth) / 2;
      const d = g.getImageData(Math.round((left + ${at.x}) * scale), Math.round(${at.y} * scale), 1, 1).data;
      return JSON.stringify(Array.from(d.slice(0, 3)));
    })()`);
    const [r, g, b] = JSON.parse(sampled);
    pass("the island stays out of its own capture", !(r > 200 && g < 90 && b > 200), sampled);
  }
  await ev(`document.getElementById('magenta').remove(); __meridian.discardCapture(); __meridian.showPreview(null); 'ok'`);
  pass("a capture is gone once discarded", !(await ev(`__meridian.getState().screen.capture !== null`)));
  const frameGone = await ev(`window.__TAURI_INTERNALS__.invoke('screen_crop', { x: 0, y: 0, w: 1, h: 1 }).then(() => false, (e) => /discarded/.test(String(e)))`);
  pass("the core drops its copy too", frameGone === true);
}

if (mode === "activity") {
  const call = (name, args) => ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)}, ${JSON.stringify(args)}).then((v) => JSON.stringify({ ok: v }), (e) => JSON.stringify({ err: String(e) }))`).then(JSON.parse);
  const flight = (departure) => `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "http://schema.org",
    "@type": "FlightReservation",
    reservationNumber: "TESTQ9",
    reservationStatus: "http://schema.org/ReservationConfirmed",
    underName: { "@type": "Person", name: "Test Traveller" },
    reservationFor: {
      "@type": "Flight",
      flightNumber: "2341",
      airline: { "@type": "Airline", name: "Test Air", iataCode: "6E" },
      departureAirport: { "@type": "Airport", name: "Mumbai", iataCode: "BOM" },
      arrivalAirport: { "@type": "Airport", name: "Delhi", iataCode: "DEL" },
      departureTime: departure,
      arrivalTime: "2030-03-15T12:45:00+05:30",
    },
  })}</script></head><body>Your booking is confirmed.</body></html>`;

  const added = await call("activity_import", { subject: "Your Test Air booking TESTQ9", from: "bookings@testair.example", body: flight("2030-03-15T10:30:00+05:30") });
  pass("a booking email becomes an event", added.ok === 1, JSON.stringify(added));
  const list = await call("activity_list", { category: "travel" });
  const mine = list.ok.filter((e) => e.dedupeKey.includes("TESTQ9") || e.title.includes("2341"));
  pass("it lands in Travel, with its source and confidence", mine.length === 1 && mine[0].confidence > 0.8 && mine[0].sourceRef?.account === "pasted email", mine[0] && `${mine[0].title} ${mine[0].confidence}`);

  const again = await call("activity_import", { subject: "Schedule change TESTQ9", from: "bookings@testair.example", body: flight("2030-03-15T13:00:00+05:30") });
  const after = (await call("activity_list", { category: "travel" })).ok.filter((e) => e.id === mine[0].id);
  const total = (await call("activity_list", { category: "travel" })).ok.filter((e) => e.title.includes("2341")).length;
  pass("a reschedule updates the event instead of duplicating it", again.ok === 1 && total === 1 && after[0]?.status === "updated", `status ${after[0]?.status}, changed ${after[0]?.changedFields}`);

  const promo = await call("activity_import", { subject: "Flights to Delhi from 2999. Sale ends Sunday!", from: "deals@testair.example", body: "Book now and save 40 percent on flights to Delhi. Offer ends Sunday. Unsubscribe here." });
  pass("a promotion produces nothing", promo.ok === 0, JSON.stringify(promo));

  const when = new Date(Date.now() + 10 * 60000);
  const pad = (n) => String(n).padStart(2, "0");
  const value = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}:00`;
  const reminder = await call("activity_add_reminder", { title: "Live test reminder", startsAt: { kind: "naive", value } });
  pass("a reminder can be added", !reminder.err, reminder.err);
  const shown = await until(`__meridian.getState().notices.find((n) => n.title.includes('Live test reminder'))?.id`, 8000, "reminder");
  pass("it surfaces on the island", !!shown && (await view()) === "notification");
  const log = (await call("reminder_log", {})).ok.filter((l) => l.key === shown);
  pass("it is logged, so it fires once", log.length === 1, log[0]?.disposition);

  const today = (await call("activity_list", { category: null })).ok.filter((e) => e.title.includes("2341") || e.title === "Live test reminder");
  for (const e of today) await call("activity_delete", { id: e.id });
  const left = (await call("activity_list", { category: null })).ok.filter((e) => e.title.includes("2341") || e.title === "Live test reminder");
  pass("test data is gone", left.length === 0);
  await ev(`__meridian.getState().notices.forEach(() => {}); 'ok'`);
}

if (mode === "vision") {
  // A generated image, so no real screen content is involved.
  const image = await ev(`(() => { const c = document.createElement('canvas'); c.width = 320; c.height = 200; const g = c.getContext('2d'); g.fillStyle = '#d01818'; g.fillRect(0, 0, 320, 200); g.fillStyle = '#fff'; g.font = 'bold 48px sans-serif'; g.fillText('HERON', 60, 118); return c.toDataURL('image/jpeg', 0.9); })()`);
  await ev(`__meridian.selectEngine('claude-code'); __meridian.setAgentMode('general'); 'ok'`);
  await ev(`__meridian.sendAgentChat('What single word is written in this image, and what is the background colour? Reply as: word, colour', [${JSON.stringify(image)}]); 'ok'`);
  await until(`(() => { const a = __meridian.getState().agentChat; const s = __meridian.getState().sessions.find(x => x.id === a.sessionId); return s && s.status === 'completed' })()`, 60000, "vision");
  const reply = await ev(`(() => { const a = __meridian.getState().agentChat; const s = __meridian.getState().sessions.find(x => x.id === a.sessionId); return s ? s.log.at(-1).text : '' })()`);
  pass("Claude Code reads an approved image", /heron/i.test(reply) && /red/i.test(reply), reply.slice(0, 60));
  await ev(`__meridian.selectEngine('anthropic'); 'ok'`);
}

if (mode === "codex") {
  const work = path.join(scratch, "session-codex");
  fs.mkdirSync(work, { recursive: true });
  const req = JSON.stringify({ agent: "codex", cwd: work, model: null, prompt: "Reply with the single word done." });
  const sid = await ev(`__meridian.startSession(${req})`);
  await until(`['completed','failed','cancelled'].includes(${session(sid)}?.status)`, 45000, "finish");
  const s = JSON.parse(await ev(`JSON.stringify(${session(sid)})`));
  console.log("codex outcome:", s.status, "|", s.activity || s.log.at(-1)?.text);
  pass("expired sign-in surfaces as a clear failure", s.status === "failed" && /sign in/i.test(JSON.stringify(s.log) + s.activity), "");
  pass("failure reaches the island", (await view()) === "error");
}

await ev("__meridian.showPreview(null); 'ok'");
ws.close();
process.exit(0);



