import { describe, expect, it } from "vitest";
import { deriveView, geometryFor, type Snapshot } from "../island/machine";
import { clock, finishGeometry, moreSteps, shownSteps, summary, workedFor, type FinishEnd, type FinishState } from "./finish";

const view = (patch: Partial<FinishState>): FinishState => ({
  phase: "working",
  app: "Northwind Expenses",
  startedAt: 0,
  now: "Typing 2,340.00 in Amount",
  steps: [],
  note: null,
  paused: null,
  ask: null,
  end: null,
  card: null,
  all: false,
  ...patch,
});

const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ at: i * 7000, text: `Step ${i + 1}`, from: null }));

const end = (patch: Partial<FinishEnd>): FinishEnd => ({ kind: "done", title: "Expense claim submitted", body: "", site: null, worked: 112_000, steps: 9, clicks: 2, filled: 5, sent: true, ...patch });

const idle: Snapshot = { panelOpen: false, listening: false, capturing: false, mediaPlaying: false, chatPending: false, sessions: [], notices: [], suggestions: [], errors: [], live: [] };

describe("Finish this for me on the island", () => {
  it("says times the way the board does", () => {
    expect(clock(9_400)).toBe("0:09");
    expect(clock(112_000)).toBe("1:52");
    expect(workedFor(38_000)).toBe("38 s");
    expect(workedFor(120_000)).toBe("2 min");
    expect(workedFor(112_000)).toBe("1 min 52 s");
  });

  it("sums up a finished task with the user's clicks in it", () => {
    expect(summary(end({}))).toBe("Worked for 1 min 52 s · 9 steps · 2 clicks from you");
    expect(summary(end({ steps: 1, clicks: 1, worked: 5000 }))).toBe("Worked for 5 s · 1 step · 1 click from you");
    expect(summary(end({ clicks: 0 }))).toContain("no clicks from you");
  });

  it("shows the latest three steps while it works, six when it ends, and more when asked", () => {
    const working = view({ steps: steps(8) });
    expect(shownSteps(working).map((s) => s.text)).toEqual(["Step 6", "Step 7", "Step 8"]);
    expect(moreSteps(working)).toBe(true);
    expect(shownSteps({ ...working, phase: "ended", end: end({}) })).toHaveLength(6);
    const all = { ...working, all: true };
    expect(shownSteps(all)).toHaveLength(8);
    expect(moreSteps(all)).toBe(false);
  });

  it("takes the island before anything but the microphone and a capture, so Stop is always on show", () => {
    expect(deriveView({ ...idle, finish: true })).toBe("finish");
    expect(deriveView({ ...idle, finish: true, here: true, asking: true, errors: [{ id: "e", title: "x", body: "y" }] })).toBe("finish");
    expect(deriveView({ ...idle, finish: true, listening: true })).toBe("listening");
    expect(deriveView(idle)).toBe("idle");
  });

  it("grows with its step log and sizes each card", () => {
    const working = finishGeometry(view({ steps: steps(2) }));
    expect(finishGeometry(view({ steps: steps(3) })).h).toBeGreaterThan(working.h);
    expect(finishGeometry(view({ steps: steps(9) })).h).toBe(finishGeometry(view({ steps: steps(3) })).h);
    expect(geometryFor("finish", { hovered: false, rows: 0, approval: false, finish: working })).toEqual(working);
    expect(finishGeometry(view({ phase: "paused", paused: "Paused — you moved the mouse" })).h).toBeLessThan(working.h);
  });
});
