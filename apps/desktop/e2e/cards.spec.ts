import { expect, test, type Page } from "@playwright/test";

// The board "Cards you can act on", against the browser stand-in for the core. What counts as a card
// is tested in cards.rs. These check what the user sees and what each button does.

type Kind = "reply" | "renewal" | "trip";
type Mock = {
  seedCards(kinds?: Kind[]): void;
  nextCheck(kinds: Kind[], failures?: { source: string; why: string }[]): void;
  cardsDue(): void;
  cardChecks(): number;
  openedUrls(): string[];
  addEvent(id: string, title: string, kind: string, over?: object): void;
  tellCards(): void;
};
type Meridian = {
  setHovered(on: boolean): void;
  openPanel(tab?: string): void;
  closePanel(): void;
  updateSettings(patch: object): Promise<void>;
  getState(): { cards: { checkedAt: number | null }; offeredDraft: { text: string } | null; settings: { myDay: Record<string, boolean> }; notices: { id: string; title: string; body: string }[]; activity: { all: { title: string; startsAt: { value: string } }[] } };
};
const meridian = <T,>(page: Page, run: (m: Meridian, mock: Mock) => T | Promise<T>) => page.evaluate(`(${run.toString()})(window.__meridian, window.__mock)`) as Promise<T>;
const island = (page: Page) => page.locator(".island");
const card = (page: Page, title: string) => page.locator(".day-card", { hasText: title });
const dockDay = (page: Page) => page.locator(".dock").getByRole("button", { name: "My day" });
const settingsDay = (page: Page) => page.locator(".settings-tab", { hasText: "My day" });
const checked = (page: Page) => expect.poll(() => meridian(page, (m) => m.getState().cards.checkedAt)).not.toBeNull();

/** India, on Friday 6 November 2026 at 9:41 am, as the board is drawn. */
test.use({ timezoneId: "Asia/Kolkata" });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-06T09:41:00+05:30"));
  // Kept on the page, so a test never touches the clipboard of the PC it runs on.
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => void Object.assign(window, { __copied: text }) } }));
  await page.goto("/");
  await page.waitForFunction(() => "__meridian" in window);
});

/** The day the board draws: the three cards, two meetings ahead and a parcel on the way. */
async function boardDay(page: Page) {
  await meridian(page, (_, mock) => {
    mock.addEvent("m1", "Design review with Asha", "meeting", { startsAt: { kind: "zoned", value: "2026-11-06T11:00:00+05:30" }, suggestedActions: [{ label: "Join", actionId: "join", url: "https://meet.google.com/abc" }] });
    mock.addEvent("m2", "Call with Carl", "meeting", { startsAt: { kind: "zoned", value: "2026-11-06T16:30:00+05:30" }, metadata: { location: "Phone" } });
    mock.seedCards();
  });
}

async function openMyDay(page: Page) {
  await meridian(page, (m) => m.openPanel("day"));
  await expect(page.locator(".day-head h2")).toHaveText("Friday, 6 Nov");
}

test("the morning line says how many things need you, once, and opens My Day", async ({ page }) => {
  await meridian(page, (_, mock) => mock.cardsDue());
  await expect(island(page)).toHaveAttribute("data-view", "notification");
  await expect(island(page)).toContainText("3 things need you today");
  await expect(island(page).getByRole("button", { name: "See" })).toBeVisible();
  expect(await meridian(page, (_, mock) => mock.cardChecks())).toBe(1);

  // The same day, a second check finds the same, and the island stays quiet.
  await island(page).getByRole("button", { name: "See" }).click();
  await expect(page.locator(".panel-head h1")).toHaveText("My day");
  await meridian(page, (m) => m.closePanel());
  await meridian(page, (_, mock) => mock.cardsDue());
  await expect.poll(() => meridian(page, (_, mock) => mock.cardChecks())).toBe(2);
  await expect(island(page)).not.toHaveAttribute("data-view", "notification");
});

