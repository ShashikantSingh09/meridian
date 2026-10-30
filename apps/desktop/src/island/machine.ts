// What the island shows, as a pure function of app state. No DOM, no timers,
// so every priority rule below is covered by machine.test.ts.

import type { Approval, SessionStatus } from "../lib/types";
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
  | "error";

export interface SessionSummary {
  id: string;
  agent: string;
  project: string;
  status: SessionStatus;
  activity: string;
  startedAt: number;
  approval: Approval | null;
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
}

const ACTIVE: ReadonlySet<SessionStatus> = new Set(["starting", "running", "waiting"]);

export const activeSessions = <T extends SessionSummary>(sessions: T[]) =>
  sessions.filter((s) => ACTIVE.has(s.status));

export const waitingApproval = <T extends SessionSummary>(sessions: T[]) =>
  sessions.find((s) => s.approval !== null) ?? null;

/**
 * Priority, highest first. The user's own actions win, then anything that
 * needs a decision, then passing news, then ambient work. An approval outranks
 * notices because an agent is blocked until someone answers.
 */
export function deriveView(s: Snapshot): IslandView {
  if (s.panelOpen) return "expanded";
  if (s.listening) return "listening";
  if (s.capturing) return "screen";
  if (waitingApproval(s.sessions)) return "working";
  if (s.errors.length > 0) return "error";
  if (s.notices.length > 0) return "notification";
  // Boarding or a meeting about to start matters more than work that can carry on.
  if (s.live[0]?.urgent) return "live";
  const active = activeSessions(s.sessions);
  if (s.suggestions.length > 0 && active.length === 0) return "contextual";
  if (active.length > 1) return "multitask";
  if (active.length === 1) return "working";
  if (s.chatPending) return "thinking";
  if (s.live.length > 0) return "live";
  if (s.mediaPlaying) return "media";
  return "idle";
}

export interface Geometry {
  w: number;
  h: number;
  r: number;
}

/** The radius is for the two bottom corners only: the top is the screen's edge. */
export const EXPANDED: Geometry = { w: 820, h: 600, r: 32 };

/** Each page is only as big as it needs, so moving between them is a morph too. */
const PANELS: Record<string, Geometry> = {
  home: { w: 780, h: 560, r: 32 },
  chat: { w: 680, h: 560, r: 32 },
  agents: { w: 820, h: 600, r: 32 },
  media: { w: 640, h: 310, r: 32 },
  day: { w: 720, h: 580, r: 32 },
  inbox: { w: 640, h: 500, r: 32 },
  settings: EXPANDED,
};

/** Everything small and active shares one height, so moving between them only changes the width. */
const BAR = { h: 46, r: 19 };

const SIZES: Record<IslandView, Geometry> = {
  idle: { w: 104, h: 34, r: 15 },
  listening: { w: 340, ...BAR },
  thinking: { w: 270, ...BAR },
  working: { w: 372, ...BAR },
  notification: { w: 392, h: 62, r: 22 },
  expanded: EXPANDED,
  contextual: { w: 420, h: 112, r: 24 },
  multitask: { w: 392, h: 0, r: 22 },
  screen: { w: 264, ...BAR },
  media: { w: 340, ...BAR },
  live: { w: 300, ...BAR },
  error: { w: 392, h: 58, r: 21 },
};

const IDLE_HOVER: Geometry = { w: 380, h: 118, r: 26 };
const GREETING: Geometry = { w: 224, h: 40, r: 17 };
const LIVE_OPEN: Geometry = { w: 408, h: 148, r: 28 };
const LIVE_OPEN_SHORT: Geometry = { w: 408, h: 122, r: 28 };
const MEDIA_OPEN: Geometry = { w: 388, h: 160, r: 28 };
const APPROVAL: Geometry = { w: 430, h: 132, r: 26 };
const PLAN: Geometry = { w: 470, h: 320, r: 28 };
/** Room for a question, plus this much per option. */
const QUESTION_BASE = 112;
const QUESTION_ROW = 40;
const MULTITASK_ROW = 34;
const MULTITASK_PAD = 18;
export const MULTITASK_MAX_ROWS = 4;

const IDLE_CLOCK: Geometry = { w: 148, h: 34, r: 15 };
const SLIVER: Geometry = { w: 96, h: 6, r: 3 };
const WORKING_HOVER: Geometry = { w: 420, h: 132, r: 24 };
const REMINDER: Geometry = { w: 420, h: 112, r: 24 };

export interface GeometryContext {
  hovered: boolean;
  rows: number;
  approval: boolean;
  /** What is waiting, when it needs more room than a command does. */
  asking?: Approval | null;
  clock?: boolean;
  /** Idle with auto-hide on: only a sliver remains until the pointer arrives. */
  sliver?: boolean;
  /** A notice with actions needs room for its buttons. */
  actions?: boolean;
  /** The open page, which sets the panel's size. */
  tab?: string;
  /** The player was clicked open. */
  mediaOpen?: boolean;
  /** Says hello once, just after the app starts. */
  greeting?: boolean;
  /** The live activity has a route or steps, which need a row of their own. */
  liveRich?: boolean;
}

export function geometryFor(view: IslandView, ctx: GeometryContext): Geometry {
  if (view === "expanded") return PANELS[ctx.tab ?? "home"] ?? EXPANDED;
  if (view === "idle" && ctx.greeting) return GREETING;
  if (view === "idle" && ctx.hovered) return IDLE_HOVER;
  if (view === "idle" && ctx.sliver) return SLIVER;
  if (view === "idle" && ctx.clock) return IDLE_CLOCK;
  if (view === "working" && ctx.asking?.plan) return PLAN;
  if (view === "working" && ctx.asking?.questions?.length) {
    const most = Math.max(...ctx.asking.questions.map((q) => Math.min(q.options.length, 4)));
    return { ...APPROVAL, h: QUESTION_BASE + most * QUESTION_ROW };
  }
  if (view === "working" && ctx.approval) return APPROVAL;
  if (view === "working" && ctx.hovered) return WORKING_HOVER;
  if (view === "media" && ctx.mediaOpen) return MEDIA_OPEN;
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
      return "--state-listening";
    case "live":
      return s.live[0]?.tone ?? "--state-working";
    case "error":
      return "--state-error";
    default:
      return "--state-idle";
  }
}
