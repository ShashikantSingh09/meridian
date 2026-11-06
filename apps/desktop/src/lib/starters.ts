// The chips under Home's ask box. They are picked here, on this PC, from what Meridian already
// shows, so choosing them costs no AI call. Picking one only fills the box.

import { timeOf } from "../island/live";
import { activeSessions } from "../island/machine";
import type { IconName } from "./icons";
import type { AppState } from "./store";

export interface Starter {
  text: string;
  /** What it came from, shown when the pointer rests on it. */
  why: string;
  icon: IconName;
}

/** What is going on, in the few facts the chips are picked from. */
export interface Going {
  now: number;
  /** The last recorded call, and the first person on it with a real name. */
  call: { endedAt: number; with: string | null } | null;
  working: number;
  /** The project of an agent waiting for an answer. */
  waiting: string | null;
  planKnown: boolean;
  /** Plans for today that are still on. */
  today: number;
  /** When the next flight leaves, within the week. */
  flight: number | null;
  /** The first day or two, when set-up steps are offered. */
  firstDays: boolean;
  /** Set-up steps still to do. */
  todo: { gmail: boolean; wake: boolean; notes: boolean };
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const RECENT_CALL = 60 * MINUTE;
const FIRST_DAYS = 2 * DAY;
const FEWEST = 4;
const MOST = 6;
const MORNING = [5, 11];

const ALWAYS: Starter[] = [
  { text: "What's on tomorrow?", why: "You can ask this any time", icon: "calendar" },
  { text: "Anything I owe people?", why: "You can ask this any time", icon: "bell" },
  { text: "Play some music", why: "You can ask this any time", icon: "music" },
];

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const weekday = (at: number) => new Date(at).toLocaleDateString(undefined, { weekday: "long" });
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Four to six chips while something is going on, and three that always work when nothing is. */
export function pickStarters(g: Going): Starter[] {
  const picked: Starter[] = [];
  if (g.call && g.now - g.call.endedAt < RECENT_CALL) {
    const why = `Because your call${g.call.with ? ` with ${g.call.with}` : ""} ended at ${clock(g.call.endedAt)}`;
    picked.push({ text: "Summarise my last call", why, icon: "note" }, { text: "What did we agree?", why, icon: "note" });
    if (g.call.with) picked.push({ text: `Draft the to-dos for ${g.call.with}`, why, icon: "chat" });
  }
  if (g.waiting) picked.push({ text: "Which one needs me?", why: `Because ${g.waiting} is waiting for you`, icon: "agents" });
  if (g.working > 0) {
    const why = `Because ${count(g.working, "agent is", "agents are")} working`;
    picked.push({ text: "What are my agents doing?", why, icon: "agents" });
    if (g.planKnown) picked.push({ text: "How much Claude is left?", why, icon: "agents" });
  }
  if (g.today > 0) picked.push({ text: "What's on today?", why: `Because you have ${count(g.today, "plan", "plans")} today`, icon: "calendar" });
  if (g.flight !== null) picked.push({ text: `When is my flight on ${weekday(g.flight)}?`, why: `Because you fly on ${weekday(g.flight)}`, icon: "plane" });
  const hour = new Date(g.now).getHours();
  if (hour >= MORNING[0]! && hour < MORNING[1]!) {
    const why = "Because it is morning";
    picked.push({ text: "What's on today?", why, icon: "calendar" }, { text: "Anything I owe people?", why, icon: "bell" }, { text: "Play my morning mix", why, icon: "music" });
  }
  if (g.firstDays) {
    const step = "A set-up step not done yet";
    picked.push({ text: "What can you do?", why: "To see what Meridian can do", icon: "bulb" });
    if (g.todo.gmail) picked.push({ text: "Connect Gmail", why: step, icon: "providers" });
    if (g.todo.wake) picked.push({ text: "Set up wake words", why: step, icon: "mic" });
    if (g.todo.notes) picked.push({ text: "Take notes on my next call", why: step, icon: "note" });
    picked.push({ text: "Play something calm", why: "To see what Meridian can do", icon: "music" });
  }
  const unique = picked.filter((s, i) => picked.findIndex((other) => other.text === s.text) === i);
  if (unique.length === 0) return ALWAYS;
  for (const s of ALWAYS) if (unique.length < FEWEST && !unique.some((u) => u.text === s.text)) unique.push(s);
  return unique.slice(0, MOST);
}

const FIRST_SEEN = "meridian.firstSeen";

/** When this PC first ran Meridian, kept so the first days can be told apart. Now, if storage fails. */
export function firstSeen(now = Date.now()) {
  try {
    const kept = Number(localStorage.getItem(FIRST_SEEN));
    if (kept > 0) return kept;
    localStorage.setItem(FIRST_SEEN, String(now));
  } catch {
    // Without storage every day looks like the first, which only means set-up chips stay longer.
  }
  return now;
}

/** The facts, read from the app's state. */
export function goingFrom(s: AppState, now: number, since: number): Going {
  const last = [...s.notes.notes].filter((n) => n.endedAt !== null).sort((a, b) => b.endedAt! - a.endedAt!)[0];
  const named = last?.speakers.find((p) => !p.you && !/^Person \d+$/.test(p.name))?.name ?? null;
  // Chat runs on an agent too, and that is the assistant answering, not an agent at work.
  const active = activeSessions(s.sessions).filter((x) => x.surface === "agents");
  const midnight = new Date(now).setHours(24, 0, 0, 0);
  const on = s.activity.all.filter((e) => e.status === "active" || e.status === "updated");
  const flights = on.map((e) => (e.kind === "flight" ? timeOf(e.startsAt) : null)).filter((at): at is number => at !== null && at > now && at < now + 7 * DAY);
  const gmail = s.integrations.find((i) => i.id === "gmail");
  return {
    now,
    call: last ? { endedAt: last.endedAt!, with: named } : null,
    working: active.length,
    waiting: active.find((x) => x.approval)?.project ?? null,
    planKnown: (s.limits["claude-code"]?.windows.length ?? 0) > 0,
    today: on.filter((e) => {
      const at = timeOf(e.startsAt);
      return at !== null && at >= now && at < midnight;
    }).length,
    flight: flights.length ? Math.min(...flights) : null,
    firstDays: now - since < FIRST_DAYS,
    todo: { gmail: !(gmail?.connected || gmail?.viaClaude === "on"), wake: !s.settings.wakeEnabled, notes: s.notes.notes.length === 0 },
  };
}
