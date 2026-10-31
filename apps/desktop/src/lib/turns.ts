// The judgement calls in a spoken conversation, as plain functions: whether someone has finished,
// what is worth saying aloud, and what a short answer means.

/** Words nobody ends a sentence on. Hearing one means they are still thinking. */
const OPEN_ENDS = new Set([
  "a", "an", "and", "are", "as", "at", "because", "but", "by", "for", "from", "if", "in", "is", "my", "of", "on", "or", "our",
  "so", "than", "that", "the", "their", "then", "to", "um", "uh", "was", "were", "when", "which", "while", "who", "with", "your",
]);

const SETTLED_MS = 750;
const THINKING_MS = 1900;

/** Whether what was said so far sounds like a whole thought. */
export function looksFinished(words: string): boolean {
  const text = words.trim();
  if (!text || /[,;:-]$/.test(text)) return false;
  const last = text.split(/\s+/).pop()!.toLowerCase().replace(/[^a-z']/g, "");
  return !OPEN_ENDS.has(last);
}

/** How long a silence must last before the turn is over. A pause mid-thought gets longer. */
export const silenceFor = (words: string) => (looksFinished(words) ? SETTLED_MS : THINKING_MS);

/** Takes whole sentences off the front of streaming text, and leaves the rest to grow. */
export function sentences(text: string, finished: boolean): { ready: string[]; rest: string } {
  const ready: string[] = [];
  let rest = text;
  for (;;) {
    const end = rest.search(/[.!?](\s|$)|\n/);
    if (end < 0 || (end === rest.length - 1 && !finished)) break;
    const sentence = rest.slice(0, end + 1).trim();
    rest = rest.slice(end + 1).trimStart();
    if (sentence) ready.push(sentence);
  }
  if (finished && rest.trim()) {
    ready.push(rest.trim());
    rest = "";
  }
  return { ready, rest };
}

/** What a reply sounds like read aloud. Nobody wants to hear a code block or a link. */
export function speakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " I put the code in chat. ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s*(#{1,6}|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~>|]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Spoken ways of ending a conversation. Only as a whole sentence, so "stop the build" is not one. */
export const isGoodbye = (words: string) => /^(that'?s all|that is all|thanks|thank you|stop|goodbye|bye|never mind|nothing)\W*$/i.test(words.trim());

/** Yes or no, for a request that needs a decision. Anything else is not an answer. */
export function yesOrNo(words: string): boolean | null {
  const said = words.trim().replace(/[.!]+$/, "").toLowerCase();
  if (/^(yes|yeah|yep|yes please|go ahead|do it|send it|allow it)$/.test(said)) return true;
  if (/^(no|nope|no thanks|don't|do not|not now|deny it)$/.test(said)) return false;
  return null;
}

const FILLERS = ["Let me look.", "One moment.", "Let me check.", "Give me a second."];

/** Something short to say when a real answer is going to take a while. */
export const filler = (turn: number) => FILLERS[turn % FILLERS.length]!;
