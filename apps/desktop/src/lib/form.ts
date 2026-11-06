// Fill this form on the island, from the Fill this form and Your details boards: the line with Undo and
// Show once it is filled, the Show list of every box and where its value came from, Undo for the form
// or one box, Go to it, the question before an ID number goes in, and the offer to start Your details.
// The run itself starts in here.ts, behind Write here's checks and with its cards.

import { bridge } from "./bridge";
import { describe, end, sayFor, settle, show, showFor } from "./here";
import { getState, islandTyping, openPanel, openSettings } from "./store";
import type { FormRow, FormSummary, HereOutcome } from "./types";

/** The card that says what Undo put back stays this long. */
export const UNDONE_MS = 4000;
/** The Show list's rows before it scrolls. */
export const LIST_ROWS = 11;

const current = () => getState().here;

/** The island's line once it is filled: "Filled 8 of 11 · 3 need you". */
export function filledLine(form: FormSummary) {
  const filled = `Filled ${form.filled} of ${form.total}`;
  return form.need > 0 ? `${filled} · ${form.need} need you` : filled;
}

/** The small pill a filled form stays as until the pointer is on it: "2 need you", or "Filled". */
export function pillLine(form: FormSummary) {
  if (form.need === 0) return "Filled";
  return form.need === 1 ? "1 needs you" : `${form.need} need you`;
}

/** Kinds of box the island has no words for: lists, whose choices are not read, tick boxes, and the
 *  user's own. They keep Go to it. */
const NO_WORDS = ["list", "checkbox", "radio", "password", "file", "button"];

/** How the island can answer a box that needs the user: a button for each choice of a question, a box
 *  for words, or not at all. Never a box that is the user's, or an ID number waiting for its yes. */
export function answerWith(row: FormRow): "choices" | "words" | null {
  if (row.state !== "needs-you") return null;
  if (row.choices?.length) return "choices";
  return NO_WORDS.includes(row.kind) ? null : "words";
}

/** How the island names a Your details key, on the button that keeps what was typed under it. */
const DETAIL_NAMES: Record<string, string> = {
  name: "name",
  "name.en": "name",
  "name.hi": "name in Hindi",
  birth: "date of birth",
  email: "email",
  phone: "phone",
  "phone.other": "other phone",
  "address.lines": "address",
  "address.city": "city",
  "address.pin": "PIN code",
  "address.state": "state",
  "address.hi": "address in Hindi",
  "work.company": "company",
  "work.title": "job title",
  "work.department": "department",
  "work.id": "employee ID",
  "work.email": "work email",
  "work.linkedin": "LinkedIn",
};
export const detailName = (key: string) => DETAIL_NAMES[key] ?? key;

/** Rows the user answered on the island, which offer Add to Your details. */
export const typedHere = (row: FormRow) => row.state === "filled" && row.origin === "typed";

/** Where a value came from, as the Show list says it. */
export function sourceOf(row: FormRow): string {
  const from = (what: string) => (row.from ? `${what} · ${row.from}` : what);
  switch (row.origin) {
    case "details":
      return "Your details";
    case "knowledge":
      return from("Knowledge");
    case "mail":
      return row.from ? `Mail · ${row.from}` : "from mail";
    case "notes":
      return from("Call notes");
    case "file":
      return from("File");
    case "clipboard":
      return "Clipboard";
    case "page":
      return "This page";
    case "said":
      return "You said";
    case "written-by-ai":
      return "Written by AI";
    case "typed":
      return row.choices?.length ? "You picked" : "You typed";
    default:
      return "";
  }
}

/** A box with no value for it, as opposed to one that is the user's or asks first. */
const missing = (row: FormRow) => row.state === "needs-you";
const needsUser = (row: FormRow) => row.state === "needs-you" || row.state === "yours" || row.state === "ask-first";

/** The Show list starts with only the boxes that need the user when one has no value, as the board
 *  draws it, and with every box otherwise. A box answered on the island stays, to offer Add to Your details. */
