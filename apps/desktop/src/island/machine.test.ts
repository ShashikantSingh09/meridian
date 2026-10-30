import { describe, expect, it } from "vitest";
import { deriveView, geometryFor, MULTITASK_MAX_ROWS, type SessionSummary, type Snapshot } from "./machine";

const base: Snapshot = {
  panelOpen: false,
  listening: false,
  capturing: false,
  mediaPlaying: false,
  chatPending: false,
  sessions: [],
  notices: [],
  suggestions: [],
  errors: [],
};

const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: "s1",
  agent: "Claude Code",
  project: "dock-agent",
  status: "running",
  activity: "",
  startedAt: 0,
  approval: null,
  ...over,
});

const notice = { id: "n", tone: "success" as const, title: "Done", body: "" };
const suggestion = { id: "c", title: "Explain error", body: "" };
const error = { id: "e", title: "Failed", body: "" };

describe("deriveView", () => {
  it("is idle with nothing going on", () => {
    expect(deriveView(base)).toBe("idle");
  });

  it("shows thinking only while a chat waits and no agent is active", () => {
    expect(deriveView({ ...base, chatPending: true })).toBe("thinking");
    expect(deriveView({ ...base, chatPending: true, sessions: [session()] })).toBe("working");
  });

  it("shows one active session as working and several as multitask", () => {
    expect(deriveView({ ...base, sessions: [session()] })).toBe("working");
    expect(deriveView({ ...base, sessions: [session(), session({ id: "s2" })] })).toBe("multitask");
  });

  it("does not count finished sessions as active", () => {
    const sessions = [session({ status: "completed" }), session({ id: "s2", status: "failed" })];
    expect(deriveView({ ...base, sessions })).toBe("idle");
  });

  it("shows music only when nothing more important is happening", () => {
    expect(deriveView({ ...base, mediaPlaying: true })).toBe("media");
    expect(deriveView({ ...base, mediaPlaying: true, chatPending: true })).toBe("thinking");
    expect(deriveView({ ...base, mediaPlaying: true, sessions: [session()] })).toBe("working");
    expect(deriveView({ ...base, mediaPlaying: true, notices: [notice] })).toBe("notification");
  });

  it("always shows when the screen is being read", () => {
    expect(deriveView({ ...base, capturing: true, sessions: [session()], notices: [notice] })).toBe("screen");
  });

  it("lets the open panel win over everything", () => {
    expect(deriveView({ ...base, panelOpen: true, listening: true, errors: [error] })).toBe("expanded");
  });

  it("puts a blocked approval ahead of errors and notices", () => {
    const approval = { id: "a", tool: "Bash", summary: "rm -rf build" };
    const sessions = [session({ status: "waiting", approval })];
    expect(deriveView({ ...base, sessions, errors: [error], notices: [notice] })).toBe("working");
  });

  it("orders error, then notification, then ambient work", () => {
    expect(deriveView({ ...base, errors: [error], notices: [notice], sessions: [session()] })).toBe("error");
    expect(deriveView({ ...base, notices: [notice], sessions: [session()] })).toBe("notification");
  });

  it("never interrupts active work with a contextual suggestion", () => {
    expect(deriveView({ ...base, suggestions: [suggestion] })).toBe("contextual");
    expect(deriveView({ ...base, suggestions: [suggestion], sessions: [session()] })).toBe("working");
  });
});

describe("geometryFor", () => {
  const ctx = { hovered: false, rows: 0, approval: false };

  it("grows the idle pill on hover", () => {
    const rest = geometryFor("idle", ctx);
    const hover = geometryFor("idle", { ...ctx, hovered: true });
    expect(hover.w).toBeGreaterThan(rest.w);
    expect(hover.h).toBeGreaterThan(rest.h);
  });

  it("makes room for an approval", () => {
    expect(geometryFor("working", { ...ctx, approval: true }).h).toBeGreaterThan(geometryFor("working", ctx).h);
  });

  it("caps multitask rows", () => {
    const capped = geometryFor("multitask", { ...ctx, rows: MULTITASK_MAX_ROWS + 5 });
    expect(capped.h).toBe(geometryFor("multitask", { ...ctx, rows: MULTITASK_MAX_ROWS }).h);
  });

  it("keeps every compact shape a valid rounded rectangle", () => {
    const views = ["idle", "listening", "thinking", "working", "notification", "contextual", "error"] as const;
    for (const v of views) {
      const g = geometryFor(v, ctx);
      expect(g.r * 2).toBeLessThanOrEqual(Math.max(g.h, 60));
    }
  });
});
