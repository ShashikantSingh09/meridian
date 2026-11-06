// What the island shows, as a pure function of app state. No DOM, no timers,
// so every priority rule below is covered by machine.test.ts.

import type { Approval, SessionStatus, Todo } from "../lib/types";
import type { LiveActivity } from "./live";

export type IslandView =
  | "idle"
  | "listening"
  | "thinking"
  | "working"
  | "notification"
  | "expanded"
  | "contextual"
  | "multitask"
  | "screen"
  | "media"
  | "live"
  | "error" | "level" | "voice"
  | "note"
  | "here"
  | "ask"
  | "finish";

export interface SessionSummary {
  id: string;
  agent: string;
  project: string;
  status: SessionStatus;
  activity: string;
  startedAt: number;
  approval: Approval | null;
  /** A request folded away to answer later. The island leaves it until another one comes. */
  foldedId?: string | null;
  /** The agent's own to-do list, when it keeps one. In memory only. */
  todos?: Todo[];
}

export interface NoticeAction {
  label: string;
  url: string | null;
}

export interface Notice {
  id: string;
  tone: "success" | "info" | "urgent";
  title: string;
  body: string;
  sessionId?: string;
  /** Set for a reminder, so snooze and dismiss reach the event itself. */
  eventId?: string;
  actions?: NoticeAction[];
  /** Stays on the island until answered. */
  sticky?: boolean;
  /** A session has ended, so the island shows what it did. */
  finished?: boolean;
  /** A recording nobody has spoken in, and the seconds before it stops by itself. */
  quiet?: number;
  /** Notes are ready, so the island offers to open them. */
  note?: string;
  /** A new version can be installed, so clicking opens Updates. */
  update?: boolean;
  /** The morning line: what needs the user today, a line each, shown when the pointer is on it. */
  cards?: CardLine[];
}

/** One card, as the morning line lists it. A line only opens the card in My Day. */
export interface CardLine {
  id: string;
  kind: "reply" | "renewal" | "trip";
  title: string;
  meta: string;
}

export interface Suggestion {
  id: string;
  title: string;
  body: string;
  /** Set for a suggestion that came from the screen, to silence it on Ignore. */
  key?: string;
}

export interface IslandError {
  id: string;
  title: string;
  body: string;
  retry?: () => void;
  /** An agent stopped, so the island says where and can open it. */
  sessionId?: string;
  /** A note could not be written, so the island can open it. */
  note?: string;
}

export interface Snapshot {
  panelOpen: boolean;
  listening: boolean;
  capturing: boolean;
  /** Something is playing and media is enabled. */
  mediaPlaying: boolean;
  chatPending: boolean;
  sessions: SessionSummary[];
  notices: Notice[];
  suggestions: Suggestion[];
  errors: IslandError[];
  live: LiveActivity[];
  /** The volume, brightness or battery, just after it changed. */
  level?: boolean;
  /** A spoken conversation is going on. */
  voice?: boolean;
  /** A call is being recorded. */
  recording?: boolean;
  /** A recorded call is being written up. */
  writingNote?: boolean;
  /** Write here is reading, writing, or saying how it went. */
  here?: boolean;
  /** A question asked on the island, from typing it to its answer. */
  asking?: boolean;
  /** Finish this for me is at work, waiting for the user, or showing how it ended. */
  finish?: boolean;
}

const ACTIVE: ReadonlySet<SessionStatus> = new Set(["starting", "running", "waiting"]);

export const activeSessions = <T extends SessionSummary>(sessions: T[]) =>
  sessions.filter((s) => ACTIVE.has(s.status));

export const waitingApproval = <T extends SessionSummary>(sessions: T[]) =>
  sessions.find((s) => s.approval !== null && s.foldedId !== s.approval.id) ?? null;

/** How many requests are waiting across every session, folded or not. */
export const waitingCount = (sessions: SessionSummary[]) => sessions.reduce((n, s) => n + (s.approval ? 1 : 0) + ((s as { queued?: unknown[] }).queued?.length ?? 0), 0);

/**
 * Priority, highest first. The user's own actions win, then anything that
 * needs a decision, then passing news, then ambient work. An approval outranks
 * notices because an agent is blocked until someone answers.
 */
