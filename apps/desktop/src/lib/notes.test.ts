import { describe, expect, it } from "vitest";
import { clockOf, currentNote, talkShares } from "./notes";
import type { Note } from "./types";

const note = (id: string, lines: [string, number, number][] = []): Note => ({
  id,
  title: id,
  titleEdited: false,
  startedAt: 0,
  endedAt: null,
  status: "ready",
  speakers: [],
  lines: lines.map(([speaker, start, end], i) => ({ id: String(i), speaker, start, end, text: "words" })),
  summary: null,
  keyPoints: [],
  todos: [],
  error: null,
});

describe("the clock", () => {
  it("reads like a clock, and hours only appear when there are some", () => {
    expect(clockOf(0)).toBe("0:00");
    expect(clockOf(75.9)).toBe("1:15");
    expect(clockOf(3725)).toBe("1:02:05");
    expect(clockOf(-2)).toBe("0:00");
  });
});

describe("the note on show", () => {
  const notes = [note("new"), note("old")];

  it("is the one picked, then the one recording, then the newest", () => {
    expect(currentNote(notes, "old", null)?.id).toBe("old");
    expect(currentNote(notes, null, "old")?.id).toBe("old");
    expect(currentNote(notes, null, null)?.id).toBe("new");
  });

  it("falls back to the newest when the one picked has been deleted", () => {
    expect(currentNote(notes, "gone", null)?.id).toBe("new");
    expect(currentNote([], "gone", null)).toBeNull();
  });
});

describe("the share of talking", () => {
  it("comes from how long each person spoke", () => {
    const shares = talkShares(note("a", [["me", 0, 30], ["p2", 30, 50], ["me", 50, 60], ["p3", 60, 70]]));
    expect(Object.fromEntries(shares)).toEqual({ me: 57, p2: 29, p3: 14 });
  });

  it("is empty with nobody heard", () => {
    expect(talkShares(note("a")).size).toBe(0);
  });
});
