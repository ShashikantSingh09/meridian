import { describe, expect, it } from "vitest";
import { pickStarters, type Going } from "./starters";

// 3 pm, so the morning set stays out unless a test asks for it.
const afternoon = new Date(2026, 10, 6, 15, 0).getTime();
const quiet: Going = { now: afternoon, call: null, working: 0, waiting: null, planKnown: false, today: 0, flight: null, firstDays: false, todo: { gmail: false, wake: false, notes: false } };
const texts = (g: Partial<Going>) => pickStarters({ ...quiet, ...g }).map((s) => s.text);

describe("starters on Home", () => {
  it("a quiet moment gives three that always work, never an empty row", () => {
    expect(texts({})).toEqual(["What's on tomorrow?", "Anything I owe people?", "Play some music"]);
  });

  it("a call that just ended comes first, with the person named on it", () => {
    const picked = pickStarters({ ...quiet, call: { endedAt: afternoon - 10 * 60_000, with: "Asha" } });
    expect(picked.map((s) => s.text).slice(0, 3)).toEqual(["Summarise my last call", "What did we agree?", "Draft the to-dos for Asha"]);
    expect(picked[0]!.why).toMatch(/^Because your call with Asha ended at /);
  });

  it("a call from hours ago is not news any more", () => {
    expect(texts({ call: { endedAt: afternoon - 3 * 60 * 60_000, with: null } })).not.toContain("Summarise my last call");
  });

  it("agents at work and today's plans each add their own, from four up to six", () => {
    const picked = texts({ working: 2, waiting: "shop", planKnown: true, today: 2, call: { endedAt: afternoon, with: "Asha" } });
    expect(picked).toHaveLength(6);
    expect(picked).toContain("Which one needs me?");
    expect(texts({ working: 1 })).toEqual(["What are my agents doing?", "What's on tomorrow?", "Anything I owe people?", "Play some music"]);
  });

  it("says why each one is there", () => {
    const [agents] = pickStarters({ ...quiet, working: 1 });
    expect(agents!.why).toBe("Because 1 agent is working");
    const [today] = pickStarters({ ...quiet, today: 2 });
    expect(today!.why).toBe("Because you have 2 plans today");
  });

  it("the morning has its own set", () => {
    expect(texts({ now: new Date(2026, 10, 6, 8, 30).getTime() }).slice(0, 3)).toEqual(["What's on today?", "Anything I owe people?", "Play my morning mix"]);
  });

  it("the first days offer set-up steps, and a step drops off once it is done", () => {
    const first = texts({ firstDays: true, todo: { gmail: true, wake: true, notes: true } });
    expect(first).toEqual(["What can you do?", "Connect Gmail", "Set up wake words", "Take notes on my next call", "Play something calm"]);
    expect(texts({ firstDays: true, todo: { gmail: false, wake: true, notes: true } })).not.toContain("Connect Gmail");
  });

  it("never shows the same words twice", () => {
    const picked = texts({ today: 1, now: new Date(2026, 10, 6, 8, 30).getTime() });
    expect(new Set(picked).size).toBe(picked.length);
  });
});
