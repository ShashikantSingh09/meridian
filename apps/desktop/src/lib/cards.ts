// Cards you can act on, on the page's side: how each one reads, and what its buttons do. What counts
// as a card is the core's (cards.rs). Nothing here sends, buys or books: the last step is the user's.

import type { CardLine } from "../island/machine";
import { bridge } from "./bridge";
import type { IconName } from "./icons";
import { offerDraft } from "./drafts";
import { addReminder, chatEngine, dismissNotice, getState, openLink, openPanel, pushError, pushNotice, setCardFocus, setCards, updateSettings, type AppState } from "./store";
import type { Card, CardFailure, CardKind, ContextEvent, MyDaySettings } from "./types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_MS = 86_400_000;
/** The morning line stays this long, longer while the pointer is on it, then waits in My Day. */
const MORNING_MS = 20_000;
const PERIODS = { week: "Weekly", month: "Monthly", year: "Yearly" } as const;

/** Each kind's square, as on the board. */
export const KINDS: Record<CardKind, { icon: IconName; tone: string; setting: keyof MyDaySettings; stop: string }> = {
  reply: { icon: "mail", tone: "#ea4335", setting: "replies", stop: "No more reply cards" },
  renewal: { icon: "renew", tone: "#bf5af2", setting: "renewals", stop: "No more renewal cards" },
  trip: { icon: "train", tone: "#0a84ff", setting: "trips", stop: "No more trip cards" },
};

// ── How a card reads ────────────────────────────────────────────────────────

/** "6 Nov" */
export const dayMonth = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
/** "Tue 10 Nov" */
export const weekdayDate = (d: Date) => `${DAYS[d.getDay()]} ${dayMonth(d)}`;
/** "Fri, 6 Nov", as the panel's heading writes the date. */
export const shortDate = (d: Date) => `${DAYS[d.getDay()]}, ${dayMonth(d)}`;
/** "Friday, 6 Nov" */
export const longDate = (d: Date) => `${LONG_DAYS[d.getDay()]}, ${dayMonth(d)}`;

/** "2 pm" and "4:30 pm". `full` keeps ":00", for a column of times. */
export function clockOf(d: Date, full = false) {
  const hour = d.getHours() % 12 || 12;
  const half = d.getHours() < 12 ? "am" : "pm";
  const minutes = d.getMinutes();
  return minutes === 0 && !full ? `${hour} ${half}` : `${hour}:${String(minutes).padStart(2, "0")} ${half}`;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** Calendar days from `a` to `b`: Tuesday to Friday is 3, whatever the hour. */
const daysBetween = (a: Date, b: Date) => Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS);
/** A day written as 2026-11-07, on this PC's calendar. */
const dayOf = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
};

/** "today", "tomorrow", "Monday" this week, or "12 Nov". */
function dayWord(day: Date, now: Date) {
  const ahead = daysBetween(now, day);
  return ahead === 0 ? "today" : ahead === 1 ? "tomorrow" : ahead > 1 && ahead < 7 ? LONG_DAYS[day.getDay()]! : dayMonth(day);
}

/** "on Tuesday" for this past week, "yesterday", or "on 28 Oct". */
function whenPast(at: Date, now: Date) {
  const ago = daysBetween(at, now);
  return ago === 0 ? "today" : ago === 1 ? "yesterday" : ago < 7 ? `on ${LONG_DAYS[at.getDay()]}` : `on ${dayMonth(at)}`;
}

const firstName = (who: string) => who.trim().split(/\s+/)[0] || who;

function waiting(card: Card, now: Date) {
  const days = daysBetween(new Date(card.seen), now);
  return days <= 0 ? "waiting since today" : days === 1 ? "waiting a day" : `waiting ${days} days`;
}

function renews(card: Extract<Card, { kind: "renewal" }>, now: Date) {
  const word = dayWord(dayOf(card.on), now);
  const when = /^\d/.test(word) ? `on ${word}` : word;
  return `${card.service} ${card.trial ? "trial ends" : "renews"} ${when}`;
}

/** The small line on top: where the card came from, and how old it is. */
export function cardTag(card: Card, now: Date) {
  switch (card.kind) {
    case "reply":
      return `Gmail · ${waiting(card, now)}`;
    case "renewal":
      return `${card.receipt ? "From a receipt in Gmail" : "From Gmail"}, ${dayMonth(new Date(card.seen))}`;
    case "trip":
      return `Calendar · ${weekdayDate(new Date(card.starts))}`;
  }
}

export function cardTitle(card: Card, now: Date) {
  switch (card.kind) {
    case "reply":
      return `Reply to ${firstName(card.who)}`;
    case "renewal":
      return card.amount ? `${renews(card, now)} — ${card.amount}` : renews(card, now);
    case "trip":
      return card.title;
  }
}

