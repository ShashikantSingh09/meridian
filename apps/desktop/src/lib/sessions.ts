// How the Agents list reads: what needs the user, what is running, and what is done. Finished work
// falls back to Earlier so the list stays about what is happening now.

import type { LogEntry, SessionDetail } from "./store";
import type { Approval, LimitWindow, Todo } from "./types";

const LIVE = ["starting", "running", "waiting"];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Finished sessions shown before the rest fold into Earlier. */
const RECENT_MOST = 4;

export interface SessionGroups {
  needs: SessionDetail[];
  running: SessionDetail[];
  finished: SessionDetail[];
  earlier: SessionDetail[];
}

export const lastActive = (s: SessionDetail) => s.endedAt ?? s.startedAt;

export function groupSessions(sessions: SessionDetail[], now: number): SessionGroups {
  // Conversations belong to Chat, and listing them here too is most of the noise.
  const tasks = sessions.filter((s) => s.surface !== "chat");
  const live = tasks.filter((s) => LIVE.includes(s.status));
  const done = tasks.filter((s) => !LIVE.includes(s.status)).sort((a, b) => lastActive(b) - lastActive(a));
  const recent = done.filter((s) => now - lastActive(s) < DAY).slice(0, RECENT_MOST);
  return {
    needs: live.filter((s) => s.approval),
    running: live.filter((s) => !s.approval),
    finished: recent,
    earlier: done.filter((s) => !recent.includes(s)),
  };
}

export function asking(approval: Approval): string {
  if (approval.questions?.length) return "Has a question";
  if (approval.plan) return "Has a plan to approve";
  if (approval.tool === "Start an agent") return "Wants to start an agent";
  if (approval.tool === "Read the screen") return "Wants to read your screen";
  return approval.tool === "Bash" || approval.tool === "PowerShell" ? "Wants to run a command" : `Wants to use ${approval.tool}`;
}

/** One line on what a session is doing, or how it ended. */
export function doing(s: SessionDetail): string {
  if (s.approval) return asking(s.approval);
  if (LIVE.includes(s.status)) return s.activity || (s.watched ? "In your terminal" : "Working");
  if (s.status === "failed") return "Failed";
  if (s.status === "cancelled") return "Stopped";
  const files = changedFiles(s.log).length;
  return files === 0 ? "Done" : `Done, ${files} ${files === 1 ? "file" : "files"} changed`;
}

export function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

