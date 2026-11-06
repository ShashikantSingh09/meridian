import { describe, expect, it } from "vitest";
import { chatTurns, marked, promiseOrder, promisesFor, shortSource } from "./knowledge";
import { actionOf } from "./sessions";
import type { SessionDetail } from "./store";
import { defaultSettings, type KnowledgePage } from "./types";

const promise = (title: string, done: boolean, linked: string[]): KnowledgePage => ({
  path: `Promises/${title}.md`,
  kind: "promise",
  title,
  about: "",
  subtitle: done ? "Done" : "You · by Fri 6 Nov",
  sections: [{ heading: "", lines: [{ at: 1, text: `You: ${title.toLowerCase()}`, source: null, yours: false, done, bullet: true }] }],
  linked,
  sources: [],
  updated: 0,
});

describe("promises", () => {
  const pages = [promise("Book the review room", true, ["Asha Rao"]), promise("Send the hero photos", false, ["asha rao"]), promise("Send Carl the invoice", false, ["Carl Mendes"])];

  it("a page shows the promises that name it, open ones first, so a ticked one moves to done", () => {
    expect(promisesFor(pages, "Asha Rao").map((p) => p.page.title)).toEqual(["Send the hero photos", "Book the review room"]);
    expect(promisesFor(pages, "Nobody")).toEqual([]);
  });

  it("the list counts only open promises and puts kept ones last", () => {
    const { pages: shown, open } = promiseOrder(pages);
    expect(open).toBe(2);
    expect(shown[shown.length - 1]!.title).toBe("Book the review room");
  });
});

describe("search marks", () => {
  it("marks every word searched for, whatever its case, and leaves the rest", () => {
    expect(marked("October invoices", "invoice")).toEqual([{ text: "October ", mark: false }, { text: "invoice", mark: true }, { text: "s", mark: false }]);
    expect(marked("Send Carl the invoice", "carl INVOICE").filter((p) => p.mark).map((p) => p.text)).toEqual(["Carl", "invoice"]);
    expect(marked("a (b)", "(b")).toEqual([{ text: "a ", mark: false }, { text: "(b", mark: true }, { text: ")", mark: false }]);
    expect(marked("plain", " ")).toEqual([{ text: "plain", mark: false }]);
  });
});

describe("sources", () => {
  it("on a person's page a source leaves out who it was from", () => {
    expect(shortSource("mail from Asha, 3 Nov")).toBe("mail, 3 Nov");
    expect(shortSource("call on 4 Nov")).toBe("call on 4 Nov");
  });

  it("the island says whom the assistant is looking up", () => {
    expect(actionOf("Checking what I know about Asha")).toEqual({ kind: "read", word: "Checking what I know about", what: "Asha" });
  });
});

describe("chats as a source", () => {
  const session = (status: SessionDetail["status"], log: SessionDetail["log"]) => ({ id: "s", surface: "chat", status, startedAt: 5, log }) as SessionDetail;
  const base = { chat: { messages: [], requestId: null, providerId: null, model: null, models: [], usage: null, task: "" }, chatPending: false, sessions: [] as SessionDetail[], settings: { ...defaultSettings, assistantName: "Mira" } };

  it("each question and its answer is one turn, typed or spoken, with the assistant's own name", () => {
    const messages = [
      { role: "user" as const, content: "When is the launch?" },
      { role: "assistant" as const, content: "18 Nov." },
      { role: "user" as const, content: "And the deck?" },
      { role: "assistant" as const, content: "" },
    ];
    expect(chatTurns({ ...base, chat: { ...base.chat, messages } })).toEqual([{ text: "You: When is the launch?\nMira: 18 Nov.", at: null }]);
  });

  it("an answer still coming is left for the next update", () => {
    const messages = [{ role: "user" as const, content: "Hi" }, { role: "assistant" as const, content: "Hel" }];
    expect(chatTurns({ ...base, chatPending: true, chat: { ...base.chat, messages } })).toEqual([]);
    const log = [{ kind: "user" as const, text: "Who is Asha?" }, { kind: "activity" as const, text: "Checking what I know about Asha" }, { kind: "text" as const, text: "Design lead." }, { kind: "user" as const, text: "And Carl?", at: 9 }, { kind: "text" as const, text: "Accounts." }];
    expect(chatTurns({ ...base, sessions: [session("completed", log)] })).toEqual([
      { text: "You: Who is Asha?\nMira: Design lead.", at: 5 },
      { text: "You: And Carl?\nMira: Accounts.", at: 9 },
    ]);
    expect(chatTurns({ ...base, sessions: [session("running", log)] })).toHaveLength(1);
  });
});
