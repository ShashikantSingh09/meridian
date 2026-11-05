/** A few lines for people about a version, shown once after an update. A release adds its own entry,
 *  written for the person using the app rather than copied from the release notes. */
export interface NewThing {
  title: string;
  line: string;
}

export const WHATS_NEW: Record<string, NewThing[]> = {
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