/** claude-opus-5-5 reads as Claude Opus 5.5. Names it does not know are shown as they came. */
export function modelName(model: string | null): string | null {
  const claude = model?.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?/);
  if (!claude) return model;
  const family = claude[1]!;
  return `Claude ${family[0]!.toUpperCase()}${family.slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
}

export function limitName(window: string): string {
  return window === "five_hour" ? "5 hours" : window === "seven_day" ? "7 days" : window;
}

/** Today by time alone, otherwise with the day. */
export function resetLabel(resetsAt: number | null, now: number): string {
  if (!resetsAt) return "";
  const when = new Date(resetsAt * 1000);
  const time = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toLowerCase();
  const today = when.toDateString() === new Date(now).toDateString();
  return `Resets ${today ? time : `${when.toLocaleDateString(undefined, { weekday: "short" })}, ${time}`}`;
}

/** How full a conversation is, as a share of what the model can hold. */
export function memoryUsed(s: SessionDetail): number | null {
  const { used, size } = s.context ?? {};
  return used && size ? Math.min(100, Math.round((used / size) * 100)) : null;
}

// ── Where a session has got to ─────────────────────────────────────────────
// Everything here reads what really happened from the log. There is no estimate of how far along
// anything is, because nothing reports one.

export type StepKind = "read" | "edit" | "run" | "other";

/** How adapters write their labels: tool_label in claude.rs, item_label in codex.rs. */
const LABELS: [prefix: string, kind: StepKind, word: string][] = [
  ["$ ", "run", "Running"],
  ["Reading ", "read", "Reading"],
  ["Searching the web: ", "read", "Searching the web"],
  ["Searching ", "read", "Searching"],
  ["Fetching ", "read", "Fetching"],
  ["Editing ", "edit", "Editing"],
  ["Writing ", "edit", "Writing"],
  ["Subagent: ", "other", "Subagent"],
  ["Checking what I know about ", "read", "Checking what I know about"],
  ["Tool: ", "other", "Using"],
];
const VERBS: Record<StepKind, string> = { read: "Read", edit: "Edit", run: "Run", other: "Step" };
const FAILED = "Failed: ";

/** A label in two parts: the stage word, then the file or command. */
export function actionOf(label: string): { kind: StepKind; word: string; what: string } {
  for (const [prefix, kind, word] of LABELS) {
    if (label.startsWith(prefix)) return { kind, word, what: label.slice(prefix.length) };
  }
  return { kind: "other", word: "Working", what: label === "Working" ? "" : label };
}

export const kindOf = (label: string) => actionOf(label).kind;

/** A tool at work, as against a retry or a notice. A tool with no wording of its own is its bare name. */
const isStep = (label: string) => LABELS.some(([prefix]) => label.startsWith(prefix)) || /^\S+$/.test(label);

export interface Step {
  kind: StepKind | "stop";
  word: string;
  verb: string;
  what: string;
  at?: number;
  /** Lines an edit changed. */
  lines?: number;
  failed?: boolean;
  /** The end of what a command printed. */
  output?: string[];
}

/** Either a run of tool actions, shown as rows, or a line of the conversation. */
export type Block = { steps: Step[] } | { entry: LogEntry };

const linesAdded = (e: LogEntry) => e.linesAdded ?? e.added?.length ?? 0;
const linesRemoved = (e: LogEntry) => e.linesRemoved ?? e.removed?.length ?? 0;

/** Folds a log into steps, with what came of each. `stopped` makes its last word a Stop row. */
export function blocksOf(log: LogEntry[], stopped = false): Block[] {
  const blocks: Block[] = [];
  const group = () => {
    const last = blocks[blocks.length - 1];
    return last && "steps" in last ? last.steps : null;
  };
  log.forEach((entry, i) => {
    const steps = group();
    const step = steps?.[steps.length - 1];
    if (entry.kind === "activity" && isStep(entry.text)) {
      const { kind, word, what } = actionOf(entry.text);
      const row: Step = { kind, word, verb: VERBS[kind], what, at: entry.at };
      if (steps) steps.push(row);
      else blocks.push({ steps: [row] });
    } else if (entry.kind === "activity" && entry.text.startsWith(FAILED) && step) {
      step.failed = true;
    } else if (entry.kind === "diff" && step?.kind === "edit") {
      step.lines = (step.lines ?? 0) + Math.max(linesAdded(entry), linesRemoved(entry));
    } else if (entry.kind === "output" && steps?.some((s) => s.kind === "run" && entry.text.startsWith(s.what))) {
      // Parallel commands finish in any order, so it goes by the command, not the position.
      const ran = steps.filter((s) => s.kind === "run" && entry.text.startsWith(s.what)).pop()!;
      ran.output = entry.lines;
      ran.failed ||= entry.failed;
    } else if (stopped && entry.kind === "system" && i === log.length - 1) {
      const row: Step = { kind: "stop", word: "Stopped", verb: "Stop", what: entry.text, at: entry.at };
      if (steps) steps.push(row);
      else blocks.push({ steps: [row] });
    } else {
      blocks.push({ entry });
    }
  });
  return blocks;
}

export const stepsOf = (log: LogEntry[]) => blocksOf(log).flatMap((block) => ("steps" in block ? block.steps : []));

/** A session can run many turns. What it did and how long it took are about the latest one. */
export const turnStart = (s: SessionDetail) => s.turnAt ?? s.startedAt;
export const thisTurn = (s: SessionDetail) => (s.turnAt ? s.log.filter((entry) => (entry.at ?? 0) >= s.turnAt!) : s.log);

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Which line of the agent's own list it is on. */
export function todoStep(todos: Todo[]): string {
  const done = todos.filter((t) => t.status === "completed").length;
  return `Step ${Math.min(done + 1, todos.length)} of ${todos.length}`;
}

/** The lines worth showing when a long list will not fit: from just before where it is. */
export function todoWindow(todos: Todo[], most: number): Todo[] {
  const at = todos.findIndex((t) => t.status !== "completed");
  const from = Math.min(Math.max(0, (at < 0 ? todos.length : at) - 1), Math.max(0, todos.length - most));
  return todos.slice(from, from + most);
}

/** Terminals report tasks one at a time, and those start without a status. */
export function mergeTodo(todos: Todo[], change: { id: string; text?: string | null; status?: string | null }): Todo[] {
  const { id, text, status } = change;
  if (status === "deleted") return todos.filter((t) => t.id !== id);
  if (todos.some((t) => t.id === id)) return todos.map((t) => (t.id === id ? { ...t, text: text ?? t.text, status: status ?? t.status } : t));
  return text ? [...todos, { id, text, status: status ?? "pending" }] : todos;
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  edits: LogEntry[];
}

export function changedFiles(log: LogEntry[]): FileChange[] {
  const files = new Map<string, FileChange>();
  for (const entry of log) {
    if (entry.kind !== "diff") continue;
    const file = files.get(entry.text) ?? { path: entry.text, added: 0, removed: 0, edits: [] };
    file.added += linesAdded(entry);
    file.removed += linesRemoved(entry);
    file.edits.push(entry);
    files.set(entry.text, file);
  }
  return [...files.values()];
}

const TEST_COMMAND = /\b(test|tests|vitest|jest|pytest|mocha|rspec|playwright|phpunit|nextest)\b/i;
const TESTS_FAILED = /\b[1-9]\d* (tests? )?(failed|failing|failures?)\b|test result: FAILED|^\s*FAIL\b/im;
const TESTS_PASSED = /\b[1-9]\d* (tests? )?(passed|passing)\b|test result: ok\b|^\s*PASS\b|^ok\s|\bOK \(\d+ tests?\)/im;

/** What the last test run really printed. A command that says neither way says nothing. */
export function testsResult(log: LogEntry[]): "passed" | "failed" | null {
  for (const entry of log.slice().reverse()) {
    if (entry.kind === "activity" && entry.text.startsWith(FAILED) && TEST_COMMAND.test(entry.text)) return "failed";
    if (entry.kind !== "output" || !TEST_COMMAND.test(entry.text)) continue;
    const printed = entry.lines?.join("\n") ?? "";
    if (entry.failed || TESTS_FAILED.test(printed)) return "failed";
    return TESTS_PASSED.test(printed) ? "passed" : null;
  }
  return null;
}

/** The agent's own last words this turn, as plain text. */
export function lastMessage(s: SessionDetail): string | null {
  const last = thisTurn(s).filter((entry) => entry.kind === "text" && entry.text.trim()).pop();
  return last ? last.text.replace(/[*`#]/g, "").replace(/\s+/g, " ").trim() : null;
}

