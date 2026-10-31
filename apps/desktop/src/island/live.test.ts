import { describe, expect, it } from "vitest";
import type { ContextEvent } from "../lib/types";
import { focusActivity, liveFrom, pickLive, span } from "./live";

const MIN = 60_000;
const departs = new Date("2026-11-02T14:00:00Z").getTime();
const arrives = departs + 120 * MIN;

const event = (over: Partial<ContextEvent>): ContextEvent => ({
  id: "e",
  kind: "flight",
  source: "email",
  occurredAt: "2026-10-30T09:00:00Z",
  startsAt: { kind: "zoned", value: new Date(departs).toISOString() },
  endsAt: { kind: "zoned", value: new Date(arrives).toISOString() },
  title: "Flight 6E 2341 DEL → BOM",
  body: null,
  metadata: { flightNumber: "6E2341", departureAirport: "DEL", arrivalAirport: "BOM" },
  confidence: 0.95,
  priority: "important",
  status: "active",
  suggestedActions: [],
  expiresAt: null,
  dedupeKey: "e",
  sourceRef: null,
  userEdited: false,
  revision: 1,
  changedFields: [],
  snoozedUntil: null,
  ...over,
});

describe("a flight", () => {
  const at = (minutes: number) => liveFrom(event({}), departs + minutes * MIN);

  it("stays away until three hours before", () => {
    expect(at(-181)).toBeNull();
    expect(at(-179)?.status).toBe("Leave for the airport");
  });

  it("counts down to the gate, then boarding, which is urgent", () => {
    expect(at(-50)?.status).toBe("Head to your gate");
    expect(at(-50)?.urgent).toBe(false);
    expect(at(-30)?.status).toBe("Boarding soon");
    expect(at(-30)?.urgent).toBe(true);
    expect(at(-30)?.right).toBe("30m");
  });

  it("shows the time left to landing and moves along the route", () => {
    const air = at(45)!;
    expect(air.status).toBe("In the air");
    expect(air.big).toBe("1h 15m to landing");
    expect(air.route?.progress).toBeCloseTo(0.375, 2);
    expect(air.left).toBe("38%");
  });

  it("says it is an estimate, because no live feed is behind it", () => {
    expect(at(45)?.foot).toContain("schedule");
  });

  it("becomes urgent as it descends, lands, then goes away", () => {
    expect(at(100)?.status).toBe("About to land");
    expect(at(100)?.urgent).toBe(true);
    expect(at(125)?.big).toBe("Landed");
    expect(at(140)).toBeNull();
  });

  it("goes quiet in the air when the email gave no arrival time", () => {
    expect(liveFrom(event({ endsAt: null }), departs + 10 * MIN)).toBeNull();
  });

  it("says so when it is cancelled, and when the time moved", () => {
    expect(liveFrom(event({ status: "cancelled" }), departs - 60 * MIN)?.right).toBe("Cancelled");
    const moved = liveFrom(event({ status: "updated", changedFields: ["startsAt"] }), departs - 120 * MIN);
    expect(moved?.status).toBe("Your flight time changed");
    expect(moved?.urgent).toBe(true);
  });

  it("stops saying it was cancelled once it would have left", () => {
    expect(liveFrom(event({ status: "cancelled" }), departs + MIN)).toBeNull();
  });
});

describe("a parcel", () => {
  const parcel = (deliveryStatus: string) => event({ kind: "delivery", endsAt: null, metadata: { deliveryStatus, carrier: "Delhivery" } });
  const now = new Date("2026-10-30T10:00:00Z").getTime();

  it("shows only on the day it arrives", () => {
    expect(liveFrom(parcel("In transit"), now)).toBeNull();
    const out = liveFrom(parcel("Out for delivery"), now)!;
    expect(out.steps).toEqual({ count: 4, at: 2 });
    expect(out.who).toBe("Delhivery");
  });

  it("flags a problem, and leaves an hour after delivery", () => {
    expect(liveFrom(parcel("Delivery problem"), now)?.urgent).toBe(true);
    expect(liveFrom(parcel("Delivered"), now)?.steps?.at).toBe(3);
    expect(liveFrom(parcel("Delivered"), now + 3 * 60 * MIN)).toBeNull();
  });

  it("does not sit on the island for days when no later email comes", () => {
    const later = now + 24 * 60 * MIN;
    expect(liveFrom(parcel("Out for delivery"), later)).toBeNull();
    expect(liveFrom(parcel("Delivery problem"), later)).toBeNull();
  });
});

describe("a meeting", () => {
  const meeting = event({ kind: "meeting", title: "Design review", suggestedActions: [{ label: "Join", actionId: "join", url: "https://meet.example/x" }] });

  it("appears ten minutes before and offers Join", () => {
    expect(liveFrom(meeting, departs - 11 * MIN)).toBeNull();
    const soon = liveFrom(meeting, departs - 4 * MIN)!;
    expect(soon.right).toBe("4m");
    expect(soon.urgent).toBe(true);
    expect(soon.action?.url).toBe("https://meet.example/x");
  });

  it("leaves five minutes after it starts", () => {
    expect(liveFrom(meeting, departs + 2 * MIN)?.right).toBe("Now");
    expect(liveFrom(meeting, departs + 6 * MIN)).toBeNull();
  });
});

describe("the rest", () => {
  it("skips anything dismissed or snoozed", () => {
    expect(liveFrom(event({ status: "dismissed" }), departs - 30 * MIN)).toBeNull();
    expect(liveFrom(event({ snoozedUntil: "2026-11-02T15:00:00Z" }), departs - 30 * MIN)).toBeNull();
  });

  it("comes back when a snooze ends", () => {
    expect(liveFrom(event({ snoozedUntil: "2026-11-02T13:15:00Z" }), departs - 30 * MIN)?.status).toBe("Boarding soon");
  });

  it("puts urgent activities first", () => {
    const later = event({ id: "later", startsAt: { kind: "zoned", value: new Date(departs + 100 * MIN).toISOString() }, endsAt: null });
    const now = departs - 20 * MIN;
    expect(pickLive([later, event({ id: "soon" })], now).map((a) => a.id)).toEqual(["soon", "later"]);
  });

  it("writes spans the way a person reads them", () => {
    expect(span(30_000)).toBe("1m");
    expect(span(0)).toBe("now");
    expect(span(78 * MIN)).toBe("1h 18m");
  });

  it("counts a focus timer in minutes and seconds", () => {
    const focus = focusActivity(1_000_000 + 24 * MIN + 18_000, 25, 1_000_000);
    expect(focus.right).toBe("24:18");
  });
});
