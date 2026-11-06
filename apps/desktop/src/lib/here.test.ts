import { describe, expect, it } from "vitest";
import { deriveView, geometryFor, type Snapshot } from "../island/machine";
import { answerLines, answerMs, SHOWN_CHARS } from "./ask";
import { stepFor } from "./here";

const quiet: Snapshot = { panelOpen: false, listening: false, capturing: false, mediaPlaying: false, chatPending: false, sessions: [], notices: [], suggestions: [], errors: [], live: [] };
const ctx = { hovered: false, rows: 0, approval: false };

describe("Write here on the island", () => {
  it("shows what the core said, and nothing once it was stopped", () => {
    expect(stepFor({ outcome: "written" })).toEqual({ step: "written" });
    expect(stepFor({ outcome: "line", text: "Click in a text box first." })).toEqual({ step: "line", text: "Click in a text box first." });
    expect(stepFor({ outcome: "ask", key: "ms-teams.exe", id: "ms-teams.exe", name: "Microsoft Teams", every: null })?.place).toEqual({ key: "ms-teams.exe", id: "ms-teams.exe", name: "Microsoft Teams", every: null });
    expect(stepFor({ outcome: "off", id: "ms-teams.exe", name: "Microsoft Teams" })).toMatchObject({ step: "off", place: { key: "ms-teams.exe" } });
    expect(stepFor({ outcome: "local", ai: "Claude" })).toEqual({ step: "local", ai: "Claude" });
    expect(stepFor({ outcome: "failed", why: "Claude did not answer in 20 seconds. Nothing was put in the box." })?.step).toBe("failed");
    expect(stepFor({ outcome: "moved", title: "You moved to another box" })).toEqual({ step: "moved", text: "You moved to another box" });
    expect(stepFor({ outcome: "stopped" })).toBeNull();
  });

  it("comes before a conversation and the work going on, but after a request that needs an answer", () => {
    expect(deriveView({ ...quiet, here: true, voice: true, chatPending: true })).toBe("here");
    expect(deriveView({ ...quiet, here: true, errors: [{ id: "e", title: "x", body: "" }] })).toBe("here");
    const waiting = { id: "s", agent: "Claude Code", project: "p", status: "waiting" as const, activity: "", startedAt: 0, approval: { id: "a", tool: "Bash", summary: "ls" } };
    expect(deriveView({ ...quiet, here: true, sessions: [waiting] })).toBe("working");
    expect(deriveView({ ...quiet, here: true, panelOpen: true })).toBe("expanded");
  });

  it("is a line while it writes and once written, and a card when it needs a click", () => {
    expect(geometryFor("here", { ...ctx, here: "writing" }).h).toBe(46);
    expect(geometryFor("here", { ...ctx, here: "written" })).toMatchObject({ w: 450, h: 46 });
    expect(geometryFor("here", { ...ctx, here: "line" }).h).toBe(46);
    for (const card of ["ask", "off", "local", "failed", "moved"]) expect(geometryFor("here", { ...ctx, here: card }).w).toBe(430);
  });
});

describe("asking from the island", () => {
  it("shows over the thinking and working views, so the question stays in view", () => {
    expect(deriveView({ ...quiet, asking: true, chatPending: true })).toBe("ask");
    const chat = { id: "s", agent: "Claude Code", project: "General", status: "running" as const, activity: "", startedAt: 0, approval: null };
    expect(deriveView({ ...quiet, asking: true, sessions: [chat] })).toBe("ask");
  });

  it("grows a line for each line of the answer, up to three", () => {
    expect(answerLines("Tuesday at 8:10 am.")).toBe(1);
    expect(answerLines("x".repeat(100))).toBe(2);
    expect(answerLines("x".repeat(SHOWN_CHARS * 3))).toBe(3);
    expect(geometryFor("ask", { ...ctx, ask: { phase: "answer", lines: 3 } }).h).toBeGreaterThan(geometryFor("ask", { ...ctx, ask: { phase: "answer", lines: 1 } }).h);
    expect(geometryFor("ask", { ...ctx, ask: { phase: "thinking", lines: 1 } }).h).toBe(46);
  });

  it("keeps a longer answer longer, within reason", () => {
    expect(answerMs("Yes.")).toBeGreaterThanOrEqual(4000);
    expect(answerMs("x".repeat(100))).toBeGreaterThan(answerMs("Yes."));
    expect(answerMs("x".repeat(10_000))).toBe(12_000);
  });
});
