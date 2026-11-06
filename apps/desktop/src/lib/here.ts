// Write here, on the page's side: what the island shows while the core reads the box, asks the AI
// and puts the reply in. Every start comes through `startWriteHere`: Ctrl Alt F, the island's button,
// the assistant's write_here, an answer asked on the island, and the cards' Open in Gmail.
// Fill this form is the same run's second kind (`startFillForm`), with the same checks and cards; its
// own steps are in form.ts.

import { bridge } from "./bridge";
import { takeOfferedDraft } from "./drafts";
import { closePanel, getState, openPanel, openSettings, setHere, setHereOffer, settingsFromCore } from "./store";
import type { FillPlace, FormProgress, FormSummary, FormUndone, HereOutcome } from "./types";

export type HereStep =
  | "writing"
  | "written"
  | "line"
  | "ask"
  | "off"
  | "local"
  | "failed"
  | "moved"
  // Fill this form: filling in, filled with Undo and Show, the Show list, put back, an ID number to
  // allow, and the offer to start Your details.
  | "filling"
  | "filled"
  | "list"
  | "undone"
  | "ids"
  | "details";

/** A place to ask about. `key` is what a yes for one time names. */
export interface HerePlace {
  key: string;
  id: string | null;
  name: string;
  /** Why it asks every time. Null the first time, which offers Once, Always and Never. */
  every: string | null;
}

export interface HereState {
  step: HereStep;
  /** The line, why it failed, or where the cursor went. */
  text?: string;
  place?: HerePlace;
  /** The AI picked, for local-only mode. */
  ai?: string;
  /** Fill this form, rather than Write here. */
  kind?: "form";
  form?: FormSummary;
  progress?: FormProgress;
  /** The Show list has every box, not only the ones that need the user. */
  all?: boolean;
  undone?: FormUndone;
}

/** A line about why nothing was read leaves after this long. */
export const LINE_MS = 3000;
/** A reply that could not go in is kept this long, to copy. */
export const KEPT_MS = 60_000;
/** Closing the panel hands the keyboard back to the window under it, which takes a moment. */
const PANEL_CLOSE_MS = 300;

export interface WriteHereOptions {
  /** Words already written, such as a card's draft. No AI is asked. */
  draft?: string;
  /** What the user asked for, in their words. */
  instruction?: string;
  /** Only into this window's box, as `lookForBox` found it. */
  window?: number;
  /** Called instead of showing why, when the words could not go in: they show somewhere else. */
  onNo?: () => void;
}

/** For a form said into again, the form as it was, to go back to when nothing more goes in. */
let run: WriteHereOptions & { kind?: "form"; before?: FormSummary } = {};
let timer: ReturnType<typeof setTimeout> | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));
const working = () => ["writing", "filling"].includes(getState().here?.step ?? "");

/** Writes into the box that has the cursor, with every check the core makes first. */
export async function startWriteHere(options: WriteHereOptions = {}) {
  if (working()) return;
  // A form on show is let go: the island now shows this reply.
  if (getState().here?.kind === "form") void bridge.formDone().catch(() => undefined);
  // Ctrl Alt F or the island's button, with a card's draft on offer from Open in Gmail: that draft goes in.
  run = options.draft === undefined && options.instruction === undefined ? { ...options, draft: takeOfferedDraft() } : options;
  await go();
}

/** Fills the form in front, with every check Write here makes first. Said again while a form is on
 *  show, it carries on in that form, so "notice period 60 days" fills that box. */
export async function startFillForm(options: { instruction?: string; window?: number } = {}) {
  if (working()) return;
  const shown = getState().here;
  run = { ...options, kind: "form", before: shown?.kind === "form" ? shown.form : undefined };
  await go();
}

/** The form as it was before it was said into again, or nothing. */
function back(before = run.before) {
  if (before) show({ step: "filled", kind: "form", form: before });
  else end();
}

/** Ctrl Alt F: the form, when the cursor is in a box of one or in no box at all, else Write here. A
 *  card's draft on offer always goes into the reply box. */
export async function startFromKey() {
  if (working()) return;
  const draft = takeOfferedDraft();
  if (draft === undefined && (await bridge.formPick().catch(() => false))) return startFillForm();
  return startWriteHere({ draft });
}

export function show(here: HereState | null) {
  clearTimeout(timer);
  setHere(here);
}

/** The island's line has gone, so the core lets the box, or the form and its outlines, go. */
export function end() {
  const form = getState().here?.kind === "form";
  show(null);
  void (form ? bridge.formDone() : bridge.hereDone()).catch(() => undefined);
}

/** Shows something for a moment, then goes. */
export function showFor(next: HereState, ms = LINE_MS) {
  show(next);
  timer = setTimeout(end, ms);
}

export const sayFor = (text: string) => showFor({ step: "line", text, kind: getState().here?.kind });

/** The place the user said yes to for this run, so trying again does not ask again. */
let allowed: string | null = null;

async function go(allow: string | null = null) {
  allowed = allow;
  if (getState().panelOpen) {
    closePanel();
    await sleep(PANEL_CLOSE_MS);
  }
  const request = { instruction: run.instruction ?? null, text: run.draft ?? null, allow, window: run.window ?? null };
  const failed = (err: unknown): HereOutcome => ({ outcome: "failed", why: describe(err) });
  if (run.kind === "form") {
    show({ step: "filling", kind: "form" });
    const outcome = await bridge.formStart(request).catch(failed);
    // One box only: Write here takes it, with the yes already given.
    if (outcome.outcome === "single") {
      run = { instruction: run.instruction, window: run.window };
      return go(allow);
    }
    return settle(outcome);
  }
  show({ step: "writing" });
  settle(await bridge.hereStart(request).catch(failed));
}