test("pointed at, the morning line lists the three, and a line opens its card in My Day", async ({ page }) => {
  await meridian(page, (_, mock) => mock.cardsDue());
  await expect(island(page)).toContainText("3 things need you today");
  await meridian(page, (m) => m.setHovered(true));
  const lines = island(page).locator(".morning-line");
  await expect(lines).toHaveCount(3);
  await expect(lines.nth(0)).toHaveText("Reply to Carlwaiting 3 days");
  await expect(lines.nth(1)).toHaveText("Netflix renews tomorrow₹649");
  await expect(lines.nth(2)).toHaveText("Book a train to Pune?Tue");
  await expect(island(page)).toContainText("Fri, 6 Nov");
  await expect(island(page).getByRole("button", { name: "Close" })).toBeVisible();
  // Nothing is approved from the island: no draft, no plan, no reminder.
  await expect(island(page).getByRole("button", { name: /draft|plan|Remind|Gmail/ })).toHaveCount(0);

  await lines.nth(1).click();
  await expect(page.locator(".panel-head h1")).toHaveText("My day");
  await expect(card(page, "Netflix renews tomorrow")).toHaveAttribute("data-focus", "true");
});

test("Close puts the morning line away, and the cards wait in My Day", async ({ page }) => {
  await meridian(page, (_, mock) => mock.cardsDue());
  await meridian(page, (m) => m.setHovered(true));
  await island(page).getByRole("button", { name: "Close" }).click();
  await meridian(page, (m) => m.setHovered(false));
  await expect(island(page)).toHaveAttribute("data-view", "idle");
  await openMyDay(page);
  await expect(page.locator(".day-card")).toHaveCount(3);
});

test("My Day opens on the day, what needs you and what is later today, with a count in the dock", async ({ page }) => {
  await boardDay(page);
  await openMyDay(page);
  await expect(page.locator(".day-head .meta")).toHaveText("3 things need you. 2 meetings, and a parcel on the way.");
  await expect(page.locator(".day-h").first()).toHaveText("Needs you · 3");
  await expect(dockDay(page).locator(".badge")).toHaveText("3");

  const carl = card(page, "Reply to Carl");
  await expect(carl.locator(".day-tag")).toHaveText("Gmail · waiting 3 days");
  await expect(carl.locator(".day-card-text")).toHaveText("Asked about the October invoice on Tuesday. A draft is ready.");
  await expect(carl.getByRole("button")).toHaveText(["Read the draft", "Open in Gmail", "Not now", ""]);
  await expect(carl.getByRole("button", { name: "Dismiss" })).toBeVisible();

  const netflix = card(page, "Netflix");
  await expect(netflix.locator(".day-tag")).toHaveText("From a receipt in Gmail, 7 Oct");
  await expect(netflix.locator(".day-card-title")).toHaveText("Netflix renews tomorrow — ₹649");
  await expect(netflix.locator(".day-card-text")).toHaveText("Monthly plan. Cancel before tomorrow if you no longer want it.");
  await expect(netflix.getByRole("button")).toHaveText(["Remind me tonight", "Open", "Not now", ""]);

  const pune = card(page, "Pune");
  await expect(pune.locator(".day-tag")).toHaveText("Calendar · Tue 10 Nov");
  await expect(pune.locator(".day-card-text")).toHaveText("Your 2 pm at the Pune office has no travel booked. A plan is ready.");
  await expect(pune.getByRole("button")).toHaveText(["See the plan", "Not now", ""]);

  await expect(page.locator(".day-later")).toHaveText(["11:00 amDesign review with AshaGoogle Meet", "4:30 pmCall with CarlPhone"]);
});