/** What a finished turn came to, leaving out whatever is not known. */
export function endFacts(s: SessionDetail): string {
  const turn = thisTurn(s);
  const files = changedFiles(turn).length;
  const tests = testsResult(turn);
  const cost = s.usage?.costUsd;
  return [files > 0 && `${count(files, "file")} changed`, tests && `tests ${tests}`, cost != null && `$${cost.toFixed(2)}`].filter(Boolean).join(", ");
}

/** Minutes and seconds, for a step or a running clock. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** How long something took, the way it is said: 3 min 12 s. */
export function spent(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min ${seconds % 60} s` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// ── How long it worked ──────────────────────────────────────────────────────

export interface LoggedStep {
  text: string;
  /** How long it took, or has taken so far for the one under way. Null for history kept before times were. */
  ms: number | null;
  /** Under way now. */
  now: boolean;
}

/** The end of a command's output that says how its tests went. */
const FAILED_COUNT = /\b(\d+) (?:tests? )?(?:failed|failing)\b/i;
const PASSED_COUNT = /\b(\d+) (?:tests? )?(?:passed|passing)\b/i;

function ranWords(step: Step): string {
  const printed = step.output?.join("\n") ?? "";
  const failed = Number(printed.match(FAILED_COUNT)?.[1] ?? 0);
  const passed = Number(printed.match(PASSED_COUNT)?.[1] ?? 0);
  if (TEST_COMMAND.test(step.what) && failed > 0) return `: ${failed} failed`;
  if (TEST_COMMAND.test(step.what) && passed > 0 && !step.failed) return `: all ${passed} passed`;
  return step.failed ? ": it failed" : "";
}

const lineCount = (lines?: number) => (lines ? `, ${count(lines, "line")}` : "");
const TOOL_WORDS: Record<string, [now: string, done: string]> = {
  AskUserQuestion: ["Asking you a question", "Asked you a question"],
  ExitPlanMode: ["Showing you a plan", "Showed you a plan"],
};

/** One step in plain words: what it is doing while it runs, and what it did once done. */
function stepWords(steps: Step[], now: boolean): string {
  const step = steps[0]!;
  const what = step.what;
  switch (step.word) {
    case "Reading": {
      const files = [...new Set(steps.map((s) => s.what))];
      const rest = files.length > 1 ? ` and ${count(files.length - 1, "other file")}` : "";
      return `${now ? "Reading" : "Read"} ${files[0]}${rest}`;
    }
    case "Editing":
      return `${now ? "Editing" : "Changed"} ${what}${lineCount(steps.reduce((n, s) => n + (s.lines ?? 0), 0))}`;
    case "Writing":
      return `${now ? "Writing" : "Wrote"} ${what}${lineCount(step.lines)}`;
    case "Running":
      return now ? `Running ${what}` : `Ran ${what}${ranWords(step)}`;
    case "Searching":
      return `${now ? "Searching for" : "Searched for"} ${what}`;
    case "Searching the web":
      return `${now ? "Searching the web" : "Searched the web"}${what ? ` for ${what}` : ""}`;
    case "Fetching":
      return `${now ? "Fetching" : "Fetched"} ${what}`;
    case "Subagent":
      return `${now ? "Working with a helper" : "Worked with a helper"}: ${what}`;
    default: {
      const own = TOOL_WORDS[what];
      return own ? own[now ? 0 : 1] : `${now ? "Using" : "Used"} ${what}`;
    }
  }
}

/** Reads in a row are one step, and so are edits in a row to the same file. */
const runOf = (step: Step) => (step.word === "Reading" ? "read" : step.word === "Editing" ? `edit:${step.what}` : null);

/** What the latest turn did, step by step in plain words, with how long each took. A step lasts until the
 *  next one starts, and the first counts from the turn's start, so the times add up to the whole. Once it
 *  has ended, its last words are a step of their own. */
export function stepLog(s: SessionDetail, now: number): LoggedStep[] {
  const turn = thisTurn(s);
  const groups: Step[][] = [];
  for (const step of stepsOf(turn)) {
    const last = groups[groups.length - 1];
    if (last && runOf(step) !== null && runOf(step) === runOf(last[0]!)) last.push(step);
    else groups.push([step]);
  }
  if (groups.length === 0) return [];
  const live = LIVE.includes(s.status);
  const end = live ? now : s.endedAt ?? now;
  const lastAt = groups[groups.length - 1]![0]!.at;
  const said = live ? undefined : turn.find((e) => e.kind === "text" && e.text.trim() && e.at !== undefined && lastAt !== undefined && e.at >= lastAt)?.at;
  // ponytail: a terminal's last words come with its Stop, so they took no time we can see. They stay in the step before.
  const summary = said !== undefined && end - said >= 1000 ? said : undefined;
  const starts = groups.map((g, i) => (i === 0 ? turnStart(s) : g[0]!.at));
  const log = groups.map((group, i): LoggedStep => {
    const start = starts[i];
    const until = i + 1 < groups.length ? starts[i + 1] : summary ?? end;
    const under = live && i === groups.length - 1;
    const ms = start === undefined || until === undefined ? null : Math.max(0, until - start);
    return { text: stepWords(group, under), ms, now: under };
  });
  return summary === undefined ? log : [...log, { text: "Wrote a summary", ms: end - summary, now: false }];
}

/** The time a turn has taken, so far or in all. */
export const worked = (s: SessionDetail, now: number) => (LIVE.includes(s.status) ? now : s.endedAt ?? now) - turnStart(s);

const needsYou = (s: SessionDetail) => s.approval !== null || s.status === "waiting";

export const needsFirst = (sessions: SessionDetail[]) => sessions.slice().sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)));

/** One session's stage, for a row beside others. */
export function stageLine(s: SessionDetail): { text: string; kind: StepKind | "needs" } {
  if (needsYou(s)) return { text: "Needs you", kind: "needs" };
  const { kind, word, what } = actionOf(s.activity);
  return { text: kind === "other" ? what || word : `${word} ${what}`, kind };
}

/** What a tile shows: the latest work while it runs, and how it came out once it has ended. */
export function recentLines(s: SessionDetail, most = 3): string[] {
  if (!LIVE.includes(s.status)) return [endFacts(s), lastMessage(s) ?? ""].filter(Boolean);
  return stepsOf(thisTurn(s)).slice(-most).flatMap((step) => [`${step.verb} ${step.what}`, ...(step.output ?? [])]).slice(-most);
}

/** The state of a tile, in a few words. */
export function tileState(s: SessionDetail, now: number): string {
  if (s.approval || !LIVE.includes(s.status)) {
    if (s.status !== "completed") return doing(s);
    const when = ago(lastActive(s), now);
    return when === "now" ? "Finished just now" : `Finished ${when} ago`;
  }
  const when = ago(turnStart(s), now);
  return when === "now" ? "Running" : `Running, ${when}`;
}

/** The steps in a plan, counted from its list. */
export const planSteps = (plan: string) => (plan.match(/^\s*(?:\d+\.|[-*])\s/gm) ?? []).length;

/** The window that stopped a failed session, while it has not yet reset. */
export function limitStop(s: SessionDetail, windows: LimitWindow[] | undefined, now: number): LimitWindow | null {
  if (s.status !== "failed") return null;
  return windows?.find((w) => w.usedPercent >= 100 && (!w.resetsAt || w.resetsAt * 1000 > now)) ?? null;
}
