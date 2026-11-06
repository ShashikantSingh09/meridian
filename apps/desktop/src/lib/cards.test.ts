import { describe, expect, it } from "vitest";
import { cardLine, cardTag, cardText, cardTitle, clockOf, daySummary, failureLine, laterOptions, laterToday, longDate, meetingsToday, needsYou, parcelsOnTheWay, planSteps, planWhy, tonight } from "./cards";
import type { Card, ContextEvent } from "./types";

/** Friday 6 November 2026, 9:41 am, as on the board. */
const NOW = new Date(2026, 10, 6, 9, 41);
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();

const carl: Card = { kind: "reply", id: "reply:19d4", seen: at(3, 10, 12), link: "https://mail.google.com/mail/#all/19d4", hiddenUntil: null, who: "Carl Mendes", address: "carl@brightline.example", subject: "October invoice", asked: "the October invoice", draft: "Hi Carl," };
const netflix: Card = { kind: "renewal", id: "renewal:netflix:2026-11-07", seen: new Date(2026, 9, 7, 8).toISOString(), link: null, hiddenUntil: null, service: "Netflix", amount: "₹649", on: "2026-11-07", period: "month", trial: false, receipt: true };
const pune: Card = {
  kind: "trip", id: "trip:e7:2026-11-10", seen: at(10, 14), link: null, hiddenUntil: null, event: "Pune office visit", starts: at(10, 14), location: "Pune office, Baner, Pune",
  place: "the Pune office", title: "Book a train to Pune?", step: "Take a morning train.", site: { name: "IRCTC", url: "https://www.irctc.co.in/" }, planned: true,
};

describe("how a card reads", () => {
  it("says where it came from and how old it is, as on the board", () => {
    expect(cardTag(carl, NOW)).toBe("Gmail · waiting 3 days");
    expect(cardTag(netflix, NOW)).toBe("From a receipt in Gmail, 7 Oct");
    expect(cardTag({ ...netflix, receipt: false }, NOW)).toBe("From Gmail, 7 Oct");
    expect(cardTag(pune, NOW)).toBe("Calendar · Tue 10 Nov");
  });

  it("gives the board's titles and lines", () => {
    expect(cardTitle(carl, NOW)).toBe("Reply to Carl");
    expect(cardText(carl, NOW)).toBe("Asked about the October invoice on Tuesday. A draft is ready.");
    expect(cardTitle(netflix, NOW)).toBe("Netflix renews tomorrow — ₹649");
    expect(cardText(netflix, NOW)).toBe("Monthly plan. Cancel before tomorrow if you no longer want it.");
    expect(cardTitle(pune, NOW)).toBe("Book a train to Pune?");
    expect(cardText(pune, NOW)).toBe("Your 2 pm at the Pune office has no travel booked. A plan is ready.");
  });

  it("says no draft is ready until one is, and names the subject when nothing was asked", () => {
    expect(cardText({ ...carl, draft: null }, NOW)).toBe("Asked about the October invoice on Tuesday.");
    expect(cardText({ ...carl, asked: "", draft: null, seen: at(5, 9) }, NOW)).toBe("Wrote yesterday about “October invoice”.");
    expect(cardText({ ...carl, draft: null, seen: new Date(2026, 9, 28, 9).toISOString() }, NOW)).toBe("Asked about the October invoice on 28 Oct.");
  });

  it("words a trial and a renewal further off", () => {
    const trial: Card = { ...netflix, service: "Canva", trial: true, period: null, on: "2026-11-09", amount: null };
    expect(cardTitle(trial, NOW)).toBe("Canva trial ends Monday");
    expect(cardText(trial, NOW)).toBe("Free trial. Cancel before Monday if you do not want to pay.");
    expect(cardText({ ...netflix, on: "2026-11-06", period: null }, NOW)).toBe("Cancel today if you no longer want it.");
    expect(cardTitle({ ...netflix, on: "2026-11-20", amount: null }, NOW)).toBe("Netflix renews on 20 Nov");
  });

  it("keeps the island's lines short, with what matters at the end", () => {
    expect([carl, netflix, pune].map((card) => cardLine(card, NOW))).toEqual([
      { id: "reply:19d4", kind: "reply", title: "Reply to Carl", meta: "waiting 3 days" },
      { id: "renewal:netflix:2026-11-07", kind: "renewal", title: "Netflix renews tomorrow", meta: "₹649" },
      { id: "trip:e7:2026-11-10", kind: "trip", title: "Book a train to Pune?", meta: "Tue" },
    ]);
    expect(needsYou(3)).toBe("3 things need you today");
    expect(needsYou(1)).toBe("1 thing needs you today");
  });

  it("lays out the plan with the last step left to the user", () => {
    expect(planSteps(pune as Extract<Card, { kind: "trip" }>)).toEqual(["Take a morning train.", "Open IRCTC and pick a seat. You pay; Meridian stops before payment.", "When the booking mail comes, this card goes away."]);
    expect(planWhy(pune as Extract<Card, { kind: "trip" }>)).toBe("Why: your calendar has “Pune office visit” on Tue at 2 pm, and there is no train or flight mail for that day.");
  });
});

