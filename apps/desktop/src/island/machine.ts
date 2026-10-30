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

export interface Notice {
  id: string;
  tone: "success" | "info";
  title: string;
  body: string;
  sessionId?: string;
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

export const EXPANDED: Geometry = { w: 760, h: 580, r: 26 };

const SIZES: Record<IslandView, Geometry> = {
  idle: { w: 128, h: 30, r: 15 },
  listening: { w: 300, h: 48, r: 24 },
  thinking: { w: 212, h: 42, r: 21 },
  working: { w: 372, h: 50, r: 25 },
  notification: { w: 392, h: 72, r: 24 },
  expanded: EXPANDED,
  contextual: { w: 408, h: 104, r: 24 },
  multitask: { w: 392, h: 0, r: 24 },
  screen: { w: 244, h: 42, r: 21 },
  media: { w: 336, h: 50, r: 25 },
  error: { w: 392, h: 76, r: 24 },
};

const IDLE_HOVER: Geometry = { w: 244, h: 36, r: 18 };
const APPROVAL: Geometry = { w: 416, h: 118, r: 24 };
const MULTITASK_ROW = 34;
const MULTITASK_PAD = 18;
export const MULTITASK_MAX_ROWS = 4;

const IDLE_CLOCK: Geometry = { w: 176, h: 30, r: 15 };
const SLIVER: Geometry = { w: 84, h: 6, r: 3 };
const WORKING_HOVER: Geometry = { w: 416, h: 128, r: 24 };
const MEDIA_HOVER: Geometry = { w: 420, h: 124, r: 26 };

export interface GeometryContext {
  hovered: boolean;
  rows: number;
  approval: boolean;
  clock?: boolean;
  /** Idle with auto-hide on: only a sliver remains until the pointer arrives. */
  sliver?: boolean;
}

export function geometryFor(view: IslandView, ctx: GeometryContext): Geometry {
  if (view === "idle" && ctx.hovered) return IDLE_HOVER;
  if (view === "idle" && ctx.sliver) return SLIVER;
  if (view === "idle" && ctx.clock) return IDLE_CLOCK;
  if (view === "working" && ctx.approval) return APPROVAL;
  if (view === "working" && ctx.hovered) return WORKING_HOVER;
  if (view === "media" && ctx.hovered) return MEDIA_HOVER;
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
      return s.notices[0]?.tone === "success" ? "--state-success" : "--state-notice";
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
