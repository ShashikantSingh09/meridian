import { beforeEach, describe, expect, it } from "vitest";
import { blurOn, judge, resetFrames } from "./frames";

describe("blur on arriving content", () => {
  beforeEach(resetFrames);

  it("stays on while frames keep up, and ignores the first frame, which is React's render", () => {
    judge([120, 16, 17, 16]);
    judge([90, 16, 18]);
    expect(blurOn()).toBe(true);
  });

  it("goes off after two slow entrances in a row", () => {
    judge([16, 16, 50]);
    expect(blurOn()).toBe(true);
    judge([16, 41, 16]);
    expect(blurOn()).toBe(false);
  });

  it("forgives one slow entrance followed by a smooth one", () => {
    judge([16, 60]);
    judge([16, 16, 17]);
    judge([16, 60]);
    expect(blurOn()).toBe(true);
  });
});