export function deriveView(s: Snapshot): IslandView {
  // A conversation can start from inside the panel, and an open microphone always shows.
  if (s.panelOpen && !s.voice) return "expanded";
  if (s.listening) return "listening";
  if (s.capturing) return "screen";
  // A task in the user's app, which they watch step by step, and whose Stop must always be on show.
  if (s.finish) return "finish";
  if (waitingApproval(s.sessions)) return "working";
  // Started by the user a moment ago, and the reply going into their box is what they are waiting for.
  if (s.here) return "here";
  if (s.asking) return "ask";
  if (s.voice) return "voice";
  if (s.errors.length > 0) return "error";
  if (s.notices.length > 0) return "notification";
  // The user has just pressed a key, so it shows at once, and only for a moment.
  if (s.level) return "level";
  // Boarding or a meeting about to start matters more than work that can carry on.
  if (s.live[0]?.urgent) return "live";
  const active = activeSessions(s.sessions);
  if (s.suggestions.length > 0 && active.length === 0) return "contextual";
  if (active.length > 1) return "multitask";
  if (active.length === 1) return "working";
  if (s.chatPending) return "thinking";
  if (s.live.length > 0) return "live";
  if (s.mediaPlaying) return "media";
  // Anything above can take the island, and the red dot stays on show over all of it.
  if (s.recording || s.writingNote) return "note";
  return "idle";
}

export interface Geometry {
  w: number;
  h: number;
  r: number;
}

/** The radius is for the two bottom corners only: the top is the screen's edge. */
export const EXPANDED: Geometry = { w: 820, h: 600, r: 32 };

/** One size for every page, as on the boards, so moving between tabs never resizes the window. */
const PANELS: Record<string, Geometry> = {
  home: { w: 820, h: 600, r: 32 },
  chat: { w: 820, h: 600, r: 32 },
  agents: { w: 820, h: 600, r: 32 },
  media: { w: 820, h: 600, r: 32 },
  day: { w: 820, h: 600, r: 32 },
  notes: { w: 820, h: 600, r: 32 },
  inbox: { w: 820, h: 600, r: 32 },
  settings: EXPANDED,
};

/** Everything small and active shares one height, so moving between them only changes the width. */
const BAR = { h: 46, r: 19 };

const SIZES: Record<IslandView, Geometry> = {
  idle: { w: 104, h: 34, r: 15 },
  listening: { w: 340, ...BAR },
  thinking: { w: 270, ...BAR },
  working: { w: 324, h: 52, r: 22 },
  notification: { w: 392, h: 62, r: 22 },
  expanded: EXPANDED,
  contextual: { w: 420, h: 112, r: 24 },
  multitask: { w: 344, h: 0, r: 22 },
  screen: { w: 264, ...BAR },
  media: { w: 340, ...BAR },
  live: { w: 300, ...BAR },
  level: { w: 300, ...BAR },
  voice: { w: 440, h: 96, r: 26 },
  error: { w: 392, h: 58, r: 21 },
  note: { w: 190, ...BAR },
  here: { w: 300, ...BAR },
  ask: { w: 440, h: 92, r: 24 },
  finish: { w: 470, h: 108, r: 24 },
};

/** Write here's line with Undo, Shorter and Warmer, a line on why not, and a card that needs a click. */
const HERE_WRITTEN: Geometry = { w: 450, ...BAR };
const HERE_LINE: Geometry = { w: 380, ...BAR };
const HERE_CARD: Geometry = { w: 430, h: 128, r: 24 };
/** Fill this form: the line once it is in, the card after Undo, and the Show list with a row a box. */
const FORM_FILLED: Geometry = { w: 420, ...BAR };
const FORM_UNDONE: Geometry = { w: 440, h: 96, r: 24 };
const FORM_LIST = (rows: number): Geometry => ({ w: 560, h: 102 + rows * 25, r: 26 });

function hereGeometry(step: string | undefined, rows: number): Geometry {
  switch (step) {
    case "writing":
    case "filling":
      return SIZES.here;
    case "written":
      return HERE_WRITTEN;
    case "line":
      return HERE_LINE;
    case "filled":
      return FORM_FILLED;
    case "list":
      return FORM_LIST(rows);
    case "undone":
      return FORM_UNDONE;
    default:
      return HERE_CARD;
  }
}
/** The question while it is answered, and the answer: a line per line of it, three at most. */
const ASK_THINKING: Geometry = { w: 330, ...BAR };
const ASK_ANSWER = (lines: number): Geometry => ({ w: 440, h: 61 + lines * 20, r: 24 });
const ASK_FAILED: Geometry = { w: 440, h: 118, r: 24 };