export function listedRows(form: FormSummary, all: boolean): { rows: FormRow[]; missing: boolean } {
  const gaps = form.rows.some(missing);
  return { rows: gaps && !all ? form.rows.filter((row) => needsUser(row) || typedHere(row)) : form.rows, missing: gaps && !all };
}

/** Rows of room the Show list needs: its rows, up to where it scrolls, and the hint or the note. */
export function listRows(form: FormSummary, all: boolean): number {
  const shown = listedRows(form, all);
  return Math.min(shown.rows.length, LIST_ROWS) + (shown.missing ? 2 : 0) + (form.stopped || form.note ? 1 : 0);
}

/** "notice period" from "Notice period", for the hint that says what to say. */
export const sayIt = (label: string) => label.replace(/\s*[*:(].*$/, "").trim().toLowerCase();

/** "Email" or "Email and Phone". */
export const both = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** What the card after Undo says about boxes the user changed since. */
export function keptLine(kept: string[]) {
  if (kept.length === 0) return "Each box has what it held before.";
  if (kept.length === 1) return `You changed ${kept[0]} after it was filled, so ${kept[0]} keeps what you typed.`;
  return `You changed ${both(kept)} after they were filled, so they keep what you typed.`;
}

export const showList = () => {
  const here = current();
  if (here?.form) show({ ...here, step: "list", all: false });
};

export const showAllRows = () => {
  const here = current();
  if (here) show({ ...here, all: true });
};

export const closeList = () => {
  const here = current();
  if (here?.form) show({ ...here, step: "filled", all: false });
};

/** Every box back, unless the user changed it since. */
export async function undoForm() {
  try {
    const undone = await bridge.formUndo(null);
    showFor({ step: "undone", kind: "form", form: undone.form, undone }, UNDONE_MS);
  } catch (err) {
    sayFor(describe(err));
  }
}

/** One box back, from the Show list. */
export async function undoBox(field: number) {
  try {
    const undone = await bridge.formUndo(field);
    const here = current();
    if (here?.kind === "form") show({ ...here, form: undone.form });
  } catch (err) {
    sayFor(describe(err));
  }
}

/** The form as the core has it now, on the card on show. */
function update(form: FormSummary) {
  const here = current();
  if (here?.kind === "form") show({ ...here, form });
}

/** An answer typed or picked on the island for a box that needs the user. The keyboard goes back to the
 *  page first, even from a box only left a moment ago, so the core finds the page in front and writes it
 *  there, as it writes every value. */
export async function answerBox(field: number, text: string) {
  await islandTyping(false);
  try {
    update(await bridge.formAnswer(field, text));
  } catch (err) {
    sayFor(describe(err));
  }
}

/** Add to Your details: what the user typed in that box is kept, through Your details' own checks.
 *  Whether it was, and if not, the card says why. */
export async function keepBox(field: number) {
  try {
    update(await bridge.formKeep(field));
    return true;
  } catch (err) {
    const here = current();
    if (here?.form) update({ ...here.form, note: describe(err) });
    return false;
  }
}

/** Go to it: the cursor into that box, which brings it into view. */
export async function goToBox(field: number) {
  await bridge.formGo(field).catch((err) => sayFor(describe(err)));
}

const failed = (err: unknown): HereOutcome => ({ outcome: "failed", why: describe(err) });

/** Yes, put the ID number in on this site, this time. Only this click says yes. */
export async function allowIds() {
  show({ step: "filling", kind: "form" });
  settle(await bridge.formIds(true).catch(failed));
}

export async function skipIds() {
  settle(await bridge.formIds(false).catch(failed));
}

/** Not now: the offer waits a week, and the line shows what was filled. */
export const notNowDetails = () => {
  const here = current();
  if (here?.form) show({ ...here, step: "filled" });
};

/** Settings › Your details, with the form's line kept for when the panel closes. */
export function addDetails() {
  notNowDetails();
  openSettings("details");
  openPanel("settings");
}

export const closeForm = () => end();
