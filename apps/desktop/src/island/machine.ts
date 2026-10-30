// What the island shows, as a pure function of app state. No DOM, no timers,
// so every priority rule below is covered by machine.test.ts.

import type { Approval, SessionStatus } from "../lib/types";

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
  const active = activeSessions(s.sessions);
  if (s.suggestions.length > 0 && active.length === 0) return "contextual";
  if (active.length > 1) return "multitask";
  if (active.length === 1) return "working";
  if (s.chatPending) return "thinking";
  if (s.mediaPlaying) return "media";
  return "idle";
}

export interface Geometry {
  w: number;
  h: number;
  r: number;
}

/** The radius is for the two bottom corners only: the top is the screen's edge. */
export const EXPANDED: Geometry = { w: 820, h: 600, r: 30 };

const SIZES: Record<IslandView, Geometry> = {
  idle: { w: 132, h: 32, r: 13 },
  listening: { w: 300, h: 44, r: 18 },
  thinking: { w: 232, h: 44, r: 18 },
  working: { w: 372, h: 44, r: 18 },
  notification: { w: 392, h: 66, r: 22 },
  expanded: EXPANDED,
  contextual: { w: 420, h: 112, r: 24 },
  multitask: { w: 392, h: 0, r: 22 },
  screen: { w: 264, h: 44, r: 18 },
  media: { w: 340, h: 44, r: 18 },
  error: { w: 392, h: 66, r: 22 },
};

const IDLE_HOVER: Geometry = { w: 300, h: 38, r: 16 };
const APPROVAL: Geometry = { w: 420, h: 124, r: 24 };
const MULTITASK_ROW = 34;
const MULTITASK_PAD = 18;
export const MULTITASK_MAX_ROWS = 4;

const IDLE_CLOCK: Geometry = { w: 188, h: 32, r: 13 };
const SLIVER: Geometry = { w: 96, h: 6, r: 3 };
const WORKING_HOVER: Geometry = { w: 420, h: 132, r: 24 };
const MEDIA_HOVER: Geometry = { w: 424, h: 128, r: 26 };
const REMINDER: Geometry = { w: 420, h: 112, r: 24 };

export interface GeometryContext {
  hovered: boolean;
  rows: number;
  approval: boolean;
  clock?: boolean;
  /** Idle with auto-hide on: only a sliver remains until the pointer arrives. */
  sliver?: boolean;
  /** A notice with actions needs room for its buttons. */
  actions?: boolean;
}

export function geometryFor(view: IslandView, ctx: GeometryContext): Geometry {
  if (view === "idle" && ctx.hovered) return IDLE_HOVER;
  if (view === "idle" && ctx.sliver) return SLIVER;
  if (view === "idle" && ctx.clock) return IDLE_CLOCK;
  if (view === "working" && ctx.approval) return APPROVAL;
  if (view === "working" && ctx.hovered) return WORKING_HOVER;
  if (view === "media" && ctx.hovered) return MEDIA_HOVER;
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
    case "error":
      return "--state-error";
    default:
      return "--state-idle";
  }
}
