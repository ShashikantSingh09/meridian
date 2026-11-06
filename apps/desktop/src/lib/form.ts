// Fill this form on the island, from the Fill this form and Your details boards: the line with Undo and
// Show once it is filled, the Show list of every box and where its value came from, Undo for the form
// or one box, Go to it, the question before an ID number goes in, and the offer to start Your details.
// The run itself starts in here.ts, behind Write here's checks and with its cards.

import { bridge } from "./bridge";
import { describe, end, sayFor, settle, show, showFor } from "./here";
import { getState, openPanel, openSettings } from "./store";
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
    default:
      return "";
  }
}

/** A box with no value for it, as opposed to one that is the user's or asks first. */
const missing = (row: FormRow) => row.state === "needs-you";
const needsUser = (row: FormRow) => row.state === "needs-you" || row.state === "yours" || row.state === "ask-first";

/** The Show list starts with only the boxes that need the user when one has no value, as the board
 *  draws it, and with every box otherwise. */
export function listedRows(form: FormSummary, all: boolean): { rows: FormRow[]; missing: boolean } {
  const gaps = form.rows.some(missing);
  return { rows: gaps && !all ? form.rows.filter(needsUser) : form.rows, missing: gaps && !all };
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