/** What the island shows for how a run ended. Pure, so every outcome is covered by here.test.ts. */
export function stepFor(outcome: HereOutcome): HereState | null {
  switch (outcome.outcome) {
    case "written":
      return { step: "written" };
    case "line":
      return { step: "line", text: outcome.text };
    case "ask":
      return { step: "ask", place: { key: outcome.key, id: outcome.id, name: outcome.name, every: outcome.every } };
    case "off":
      return { step: "off", place: { key: outcome.id, id: outcome.id, name: outcome.name, every: null } };
    case "local":
      return { step: "local", ai: outcome.ai };
    case "failed":
      return { step: "failed", text: outcome.why };
    case "moved":
      return { step: "moved", text: outcome.title };
    case "stopped":
    case "single":
      return null;
    case "filled": {
      // An ID number is asked about first, then the offer to start Your details, then the line.
      const form = outcome.form;
      return { step: form.ids.length > 0 ? "ids" : form.details ? "details" : "filled", kind: "form", form };
    }
  }
}

export function settle(outcome: HereOutcome) {
  const found = stepFor(outcome);
  const next = found && run.kind === "form" ? { ...found, kind: "form" as const } : found;
  // An answer from the island goes back to the island when it cannot go in, as before. A place
  // still to be asked about is asked first.
  if (run.onNo && next && next.step !== "written" && next.step !== "ask") return no();
  if (!next) return back();
  show(next);
  if (next.step === "line") timer = setTimeout(end, LINE_MS);
  if (next.step === "moved") timer = setTimeout(end, KEPT_MS);
}

/** Not this time. An answer from the island shows there instead. */
function no() {
  const { onNo: elsewhere, before } = run;
  run = {};
  back(before);
  elsewhere?.();
}

const place = () => getState().here?.place;

/** The list of apps and sites belongs to the core, which hands back the settings. */
export async function setPlace(next: FillPlace) {
  settingsFromCore(await bridge.fillPlaceSet(next));
}

export async function forgetPlace(id: string) {
  settingsFromCore(await bridge.fillPlaceForget(id));
}

const listed = (id: string) => getState().settings.fill.places.find((p) => p.id.toLowerCase() === id.toLowerCase());

/** Yes, this one time. A bank or government site goes on the list, as one that asks every time. */
export async function allowOnce() {
  const asked = place();
  if (!asked) return;
  if (asked.every && asked.id && !listed(asked.id)) await setPlace({ id: asked.id, name: asked.name, fill: "ask", finish: false, alwaysAsk: true }).catch(() => undefined);
  await go(asked.key);
}

export async function allowAlways() {
  const asked = place();
  if (!asked?.id) return;
  await setPlace({ id: asked.id, name: asked.name, fill: "allowed", finish: false, alwaysAsk: false });
  await go();
}

export async function neverHere() {
  const asked = place();
  if (asked?.id) await setPlace({ id: asked.id, name: asked.name, fill: "never", finish: false, alwaysAsk: false });
  no();
}

export const notNow = () => no();

/** From the card for a place set to Never: it goes back on the list, as it was before Never. */
export async function allowPlace() {
  const off = place();
  if (!off?.id) return;
  const known = listed(off.id);
  await setPlace({ id: off.id, name: known?.name ?? off.name, fill: known?.alwaysAsk ? "ask" : "allowed", finish: false, alwaysAsk: known?.alwaysAsk ?? false });
  await go(off.key);
}

export async function undoHere() {
  try {
    await bridge.hereUndo();
    end();
  } catch (err) {
    show({ step: "line", text: describe(err) });
    timer = setTimeout(end, LINE_MS);
  }
}

async function again(ask: () => Promise<HereOutcome>) {
  show({ step: "writing" });
  settle(await ask().catch((err): HereOutcome => ({ outcome: "failed", why: describe(err) })));
}

export const rewrite = (how: "shorter" | "warmer") => again(() => bridge.hereRewrite(how));
/** A form is read and filled again from the start, with the yes already given. */
export const tryAgain = () => (run.kind === "form" ? go(allowed) : again(() => bridge.hereRetry()));

export async function copyReply() {
  try {
    await bridge.hereCopy();
    end();
  } catch (err) {
    show({ step: "line", text: describe(err) });
    timer = setTimeout(end, LINE_MS);
  }
}

export const closeHere = () => end();

/** Local-only mode with an online AI: the AI is picked in Settings › Fill in the page. */
export function openFillSettings() {
  end();
  openSettings("fill");
  openPanel("settings");
}

/** Whether to offer Write here, or Fill this form, on the island, looked at as the pointer arrives.
 *  Nothing a box holds is read. */
export async function lookForBox() {
  if (!getState().settings.fill.on) return setHereOffer(null);
  const offer = await bridge.hereOffer().catch(() => null);
  setHereOffer(offer?.window ?? null, offer?.form ?? false);
}

export function wireHere() {
  void bridge.onHereKey(() => void startFromKey());
  void bridge.onHereStart(({ instruction }) => void startWriteHere({ instruction }));
  void bridge.onFormStart(({ instruction }) => void startFillForm({ instruction }));
  void bridge.onFormProgress((progress) => {
    const here = getState().here;
    if (here?.step === "filling") show({ ...here, progress });
  });
  // The page was left, or Undo ran out.
  void bridge.onFormEnded(() => {
    if (getState().here?.kind === "form" && !working()) end();
  });
  // Typing anything in the box closes the line.
  void bridge.onHereEnded(() => {
    if (getState().here?.step === "written") end();
  });
}
