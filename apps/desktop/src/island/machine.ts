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
  | "note";

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
  if (waitingApproval(s.sessions)) return "working";
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
};

const IDLE_HOVER: Geometry = { w: 380, h: 118, r: 26 };
const GREETING: Geometry = { w: 224, h: 40, r: 17 };
const LIVE_OPEN: Geometry = { w: 408, h: 148, r: 28 };
const LIVE_OPEN_SHORT: Geometry = { w: 408, h: 122, r: 28 };
const MEDIA_OPEN: Geometry = { w: 388, h: 172, r: 28 };
const BATTERY: Geometry = { w: 340, ...BAR };
const BATTERY_OPEN: Geometry = { w: 408, h: 104, r: 28 };
const APPROVAL: Geometry = { w: 430, h: 132, r: 26 };
const PLAN: Geometry = { w: 470, h: 320, r: 28 };
/** Room for two lines of a question, plus this much per option. */
const QUESTION_BASE = 134;
const QUESTION_ROW = 40;
const MULTITASK_ROW = 34;
const MULTITASK_PAD = 18;
export const MULTITASK_MAX_ROWS = 4;
/** A session carrying on while another one asks, under the question. */
const OTHER_ROW = 38;
const STAGES: Geometry = { w: 344, h: 208, r: 22 };
/** The heading of the to-do card, plus this much per line. */
const TODO_BASE = 46;
const TODO_ROW = 23;
export const TODO_MAX_ROWS = 6;
const FINISHED: Geometry = { w: 344, h: 196, r: 22 };
/** Nothing to quote, so only the heading, the facts and the buttons. */
const FINISHED_BRIEF: Geometry = { w: 344, h: 126, r: 22 };
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
  /** What is on show is an agent that stopped. */
  stopped?: boolean;
  /** Nothing is recording, so the note view is only saying it is writing. */
  noteWriting?: boolean;
  /** The notice on show says some notes are ready. */
  noteReady?: boolean;
  /** The error on show is a note that could not be written. */
  noteFailed?: boolean;
}

export function geometryFor(view: IslandView, ctx: GeometryContext): Geometry {
  if (view === "expanded") return PANELS[ctx.tab ?? "home"] ?? EXPANDED;
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
    return { ...APPROVAL, h: QUESTION_BASE + most * QUESTION_ROW + others };
  }
  if (view === "working" && ctx.approval) return { ...APPROVAL, h: APPROVAL.h + others };
  if (view === "working" && ctx.hovered && ctx.todos) return { w: 324, h: TODO_BASE + Math.min(ctx.todos, TODO_MAX_ROWS) * TODO_ROW, r: 22 };
  if (view === "working" && ctx.hovered) return STAGES;
  if (view === "note") return ctx.noteWriting ? NOTE_WRITING : ctx.hovered ? NOTE_STOP : SIZES.note;
  if (view === "notification" && ctx.noteReady) return NOTE_READY;
  if (view === "error" && ctx.noteFailed) return NOTE_FAILED;
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
    default:
      return "--state-idle";
  }
}
