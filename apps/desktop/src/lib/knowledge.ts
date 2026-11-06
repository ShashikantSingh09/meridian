// Knowledge on the page's side: it brings the AI Chat is on and the chats, and follows what the
// core reports. The pages themselves, and what an update may change, are the core's.

import { bridge } from "./bridge";
import { chatEngine, getState, setKnowledge, setTab, showNote, type AppState } from "./store";
import type { KnowledgeLine, KnowledgePage } from "./types";

const LIVE = ["starting", "running", "waiting"];
const OPENS = /^https:\/\/(mail\.google\.com|calendar\.google\.com|www\.google\.com\/calendar)\//;

export async function refreshKnowledge() {
  setKnowledge(await bridge.knowledgeState());
}

/** Update now, or the core saying the PC is idle. With no AI ready, an idle update says nothing,
 *  because nothing about Knowledge shows on the island. */
export async function updateKnowledge(idle = false) {
  const engine = await chatEngine();
  if (!engine) {
    if (idle) return;
    throw new Error("No AI is ready. Add one in Settings, AI models.");
  }
  const state = getState();
  await bridge.knowledgeUpdate(engine, state.settings.knowledge.chats ? chatTurns(state) : [], idle);
}

export function wireKnowledge() {
  void bridge.onKnowledgeChanged(() => void refreshKnowledge());
  void bridge.onKnowledgeIdle(() => void updateKnowledge(true).catch(() => undefined));
  void refreshKnowledge();
}

type Turn = { text: string; at: number | null };

/** Each question to the assistant with its answer, typed or spoken. One still being answered waits for the next update. */
export function chatTurns(state: Pick<AppState, "chat" | "chatPending" | "sessions" | "settings">): Turn[] {
  const name = state.settings.assistantName.trim() || "Meridian";
  const turns: Turn[] = [];
  const messages = state.chat.messages;
  messages.forEach((m, i) => {
    const reply = messages[i + 1];
    const answering = state.chatPending && i + 1 === messages.length - 1;
    if (m.role === "user" && reply?.role === "assistant" && reply.content.trim() && !answering) turns.push({ text: `You: ${m.content}\n${name}: ${reply.content}`, at: null });
  });
  for (const s of state.sessions.filter((s) => s.surface === "chat")) {
    let current: { said: string; at: number | null; replies: string[] } | null = null;
    const done = () => current && current.replies.length > 0 && turns.push({ text: `You: ${current.said}\n${name}: ${current.replies.join("\n")}`, at: current.at });
    for (const entry of s.log) {
      if (entry.kind === "user") {
        done();
        current = { said: entry.text, at: entry.at ?? s.startedAt, replies: [] };
      } else if (entry.kind === "text" && current) current.replies.push(entry.text);
    }
    if (!LIVE.includes(s.status)) done();
  }
  return turns;
}

/** The promises that name a page, open ones first, so a ticked one moves to the end. */
export function promisesFor(pages: KnowledgePage[], title: string): { page: KnowledgePage; line: KnowledgeLine }[] {
  const named = title.toLowerCase();
  return pages
    .filter((p) => p.kind === "promise" && p.linked.some((l) => l.toLowerCase() === named))
    .flatMap((page) => page.sections.flatMap((s) => s.lines).filter((line) => line.done !== null).map((line) => ({ page, line })))
    .sort((a, b) => Number(a.line.done) - Number(b.line.done));
}

/** Open promises first, and how many are open, for the list. */
export function promiseOrder(pages: KnowledgePage[]) {
  const done = (p: KnowledgePage) => p.subtitle === "Done";
  return { pages: [...pages].sort((a, b) => Number(done(a)) - Number(done(b))), open: pages.filter((p) => !done(p)).length };
}

/** Text in parts, with every word of the search marked. */
export function marked(text: string, query: string): { text: string; mark: boolean }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return [{ text, mark: false }];
  return text.split(new RegExp(`(${words.join("|")})`, "gi")).filter(Boolean).map((part) => ({ text: part, mark: words.some((w) => new RegExp(`^${w}$`, "i").test(part)) }));
}

/** On a person's own page, "mail from Asha, 3 Nov" says more than it needs to. */
export const shortSource = (label: string) => label.replace(/ from [^,]+/, "");

/** A call opens its notes, a chat opens Chat, and mail or an event opens in Google. Nothing else opens. */
export function openSource(target: string) {
  if (target.startsWith("meridian:note/")) {
    showNote(target.slice("meridian:note/".length));
    setTab("notes");
  } else if (target === "meridian:chat") setTab("chat");
  else if (OPENS.test(target)) void bridge.openUrl(target);
}

export const sourceTip = (target: string) =>
  target.startsWith("meridian:note/") ? "Open these notes" : target === "meridian:chat" ? "Open Chat" : target.includes("mail.google.com") ? "Open in Gmail" : "Open in Google Calendar";

/** "7:12 am" today, and the day before that. */
export function updatedWhen(ms: number, now = new Date()) {
  const at = new Date(ms);
  return at.toDateString() === now.toDateString() ? at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