export function cardText(card: Card, now: Date) {
  switch (card.kind) {
    case "reply": {
      const when = whenPast(new Date(card.seen), now);
      const said = card.asked ? `Asked about ${card.asked} ${when}.` : `Wrote ${when} about “${card.subject}”.`;
      return card.draft ? `${said} A draft is ready.` : said;
    }
    case "renewal": {
      const word = dayWord(dayOf(card.on), now);
      const before = word === "today" ? "Cancel today" : `Cancel before ${word}`;
      const plan = card.trial ? "Free trial. " : card.period ? `${PERIODS[card.period]} plan. ` : "";
      return `${plan}${before} if you ${card.trial ? "do not want to pay" : "no longer want it"}.`;
    }
    case "trip":
      return `Your ${clockOf(new Date(card.starts))} at ${card.place} has no travel booked. A plan is ready.`;
  }
}

/** One line on the island, and what sits at its end. */
export function cardLine(card: Card, now: Date): CardLine {
  const line = (title: string, meta: string): CardLine => ({ id: card.id, kind: card.kind, title, meta });
  switch (card.kind) {
    case "reply":
      return line(`Reply to ${firstName(card.who)}`, waiting(card, now));
    case "renewal":
      return line(renews(card, now), card.amount ?? "");
    case "trip": {
      const starts = new Date(card.starts);
      return line(card.title, daysBetween(now, starts) === 0 ? clockOf(starts) : DAYS[starts.getDay()]!);
    }
  }
}

export const needsYou = (n: number) => `${n} ${n === 1 ? "thing needs" : "things need"} you today`;

/** "3 things need you. 2 meetings, and a parcel on the way." */
export function daySummary(needs: number, meetings: number, parcels: number) {
  const first = needs > 0 ? `${needs} ${needs === 1 ? "thing needs" : "things need"} you.` : "";
  const rest = [meetings > 0 && `${meetings} ${meetings === 1 ? "meeting" : "meetings"}`, parcels > 0 && (parcels === 1 ? "a parcel on the way" : `${parcels} parcels on the way`)].filter(Boolean).join(", and ");
  const second = rest ? `${rest[0]!.toUpperCase()}${rest.slice(1)}.` : "";
  return [first, second].filter(Boolean).join(" ");
}

const OPEN = ["active", "updated"];
const today = (e: ContextEvent, now: Date) => e.startsAt !== null && new Date(e.startsAt.kind === "date" ? `${e.startsAt.value}T00:00:00` : e.startsAt.value).toDateString() === now.toDateString();
export const meetingsToday = (events: ContextEvent[], now: Date) => events.filter((e) => e.kind === "meeting" && OPEN.includes(e.status) && today(e, now)).length;
export const parcelsOnTheWay = (events: ContextEvent[]) => events.filter((e) => e.kind === "delivery" && OPEN.includes(e.status) && e.metadata.deliveryStatus !== "Delivered").length;

const PLACES: [string, string][] = [["meet.google.com", "Google Meet"], ["zoom.us", "Zoom"], ["teams.microsoft.com", "Teams"], ["teams.live.com", "Teams"], ["webex.com", "Webex"]];
const NOT_LATER = ["delivery", "order", "flight", "hotel", "rentalCar"];

function whereOf(e: ContextEvent) {
  const join = e.suggestedActions.find((a) => a.actionId === "join" && a.url)?.url;
  const host = join ? new URL(join).hostname : "";
  const known = PLACES.find(([h]) => host === h || host.endsWith(`.${h}`));
  if (known) return known[1];
  return typeof e.metadata.location === "string" ? e.metadata.location : "";
}

/** What is still ahead today at a set time, soonest first. Travel and parcels have their own places. */
export function laterToday(events: ContextEvent[], now: Date) {
  return events
    .filter((e) => e.startsAt && e.startsAt.kind !== "date" && OPEN.includes(e.status) && !NOT_LATER.includes(e.kind))
    .map((e) => ({ e, at: new Date(e.startsAt!.value) }))
    .filter(({ at }) => at.toDateString() === now.toDateString() && at.getTime() > now.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map(({ e, at }) => ({ id: e.id, time: clockOf(at, true), title: e.title, where: whereOf(e) }));
}

/** "Could not check Gmail this morning, because Claude Code is signed out. Cards from mail may be missing." */
export function failureLine(failure: CardFailure, checkedAt: Date) {
  const name = failure.source === "gmail" ? "Gmail" : "Google Calendar";
  const when = checkedAt.getHours() < 12 ? "this morning" : "today";
  const why = failure.why ? `, because ${failure.why}` : "";
  return `Could not check ${name} ${when}${why}. Cards from ${failure.source === "gmail" ? "mail" : "your calendar"} may be missing.`;
}

/** The plan's steps. The first is the AI's, the rest say who does what. */
export function planSteps(card: Extract<Card, { kind: "trip" }>) {
  return [card.step, `Open ${card.site.name} and pick a seat. You pay; Meridian stops before payment.`, "When the booking mail comes, this card goes away."];
}

export function planWhy(card: Extract<Card, { kind: "trip" }>) {
  const starts = new Date(card.starts);
  return `Why: your calendar has “${card.event}” on ${DAYS[starts.getDay()]} at ${clockOf(starts)}, and there is no train or flight mail for that day.`;
}

// ── When it comes back ──────────────────────────────────────────────────────

/** Not now's choices: later today, tomorrow morning, and Monday when that is not tomorrow. */
export function laterOptions(now: Date): { label: string; until: number }[] {
  const at = (days: number, hour: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour).getTime();
  const out: { label: string; until: number }[] = [];
  if (now.getHours() < 15) out.push({ label: "Later today, 4 pm", until: at(0, 16) });
  else if (now.getHours() < 19) out.push({ label: "This evening, 8 pm", until: at(0, 20) });
  out.push({ label: "Tomorrow morning", until: at(1, 9) });
  const toMonday = (8 - now.getDay()) % 7 || 7;
  if (toMonday > 1) out.push({ label: toMonday === 7 ? "Next Monday" : "Monday", until: at(toMonday, 9) });
  return out;
}

/** 8 pm, or the next hour once it is later than that. */
export function tonight(now: Date) {
  const hour = Math.max(20, now.getHours() + 1);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour);
}