/** The greeting, the chips, and a row to ask from and to Write here. */
const IDLE_HOVER: Geometry = { w: 380, h: 164, r: 26 };
const GREETING: Geometry = { w: 224, h: 40, r: 17 };
const LIVE_OPEN: Geometry = { w: 408, h: 148, r: 28 };
const LIVE_OPEN_SHORT: Geometry = { w: 408, h: 122, r: 28 };
const MEDIA_OPEN: Geometry = { w: 388, h: 172, r: 28 };
const BATTERY: Geometry = { w: 340, ...BAR };
const BATTERY_OPEN: Geometry = { w: 408, h: 104, r: 28 };
const APPROVAL: Geometry = { w: 430, h: 132, r: 26 };
const PLAN: Geometry = { w: 470, h: 320, r: 28 };
/** Room for two lines of a question and the box to type an answer in, plus this much per option. */
const QUESTION_BASE = 138;
const QUESTION_ROW = 40;
const QUESTION_W = 460;
const MULTITASK_ROW = 34;
const MULTITASK_PAD = 18;
export const MULTITASK_MAX_ROWS = 4;
/** A session carrying on while another one asks, under the question. */
const OTHER_ROW = 38;
/** The working card: its heading, the step under way and the buttons, and the short step log. */
const STAGES: Geometry = { w: 460, h: 106, r: 24 };
/** The last few steps on the working card, and as many as fit on the finished one. */
export const STAGE_ROWS = 3;
export const FINISHED_ROWS = 6;
/** The step log's box, with a row per step. */
const logBox = (rows: number) => (rows > 0 ? 20 + rows * 21 : 0);
/** The heading of the to-do card, plus this much per line. */
const TODO_BASE = 46;
const TODO_ROW = 23;
export const TODO_MAX_ROWS = 6;
/** The heading, the title, how long it worked and the buttons, then its last words or its steps. */
const FINISHED: Geometry = { w: 460, h: 196, r: 24 };
const FINISHED_BRIEF: Geometry = { w: 460, h: 126, r: 24 };
const FINISHED_LOG = 120;
const STOPPED: Geometry = { w: 344, h: 164, r: 22 };

const IDLE_CLOCK: Geometry = { w: 148, h: 34, r: 15 };
/** With a laptop's charge beside the clock, or on its own. */
const IDLE_CLOCK_CHARGE: Geometry = { w: 214, h: 34, r: 15 };
const IDLE_CHARGE: Geometry = { w: 124, h: 34, r: 15 };
/** Room for the plan-use ring beside the time. */
const USAGE_W = 30;
const SLIVER: Geometry = { w: 96, h: 6, r: 3 };
const REMINDER: Geometry = { w: 420, h: 112, r: 24 };
const NOTE_STOP: Geometry = { w: 262, ...BAR };
const NOTE_WRITING: Geometry = { w: 250, ...BAR };
const NOTE_READY: Geometry = { w: 372, ...BAR };
const NOTE_FAILED: Geometry = { w: 330, ...BAR };
/** The morning line, and the card it opens into under the pointer: its heading and buttons, plus a row a card. */
const MORNING: Geometry = { w: 330, ...BAR };
const MORNING_OPEN: Geometry = { w: 430, h: 92, r: 24 };
const MORNING_ROW = 28;

export interface GeometryContext {
  hovered: boolean;
  rows: number;
  approval: boolean;
  /** What is waiting, when it needs more room than a command does. */
  asking?: Approval | null;
  clock?: boolean;
  /** A laptop's charge is shown at rest. */
  charge?: boolean;
  /** The plan-use ring is shown at rest. */
  usage?: boolean;
  /** Idle with auto-hide on: only a sliver remains until the pointer arrives. */
  sliver?: boolean;
  /** A notice with actions needs room for its buttons. */
  actions?: boolean;
  /** The open page, which sets the panel's size. */
  tab?: string;
  /** The player was clicked open. */
  mediaOpen?: boolean;
  /** The words on show need a second line. */
  voiceLong?: boolean;
  /** The level showing is the battery, which has more to say. */
  battery?: boolean;
  /** Says hello once, just after the app starts. */
  greeting?: boolean;
  /** The live activity has a route or steps, which need a row of their own. */
  liveRich?: boolean;
  /** Lines in the agent's own to-do list. */
  todos?: number;
  /** A session's end is on show, and whether there is a message to quote. */
  finished?: "message" | "brief";
  /** Steps in the log of the session on show. */
  steps?: number;
  /** What is on show is an agent that stopped. */
  stopped?: boolean;
  /** Nothing is recording, so the note view is only saying it is writing. */
  noteWriting?: boolean;
  /** The notice on show says some notes are ready. */
  noteReady?: boolean;
  /** The error on show is a note that could not be written. */
  noteFailed?: boolean;
  /** Lines in the morning line on show. */
  cards?: number;
  /** Where Write here, or Fill this form, is up to. */
  here?: string;
  /** Rows of room the Show list of a form needs. */
  formRows?: number;
  /** Where a question asked on the island is up to, and how many lines its answer takes. */
  ask?: { phase: string; lines: number };
  /** Finish this for me's card, sized by `finishGeometry` from what it shows. */
  finish?: Geometry;
}

