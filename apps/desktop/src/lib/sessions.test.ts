import { describe, expect, it } from "vitest";
import { actionOf, ago, blocksOf, changedFiles, clock, doing, endFacts, groupSessions, kindOf, lastMessage, limitName, limitStop, memoryUsed, mergeTodo, modelName, needsFirst, planSteps, recentLines, resetLabel, spent, stageLine, stepLog, stepsOf, testsResult, thisTurn, tileState, todoStep, todoWindow, turnStart, worked } from "./sessions";
import type { LogEntry, SessionDetail } from "./store";

const NOW = new Date(2026, 9, 31, 17, 0).getTime();
const MINUTE = 60_000;

const session = (over: Partial<SessionDetail>): SessionDetail =>
  ({ id: "s", agent: "Claude Code", agentId: "claude-code", project: "shop", status: "completed", activity: "", startedAt: NOW - 90 * MINUTE, endedAt: NOW - 60 * MINUTE, approval: null, surface: "agents", log: [], ...over }) as SessionDetail;

describe("the Agents list", () => {
  it("leaves conversations to Chat", () => {
    const groups = groupSessions([session({ id: "a", surface: "chat" }), session({ id: "b" })], NOW);
    expect(groups.finished.map((s) => s.id)).toEqual(["b"]);
  });

  it("puts what needs the user first, then what is running", () => {
    const approval = { id: "x", tool: "Bash", summary: "ls" };
    const groups = groupSessions([session({ id: "a", status: "running" }), session({ id: "b", status: "waiting", approval })], NOW);
    expect(groups.needs.map((s) => s.id)).toEqual(["b"]);
    expect(groups.running.map((s) => s.id)).toEqual(["a"]);
  });

  it("folds old and excess finished work into Earlier, newest first", () => {
    const recent = [1, 2, 3, 4, 5].map((n) => session({ id: `r${n}`, endedAt: NOW - n * MINUTE }));
    const groups = groupSessions([session({ id: "old", endedAt: NOW - 3 * 24 * 60 * MINUTE }), ...recent], NOW);
    expect(groups.finished.map((s) => s.id)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(groups.earlier.map((s) => s.id)).toEqual(["r5", "old"]);
  });
});

describe("what a row says", () => {
  it("names what is being asked for", () => {
    expect(doing(session({ status: "waiting", approval: { id: "x", tool: "Bash", summary: "ls" } }))).toBe("Wants to run a command");
    expect(doing(session({ status: "waiting", approval: { id: "x", tool: "Edit", summary: "a.ts" } }))).toBe("Wants to use Edit");
  });

  it("says how a session ended, and counts each file once", () => {
    const diff = (text: string) => ({ kind: "diff" as const, text });
    expect(doing(session({ log: [diff("a.ts"), diff("a.ts"), diff("b.ts")] }))).toBe("Done, 2 files changed");
    expect(doing(session({ log: [diff("a.ts")] }))).toBe("Done, 1 file changed");
    expect(doing(session({}))).toBe("Done");
    expect(doing(session({ status: "failed" }))).toBe("Failed");
    expect(doing(session({ status: "cancelled" }))).toBe("Stopped");
  });

  it("shows the live activity while running", () => {
    expect(doing(session({ status: "running", activity: "$ npm test" }))).toBe("$ npm test");
    expect(doing(session({ status: "running" }))).toBe("Working");
  });

  it("keeps times short", () => {
    expect(ago(NOW - 20_000, NOW)).toBe("now");
    expect(ago(NOW - 4 * MINUTE, NOW)).toBe("4m");
    expect(ago(NOW - 130 * MINUTE, NOW)).toBe("2h");
    expect(ago(NOW - 3 * 1440 * MINUTE, NOW)).toBe("3d");
  });
});

describe("limits and models", () => {
  it("reads model names the way people say them", () => {
    expect(modelName("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(modelName("claude-haiku-5-5-20260101")).toBe("Claude Haiku 5.5");
    expect(modelName("claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(modelName("gpt-5.5")).toBe("gpt-5.5");
    expect(modelName(null)).toBeNull();
  });

  it("names the windows and when they reset", () => {
    expect(limitName("five_hour")).toBe("5 hours");
    expect(limitName("seven_day")).toBe("7 days");
    expect(resetLabel(null, NOW)).toBe("");
    expect(resetLabel(new Date(2026, 9, 31, 20, 30).getTime() / 1000, NOW)).toMatch(/^Resets 8:30/);
    expect(resetLabel(new Date(2026, 10, 3, 15, 0).getTime() / 1000, NOW)).toMatch(/^Resets \w+, 3:00/);
  });

  it("works out how full a conversation is, only when it knows both numbers", () => {
    expect(memoryUsed(session({ context: { used: 16_000, size: 200_000 } }))).toBe(8);
    expect(memoryUsed(session({ context: { used: 16_000, size: null } }))).toBeNull();
    expect(memoryUsed(session({}))).toBeNull();
  });

  it("finds the limit that stopped a session, only while it has not reset", () => {
    const full = { window: "five_hour", usedPercent: 100, resetsAt: NOW / 1000 + 600 };
    expect(limitStop(session({ status: "failed" }), [full], NOW)).toBe(full);
    expect(limitStop(session({ status: "completed" }), [full], NOW)).toBeNull();
    expect(limitStop(session({ status: "failed" }), [{ ...full, usedPercent: 83 }], NOW)).toBeNull();
    expect(limitStop(session({ status: "failed" }), [{ ...full, resetsAt: NOW / 1000 - 1 }], NOW)).toBeNull();
    expect(limitStop(session({ status: "failed" }), undefined, NOW)).toBeNull();
  });
});

const did = (text: string, at?: number): LogEntry => ({ kind: "activity", text, at });
const edit = (text: string, linesAdded: number, linesRemoved: number, at?: number): LogEntry => ({ kind: "diff", text, linesAdded, linesRemoved, at });
const ran = (text: string, lines: string[], failed = false): LogEntry => ({ kind: "output", text, lines, failed });

describe("reading an activity label", () => {
  it("sorts what the adapters write into read, edit, run and other", () => {
    expect(kindOf("Reading src/a.ts")).toBe("read");
    expect(kindOf("Searching TODO")).toBe("read");
    expect(kindOf("Searching the web: weather")).toBe("read");
    expect(kindOf("Searching the web")).toBe("read");
    expect(kindOf("Fetching https://a.example")).toBe("read");
    expect(kindOf("Editing a.ts")).toBe("edit");
    expect(kindOf("Writing a.ts")).toBe("edit");
    expect(kindOf("$ npm test")).toBe("run");
    expect(kindOf("Subagent: review")).toBe("other");
    expect(kindOf("mcp__db__query")).toBe("other");
    expect(kindOf("Retrying the API, attempt 2")).toBe("other");
  });

  it("splits a label into the stage word and what it acts on", () => {
    expect(actionOf("Editing src/island/machine.ts")).toEqual({ kind: "edit", word: "Editing", what: "src/island/machine.ts" });
    expect(actionOf("$ npm run test -- island")).toEqual({ kind: "run", word: "Running", what: "npm run test -- island" });
    expect(actionOf("Working")).toEqual({ kind: "other", word: "Working", what: "" });
    expect(actionOf("")).toEqual({ kind: "other", word: "Working", what: "" });
  });
});

describe("the steps of a session", () => {
  it("counts tool actions only, never a retry, a notice or a failure", () => {
    const log = [did("Reading a.ts"), did("mcp__db__query"), did("Retrying the API, attempt 2"), did("Claude needs your permission"), did("$ npm test"), did("Failed: $ npm test"), { kind: "text" as const, text: "Hm." }, { kind: "user" as const, text: "go" }];
    expect(stepsOf(log).map((s) => s.verb)).toEqual(["Read", "Step", "Run"]);
  });

  it("folds an edit's lines and a command's output into their steps", () => {
    const [step, run] = stepsOf([did("Editing a.ts", 5), edit("a.ts", 6, 2), edit("a.ts", 1, 0), did("$ npm test", 9), ran("npm test", ["ok"])]);
    expect(step).toMatchObject({ verb: "Edit", what: "a.ts", lines: 7, at: 5 });
    expect(run).toMatchObject({ verb: "Run", output: ["ok"] });
  });

  it("gives each command its own output when two ran at once", () => {
    const [first, second] = stepsOf([did("$ npm test"), did("$ npm run lint"), ran("npm test", ["one"]), ran("npm run lint", ["two"], true)]);
    expect(first!.output).toEqual(["one"]);
    expect(second).toMatchObject({ output: ["two"], failed: true });
  });

  it("marks a step that failed", () => {
    expect(stepsOf([did("$ npm test"), did("Failed: $ npm test")])[0]!.failed).toBe(true);
  });

  it("keeps the conversation between runs of steps, and anything it cannot place", () => {
    const blocks = blocksOf([{ kind: "user", text: "go" }, did("Reading a.ts"), { kind: "text", text: "Now." }, did("$ ls"), edit("loose.ts", 1, 0), ran("other", ["x"])]);
    expect(blocks.map((b) => ("steps" in b ? b.steps.length : b.entry.kind))).toEqual(["user", 1, "text", 1, "diff", "output"]);
  });

  it("ends on a Stop row only when the session failed", () => {
    const log: LogEntry[] = [did("Reading a.ts"), { kind: "system", text: "Usage limit reached" }];
    expect(stepsOf(log).map((s) => s.verb)).toEqual(["Read"]);
    const [block] = blocksOf(log, true);
    expect("steps" in block! && block.steps.map((s) => [s.verb, s.what])).toEqual([["Read", "a.ts"], ["Stop", "Usage limit reached"]]);
  });

  it("is about the latest turn, once there has been more than one", () => {
    const s = session({ startedAt: 1, turnAt: 100, log: [did("Reading old.ts", 50), did("Reading new.ts", 150), { kind: "text", text: "no time" }] });
    expect(turnStart(s)).toBe(100);
    expect(thisTurn(s).map((e) => e.text)).toEqual(["Reading new.ts"]);
    expect(turnStart(session({ startedAt: 1 }))).toBe(1);
    expect(thisTurn(session({ log: [did("x")] }))).toHaveLength(1);
  });
});

describe("the agent's own list", () => {
  const list = (...statuses: string[]) => statuses.map((status, i) => ({ id: String(i), text: `t${i}`, status }));

  it("says which line it is on", () => {
    expect(todoStep(list("completed", "completed", "in_progress", "pending", "pending"))).toBe("Step 3 of 5");
    expect(todoStep(list("pending", "pending"))).toBe("Step 1 of 2");
    expect(todoStep(list("completed", "completed"))).toBe("Step 2 of 2");
  });

  it("shows a long list from just before where it is", () => {
    const long = list("completed", "completed", "completed", "in_progress", "pending", "pending", "pending", "pending", "pending", "pending");
    expect(todoWindow(long, 6).map((t) => t.id)).toEqual(["2", "3", "4", "5", "6", "7"]);
    expect(todoWindow(list(...new Array(10).fill("completed")), 6).map((t) => t.id)).toEqual(["4", "5", "6", "7", "8", "9"]);
    expect(todoWindow(list("pending", "pending"), 6)).toHaveLength(2);
  });

  it("builds up from tasks reported one at a time", () => {
    let todos = mergeTodo([], { id: "1", text: "Add a test" });
    expect(todos).toEqual([{ id: "1", text: "Add a test", status: "pending" }]);
    todos = mergeTodo(todos, { id: "1", status: "in_progress" });
    expect(todos[0]).toMatchObject({ text: "Add a test", status: "in_progress" });
    todos = mergeTodo(todos, { id: "1", text: "Add two tests" });
    expect(todos[0]).toMatchObject({ text: "Add two tests", status: "in_progress" });
    expect(mergeTodo(todos, { id: "9", status: "completed" }), "a task from before this app was listening").toEqual(todos);
    expect(mergeTodo(todos, { id: "1", status: "deleted" })).toEqual([]);
  });
});

describe("what changed", () => {
  it("adds up each file from the real counts", () => {
    const files = changedFiles([edit("a.ts", 12, 3), edit("b.ts", 4, 1), edit("a.ts", 1, 1), did("Reading c.ts")]);
    expect(files.map((f) => [f.path, f.added, f.removed, f.edits.length])).toEqual([["a.ts", 13, 4, 2], ["b.ts", 4, 1, 1]]);
  });

  it("falls back on the lines kept, for history from before the counts", () => {
    expect(changedFiles([{ kind: "diff", text: "a.ts", added: ["x", "y"], removed: ["z"] }])[0]).toMatchObject({ added: 2, removed: 1 });
  });
});

describe("whether the tests passed", () => {
  it("believes what a test run printed, and nothing else", () => {
    expect(testsResult([ran("npm test", ["Tests  148 passed (148)", "Duration  1.2s"])])).toBe("passed");
    expect(testsResult([ran("cargo test", ["test result: ok. 12 passed; 0 failed; 0 ignored"])])).toBe("passed");
    expect(testsResult([ran("npx playwright test", ["  31 passed (40.1s)"])])).toBe("passed");
    expect(testsResult([ran("pytest", ["=== 5 passed in 0.12s ==="])])).toBe("passed");
    expect(testsResult([ran("go test ./...", ["ok  	shop/cart	0.1s"])])).toBe("passed");
    expect(testsResult([ran("ls", ["12 passed"])]), "not a test run").toBeNull();
    expect(testsResult([ran("npm test", ["Started"])]), "says neither way").toBeNull();
    expect(testsResult([ran("npm test", ["0 passed"])]), "ran nothing").toBeNull();
    expect(testsResult([])).toBeNull();
  });

  it("sees a failure however it shows up", () => {
    expect(testsResult([ran("npm test", ["Tests  2 failed | 146 passed (148)"])])).toBe("failed");
    expect(testsResult([ran("cargo test", ["test result: FAILED. 11 passed; 1 failed"])])).toBe("failed");
    expect(testsResult([ran("npm test", ["boom"], true)])).toBe("failed");
    expect(testsResult([did("$ npm test"), did("Failed: $ npm test")])).toBe("failed");
    expect(testsResult([ran("cargo test", ["test result: ok. 3 passed; 0 failed; 0 ignored"])]), "no failures is not a failure").toBe("passed");
  });

  it("goes by the last run", () => {
    expect(testsResult([ran("npm test", ["1 failed"]), did("Editing a.ts"), ran("npm test", ["2 passed"])])).toBe("passed");
    expect(testsResult([ran("npm test", ["2 passed"]), did("Failed: $ npm test")])).toBe("failed");
  });
});

describe("how a session ended", () => {
  it("quotes the agent's last words, as plain text", () => {
    const log: LogEntry[] = [{ kind: "text", text: "First." }, did("Reading a.ts"), { kind: "text", text: "## Done\n\nIt **now** resizes `once`.\n" }];
    expect(lastMessage(session({ log }))).toBe("Done It now resizes once.");
    expect(lastMessage(session({ log: [{ kind: "text", text: "  \n" }] }))).toBeNull();
    expect(lastMessage(session({}))).toBeNull();
  });

  it("does not quote an earlier turn", () => {
    expect(lastMessage(session({ turnAt: 100, log: [{ kind: "text", text: "Old.", at: 50 }] }))).toBeNull();
  });

  it("lists what is known, and leaves out what is not", () => {
    const log = [edit("a.ts", 1, 0), edit("b.ts", 1, 0), edit("c.ts", 1, 0), ran("npm test", ["3 passed"])];
    expect(endFacts(session({ log, usage: { input: 1, output: 1, costUsd: 0.18 } }))).toBe("3 files changed, tests passed, $0.18");
    expect(endFacts(session({ log: [edit("a.ts", 1, 0)], usage: { input: 1, output: 1, costUsd: null } }))).toBe("1 file changed");
    expect(endFacts(session({}))).toBe("");
  });

  it("keeps times short", () => {
    expect(clock(42_900)).toBe("0:42");
    expect(clock(252_000)).toBe("4:12");
    expect(clock(-5)).toBe("0:00");
    expect(spent(52_000)).toBe("52 s");
    expect(spent(252_000)).toBe("4 min 12 s");
    expect(spent(3_780_000)).toBe("1 h 3 min");
  });
});

describe("many at once", () => {
  it("puts whatever needs the user first, and keeps the rest in order", () => {
    const approval = { id: "x", tool: "Bash", summary: "ls" };
    const list = [session({ id: "a", status: "running" }), session({ id: "b", status: "running" }), session({ id: "c", status: "waiting", approval })];
    expect(needsFirst(list).map((s) => s.id)).toEqual(["c", "a", "b"]);
  });

  it("gives each its stage", () => {
    expect(stageLine(session({ status: "running", activity: "$ npm test" }))).toEqual({ text: "Running npm test", kind: "run" });
    expect(stageLine(session({ status: "running", activity: "Editing index.html" }))).toEqual({ text: "Editing index.html", kind: "edit" });
    expect(stageLine(session({ status: "running", activity: "Working" }))).toEqual({ text: "Working", kind: "other" });
    expect(stageLine(session({ status: "waiting" }))).toEqual({ text: "Needs you", kind: "needs" });
  });

  it("gives each tile its state and its latest lines", () => {
    const approval = { id: "x", tool: "Bash", summary: "ls" };
    expect(tileState(session({ status: "waiting", approval }), NOW)).toBe("Wants to run a command");
    expect(tileState(session({ status: "running", startedAt: NOW - 12 * MINUTE }), NOW)).toBe("Running, 12m");
    expect(tileState(session({}), NOW)).toBe("Finished 1h ago");
    expect(tileState(session({ endedAt: NOW }), NOW)).toBe("Finished just now");
    expect(tileState(session({ status: "failed" }), NOW)).toBe("Failed");

    const log = [did("Reading a.ts"), did("$ npm test"), ran("npm test", ["PASS a", "FAIL b"]), did("Editing a.ts")];
    expect(recentLines(session({ status: "running", log }))).toEqual(["PASS a", "FAIL b", "Edit a.ts"]);
    expect(recentLines(session({ log: [edit("a.ts", 1, 0), { kind: "text", text: "Opened pull request 214" }] }))).toEqual(["1 file changed", "Opened pull request 214"]);
  });

  it("counts the steps of a plan from its list", () => {
    expect(planSteps("## Plan\n\n1. One\n2. Two\n- Three\n\nThis is prose.")).toBe(3);
    expect(planSteps("Just words.")).toBe(0);
  });
});

describe("how long it worked", () => {
  const S = 1000;
  const start = NOW - 200 * S;
  const at = (seconds: number) => start + seconds * S;
  const said = (text: string, seconds: number): LogEntry => ({ kind: "text", text, at: at(seconds) });
  const out = (text: string, lines: string[], seconds: number, failed = false): LogEntry => ({ kind: "output", text, lines, failed, at: at(seconds) });
  const board = [
    did("Reading cart.ts", at(3)), did("Reading total.ts", at(9)), did("Reading cart.ts", at(12)), did("Reading tax.ts", at(15)), did("Reading money.ts", at(16)),
    did("Editing cart.ts", at(18)), edit("cart.ts", 2, 1, at(18)),
    did("$ npm test", at(59)), out("npm test", ["Tests  2 failed | 46 passed (48)"], 120, true),
    did("Editing total.ts", at(124)), edit("total.ts", 1, 1, at(124)),
    did("$ npm test", at(146)), out("npm test", ["Tests  48 passed (48)"], 180),
    said("The cart total is fixed.", 185),
  ];
  const ended = session({ startedAt: start, endedAt: at(192), log: board });

  it("puts each step in plain words, with how long it took, adding up to the whole", () => {
    const log = stepLog(ended, NOW);
    expect(log.map((s) => s.text)).toEqual([
      "Read cart.ts and 3 other files",
      "Changed cart.ts, 2 lines",
      "Ran npm test: 2 failed",
      "Changed total.ts, 1 line",
      "Ran npm test: all 48 passed",
      "Wrote a summary",
    ]);
    expect(log.map((s) => clock(s.ms!))).toEqual(["0:18", "0:41", "1:05", "0:22", "0:39", "0:07"]);
    expect(log.reduce((n, s) => n + s.ms!, 0)).toBe(worked(ended, NOW));
    expect(spent(worked(ended, NOW))).toBe("3 min 12 s");
    expect(log.some((s) => s.now)).toBe(false);
  });

  it("says what the step under way is doing, and counts its time live", () => {
    const running = session({ status: "running", startedAt: start, endedAt: null, log: board.slice(0, 8) });
    const log = stepLog(running, at(100));
    expect(log.map((s) => s.text)).toEqual(["Read cart.ts and 3 other files", "Changed cart.ts, 2 lines", "Running npm test"]);
    expect(log.map((s) => s.now)).toEqual([false, false, true]);
    expect(log[2]!.ms).toBe(41 * S);
    expect(stepLog(running, at(110))[2]!.ms).toBe(51 * S);
    expect(worked(running, at(100))).toBe(100 * S);
  });

  it("keeps edits to different files apart, and words that were not steps out", () => {
    const log = [did("Editing a.ts", at(1)), did("Editing a.ts", at(2)), did("Retrying the API, attempt 2", at(3)), did("Editing b.ts", at(4)), did("Searching todo", at(5)), did("Tool: Open app", at(6)), did("AskUserQuestion", at(7))];
    expect(stepLog(session({ startedAt: start, endedAt: at(8), log }), NOW).map((s) => s.text)).toEqual(["Changed a.ts", "Changed b.ts", "Searched for todo", "Used Open app", "Asked you a question"]);
  });

  it("leaves a terminal's last words in the step before, since they took no time it can see", () => {
    const log = [did("$ npm test", at(1)), said("Done.", 10)];
    expect(stepLog(session({ startedAt: start, endedAt: at(10), log }), NOW).map((s) => [s.text, s.ms])).toEqual([["Ran npm test", 10 * S]]);
  });

  it("has nothing to list for a turn with no steps, and no times for history kept without them", () => {
    expect(stepLog(session({ log: [said("Hello.", 1)] }), NOW)).toEqual([]);
    const old = stepLog(session({ log: [did("Reading a.ts"), did("Editing a.ts")] }), NOW);
    expect(old.map((s) => s.ms)).toEqual([null, null]);
  });
});