test("Read the draft shows the draft and what it was written from, and Open in Gmail hands it to Write here", async ({ page }) => {
  await boardDay(page);
  await openMyDay(page);
  await card(page, "Reply to Carl").getByRole("button", { name: "Read the draft" }).click();
  const sheet = page.getByRole("dialog", { name: "Reply to Carl" });
  await expect(sheet).toContainText("Draft · not sent");
  await expect(sheet).toContainText("To Carl Mendes · Re: October invoice");
  await expect(sheet.locator(".day-draft")).toHaveText("Hi Carl,\nSorry for the slow reply. I'll send the October invoice today, so you have it well before Friday's close.\nThanks,\nRavi");
  await expect(sheet).toContainText("Written from Carl's mail of 3 Nov.");
  await expect(sheet.locator(".day-info")).toHaveText("Meridian does not send this. Open in Gmail opens the thread, and Write here puts the draft in the reply box. You press Send.");

  await sheet.getByRole("button", { name: "Copy" }).click();
  await expect(sheet.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => (window as never as { __copied: string }).__copied)).toContain("Hi Carl,");

  await sheet.getByRole("button", { name: "Change it" }).click();
  await sheet.getByLabel("Draft").fill("Hi Carl,\nSent it just now.\nRavi");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet.locator(".day-draft")).toHaveText("Hi Carl,\nSent it just now.\nRavi");

  await sheet.getByRole("button", { name: "Open in Gmail" }).click();
  await expect(sheet).toHaveCount(0);
  expect(await meridian(page, (_, mock) => mock.openedUrls())).toEqual(["https://mail.google.com/mail/#all/19d4"]);
  expect(await meridian(page, (m) => m.getState().offeredDraft?.text)).toBe("Hi Carl,\nSent it just now.\nRavi");
  // Meridian sends nothing: the island says what to do, once the panel is away.
  await meridian(page, (m) => m.closePanel());
  await expect(island(page)).toContainText("Click in the reply box, then press Ctrl Alt F");
  await expect(island(page)).toContainText("The draft goes in. You press Send.");

  // Ctrl Alt F puts that draft in as it is, once, rather than writing a new reply.
  await page.evaluate(() => {
    const app = (window as never as { __meridian: { getState(): { settings: { fill: object } }; updateSettings(s: object): Promise<void> } }).__meridian;
    return app.updateSettings({ fill: { ...app.getState().settings.fill, on: true } });
  });
  await meridian(page, (_, mock) => (mock.pressHereKey as () => void)());
  await expect(island(page)).toContainText("Written here · not sent");
  const starts = (await meridian(page, (_, mock) => (mock.hereCalls as () => string[])())) as string[];
  expect(starts).toEqual([`start ${JSON.stringify({ instruction: null, text: "Hi Carl,\nSent it just now.\nRavi", allow: null, window: null })}`]);
  expect(await meridian(page, (m) => m.getState().offeredDraft)).toBeNull();
});

test("Escape closes a sheet and leaves My Day open", async ({ page }) => {
  await boardDay(page);
  await openMyDay(page);
  await card(page, "Reply to Carl").getByRole("button", { name: "Read the draft" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".panel")).toBeVisible();
});

test("See the plan is a plan, not a booking, and Open IRCTC only opens the site", async ({ page }) => {
  await boardDay(page);
  await openMyDay(page);
  await card(page, "Pune").getByRole("button", { name: "See the plan" }).click();
  const sheet = page.getByRole("dialog", { name: "Book a train to Pune?" });
  await expect(sheet).toContainText("Tue 10 Nov");
  await expect(sheet.locator(".day-steps li")).toHaveText([
    "1Take a morning train from Mumbai that gets in before noon, which leaves time before your 2 pm.",
    "2Open IRCTC and pick a seat. You pay; Meridian stops before payment.",
    "3When the booking mail comes, this card goes away.",
  ]);
  await expect(sheet).toContainText("Why: your calendar has “Pune office visit” on Tue at 2 pm, and there is no train or flight mail for that day.");
  await sheet.getByRole("button", { name: "Open IRCTC" }).click();
  expect(await meridian(page, (_, mock) => mock.openedUrls())).toEqual(["https://www.irctc.co.in/"]);
  await expect(card(page, "Pune")).toBeVisible();
});

test("Not now asks when to bring a card back, and hides it until then", async ({ page }) => {
  await boardDay(page);
  await openMyDay(page);
  await card(page, "Reply to Carl").getByRole("button", { name: "Not now" }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["Later today, 4 pm", "Tomorrow morning", "Monday"]);
  await page.getByRole("menuitem", { name: "Later today, 4 pm" }).click();
  await expect(card(page, "Reply to Carl")).toHaveCount(0);
  await expect(page.locator(".day-h").first()).toHaveText("Needs you · 2");

  // At 4 pm the core says it is back.
  await page.clock.setFixedTime(new Date("2026-11-06T16:00:00+05:30"));
  await meridian(page, (_, mock) => mock.tellCards());
  await expect(card(page, "Reply to Carl")).toBeVisible();
});

test("Dismiss shows Undo for a few seconds, and a way to stop cards of that kind", async ({ page }) => {
  await boardDay(page);
  await openMyDay(page);
  await card(page, "Netflix").getByRole("button", { name: "Dismiss" }).click();
  const toast = page.locator(".day-toast");
  await expect(toast).toContainText("Dismissed “Netflix renews tomorrow”");
  await expect(card(page, "Netflix")).toHaveCount(0);
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(card(page, "Netflix")).toBeVisible();

  await card(page, "Netflix").getByRole("button", { name: "Dismiss" }).click();
  await toast.getByRole("button", { name: "No more renewal cards" }).click();
  expect(await meridian(page, (m) => m.getState().settings.myDay)).toEqual({ replies: true, renewals: false, trips: true, summary: true });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settingsDay(page).click();
  await expect(page.getByRole("switch", { name: "Renewals and free trials" })).not.toBeChecked();
});