export function geometryFor(view: IslandView, ctx: GeometryContext): Geometry {
  if (view === "expanded") return PANELS[ctx.tab ?? "home"] ?? EXPANDED;
  if (view === "finish") return ctx.finish ?? SIZES.finish;
  if (view === "idle" && ctx.greeting) return GREETING;
  if (view === "idle" && ctx.hovered) return IDLE_HOVER;
  if (view === "idle" && ctx.sliver) return SLIVER;
  if (view === "idle" && (ctx.clock || ctx.charge)) {
    const base = ctx.clock ? (ctx.charge ? IDLE_CLOCK_CHARGE : IDLE_CLOCK) : IDLE_CHARGE;
    return ctx.usage ? { ...base, w: base.w + USAGE_W } : base;
  }
  // Whoever else is at work stays on show under a question, with what needs the user first.
  const others = Math.max(0, Math.min(ctx.rows, MULTITASK_MAX_ROWS) - 1) * OTHER_ROW;
  if (view === "working" && ctx.asking?.plan) return { ...PLAN, h: PLAN.h + others };
  if (view === "working" && ctx.asking?.questions?.length) {
    const most = Math.max(...ctx.asking.questions.map((q) => Math.min(q.options.length, 4)));
    return { ...APPROVAL, w: QUESTION_W, h: QUESTION_BASE + most * QUESTION_ROW + others };
  }
  if (view === "working" && ctx.approval) return { ...APPROVAL, h: APPROVAL.h + others };
  if (view === "working" && ctx.hovered && ctx.todos) return { w: 324, h: TODO_BASE + Math.min(ctx.todos, TODO_MAX_ROWS) * TODO_ROW, r: 22 };
  if (view === "working" && ctx.hovered) return { ...STAGES, h: STAGES.h + logBox(Math.min(ctx.steps ?? 0, STAGE_ROWS)) };
  if (view === "note") return ctx.noteWriting ? NOTE_WRITING : ctx.hovered ? NOTE_STOP : SIZES.note;
  if (view === "notification" && ctx.cards) return ctx.hovered ? { ...MORNING_OPEN, h: MORNING_OPEN.h + ctx.cards * MORNING_ROW } : MORNING;
  if (view === "here") return hereGeometry(ctx.here, ctx.formRows ?? 0);
  if (view === "ask") {
    if (ctx.ask?.phase === "thinking") return ASK_THINKING;
    if (ctx.ask?.phase === "answer") return ASK_ANSWER(ctx.ask.lines);
    if (ctx.ask?.phase === "failed") return ASK_FAILED;
  }
  if (view === "notification" && ctx.noteReady) return NOTE_READY;
  if (view === "error" && ctx.noteFailed) return NOTE_FAILED;
  if (view === "notification" && ctx.finished && ctx.steps) return { ...FINISHED, h: FINISHED_LOG + logBox(Math.min(ctx.steps, FINISHED_ROWS)) };
  if (view === "notification" && ctx.finished) return ctx.finished === "message" ? FINISHED : FINISHED_BRIEF;
  if (view === "error" && ctx.stopped) return STOPPED;
  if (view === "media" && ctx.mediaOpen) return MEDIA_OPEN;
  if (view === "voice" && ctx.voiceLong) return { ...SIZES.voice, h: 118 };
  if (view === "level" && ctx.battery) return ctx.hovered ? BATTERY_OPEN : BATTERY;
  if (view === "live" && ctx.hovered) return ctx.liveRich ? LIVE_OPEN : LIVE_OPEN_SHORT;
  if (view === "notification" && ctx.actions) return REMINDER;
  if (view === "multitask") {
    const rows = Math.min(ctx.rows, MULTITASK_MAX_ROWS);
    return { ...SIZES.multitask, h: rows * MULTITASK_ROW + MULTITASK_PAD };
  }
  return SIZES[view];
}

/** Colour of the line of light, as a design token name. */
export function stateToken(view: IslandView, s: Snapshot): string {
  switch (view) {
    case "listening":
      return "--state-listening";
    case "thinking":
      return "--state-thinking";
    case "working":
      return waitingApproval(s.sessions) ? "--state-waiting" : "--state-working";
    case "multitask":
      return "--state-working";
    case "notification":
      return s.notices[0]?.tone === "success"
        ? "--state-success"
        : s.notices[0]?.tone === "urgent"
          ? "--state-waiting"
          : "--state-notice";
    case "contextual":
    case "screen":
      return "--state-context";
    case "media":
    case "level":
    case "voice":
      return "--state-listening";
    case "live":
      return s.live[0]?.tone ?? "--state-working";
    case "error":
      return "--state-error";
    case "here":
    case "ask":
      return "--state-thinking";
    case "finish":
      return "--state-working";
    default:
      return "--state-idle";
  }
}
