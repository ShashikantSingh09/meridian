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

/** Ways of saying you are finished, without apostrophes or punctuation, because those are taken out first. */
const GOODBYES = [
  "thats all", "that is all", "thats it", "that is it", "thatll be all", "that will be all", "thats everything", "that is everything", "thats enough", "that is enough",
  "nothing else", "nothing more", "nothing", "no more", "not now", "never mind", "nevermind", "forget it", "leave it",
  "im done", "i am done", "were done", "we are done", "all done", "done", "im good", "i am good", "im all set", "i am all set", "all set", "im finished", "i am finished", "finished",
  "stop", "stop listening", "you can stop", "you can stop listening", "you can stop now", "you can go", "you can go now", "go to sleep", "go away", "exit", "quit", "close", "cancel",
  "thanks", "thank you", "thanks a lot", "thanks so much", "thank you so much", "thank you very much",
  "bye", "bye bye", "goodbye", "good bye", "good night", "goodnight", "see you", "see ya", "see you later", "talk to you later", "catch you later", "later",
  "bas", "bas karo", "bas kar", "bas itna hi", "bas yahi", "ho gaya", "hogaya", "aur kuch nahi", "aur kuch nahin", "kuch nahi", "kuch nahin", "rehne do", "chhodo", "chodo", "band karo",
  "alvida", "shukriya", "dhanyavaad", "dhanyawad", "dhanyavad",
  "बस", "बस करो", "बस इतना ही", "हो गया", "और कुछ नहीं", "कुछ नहीं", "रहने दो", "छोड़ो", "बंद करो", "अलविदा", "शुक्रिया", "धन्यवाद",
];

/** Said around a goodbye without changing it, such as the ok in "ok that's it". None is a goodbye alone, because each can answer a question. */
const AROUND_GOODBYE = [
  "ok", "okay", "alright", "all right", "right", "yeah", "yes", "yep", "no", "nope", "nah", "hmm", "well", "so", "fine", "good", "great", "cool", "perfect", "nice", "awesome",
  "please", "now", "then", "for now", "for today", "for the day", "haan", "han", "ji", "accha", "acha", "theek hai", "thik hai", "chalo", "ab",
  "ठीक है", "अच्छा", "हाँ", "हां", "जी", "चलो", "अब",
];

/** A wake word without its greeting. */
const bareName = (phrase: string) => phrase.toLowerCase().replace(/^(hey|hi|hello|okay|ok|oye)\s+/, "");

/**
 * Whether someone has finished talking to it. Every word has to be part of saying so, however it is
 * put, so "ok that's it, thanks" is one and "stop the build" is not. `names` are what it answers to.
 */
export function isGoodbye(words: string, names: string[] = []): boolean {
  let left = words.toLowerCase().replace(/['’]/g, "").replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const phrases = [...GOODBYES, ...AROUND_GOODBYE, ...names.map(bareName).filter(Boolean)].sort((a, b) => b.length - a.length);
  let finished = false;
  for (let phrase = phrases.find((p) => left === p || left.startsWith(`${p} `) || left.endsWith(` ${p}`)); phrase; phrase = phrases.find((p) => left === p || left.startsWith(`${p} `) || left.endsWith(` ${p}`))) {
    left = (left.startsWith(phrase) ? left.slice(phrase.length) : left.slice(0, -phrase.length)).trim();
    finished ||= GOODBYES.includes(phrase);
  }
  return finished && !left;
}

/** What was said without the name it was called by, which the AI has no need to hear. People who get no answer say it again. */
export function withoutWakeWord(words: string, wakeWords: string[]): string {
  for (const phrase of wakeWords) {
    const name = bareName(phrase).replace(/[^\p{L}\p{M}' ]/gu, "");
    if (!name) continue;
    const called = new RegExp(`^[\\s\\p{P}]*(?:(?:hey|hi|hello|okay|ok|oye)[\\s,]+)?${name}(?![\\p{L}\\p{M}])[\\s\\p{P}]*`, "iu");
    if (called.test(words)) return withoutWakeWord(words.replace(called, ""), wakeWords);
  }
  return words;
}

/** Yes or no, for a request that needs a decision. Anything else is not an answer. */
export function yesOrNo(words: string): boolean | null {
  const said = words.trim().replace(/[.!।,]+/g, "").replace(/\s+/g, " ").toLowerCase();
  if (/^(yes|yeah|yep|yes please|go ahead|do it|send it|allow it|haan|han|haan kar do|haan ji|ji haan|theek hai|thik hai|kar do|हाँ|हां|हाँ कर दो|हां कर दो|जी हाँ|जी हां|ठीक है|कर दो)$/u.test(said)) return true;
  if (/^(no|nope|no thanks|don't|do not|not now|deny it|nahin|nahi|mat karo|rehne do|nahin rehne do|नहीं|मत करो|रहने दो|नहीं रहने दो)$/u.test(said)) return false;
  return null;
}

/** Words for allowing a request by voice. One is picked for each request, so a plain "yes" from a
 *  video, a recording or someone else in the room cannot allow it. */
export const ALLOW_WORDS = ["harbour", "maple", "comet", "river", "lantern", "pebble", "orchid", "falcon", "meadow", "cobalt", "tulip", "glacier", "ember", "willow", "summit", "canyon", "violet", "anchor", "saffron", "quartz", "juniper", "marble", "coral", "thunder"];

export const pickAllowWord = (random: () => number = Math.random) => ALLOW_WORDS[Math.floor(random() * ALLOW_WORDS.length) % ALLOW_WORDS.length]!;

/** A spoken answer to a request: no is enough to deny, and allowing needs the request's own word. */
export function spokenAnswer(words: string, allowWord: string): boolean | null {
  const said = words.trim().replace(/[.!।,"']+/g, "").replace(/\s+/g, " ").toLowerCase();
  if (yesOrNo(said) === false) return false;
  const named = said.split(" ").includes(allowWord.toLowerCase());
  const refused = /(^| )(no|not|don't|dont|never|nahin|nahi|नहीं)( |$)/u.test(said);
  return named && !refused ? true : null;
}

const FILLERS = ["Let me look.", "One moment.", "Let me check.", "Give me a second."];

/** Something short to say when a real answer is going to take a while. */
export const filler = (turn: number) => FILLERS[turn % FILLERS.length]!;
