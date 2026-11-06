// Finish this for me, on the page's side: the island shows what the core says the task is doing.
// The page never starts a task and never answers a question by itself. Stop, Continue, Undo and every
// answer are the user's clicks on the island.

import { bridge } from "./bridge";
import { setPlace } from "./here";
import { getState, openPanel, openSettings, setFinish } from "./store";

/** A step, in plain words. `at` is milliseconds since the task began. */
export interface FinishLine {
  at: number;
  text: string;
  /** "mail", "notes" or "Knowledge", for a line that came from what it read. */
  from: string | null;
}

/** A step waiting for one click. `button` is the control's own name, shown as the app has it. */
export interface FinishQuestion {
  id: string;
  kind: "commit" | "upload" | "site" | "landed" | "detail";
  title: string;
  body: string;
  button: string | null;
  yes: string;
  no: string;
}

export interface FinishEnd {
  kind: "done" | "stopped" | "failed" | "payment";
  title: string;
  body: string;
  site: string | null;
  /** Milliseconds of work, without the time it waited for the user. */
  worked: number;
  steps: number;
  clicks: number;
  filled: number;
  sent: boolean;
}

/** Why a task could not start, said before anything in the window was read. */
export interface FinishCard {
  kind: "off" | "local" | "never" | "not-listed";
  title: string;
  body: string;
  id: string | null;
  name: string | null;
}

export interface FinishView {
  phase: "working" | "paused" | "ask" | "ended" | "card";
  app: string;
  /** When the task began, in milliseconds since 1970. */
  startedAt: number;
  now: string;
  steps: FinishLine[];
  note: string | null;
  paused: string | null;
  ask: FinishQuestion | null;
  end: FinishEnd | null;
  card: FinishCard | null;
}

/** What the island shows: the core's view, and whether every step is open. */
export interface FinishState extends FinishView {
  all: boolean;
  /** What Undo said, once it has run. */
  undone?: string;
}

/** The last few steps while it works, and more once it is done, unless every step is open. */
export const WORKING_ROWS = 3;
export const ENDED_ROWS = 6;
const ALL_ROWS = 12;

/** 0:09, 1:52. */
export function clock(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** 38 s, 2 min, 1 min 52 s. */
export function workedFor(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest} s`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Worked for 1 min 52 s · 9 steps · 2 clicks from you. */
export function summary(end: FinishEnd) {
  const clicks = end.clicks === 0 ? "no clicks from you" : `${plural(end.clicks, "click", "clicks")} from you`;
  return `Worked for ${workedFor(end.worked)} · ${plural(end.steps, "step", "steps")} · ${clicks}`;
}

/** The steps on show: the latest ones, or as many as fit when every step is open. */
export function shownSteps(state: FinishState) {
  const rows = state.all ? ALL_ROWS : state.phase === "ended" ? ENDED_ROWS : WORKING_ROWS;
  return state.steps.slice(-rows);
}

/** There are steps out of sight, so the island offers to show them. */
export const moreSteps = (state: FinishState) => !state.all && state.steps.length > shownSteps(state).length;

/** The step log's box, with a row per step. */
const logBox = (rows: number) => (rows > 0 ? 16 + rows * 21 : 0);

/** The island's size for each card on the Finish this for me board. */
export function finishGeometry(state: FinishState) {
  const rows = shownSteps(state).length;
  switch (state.phase) {
    case "working":
      return { w: 470, h: 108 + logBox(rows), r: 24 };
    case "paused":
      return { w: 440, h: 92, r: 24 };
    case "ask":
      return { w: 440, h: state.ask?.kind === "commit" ? 136 : 118, r: 24 };
    case "ended":
      if (state.end?.kind === "done") return { w: 470, h: 132 + logBox(rows) + (state.end.sent ? 20 : 0), r: 24 };
      return { w: 440, h: 118, r: 24 };
    case "card":
      return { w: 440, h: 118, r: 24 };
  }
}

/** The core said what the task is doing now. Every step open stays open. */
export function showFinish(view: FinishView | null) {
  const before = getState().finish;
  setFinish(view ? { ...view, all: before?.all ?? false, undone: view.phase === "ended" ? before?.undone : undefined } : null);
}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const stopFinish = () => void bridge.finishStop();
export const continueFinish = () => void bridge.finishContinue();

/** The user's click on the question up. */
export function answerFinish(yes: boolean) {
  const asked = getState().finish?.ask;
  if (asked) void bridge.finishAnswer(asked.id, yes).catch(() => undefined);
}

export function toggleSteps() {
  const finish = getState().finish;
  if (finish) setFinish({ ...finish, all: !finish.all });
}

/** Puts back the boxes it filled, where they still hold what it wrote. */
export async function undoFinish() {
  const undone = await bridge.finishUndo().catch(describe);
  const finish = getState().finish;
  if (finish) setFinish({ ...finish, undone });
}

export function closeFinish() {
  setFinish(null);
  void bridge.finishClose();
}

/** Allow on the island: the app or site gets Finish too, and the same task starts again with every check. */
export async function allowFinish() {
  const card = getState().finish?.card;
  if (!card?.id || !card.name) return;
  const known = getState().settings.fill.places.find((p) => p.id.toLowerCase() === card.id!.toLowerCase());
  await setPlace({ id: card.id, name: known?.name ?? card.name, fill: "allowed", finish: true, alwaysAsk: false });
  setFinish(null);
  await bridge.finishAgain().catch(() => undefined);
}

/** The experiment is off: the switch is in Settings › Fill in the page. */
export function finishSettings() {
  setFinish(null);
  openSettings("fill");
  openPanel("settings");
}

export function wireFinish() {
  void bridge.onFinishState(showFinish);
}
