import { describe, expect, it } from "vitest";
import { animates, brightness, displacement, envelope, pulseAt, type LineMode } from "./line";

const modes: LineMode[] = ["rest", "listen", "think", "work", "flare", "fracture"];

describe("line shape", () => {
  it("tapers to nothing at both ends", () => {
    expect(envelope(0)).toBeCloseTo(0);
    expect(envelope(1)).toBeCloseTo(0);
    expect(envelope(0.5)).toBeCloseTo(1);
  });

  it("stays inside its box for any mode, level and time", () => {
    for (const mode of modes) {
      for (let t = 0; t < 12; t += 0.37) {
        for (let u = 0; u <= 1; u += 0.05) {
          expect(Math.abs(displacement(mode, u, t, 1))).toBeLessThanOrEqual(1);
          const b = brightness(mode, u, t);
          expect(b).toBeGreaterThanOrEqual(0);
          expect(b).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("answers the microphone: louder means taller", () => {
    const peak = (level: number) => {
      let max = 0;
      for (let u = 0; u <= 1; u += 0.01) max = Math.max(max, Math.abs(displacement("listen", u, 0.3, level)));
      return max;
    };
    expect(peak(1)).toBeGreaterThan(peak(0.1) * 2);
  });

  it("leaves a real gap in a fractured line", () => {
    expect(brightness("fracture", 0.5, 1)).toBe(0);
    expect(brightness("fracture", 0.3, 1)).toBeGreaterThan(0);
  });

  it("carries the work pulse across the whole line", () => {
    const seen = Array.from({ length: 80 }, (_, i) => pulseAt(i * 0.05));
    expect(Math.min(...seen)).toBeLessThan(0);
    expect(Math.max(...seen)).toBeGreaterThan(1);
  });

  it("asks for frames only when something moves", () => {
    expect(animates("rest")).toBe(false);
    expect(animates("work")).toBe(true);
  });
});
