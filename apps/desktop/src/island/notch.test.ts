import { describe, expect, it } from "vitest";
import { earOf, notchPath } from "./notch";

describe("the island's outline", () => {
  it("is one open line from the top edge back to the top edge", () => {
    const d = notchPath(104, 34, 12);
    expect(d.match(/M/g)).toHaveLength(1);
    expect(d).not.toMatch(/Z/i);
    expect(d.startsWith("M-10 0")).toBe(true);
    expect(d.endsWith("114 0")).toBe(true);
  });

  it("keeps its curves in proportion as it shrinks", () => {
    expect(earOf(104, 34)).toBe(10);
    expect(earOf(96, 6)).toBe(2);
    expect(earOf(18, 4)).toBeCloseTo(4 / 3);
  });

  it("never asks for a corner bigger than the shape", () => {
    expect(notchPath(20, 6, 32)).toContain("A6 6");
  });
});