/** A wall-clock time with no zone, as a reminder of the user's own is kept. */
const wallClock = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:00`;

// ── What the buttons do ─────────────────────────────────────────────────────

export async function refreshCards() {
  setCards(await bridge.cardsState());
}

/** Gmail and the calendar are read through Claude Code, and never in local-only mode. */
export const canCheck = (s: Pick<AppState, "settings" | "agents">) =>
  !s.settings.localOnly && s.agents.some((a) => a.id === "claude-code" && a.installed) && (s.settings.myDay.replies || s.settings.myDay.renewals || s.settings.myDay.trips);

/** The morning check, or Try again. Drafts and plans are written with the AI Chat is on. */
export async function checkCards(morning = false) {
  const s = getState();
  if (!canCheck(s) || s.cards.checking) return;
  try {
    const engine = (await chatEngine()) ?? {};
    const summary = await bridge.cardsCheck(engine, morning);
    await refreshCards();
    if (summary) showMorningLine();
  } catch (err) {
    await refreshCards();
    // The morning check is nobody's click, so it fails quietly. My Day still says which source is missing.
    if (!morning) pushError({ title: "Could not check My Day", body: err instanceof Error ? err.message : String(err) });
  }
}

/** One line on the island. Pointed at, it lists the cards. Nothing on it approves anything. */
export function showMorningLine(now = new Date()) {
  const cards = getState().cards.cards;
  if (cards.length === 0) return;
  dismissNotice("morning");
  pushNotice({ id: "morning", tone: "info", title: needsYou(cards.length), body: shortDate(now), cards: cards.slice(0, 3).map((card) => cardLine(card, now)) }, MORNING_MS);
}

/** A line on the island opens its card in My Day. */
export function openCard(id: string | null) {
  dismissNotice("morning");
  setCardFocus(id);
  openPanel("day");
}

export async function hideCard(id: string, until: number) {
  await bridge.cardsHide(id, until);
  await refreshCards();
}

export async function dismissCard(id: string, dismissed = true) {
  await bridge.cardsDismiss(id, dismissed);
  await refreshCards();
}

/** Dismiss's second offer: no more cards of that kind. Settings › My day turns them back on. */
export async function stopKind(kind: CardKind) {
  const myDay = getState().settings.myDay;
  await updateSettings({ myDay: { ...myDay, [KINDS[kind].setting]: false } });
  await refreshCards();
}

/** A reminder of the user's own tonight, and the card waits until then. Returns when. */
export async function remindTonight(card: Card, now = new Date()) {
  const at = tonight(now);
  await addReminder(cardTitle(card, now), { kind: "naive", value: wallClock(at) });
  await hideCard(card.id, at.getTime());
  return at;
}

/** The draft, written now when the check did not get to it. */
export async function draftOf(card: Extract<Card, { kind: "reply" }>) {
  if (card.draft) return card.draft;
  const engine = await chatEngine();
  if (!engine) throw new Error("No AI is ready. Add one in Settings, AI models.");
  const draft = await bridge.cardsDraft(card.id, engine);
  await refreshCards();
  return draft;
}

/** Opens the thread, and hands the draft to Write here, which puts it in the reply box. The user presses Send. */
export async function openInGmail(card: Extract<Card, { kind: "reply" }>, draft = card.draft) {
  if (card.link) openLink(card.link);
  const text = draft ?? (await draftOf(card).catch(() => null));
  if (text) offerDraft(text);
}

export function wireCards() {
  void bridge.onCardsChanged(() => void refreshCards());
  void bridge.onCardsDue(() => void checkCards(true));
  void refreshCards();
}
