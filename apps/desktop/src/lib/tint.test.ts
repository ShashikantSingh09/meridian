import { describe, expect, it } from "vitest";
import { vivid } from "./store";

describe("a colour from album art", () => {
  it("keeps the hue of a dark cover, bright enough to see on black", () => {
    expect(vivid(60, 10, 12)).toBe("hsl(358 72% 66%)");
    expect(vivid(10, 50, 20)).toBe("hsl(135 72% 66%)");
    expect(vivid(10, 12, 60)).toBe("hsl(238 72% 66%)");
  });

  it("does not invent a colour for a black and white cover", () => {
    expect(vivid(30, 30, 32)).toBe("hsl(0 0% 78%)");
  });
});
