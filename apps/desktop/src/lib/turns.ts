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
export const isGoodbye = (words: string) =>
  /^(that'?s all|that is all|thanks|thank you|stop|goodbye|bye|never mind|nothing|bas|bas karo|bas itna hi|shukriya|dhanyavaad|बस|बस करो|बस इतना ही|शुक्रिया|धन्यवाद)[\s।.!]*$/iu.test(words.trim());

/** What was said without the name it was called by, which the AI has no need to hear. */
export function withoutWakeWord(words: string, wakeWords: string[]): string {
  const name = (phrase: string) => phrase.toLowerCase().replace(/^(hey|hi|hello|okay|ok|oye)\s+/, "");
  for (const phrase of wakeWords) {
    const called = new RegExp(`^\\W*(?:(?:hey|hi|hello|okay|ok|oye)[\\s,]+)?${name(phrase).replace(/[^a-z' ]/g, "")}\\b[\\s,.!?:;-]*`, "i");
    if (called.test(words)) return words.replace(called, "");
  }
  return words;
}

/** Letters apart, so a name written slightly differently by the hearing still counts. */
function apart(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

/** Meridian as Hindi hearing writes it. */
const MERIDIAN_IN_HINDI = /म[ेै]?र[िीे]?ड[िी]?[यए]न/u;

/** Whether the words really hold a wake word. The check that talk in the room was not meant for it. */
export function calledByName(words: string, wakeWords: string[]): boolean {
  const said = words.toLowerCase().split(/[^\p{L}']+/u).filter(Boolean);
  return wakeWords.some((phrase) => {
    const name = phrase.toLowerCase().replace(/^(hey|hi|hello|okay|ok|oye)\s+/, "");
    if (name === "meridian" && MERIDIAN_IN_HINDI.test(words)) return true;
    const parts = name.split(/\s+/);
    return parts.every((part) => said.some((word) => (part.length < 5 ? word === part : apart(word, part) <= 2)));
  });
}

/** Yes or no, for a request that needs a decision. Anything else is not an answer. */
export function yesOrNo(words: string): boolean | null {
  const said = words.trim().replace(/[.!।,]+/g, "").replace(/\s+/g, " ").toLowerCase();
  if (/^(yes|yeah|yep|yes please|go ahead|do it|send it|allow it|haan|han|haan kar do|haan ji|ji haan|theek hai|thik hai|kar do|हाँ|हां|हाँ कर दो|हां कर दो|जी हाँ|जी हां|ठीक है|कर दो)$/u.test(said)) return true;
  if (/^(no|nope|no thanks|don't|do not|not now|deny it|nahin|nahi|mat karo|rehne do|nahin rehne do|नहीं|मत करो|रहने दो|नहीं रहने दो)$/u.test(said)) return false;
  return null;
}

const FILLERS = ["Let me look.", "One moment.", "Let me check.", "Give me a second."];

/** Something short to say when a real answer is going to take a while. */
export const filler = (turn: number) => FILLERS[turn % FILLERS.length]!;
