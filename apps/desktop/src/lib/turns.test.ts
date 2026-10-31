import { describe, expect, it } from "vitest";
import { filler, isGoodbye, looksFinished, sentences, silenceFor, speakable, yesOrNo, withoutWakeWord, calledByName } from "./turns";

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

  it("keeps its place as a reply with markdown streams in, losing nothing", () => {
    const reply = "The **quick** fox ran. See `this` thing.\n```ts\nconst a = 1;\n```\nAfter the code. Last one.";
    const said: string[] = [];
    for (let end = 1; end <= reply.length; end++) {
      const { ready } = sentences(speakable(reply.slice(0, end)), end === reply.length);
      while (said.length < ready.length) said.push(ready[said.length]!);
    }
    expect(said).toEqual(["The quick fox ran.", "See this thing.", "I put the code in chat.", "After the code.", "Last one."]);
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

describe("the name it is called by", () => {
  const words = ["Hey Meridian", "Suno Mira"];
  it("comes off the front of what was said, however it was said", () => {
    expect(withoutWakeWord("Hey Meridian, open Chrome", words)).toBe("open Chrome");
    expect(withoutWakeWord("meridian what's the time", words)).toBe("what's the time");
    expect(withoutWakeWord("Okay Meridian. Next song", words)).toBe("Next song");
    expect(withoutWakeWord("Suno Mira gaana chalao", words)).toBe("gaana chalao");
  });
  it("stays when it is part of the question", () => {
    expect(withoutWakeWord("what is the prime meridian", words)).toBe("what is the prime meridian");
  });
  it("leaves nothing when only the name was said", () => {
    expect(withoutWakeWord("Hey Meridian.", words)).toBe("");
  });
});

describe("answers in Hindi", () => {
  it("count as yes and no", () => {
    for (const yes of ["haan", "हाँ", "हाँ, कर दो", "ठीक है", "theek hai", "kar do"]) expect(yesOrNo(yes), yes).toBe(true);
    for (const no of ["nahin", "नहीं", "मत करो", "रहने दो", "नहीं, रहने दो", "rehne do"]) expect(yesOrNo(no), no).toBe(false);
  });
  it("can end a conversation", () => {
    for (const bye of ["bas", "बस", "शुक्रिया", "धन्यवाद"]) expect(isGoodbye(bye), bye).toBe(true);
  });
});

describe("proving it was called", () => {
  const words = ["Hey Meridian", "Meridian", "Suno Mira"];
  it("accepts the name however the hearing wrote it", () => {
    for (const said of ["Hey Meridian, open Chrome", "meridian what's the time", "Maridian open Spotify", "Meridien play music", "मेरिडियन गाना चलाओ", "मेरीडियन समय क्या है", "suno mira gaana chalao"]) {
      expect(calledByName(said, words), said).toBe(true);
    }
  });
  it("refuses talk that never said it", () => {
    for (const said of ["हां वो देखना पड़ेगा तेरे साथ", "Quando você me explica essa? Do, que ela não posta", "what's for dinner tonight", "the meeting is at nine", ""]) {
      expect(calledByName(said, words), said).toBe(false);
    }
  });
});
