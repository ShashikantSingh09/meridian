// Live activities: things with a clear start and end, followed on the island while they
// happen. Pure functions of an event and the time, so every stage is covered by
// live.test.ts. Times come from what the source stated. Nothing here is a live feed, so
// wording says "scheduled" where a real flight may differ.

import type { ContextEvent, EventTime } from "../lib/types";

export interface LiveActivity {
  id: string;
  kind: "flight" | "delivery" | "meeting" | "ticket" | "timer";
  /** Design token of its colour. */
  tone: string;
  /** The small view: one side, then the other. */
  left: string;
  right: string;
  /** Under three characters, for the bubble beside the island. */
  short: string;
  status: string;
  big: string;
  who: string;
  detail: string;
  foot: string;
  steps?: { count: number; at: number };
  route?: { from: string; to: string; progress: number };
  action?: { label: string; url: string };
  /** Worth taking the island from running work. */
  urgent: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const FLIGHT_LEAD = 3 * HOUR;
const GATE_LEAD = HOUR;
const BOARDING_LEAD = 40 * MINUTE;
const DESCENT = 25 * MINUTE;
const AFTER_LANDING = 15 * MINUTE;
const MEETING_LEAD = 10 * MINUTE;
const MEETING_AFTER = 5 * MINUTE;
const TICKET_LEAD = 3 * HOUR;
const DELIVERED_FOR = HOUR;
/** What one email said about a parcel stops being news, even if no later email comes. */
const PARCEL_NEWS_FOR = 8 * HOUR;

export function timeOf(time: EventTime | null): number | null {
  if (!time) return null;
  const at = new Date(time.kind === "date" ? `${time.value}T00:00:00` : time.value).getTime();
  return Number.isNaN(at) ? null : at;
}

/** 1h 18m, 25m, or under a minute. */
export function span(ms: number) {
  const minutes = Math.max(0, Math.ceil(ms / MINUTE));
  if (minutes < 1) return "now";
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const meta = (e: ContextEvent, key: string) => (typeof e.metadata[key] === "string" ? (e.metadata[key] as string) : "");
const link = (e: ContextEvent, label: string) => {
  const url = e.suggestedActions.find((a) => a.url)?.url;
  return url ? { label, url } : undefined;
};
const shortSpan = (ms: number) => {
  const minutes = Math.ceil(ms / MINUTE);
  return minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes}`;
};

function flight(e: ContextEvent, now: number): LiveActivity | null {
  const departs = timeOf(e.startsAt);
  const arrives = timeOf(e.endsAt);
  if (departs === null || now < departs - FLIGHT_LEAD) return null;
  const from = meta(e, "departureAirport") || "From";
  const to = meta(e, "arrivalAirport") || "To";
  const number = meta(e, "flightNumber") || meta(e, "airline") || "Flight";
  const base = { id: e.id, kind: "flight" as const, who: number };
  const footArrive = arrives ? `Scheduled to land ${clock(arrives)}` : "";

  if (e.status === "cancelled") {
    if (now >= departs) return null;
    return { ...base, tone: "--state-error", left: number, right: "Cancelled", short: "!", status: "Cancelled", big: "This flight was cancelled", detail: `${from} to ${to}`, foot: "From your airline's email", urgent: true };
  }
  if (now < departs) {
    const left = departs - now;
    const moved = e.status === "updated" && e.changedFields.includes("startsAt");
    if (left <= BOARDING_LEAD) {
      return { ...base, tone: "--state-waiting", left: from, right: span(left), short: shortSpan(left), status: moved ? "Your flight time changed" : "Boarding soon", big: `Departs in ${span(left)}`, detail: clock(departs), route: { from, to, progress: 0 }, foot: footArrive, urgent: true };
    }
    if (left <= GATE_LEAD) {
      return { ...base, tone: "--state-working", left: from, right: span(left), short: shortSpan(left), status: moved ? "Your flight time changed" : "Head to your gate", big: `Departs in ${span(left)}`, detail: clock(departs), route: { from, to, progress: 0 }, foot: footArrive, urgent: moved };
    }
    return { ...base, tone: "--state-working", left: from, right: `in ${span(left)}`, short: shortSpan(left), status: moved ? "Your flight time changed" : "Leave for the airport", big: `Departs in ${span(left)}`, detail: clock(departs), route: { from, to, progress: 0 }, foot: footArrive, urgent: moved };
  }
  if (arrives === null) return null;
  if (now < arrives) {
    const left = arrives - now;
    const progress = Math.min(1, (now - departs) / Math.max(MINUTE, arrives - departs));
    const descending = left <= DESCENT;
    return { ...base, tone: "--state-listening", left: `${Math.round(progress * 100)}%`, right: span(left), short: shortSpan(left), status: descending ? "About to land" : "In the air", big: `${span(left)} to landing`, detail: `Lands ${clock(arrives)}`, route: { from, to, progress }, foot: "Estimated from the schedule", urgent: descending };
  }
  if (now < arrives + AFTER_LANDING) {
    return { ...base, tone: "--state-success", left: "Landed", right: to, short: "ok", status: `Welcome to ${to}`, big: "Landed", detail: `Scheduled ${clock(arrives)}`, route: { from, to, progress: 1 }, foot: "Estimated from the schedule", urgent: false };
  }
  return null;
}

const DELIVERY_STEP: Record<string, number> = { shipped: 1, "in transit": 1, "out for delivery": 2, delivered: 3 };

function delivery(e: ContextEvent, now: number): LiveActivity | null {
  const status = meta(e, "deliveryStatus").toLowerCase();
  const carrier = meta(e, "carrier") || "Parcel";
  const arrives = timeOf(e.endsAt);
  const base = { id: e.id, kind: "delivery" as const, who: carrier, action: link(e, "Track") };
  if (now - new Date(e.occurredAt).getTime() > (status === "delivered" ? DELIVERED_FOR : PARCEL_NEWS_FOR)) return null;
  if (status === "delivery problem") {
    return { ...base, tone: "--state-error", left: carrier, right: "Problem", short: "!", status: "Delivery problem", big: "Your parcel needs attention", detail: e.title, foot: "Ordered, shipped, out for delivery, delivered", steps: { count: 4, at: 2 }, urgent: true };
  }
  if (status === "delivered") {
    return { ...base, tone: "--state-success", left: carrier, right: "Delivered", short: "ok", status: "Delivered", big: "Your parcel has arrived", detail: e.title, foot: "Ordered, shipped, out for delivery, delivered", steps: { count: 4, at: 3 }, urgent: false };
  }
  // A parcel in transit for days should not sit on the island for days.
  if (status !== "out for delivery") return null;
  const by = arrives ? `Arrives by ${clock(arrives)}` : "Arrives today";
  return { ...base, tone: "--state-waiting", left: "Out for delivery", right: "Today", short: "go", status: "Out for delivery", big: by, detail: carrier, foot: "Ordered, shipped, out for delivery, delivered", steps: { count: 4, at: DELIVERY_STEP[status] }, urgent: false };
}

function meeting(e: ContextEvent, now: number): LiveActivity | null {
  const at = timeOf(e.startsAt);
  if (at === null || e.status === "cancelled" || now < at - MEETING_LEAD || now > at + MEETING_AFTER) return null;
  const left = at - now;
  const started = left <= 0;
  return {
    id: e.id,
    kind: "meeting",
    tone: "--state-thinking",
    left: e.title,
    right: started ? "Now" : span(left),
    short: started ? "go" : shortSpan(left),
    status: started ? "Started" : `Starts in ${span(left)}`,
    big: e.title,
    who: "Calendar",
    detail: clock(at),
    foot: e.body ?? "",
    action: link(e, "Join"),
    urgent: left <= 5 * MINUTE,
  };
}

function ticket(e: ContextEvent, now: number): LiveActivity | null {
  const at = timeOf(e.startsAt);
  if (at === null || e.status === "cancelled" || now < at - TICKET_LEAD || now > at) return null;
  const left = at - now;
  return { id: e.id, kind: "ticket", tone: "--state-notice", left: e.title, right: span(left), short: shortSpan(left), status: `Starts in ${span(left)}`, big: e.title, who: meta(e, "venue") || "Today", detail: clock(at), foot: meta(e, "address"), action: link(e, "Open"), urgent: false };
}

export function focusActivity(endsAt: number, minutes: number, now: number): LiveActivity {
  const left = Math.max(0, endsAt - now);
  const whole = Math.ceil(left / 1000);
  const time = `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  return {
    id: "focus",
    kind: "timer",
    tone: "--state-waiting",
    left: "Focus",
    right: time,
    short: `${Math.ceil(left / MINUTE)}`,
    status: "Focus time",
    big: `${time} left`,
    who: "Focus",
    detail: `${minutes} min`,
    foot: "Click to open",
    route: undefined,
    urgent: false,
  };
}

export function liveFrom(event: ContextEvent, now: number): LiveActivity | null {
  if (event.status === "dismissed" || (event.snoozedUntil && new Date(event.snoozedUntil).getTime() > now)) return null;
  switch (event.kind) {
    case "flight":
      return flight(event, now);
    case "delivery":
      return delivery(event, now);
    case "meeting":
      return meeting(event, now);
    case "eventTicket":
    case "restaurant":
    case "appointment":
      return ticket(event, now);
    default:
      return null;
  }
}

/** Urgent first. The rest keep their order, which is soonest first from the store. */
export function pickLive(events: ContextEvent[], now: number): LiveActivity[] {
  const found = events.map((e) => liveFrom(e, now)).filter((a): a is LiveActivity => a !== null);
  return [...found.filter((a) => a.urgent), ...found.filter((a) => !a.urgent)];
}
