// Asking from the island: point, click, type, Enter. The answer comes back on the island, or, when a
// text box had the cursor, goes into that box through Write here and every check it makes. It is
// saved in Chat either way.

import { lookForBox, startWriteHere } from "./here";
import { dismissError, getState, islandTyping, openPanel, refreshAuth, sendToEngine, setAsk, signInAgent } from "./store";
import { chatNow, replySince } from "./voice";

export type AskPhase = "typing" | "thinking" | "answer" | "failed";

export interface AskState {
  phase: AskPhase;
  question: string;
  answer: string;
  /** Why it could not answer, in one line. */
  why: string;
  /** The agent is signed out, so the card offers to sign in and ask again. */
  signIn: boolean;
  /** The window whose box Meridian may write in had the cursor when the island was pointed at. The
   *  answer goes into that box, and only that one. */
  box: number | null;
}

/** About three lines of the island's card. The whole answer is in Chat. */
export const SHOWN_CHARS = 160;
/** An answer stays a few seconds, longer for a longer one. */
export const answerMs = (answer: string) => Math.min(12_000, 4000 + 40 * answer.length);
/** Lines on the card for an answer this long, at most three. */
export const answerLines = (answer: string) => Math.max(1, Math.min(3, Math.ceil(answer.length / 55)));
/** A pointer can rest on the island with nobody reading, so holding an answer has a limit. */
const HELD_MOST_MS = 20_000;
const LONGEST_WAIT_MS = 5 * 60_000;
const POLL_MS = 120;

/** Which question is current, so the answer to one that was closed is dropped. */
let current = 0;
let leave: ReturnType<typeof setTimeout> | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const patch = (change: Partial<AskState>) => {
  const ask = getState().ask;
  if (ask) setAsk({ ...ask, ...change });
};

/** The field on the island was clicked. Whether a box had the cursor is known from the pointer's arrival,
 *  before the island takes the keyboard. */
export function openAsk() {
  islandTyping(true);
  setAsk({ phase: "typing", question: "", answer: "", why: "", signIn: false, box: getState().hereOffer });
}

export const typeAsk = (question: string) => patch({ question });

export function closeAsk() {
  current++;
  clearTimeout(leave);
  if (getState().ask?.phase === "typing") islandTyping(false);
  setAsk(null);
}

export function sendAsk() {
  const ask = getState().ask;
  const question = ask?.question.trim();
  if (!ask || ask.phase !== "typing" || !question) return;
  // The keyboard goes back to the window it came from, so an answer can go into its box.
  islandTyping(false);
  void pose(question, ask.box);
}

async function pose(question: string, box: number | null) {
  const mine = ++current;
  clearTimeout(leave);
  setAsk({ phase: "thinking", question, answer: "", why: "", signIn: false, box });
  const before = chatNow();
  const errors = new Set(getState().errors.map((e) => e.id));
  const reply = await follow(mine, before, sendToEngine(question, [], box !== null));
  if (mine !== current) return;
  // A failure the chat reported is said on this card instead.
  const fresh = getState().errors.find((e) => !errors.has(e.id));
  if (fresh) dismissError(fresh.id);
  if (reply && !fresh) return answered(question, reply, box);
  const agent = getState().agentChat.agent;
  const name = getState().agents.find((a) => a.id === agent)?.name ?? "The AI";
  const signedOut = agent ? (await refreshAuth(agent))?.signedIn === false : false;
  if (mine !== current) return;
  const why = signedOut ? `${name} is signed out.` : (fresh?.body ?? "No answer came back.");
  setAsk({ phase: "failed", question, answer: "", why: `${why.replace(/\.?$/, ".")} Your question is kept.`, signIn: signedOut, box });
}

/** The reply to the question just sent, or null when it failed or never started. */
async function follow(mine: number, before: unknown, sent: Promise<unknown>): Promise<string | null> {
  let started = true;
  void sent.then(
    () => {
      // Nothing began, so nothing will arrive. The reason is already on screen.
      if (chatNow() === before && !getState().chatPending) started = false;
    },
    () => (started = false),
  );
  const until = Date.now() + LONGEST_WAIT_MS;
  while (mine === current && Date.now() < until) {
    const reply = replySince(before);
    if (reply.done) return reply.text.trim() || null;
    if (!started) return null;
    await sleep(POLL_MS);
  }
  return null;
}

function answered(question: string, answer: string, box: number | null) {
  if (box === null) return showAnswer(question, answer);
  setAsk(null);
  void startWriteHere({ draft: answer, window: box, onNo: () => showAnswer(question, answer) });
}

function showAnswer(question: string, answer: string) {
  const mine = current;
  setAsk({ phase: "answer", question, answer, why: "", signIn: false, box: null });
  // Pointing at it keeps it, within reason.
  const latest = Date.now() + answerMs(answer) + HELD_MOST_MS;
  const expire = () => {
    if (mine !== current || getState().ask?.phase !== "answer") return;
    if (getState().hovered && Date.now() < latest) return void (leave = setTimeout(expire, 1500));
    closeAsk();
  };
  leave = setTimeout(expire, answerMs(answer));
}

export function openInChat() {
  closeAsk();
  openPanel("chat");
}

/** Asks the same question again, into a box only if one has the cursor now. */
export async function askAgain() {
  const ask = getState().ask;
  if (!ask) return;
  await lookForBox();
  void pose(ask.question, getState().hereOffer);
}

/** Signs in, then asks the same question again, so there is nothing to retype. Signing in opens a
 *  browser, whose boxes are no place for the answer, so it shows on the island. */
export async function signInAgain() {
  const ask = getState().ask;
  const agent = getState().agentChat.agent;
  if (!ask || !agent) return;
  await signInAgent(agent, getState().agents.find((a) => a.id === agent)?.name ?? agent);
  if (getState().auth[agent]?.signedIn && getState().ask === ask) void pose(ask.question, null);
}
