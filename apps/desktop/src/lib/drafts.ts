// The one hand-over from a card's draft to Write here. Meridian's Gmail access stays read-only, so a
// draft reaches a reply box only through Write here, and the user presses Send.

import { dismissNotice, getState, pushNotice, setOfferedDraft } from "./store";

/** As long as Write here keeps a reply it could not put in. */
const OFFER_MS = 60_000;
/** The line on show, so a second draft replaces it rather than waiting behind it. */
let line = "";

/** Keeps the draft for Write here, and says on the island what to do next. Gmail opens the thread, but only
 *  the user can open its reply box, so the draft waits for their Ctrl Alt F or the island's Write here. */
export function offerDraft(text: string) {
  setOfferedDraft({ text, at: Date.now() });
  dismissNotice(line);
  line = `offered-draft-${Date.now()}`;
  pushNotice({ id: line, tone: "info", title: "Click in the reply box, then press Ctrl Alt F", body: "The draft goes in. You press Send." }, OFFER_MS);
}

/** The draft still on offer, once: Write here puts it in as it is, rather than writing a new reply. */
export function takeOfferedDraft(): string | undefined {
  const offered = getState().offeredDraft;
  if (!offered) return undefined;
  setOfferedDraft(null);
  dismissNotice(line);
  return Date.now() - offered.at < OFFER_MS ? offered.text : undefined;
}
