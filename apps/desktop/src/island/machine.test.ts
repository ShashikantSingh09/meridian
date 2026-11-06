import { describe, expect, it } from "vitest";
import { deriveView, FINISHED_ROWS, geometryFor, MULTITASK_MAX_ROWS, STAGE_ROWS, TODO_MAX_ROWS, type SessionSummary, type Snapshot } from "./machine";

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
  live: [],
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

describe("a recording", () => {
  const quiet: Snapshot = { panelOpen: false, listening: false, capturing: false, mediaPlaying: false, chatPending: false, sessions: [], notices: [], suggestions: [], errors: [], live: [] };

  it("shows on the idle island, and writing up shows after it", () => {
    expect(deriveView({ ...quiet, recording: true })).toBe("note");
    expect(deriveView({ ...quiet, writingNote: true })).toBe("note");
  });

  it("gives way to anything else, and to the open panel", () => {
    expect(deriveView({ ...quiet, recording: true, mediaPlaying: true })).toBe("media");
    expect(deriveView({ ...quiet, recording: true, panelOpen: true })).toBe("expanded");
    expect(deriveView({ ...quiet, recording: true, notices: [{ id: "a", tone: "info", title: "t", body: "b" }] })).toBe("notification");
  });

  it("is the sizes on the board", () => {
    const base = { hovered: false, rows: 0, approval: false };
    expect(geometryFor("note", base)).toMatchObject({ w: 190, h: 46 });
    expect(geometryFor("note", { ...base, hovered: true })).toMatchObject({ w: 262, h: 46 });
    expect(geometryFor("note", { ...base, noteWriting: true })).toMatchObject({ w: 250, h: 46 });
    expect(geometryFor("notification", { ...base, noteReady: true })).toMatchObject({ w: 372, h: 46 });
    expect(geometryFor("error", { ...base, noteFailed: true })).toMatchObject({ w: 330, h: 46 });
    expect(geometryFor("expanded", { ...base, tab: "notes" })).toMatchObject({ w: 820, h: 600 });
  });
});

describe("the morning line", () => {
  it("is a pill, and opens into the board's card with a row a thing under the pointer", () => {
    const base = { hovered: false, rows: 0, approval: false, cards: 3 };
    expect(geometryFor("notification", base)).toMatchObject({ w: 330, h: 46 });
    expect(geometryFor("notification", { ...base, hovered: true })).toMatchObject({ w: 430, h: 176 });
    expect(geometryFor("notification", { ...base, hovered: true, cards: 1 })).toMatchObject({ w: 430, h: 120 });
  });
});

describe("volume, brightness and the battery", () => {
  it("shows at once, but never over something that needs an answer", () => {
    expect(deriveView({ ...base, level: true })).toBe("level");
    expect(deriveView({ ...base, level: true, mediaPlaying: true })).toBe("level");
    expect(deriveView({ ...base, level: true, listening: true })).toBe("listening");
    expect(deriveView({ ...base, level: true, panelOpen: true })).toBe("expanded");
  });
});

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

  it("shows an open microphone even over the panel", () => {
    expect(deriveView({ ...base, panelOpen: true, voice: true })).toBe("voice");
  });

  it("still puts a blocked approval ahead of a conversation started from the panel", () => {
    const blocked = session({ status: "waiting", approval: { id: "a", tool: "Bash", summary: "x" } });
    expect(deriveView({ ...base, panelOpen: true, voice: true, sessions: [blocked] })).toBe("working");
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

describe("volume, brightness and the battery", () => {
  it("shows at once, but never over something that needs an answer", () => {
    expect(deriveView({ ...base, level: true })).toBe("level");
    expect(deriveView({ ...base, level: true, mediaPlaying: true })).toBe("level");
    expect(deriveView({ ...base, level: true, listening: true })).toBe("listening");
    expect(deriveView({ ...base, level: true, panelOpen: true })).toBe("expanded");
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

  it("opens the pill to the stages, or to the agent's own list when it keeps one", () => {
    const pill = geometryFor("working", ctx);
    const stages = geometryFor("working", { ...ctx, hovered: true });
    expect(stages.h).toBeGreaterThan(pill.h);
    const list = geometryFor("working", { ...ctx, hovered: true, todos: 5 });
    expect(list.h).toBeGreaterThan(pill.h);
    expect(geometryFor("working", { ...ctx, hovered: true, todos: 40 }).h).toBe(geometryFor("working", { ...ctx, hovered: true, todos: TODO_MAX_ROWS }).h);
  });

  it("keeps whoever else is at work on show under a request, without shrinking the request", () => {
    const alone = geometryFor("working", { ...ctx, approval: true, rows: 1 });
    const beside = geometryFor("working", { ...ctx, approval: true, rows: 3 });
    expect(beside.h).toBeGreaterThan(alone.h);
    expect(geometryFor("working", { ...ctx, approval: true, rows: 30 }).h).toBe(geometryFor("working", { ...ctx, approval: true, rows: MULTITASK_MAX_ROWS }).h);
    expect(geometryFor("working", { ...ctx, approval: true }).h).toBe(alone.h);
  });

  it("makes a finished card only as tall as what it has to say", () => {
    const plain = geometryFor("notification", ctx);
    const brief = geometryFor("notification", { ...ctx, finished: "brief" });
    const message = geometryFor("notification", { ...ctx, finished: "message" });
    expect(brief.h).toBeGreaterThan(plain.h);
    expect(message.h).toBeGreaterThan(brief.h);
  });

  it("gives each step in the log a row, up to the most that fit", () => {
    const finished = (steps: number) => geometryFor("notification", { ...ctx, finished: "brief", steps }).h;
    expect(finished(3)).toBeGreaterThan(finished(2));
    expect(finished(40)).toBe(finished(FINISHED_ROWS));
    const working = (steps: number) => geometryFor("working", { ...ctx, hovered: true, steps }).h;
    expect(working(2)).toBeGreaterThan(working(1));
    expect(working(40)).toBe(working(STAGE_ROWS));
    expect(working(0)).toBeLessThan(working(1));
  });

  it("gives an agent that stopped room to say why", () => {
    expect(geometryFor("error", { ...ctx, stopped: true }).h).toBeGreaterThan(geometryFor("error", ctx).h);
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
