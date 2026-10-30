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
  chatPending: boolean;
  sessions: SessionSummary[];
  notices: Notice[];
  suggestions: Suggestion[];
  errors: IslandError[];
}

const ACTIVE: ReadonlySet<SessionStatus> = new Set(["starting", "running", "waiting"]);

export const activeSessions = (sessions: SessionSummary[]) =>
  sessions.filter((s) => ACTIVE.has(s.status));

export const waitingApproval = (sessions: SessionSummary[]) =>
  sessions.find((s) => s.approval !== null) ?? null;

/**
 * Priority, highest first. The user's own actions win, then anything that
 * needs a decision, then passing news, then ambient work. An approval outranks
 * notices because an agent is blocked until someone answers.
 */
export function deriveView(s: Snapshot): IslandView {
  if (s.panelOpen) return "expanded";
  if (s.listening) return "listening";
  if (waitingApproval(s.sessions)) return "working";
  if (s.errors.length > 0) return "error";
  if (s.notices.length > 0) return "notification";
  const active = activeSessions(s.sessions);
  if (s.suggestions.length > 0 && active.length === 0) return "contextual";
  if (active.length > 1) return "multitask";
  if (active.length === 1) return "working";
  if (s.chatPending) return "thinking";
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
  error: { w: 392, h: 76, r: 24 },
};

const IDLE_HOVER: Geometry = { w: 244, h: 36, r: 18 };
const APPROVAL: Geometry = { w: 416, h: 118, r: 24 };
const MULTITASK_ROW = 34;
const MULTITASK_PAD = 18;
export const MULTITASK_MAX_ROWS = 4;

export function geometryFor(view: IslandView, ctx: { hovered: boolean; rows: number; approval: boolean }): Geometry {
  if (view === "idle" && ctx.hovered) return IDLE_HOVER;
  if (view === "working" && ctx.approval) return APPROVAL;
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
      return "--state-context";
    case "error":
      return "--state-error";
    default:
      return "--state-idle";
  }
}