const event = (id: string, kind: string, starts: string | null, over: Partial<ContextEvent> = {}): ContextEvent => ({
  id, kind, source: "calendar", occurredAt: at(1, 9), startsAt: starts ? { kind: "zoned", value: starts } : null, endsAt: null, title: id, body: null, metadata: {},
  confidence: 1, priority: "important", status: "active", suggestedActions: [], expiresAt: null, dedupeKey: id, sourceRef: null, userEdited: false, revision: 1, changedFields: [], snoozedUntil: null, ...over,
});

describe("the day", () => {
  it("sums up the day as the board does", () => {
    expect(longDate(NOW)).toBe("Friday, 6 Nov");
    expect(daySummary(3, 2, 1)).toBe("3 things need you. 2 meetings, and a parcel on the way.");
    expect(daySummary(0, 1, 0)).toBe("1 meeting.");
    expect(daySummary(1, 0, 3)).toBe("1 thing needs you. 3 parcels on the way.");
    expect(daySummary(0, 0, 0)).toBe("");
  });

  it("counts today's meetings and the parcels still coming", () => {
    const events = [
      event("Design review with Asha", "meeting", at(6, 11)),
      event("Call with Carl", "meeting", at(6, 16, 30)),
      event("Moved", "meeting", at(6, 12), { status: "cancelled" }),
      event("Tomorrow", "meeting", at(7, 10)),
      event("Parcel", "delivery", null, { metadata: { deliveryStatus: "In transit" } }),
      event("Arrived", "delivery", null, { metadata: { deliveryStatus: "Delivered" } }),
    ];
    expect(meetingsToday(events, NOW)).toBe(2);
    expect(parcelsOnTheWay(events)).toBe(1);
  });

  it("lists what is still ahead today at a set time, and where", () => {
    const events = [
      event("Call with Carl", "meeting", at(6, 16, 30), { metadata: { location: "Phone" } }),
      event("Design review with Asha", "meeting", at(6, 11), { suggestedActions: [{ label: "Join", actionId: "join", url: "https://meet.google.com/abc" }] }),
      event("Stand-up", "meeting", at(6, 9)),
      event("Flight", "flight", at(6, 18)),
      event("Dentist", "appointment", at(7, 10)),
    ];
    expect(laterToday(events, NOW)).toEqual([
      { id: "Design review with Asha", time: "11:00 am", title: "Design review with Asha", where: "Google Meet" },
      { id: "Call with Carl", time: "4:30 pm", title: "Call with Carl", where: "Phone" },
    ]);
    expect(clockOf(new Date(2026, 10, 6, 0, 5))).toBe("12:05 am");
  });

  it("names a source that could not be read, and why when it knows", () => {
    expect(failureLine({ source: "gmail", why: "Claude Code is signed out" }, NOW)).toBe("Could not check Gmail this morning, because Claude Code is signed out. Cards from mail may be missing.");
    expect(failureLine({ source: "calendar", why: "" }, new Date(2026, 10, 6, 14))).toBe("Could not check Google Calendar today. Cards from your calendar may be missing.");
  });
});

describe("when a card comes back", () => {
  it("offers later today, tomorrow morning and Monday on a Friday morning", () => {
    expect(laterOptions(NOW)).toEqual([
      { label: "Later today, 4 pm", until: new Date(2026, 10, 6, 16).getTime() },
      { label: "Tomorrow morning", until: new Date(2026, 10, 7, 9).getTime() },
      { label: "Monday", until: new Date(2026, 10, 9, 9).getTime() },
    ]);
  });

  it("moves to the evening in the afternoon, drops later today at night, and never offers Monday twice", () => {
    expect(laterOptions(new Date(2026, 10, 6, 16)).map((o) => o.label)).toEqual(["This evening, 8 pm", "Tomorrow morning", "Monday"]);
    expect(laterOptions(new Date(2026, 10, 6, 21)).map((o) => o.label)).toEqual(["Tomorrow morning", "Monday"]);
    // On a Sunday, tomorrow morning is Monday already.
    expect(laterOptions(new Date(2026, 10, 8, 10)).map((o) => o.label)).toEqual(["Later today, 4 pm", "Tomorrow morning"]);
    const monday = laterOptions(new Date(2026, 10, 9, 10));
    expect(monday.at(-1)).toEqual({ label: "Next Monday", until: new Date(2026, 10, 16, 9).getTime() });
  });

  it("reminds tonight at 8 pm, or the next hour once it is later", () => {
    expect(tonight(NOW)).toEqual(new Date(2026, 10, 6, 20));
    expect(tonight(new Date(2026, 10, 6, 21, 15))).toEqual(new Date(2026, 10, 6, 22));
  });
});
