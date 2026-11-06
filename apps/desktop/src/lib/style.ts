// Sounds like you, on the page's side: the profile the core keeps on this PC, and the real count
// while it learns. The run lives in the core, so the panel can close and the island says when it ends.

import { useSyncExternalStore } from "react";
import { bridge } from "./bridge";
import { pushNotice } from "./store";

export interface StyleLine {
  /** greeting, signoff, length, tone, uses, avoids or languages. */
  key: string;
  text: string;
  /** The user wrote this, so learning again leaves it as it is. */
  mine: boolean;
}

export interface StyleProfile {
  learnedAt: string;
  /** How many sent emails it was learned from. */
  emails: number;
  lines: StyleLine[];
}

/** How many sent emails it learns from. */
export const STYLE_EMAILS = 100;

export interface StyleState {
  profile: StyleProfile | null;
  /** The file has been looked at, so no profile means none was learned. */
  loaded: boolean;
  /** Whether Gmail answers through the Claude account, once asked. */
  gmail: "checking" | "on" | "off" | null;
  /** How many sent emails have been read so far, while it learns. */
  reading: number | null;
  /** Why the last run stopped part way. */
  failed: string | null;
}

let style: StyleState = { profile: null, loaded: false, gmail: null, reading: null, failed: null };
const listeners = new Set<() => void>();

function set(patch: Partial<StyleState>) {
  style = { ...style, ...patch };
  listeners.forEach((listener) => listener());
}

export const useStyle = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => style,
  );

export const learnedFrom = (emails: number) =>
  emails >= STYLE_EMAILS ? `Learned from your last ${STYLE_EMAILS} sent emails` : `Learned from ${emails} sent ${emails === 1 ? "email" : "emails"}`;

let stopping = false;

export async function loadStyle() {
  set({ profile: await bridge.styleGet().catch(() => null), loaded: true });
}

/** Claude Code reports this as it starts, which takes seconds, so it is asked only while it matters. */
export async function checkGmail() {
  if (style.gmail === "checking") return;
  set({ gmail: "checking" });
  const [gmail] = await bridge.claudeConnectors().catch((): [boolean, boolean] => [false, false]);
  set({ gmail: gmail ? "on" : "off" });
}

export async function learnStyle() {
  if (style.reading !== null) return;
  stopping = false;
  set({ reading: 0, failed: null });
  try {
    const profile = await bridge.styleLearn((reading) => set({ reading }));
    set({ profile, reading: null, gmail: "on" });
    pushNotice({ tone: "success", title: "Sounds like you", body: `${learnedFrom(profile.emails)}.` });
  } catch (err) {
    // Stop keeps nothing and says nothing: the card goes back to what it was.
    const why = String(err).replace(/^Error: /, "");
    set({ reading: null, failed: stopping ? null : why });
    if (!stopping) pushNotice({ tone: "info", title: "Sounds like you", body: why });
  }
}

export function stopLearning() {
  stopping = true;
  void bridge.styleStop();
}

export async function saveLine(key: string, text: string) {
  set({ profile: await bridge.styleSetLine(key, text) });
}

export async function forgetStyle() {
  await bridge.styleForget();
  set({ profile: null, failed: null });
}
