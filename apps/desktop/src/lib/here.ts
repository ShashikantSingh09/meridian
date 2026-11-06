// Write here, on the page's side: what the island shows while the core reads the box, asks the AI
// and puts the reply in. Every start comes through `startWriteHere`: Ctrl Alt F, the island's button,
// the assistant's write_here, an answer asked on the island, and the cards' Open in Gmail.

import { bridge } from "./bridge";
import { takeOfferedDraft } from "./drafts";
import { closePanel, getState, openPanel, openSettings, setHere, setHereOffer, settingsFromCore } from "./store";
import type { FillPlace, HereOutcome } from "./types";

export type HereStep = "writing" | "written" | "line" | "ask" | "off" | "local" | "failed" | "moved";

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

let run: WriteHereOptions = {};
let timer: ReturnType<typeof setTimeout> | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Writes into the box that has the cursor, with every check the core makes first. */
export async function startWriteHere(options: WriteHereOptions = {}) {
  if (getState().here?.step === "writing") return;
  // Ctrl Alt F or the island's button, with a card's draft on offer from Open in Gmail: that draft goes in.
  run = options.draft === undefined && options.instruction === undefined ? { ...options, draft: takeOfferedDraft() } : options;
  await go();
}

function show(here: HereState | null) {
  clearTimeout(timer);
  setHere(here);
}

/** The island's line has gone, so the core lets the box go. */
function end() {
  show(null);
  void bridge.hereDone().catch(() => undefined);
}

async function go(allow: string | null = null) {
  if (getState().panelOpen) {
    closePanel();
    await sleep(PANEL_CLOSE_MS);
  }
  show({ step: "writing" });
  const outcome = await bridge.hereStart({ instruction: run.instruction ?? null, text: run.draft ?? null, allow, window: run.window ?? null }).catch((err): HereOutcome => ({ outcome: "failed", why: describe(err) }));
  settle(outcome);
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
      return null;
  }
}

function settle(outcome: HereOutcome) {
  const next = stepFor(outcome);
  // An answer from the island goes back to the island when it cannot go in, as before. A place
  // still to be asked about is asked first.
  if (run.onNo && next && next.step !== "written" && next.step !== "ask") return no();
  if (!next) return end();
  show(next);
  if (next.step === "line") timer = setTimeout(end, LINE_MS);
  if (next.step === "moved") timer = setTimeout(end, KEPT_MS);
}

/** Not this time. An answer from the island shows there instead. */
function no() {
  const elsewhere = run.onNo;
  run = {};
  end();
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
export const tryAgain = () => again(() => bridge.hereRetry());

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

/** Whether to offer Write here on the island, looked at as the pointer arrives. Nothing a box holds is read. */
export async function lookForBox() {
  if (!getState().settings.fill.on) return setHereOffer(null);
  setHereOffer(await bridge.hereOffer().catch(() => null));
}

export function wireHere() {
  void bridge.onHereKey(() => void startWriteHere());
  void bridge.onHereStart(({ instruction }) => void startWriteHere({ instruction }));
  // Typing anything in the box closes the line.
  void bridge.onHereEnded(() => {
    if (getState().here?.step === "written") end();
  });
}
