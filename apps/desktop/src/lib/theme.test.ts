import { describe, expect, it } from "vitest";
import { activeTheme } from "./theme";

const choice = { theme: "ocean", themeUse: "theme" as const, themeDark: "midnight", themeLight: "daylight" };

describe("which theme shows", () => {
  it("is the chosen one by default", () => {
    expect(activeTheme(choice, true, 12)).toBe("ocean");
  });

  it("follows Windows when asked", () => {
    const windows = { ...choice, themeUse: "windows" as const };
    expect(activeTheme(windows, true, 12)).toBe("midnight");
    expect(activeTheme(windows, false, 12)).toBe("daylight");
  });

  it("follows the clock when asked", () => {
    const clock = { ...choice, themeUse: "time" as const };
    expect(activeTheme(clock, true, 9)).toBe("daylight");
    expect(activeTheme(clock, true, 22)).toBe("midnight");
    expect(activeTheme(clock, true, 3)).toBe("midnight");
  });
});
