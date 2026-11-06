import { describe, expect, it, vi } from "vitest";
import { CHECKS, failure, judge, reportText, resultLine, resultOf, summaryLine, within, type Outcome, type Row } from "./repair";

const row = (id: Row["id"], outcome: Outcome, state: Row["state"] = outcome.ok ? "fine" : "needs"): Row => ({ id, state, line: outcome.line, report: outcome.report, fix: outcome.fix, help: outcome.help });
const at = new Date(2026, 10, 6, 9, 14).getTime();

describe("each check's verdict", () => {
  it("there are eight checks, in the board's order", () => {
    expect(CHECKS.map((c) => c.name)).toEqual(["Microphone", "Wake words", "Speech", "AI sign-in", "Claude Code hooks", "Gmail", "Updates", "Notes recording"]);
  });

  it("an unplugged microphone is something Meridian fixes itself", () => {
    expect(judge.microphone({ inputs: 2, chosenGone: true, open: "failed", name: "" })).toMatchObject({ ok: false, fix: "microphone" });
    expect(judge.microphone({ inputs: 1, chosenGone: false, open: "heard", name: "Realtek microphone" })).toMatchObject({ ok: true, line: "Realtek microphone · hears you" });
  });

  it("a microphone Windows blocks needs the user, with the steps", () => {
    const blocked = judge.microphone({ inputs: 1, chosenGone: false, open: "blocked", name: "" });
    expect(blocked.ok).toBe(false);
    expect(blocked.fix).toBeUndefined();
    expect(blocked.help?.steps[0]).toContain("Privacy and security");
  });

  it("missing hooks are put back by Fix, and a project that turns hooks off needs the user", () => {
    expect(judge.hooks({ on: false, inPlace: false, offIn: [], projects: 0 })).toMatchObject({ ok: true, report: "off" });
    expect(judge.hooks({ on: true, inPlace: false, offIn: [], projects: 2 })).toMatchObject({ ok: false, fix: "hooks" });
    const off = judge.hooks({ on: true, inPlace: true, offIn: ["C:\\Projects\\shop"], projects: 4 });
    expect(off).toMatchObject({ ok: false, line: "Turned off in 1 project: shop", report: "off in 1 project" });
    expect(off.fix).toBeUndefined();
  });

  it("Gmail not connected in the Claude account gives the steps and Claude's page", () => {
    const gmail = judge.gmail({ localOnly: false, direct: false, registered: false, claude: true, onClaude: false });
    expect(gmail.line).toBe("Not connected to your Claude account");
    expect(gmail.help?.lead).toBe("This one needs you, on Claude's page:");
    expect(gmail.help?.go).toEqual({ label: "Open Claude's page", link: "https://claude.ai/customize/connectors" });
    expect(judge.gmail({ localOnly: true, direct: false, registered: false, claude: true, onClaude: false }).ok).toBe(true);
  });

  it("updates never ask GitHub before the user said yes", () => {
    const off = judge.updates({ localOnly: false, version: "0.6.3", kind: "setup", checks: null, reached: true, latest: "v0.6.4", available: true, at: "9:14 am" });
    expect(off).toMatchObject({ ok: true, line: "0.6.3, installed copy · checking by itself is off" });
    expect(judge.updates({ localOnly: false, version: "0.6.3", kind: "setup", checks: true, reached: true, latest: "v0.6.4", available: true, at: "9:14 am" }).line).toBe("0.6.4 is ready to install");
  });

  it("speech says when English and Hindi voices are both there", () => {
    const voices = [{ note: "en-IN" }, { note: "hi-IN" }];
    expect(judge.speech({ name: "Windows voices", missing: null, outputGone: false, voices, failed: null })).toMatchObject({ ok: true, line: "English and Hindi voices are ready", report: "en-IN, hi-IN" });
    expect(judge.speech({ name: "ElevenLabs", missing: "key", outputGone: false, voices: [], failed: null }).ok).toBe(false);
  });

  it("notes need a hearing service that writes calls down, and its key", () => {
    expect(judge.notes({ localOnly: false, service: null, hasKey: false, outputs: 1 }).line).toBe("Notes need ElevenLabs or Deepgram");
    expect(judge.notes({ localOnly: false, service: "Deepgram", hasKey: true, outputs: 1 }).ok).toBe(true);
  });

  it("an agent that is not signed in is offered Sign in", () => {
    const ai = judge.ai({ localOnly: false, local: null, agent: { id: "claude-code", name: "Claude Code", signedIn: false }, provider: null });
    expect(ai.help?.go).toEqual({ label: "Sign in", signIn: "claude-code" });
    expect(judge.ai({ localOnly: false, local: null, agent: { id: "claude-code", name: "Claude Code", signedIn: true }, provider: null }).line).toBe("Claude, through Claude Code");
  });
});

describe("the run", () => {
  it("a check past its time limit gives way", async () => {
    vi.useFakeTimers();
    const stuck = within(4000, new Promise(() => {})).catch(failure);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await stuck).toMatchObject({ ok: false, line: "Took longer than 4 seconds", report: "timed out" });
    vi.useRealTimers();
  });

  it("counts what is fine and what needs the user", () => {
    const rows = [row("microphone", { ok: true, line: "Hears you", report: "mic" }), row("gmail", { ok: false, line: "Not connected", report: "not connected" })];
    expect(summaryLine(rows, at)).toMatch(/^Checked 9:14.* · 1 fine, 1 needs you$/);
    expect(resultOf(rows, at)).toEqual({ fine: 1, needs: 1, at });
    expect(resultLine({ fine: 1, needs: 1, at })).toBe("1 needs you");
    expect(resultLine({ fine: 8, needs: 0, at })).toMatch(/^All 8 fine · 9:14/);
  });

  it("a stopped run is no result for About", () => {
    const rows: Row[] = [row("microphone", { ok: true, line: "Hears you", report: "mic" }), { id: "wake", state: "stopped", line: "Not checked", report: "" }];
    expect(resultOf(rows, at)).toBeNull();
    expect(summaryLine(rows, at)).toMatch(/^Stopped at /);
  });
});

describe("the report", () => {
  const rows = [
    row("microphone", judge.microphone({ inputs: 1, chosenGone: false, open: "heard", name: "Asha's AirPods" })),
    row("hooks", judge.hooks({ on: true, inPlace: true, offIn: ["C:\\Projects\\shop"], projects: 4 })),
    row("gmail", judge.gmail({ localOnly: false, direct: false, registered: false, claude: true, onClaude: false })),
    { id: "notes", state: "stopped", line: "Not checked", report: "" } as Row,
  ];
  const text = reportText(rows, { version: "0.6.3", kind: "setup", system: "Windows 11" });

  it("is plain text, and its second line says what it leaves out", () => {
    expect(text.split("\n").slice(0, 3)).toEqual(["Meridian 0.6.3, installed · Windows 11", "No messages, recordings or notes are in this report.", ""]);
    expect(text).toContain("Gmail             needs you   not connected");
    expect(text).toContain("Notes recording   not checked");
  });

  it("turns project names into counts, and keeps people's names out", () => {
    expect(text).toContain("Claude Code hooks needs you   off in 1 project");
    expect(text).not.toContain("shop");
    expect(text).not.toContain("Asha");
    expect(text).toContain("AirPods");
  });
});