test("Remind me tonight adds a reminder at 8 pm and the card waits until then", async ({ page }) => {
  await boardDay(page);
  await openMyDay(page);
  await card(page, "Netflix").getByRole("button", { name: "Remind me tonight" }).click();
  await expect(page.locator(".day-toast")).toContainText("A reminder is set for 8 pm. The card is back then.");
  await expect(card(page, "Netflix")).toHaveCount(0);
  const reminder = await meridian(page, (m) => m.getState().activity.all.find((e) => e.title === "Netflix renews tomorrow — ₹649"));
  expect(reminder?.startsAt.value).toBe("2026-11-06T20:00:00");
});

test("with nothing to do, My Day says so plainly and the island skips the morning line", async ({ page }) => {
  await meridian(page, (_, mock) => {
    mock.nextCheck([]);
    mock.cardsDue();
  });
  await checked(page);
  await expect(island(page)).toHaveAttribute("data-view", "idle");
  await openMyDay(page);
  await expect(page.locator(".day-calm")).toContainText("Nothing needs you today");
  await expect(page.locator(".day-calm")).toContainText("Cards show up here when someone is waiting on a reply, something renews, or a trip has no booking.");
  await expect(dockDay(page).locator(".badge")).toHaveCount(0);
});

test("a source that cannot be read is named with why, and cards from the others still show", async ({ page }) => {
  await meridian(page, (_, mock) => {
    mock.nextCheck(["trip"], [{ source: "gmail", why: "Claude Code is signed out" }]);
    mock.cardsDue();
  });
  await openMyDay(page);
  const warn = page.locator(".day-warn");
  await expect(warn).toContainText("Could not check Gmail this morning, because Claude Code is signed out. Cards from mail may be missing.");
  await expect(page.locator(".day-card")).toHaveCount(1);
  await expect(card(page, "Pune")).toBeVisible();
  await expect(page.locator(".day-calm")).toHaveCount(0);

  await meridian(page, (_, mock) => mock.nextCheck(["reply", "renewal", "trip"]));
  await warn.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator(".day-card")).toHaveCount(3);
  await expect(warn).toHaveCount(0);
  expect(await meridian(page, (_, mock) => mock.cardChecks())).toBe(2);
});

test("Settings › My day turns each kind off, and a kind that is off leaves My Day", async ({ page }) => {
  await boardDay(page);
  await meridian(page, (m) => m.openPanel("settings"));
  await settingsDay(page).click();
  for (const [name, hint] of [
    ["Replies people are waiting on", "After 2 days with no reply from you"],
    ["Renewals and free trials", "From receipts in Gmail"],
    ["Trips with nothing booked", "From your calendar and booking mail"],
    ["Morning summary on the island", "Once, after 6 am"],
  ]) {
    await expect(page.getByRole("switch", { name: name! })).toBeChecked();
    await expect(page.locator(".setting", { hasText: name! })).toContainText(hint!);
  }
  await expect(page.locator(".settings-body")).toContainText("Each kind can be turned off. All of them need Gmail or Google Calendar connected");
  await page.getByRole("switch", { name: "Trips with nothing booked" }).click();
  await dockDay(page).click();
  await expect(page.locator(".day-card")).toHaveCount(2);
  await expect(card(page, "Pune")).toHaveCount(0);
});

test("with the morning summary off, the check runs and the island stays quiet", async ({ page }) => {
  await meridian(page, (m) => m.updateSettings({ myDay: { replies: true, renewals: true, trips: true, summary: false } }));
  await meridian(page, (_, mock) => mock.cardsDue());
  await checked(page);
  await expect(island(page)).toHaveAttribute("data-view", "idle");
});

test("in local-only mode nothing is read, and Settings › My day says why", async ({ page }) => {
  await meridian(page, (m) => m.updateSettings({ localOnly: true }));
  await meridian(page, (_, mock) => mock.cardsDue());
  await page.waitForTimeout(200);
  expect(await meridian(page, (_, mock) => mock.cardChecks())).toBe(0);
  await meridian(page, (m) => m.openPanel("settings"));
  await settingsDay(page).click();
  await expect(page.getByRole("switch", { name: "Replies people are waiting on" })).toBeDisabled();
  await expect(page.locator(".settings-body")).toContainText("Off while local-only mode is on");
});
