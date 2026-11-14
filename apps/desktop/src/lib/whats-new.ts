/** A few lines for people about a version, shown once after an update. A release adds its own entry,
 *  written for the person using the app rather than copied from the release notes. */
export interface NewThing {
  title: string;
  line: string;
}

export const WHATS_NEW: Record<string, NewThing[]> = {
  "0.9.0": [
    { title: "Meet Lantern", line: "Meridian's face now has a body of dark glass, lit from inside in the colour of its mood." },
    { title: "Home, at a glance", line: "Tiles for what is happening now, the time, your next event and your music." },
    { title: "Big numbers, real colour", line: "Agents show how long, how many steps and how many lines. Music takes its album's colour." },
  ],
  "0.8.1": [
    { title: "Set the volume from the island", line: "When the volume shows, drag it, or scroll over it." },
    { title: "Numbers that roll", line: "Steps, minutes and the clock roll to the next number." },
    { title: "Small moments of light", line: "Sparks when an agent finishes, a lap of light round Ask, a glow under the pointer." },
  ],
  "0.8.0": [
    { title: "A panel that fits each page", line: "The island grows to the page you open, and reshapes as you change tab." },
    { title: "Tabs that say where you are", line: "They float under the panel, and the one you are on shows its name." },
    { title: "Calmer Home, with colour", line: "One card for what is happening now, and a glow while an agent works or waits for you." },
  ],
  "0.7.5": [
    { title: "Your AI on another machine", line: "Give Ollama or LM Studio an address, and a key if it asks, in Settings, AI models." },
  ],
  "0.7.4": [
    { title: "Your AI on another machine", line: "Give Ollama or LM Studio an address in Settings, AI models, and Meridian uses it." },
  ],
  "0.7.3": [
    { title: "Fills the tab you are on", line: "A form in another open tab is never read or filled." },
    { title: "Works the first time", line: "Ctrl Alt F finds your box right after Chrome starts." },
    { title: "Tick boxes and Undo, fixed", line: "Ticks stay ticked, and Undo puts long answers back." },
  ],
  "0.7.2": [
    { title: "Fills the form you are in", line: "Search, newsletter and cookie boxes elsewhere on the page are left alone." },
    { title: "Answer on the island", line: "Type or pick what a box needs, and add it to Your details for next time." },
    { title: "Out of your way", line: "A small pill after a fill, and green outlines fade after a few seconds." },
  ],
  "0.7.1": [
    { title: "Fill this form reads forms better", line: "Email boxes that suggest domains now fill in, and a page's lists are left alone." },
    { title: "Outlines stay with their tab", line: "They hide when you switch tabs and come back when you return." },
  ],
  "0.7.0": [
    { title: "Write here and Fill this form", line: "Ctrl Alt F writes a reply or fills a form in place. Turn it on in Settings." },
    { title: "Cards in My Day", line: "Replies you owe, renewals and trips, each with a draft or a plan." },
    { title: "Knowledge and Your details", line: "Pages about your people and projects, and your details, kept on this PC." },
  ],
  "0.6.3": [
    { title: "Wakes only for its name", line: "Speech that only sounds close no longer starts it listening." },
    { title: "The eyes you liked are back", line: "They follow you smoothly and blink the way they did before." },
  ],
  "0.6.2": [
    { title: "Calmer, more natural motion", line: "The face eases into each look and stops, with no wobble." },
    { title: "Eyes that leave you be", line: "They notice your pointer only when it comes near the island." },
    { title: "Less going on at once", line: "Fewer blinks and hops, and no sparks when something finishes." },
  ],
  "0.6.1": [
    { title: "The smiley talks", line: "Its mouth opens and closes with the voice, and turns with its eyes." },
    { title: "Cards warn before they close", line: "A line runs out in the last 5 seconds. Pin keeps the card." },
    { title: "It leans when you drag it", line: "The way you move it, then a small squash when you let go." },
  ],
  "0.6.0": [
    { title: "Faces that blink and glance", line: "They move less, so the island uses less power." },
    { title: "Approvals show everything", line: "A long command says when it is cut, and a new agent names its folder." },
    { title: "A quiet room while you talk", line: "Music and videos go silent while you speak to it." },
  ],
};

const parts = (version: string) => version.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);

/** True when `a` is a later version than `b`. */
export function isNewer(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/** What to show once, when the app has been updated since the user last saw this. A first install
 *  shows nothing, because nothing has changed for them. */
export function whatsNew(current: string, lastSeen: string | null): NewThing[] {
  if (!lastSeen || !isNewer(current, lastSeen)) return [];
  return WHATS_NEW[current.replace(/^v/, "")] ?? [];
}
