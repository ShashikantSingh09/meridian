import { describe, expect, it } from "vitest";
import { span, story } from "./levels";
import type { Level } from "./types";

const volume = (percent: number, muted = false): Level => ({ kind: "volume", percent, muted });
const brightness = (percent: number): Level => ({ kind: "brightness", percent });
const power = (percent: number, plugged: boolean, extra: Partial<Extract<Level, { kind: "battery" }>> = {}): Level => ({
  kind: "battery",
  percent,
  plugged,
  saver: false,
  secondsLeft: null,
  secondsToFull: null,
  watts: null,
  health: null,
  ...extra,
});

describe("volume and brightness", () => {
  it("reacts to the direction of the key", () => {
    expect(story(volume(62), volume(50)).mood).toBe("done");
    expect(story(volume(38), volume(50)).mood).toBe("working");
    expect(story(brightness(80), brightness(50)).mood).toBe("needs");
    expect(story(brightness(30), brightness(50)).mood).toBe("sleepy");
  });

  it("is startled at full volume and sleeps when muted", () => {
    expect(story(volume(100), volume(90))).toMatchObject({ mood: "needs", shake: true });
    expect(story(volume(62, true), volume(62))).toMatchObject({ mood: "asleep", percent: 0, number: "" });
    expect(story(brightness(5), brightness(10)).mood).toBe("asleep");
  });
});

describe("the battery", () => {
  it("jolts only as the charger goes in", () => {
    expect(story(power(64, true), power(64, false)).zap).toBe(true);
    expect(story(power(64, true), power(63, true)).zap).toBeFalsy();
  });

  it("says when it will be full, from what Windows reports", () => {
    const noon = new Date(2026, 9, 31, 12, 0).getTime();
    const told = story(power(64, true, { secondsToFull: 4320, watts: 65, health: 92 }), null, noon);
    expect(told).toMatchObject({ title: "Charging", detail: "1 h 12 min until full", right: "65 W", bolt: true });
    expect(told.left).toContain("1:12");
  });

  it("never invents a time it was not given", () => {
    expect(story(power(64, true), null).detail).toBe("Plugged in");
    expect(story(power(20, false), null).detail).toBe("");
  });

  it("worries more as it runs down", () => {
    expect(story(power(20, false), null)).toMatchObject({ title: "Battery low", mood: "sleepy", tone: "#ff9f0a" });
    expect(story(power(7, false), null)).toMatchObject({ title: "Plug in soon", mood: "error", shake: true });
    expect(story(power(100, true), null)).toMatchObject({ title: "Fully charged", mood: "done" });
    expect(story(power(40, false, { saver: true }), null)).toMatchObject({ title: "Battery saver on" });
  });
});

describe("a length of time", () => {
  it("reads naturally", () => {
    expect(span(540)).toBe("9 min");
    expect(span(4320)).toBe("1 h 12 min");
    expect(span(10)).toBe("1 min");
  });
});
