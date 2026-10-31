import { describe, expect, it } from "vitest";
import { filler, isGoodbye, looksFinished, sentences, silenceFor, speakable, yesOrNo } from "./turns";

describe("knowing when someone has finished", () => {
  it("hears a whole thought", () => {
    expect(looksFinished("what time is my flight")).toBe(true);
    expect(looksFinished("check my calendar.")).toBe(true);
  });

  it("waits through a sentence that is plainly not over", () => {
    for (const unfinished of ["can you check my flight and", "the one to", "what about the", "send it to,", "um", ""]) {
      expect(looksFinished(unfinished), unfinished).toBe(false);
    }
  });

  it("gives a pause mid-thought longer", () => {
    expect(silenceFor("what about the")).toBeGreaterThan(silenceFor("what about the return"));
  });
});

describe("speaking a reply as it arrives", () => {
  it("takes whole sentences and keeps the rest", () => {
    expect(sentences("It leaves at 7. It is on ti", false)).toEqual({ ready: ["It leaves at 7."], rest: "It is on ti" });
  });

  it("does not break on a number or a version", () => {
    expect(sentences("Version 0.3.0 is out now. Next", false).ready).toEqual(["Version 0.3.0 is out now."]);
  });

  it("holds the last sentence until it might be over, then lets it go", () => {
    expect(sentences("Nearly there.", false)).toEqual({ ready: [], rest: "Nearly there." });
    expect(sentences("Nearly there.", true)).toEqual({ ready: ["Nearly there."], rest: "" });
    expect(sentences("No full stop", true).ready).toEqual(["No full stop"]);
  });
});

describe("what gets read aloud", () => {
  it("leaves out what only reads well", () => {
    expect(speakable("Here:\n```ts\nconst a = 1;\n```\nDone.")).toBe("Here:\n I put the code in chat. \nDone.".replace(/ +/g, " ").trim());
    expect(speakable("See [the docs](https://x.dev/a) or https://x.dev")).toBe("See the docs or a link");
    expect(speakable("## Title\n- **one**\n- `two`")).toBe("Title\none\ntwo");
  });
});

describe("short answers", () => {
  it("knows a goodbye only as a whole sentence", () => {
    expect(isGoodbye("That's all.")).toBe(true);
    expect(isGoodbye("thanks")).toBe(true);
    expect(isGoodbye("stop the build")).toBe(false);
    expect(isGoodbye("thanks, now open the file")).toBe(false);
  });

  it("takes yes or no as a decision, and nothing else", () => {
    expect(yesOrNo("Yes.")).toBe(true);
    expect(yesOrNo("go ahead")).toBe(true);
    expect(yesOrNo("no thanks")).toBe(false);
    expect(yesOrNo("yes but change the subject first")).toBeNull();
    expect(yesOrNo("maybe")).toBeNull();
  });

  it("varies what it says while it thinks", () => {
    expect(filler(0)).not.toBe(filler(1));
  });
});
