import { expect, test, type Page } from "@playwright/test";

type Mock = {
  seedKnowledge(): void;
  holdKnowledge(): void;
  finishKnowledge(): void;
  idleKnowledge(): void;
  knowledgeRuns(): { chats: number; idle: boolean }[];
  knowledgeOpened(): string[];
  openedUrls(): string[];
  publishWatched(id: string): void;
  publishEvent(id: string, event: object): void;
};
const mock = <T,>(page: Page, run: (m: Mock) => T) => page.evaluate(`(${run.toString()})(window.__mock)`) as Promise<T>;
const settings = (page: Page, patch: object) => page.evaluate((p) => (window as never as { __meridian: { updateSettings(p: object): Promise<void> } }).__meridian.updateSettings(p), patch);
const sources = (on: Partial<Record<"notes" | "gmail" | "calendar" | "chats", boolean>>) => ({ knowledge: { notes: false, gmail: false, calendar: false, chats: false, when: "idle", ...on } });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => "__meridian" in window);
  await page.evaluate(() => (window as never as { __meridian: { openPanel(): void } }).__meridian.openPanel());
  await expect(page.locator(".panel")).toBeVisible();
});

const openKnowledge = (page: Page) => page.getByRole("button", { name: "Knowledge", exact: true }).click();

/** The sample pages from the board, with call notes turned on. */
async function withPages(page: Page) {
  await settings(page, sources({ notes: true }));
  await mock(page, (m) => m.seedKnowledge());
  await openKnowledge(page);
  await expect(page.locator(".know-reader h2")).toHaveText("Asha Rao");
}

test("Knowledge is a book in the dock, between Notes and Notifications", async ({ page }) => {
  const names = await page.locator(".dock .dock-item").evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")));
  expect(names.slice(names.indexOf("Notes"), names.indexOf("Notes") + 3)).toEqual(["Notes", "Knowledge", "Notifications"]);
});

test("the first time, it is empty until sources are picked, and nothing is read before that", async ({ page }) => {
  await openKnowledge(page);
  await expect(page.getByRole("heading", { name: "Nothing here yet" })).toBeVisible();
  await expect(page.locator(".know-first")).toContainText("They stay on this PC as plain files you can read and change.");
  await expect(page.locator(".know-first .chip")).toHaveText(["People, like Asha Rao", "Projects, like the shop relaunch", 'Promises, like "send the invoice"', "Places, like the Pune office"]);
  await page.getByRole("button", { name: "Pick sources" }).click();
  await expect(page.locator(".know-crumb")).toHaveText("Knowledge › Sources");
  for (const name of ["Call notes", "Gmail", "Google Calendar", "Chats with Meridian"]) await expect(page.getByRole("switch", { name })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Update now" })).toBeDisabled();
  await expect(page.getByRole("radio", { name: "When idle and plugged in" })).toBeChecked();
  expect(await mock(page, (m) => m.knowledgeRuns().length)).toBe(0);
  await page.getByRole("button", { name: "Back to the pages" }).click();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.locator(".panel-head h1")).not.toHaveText("Knowledge");
});

test("turning sources on and pressing Update now writes the pages", async ({ page }) => {
  await openKnowledge(page);
  await page.getByRole("button", { name: "Pick sources" }).click();
  await expect(page.locator(".know-source").first()).toContainText("calls on this PC");
  await page.getByRole("switch", { name: "Call notes" }).click();
  await page.getByRole("switch", { name: "Gmail" }).click();
  await expect(page.getByRole("switch", { name: "Gmail" })).toBeChecked();
  await page.getByRole("radio", { name: "Only when I press Update now" }).click();
  expect(await page.evaluate(() => (window as never as { __meridian: { getState(): { settings: { knowledge: object } } } }).__meridian.getState().settings.knowledge)).toEqual({ notes: true, gmail: true, calendar: false, chats: false, when: "manual" });
  await page.getByRole("button", { name: "Update now" }).click();
  await expect(page.locator(".know-sources")).toContainText("Updated");
  await page.getByRole("button", { name: "Back to the pages" }).click();
  await expect(page.locator(".know-reader h2")).toHaveText("Asha Rao");
  expect(await mock(page, (m) => m.knowledgeRuns())).toEqual([{ chats: 0, idle: false }]);
});

test("while it updates, the count is real, a failing source says why, the rest go on, and nothing shows on the island", async ({ page }) => {
  await settings(page, sources({ notes: true, gmail: true, calendar: true }));
  await mock(page, (m) => m.holdKnowledge());
  await openKnowledge(page);
  await page.getByRole("button", { name: "Update now" }).click();
  await expect(page.locator(".know-progress")).toContainText("14 of 52 new items · now reading the call with Asha, 4 Nov");
  await expect(page.getByRole("progressbar", { name: "Items read" })).toHaveAttribute("aria-valuenow", "14");
  const row = (name: string) => page.locator(".know-source", { hasText: name });
  await expect(row("Call notes")).toContainText("2 new calls");
  await expect(row("Gmail")).toContainText("Skipped this time");
  await expect(row("Gmail")).toContainText("Claude Code is signed out, so Gmail could not be read.");
  await expect(row("Gmail").getByRole("button", { name: "Sign in again" })).toBeVisible();
  await expect(row("Google Calendar")).toContainText("Done · 6 new events");
  await expect(row("Chats with Meridian")).toContainText("Off");
  await page.evaluate(() => (window as never as { __meridian: { closePanel(): void } }).__meridian.closePanel());
  await expect(page.locator(".island")).toHaveAttribute("data-view", "idle");
  expect(await page.evaluate(() => (window as never as { __meridian: { getState(): { notices: unknown[]; errors: unknown[] } } }).__meridian.getState().notices.length)).toBe(0);
  await page.evaluate(() => (window as never as { __meridian: { openPanel(): void } }).__meridian.openPanel());
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator(".know-sources")).toContainText("Stopped. It carries on next time.");
  await expect(page.getByRole("button", { name: "Update now" })).toBeEnabled();
});

test("an idle PC starts an update by itself, which says nothing on the island", async ({ page }) => {
  await settings(page, sources({ chats: true }));
  await page.evaluate(() => (window as never as { __meridian: { closePanel(): void } }).__meridian.closePanel());
  await mock(page, (m) => m.idleKnowledge());
  await expect.poll(() => mock(page, (m) => m.knowledgeRuns())).toEqual([{ chats: 0, idle: true }]);
  await expect(page.locator(".island")).toHaveAttribute("data-view", "idle");
});

test("with local-only mode on, Gmail and Calendar are off", async ({ page }) => {
  await settings(page, { localOnly: true, ...sources({ gmail: true }) });
  await openKnowledge(page);
  await expect(page.getByRole("switch", { name: "Gmail" })).toBeDisabled();
  await expect(page.getByRole("switch", { name: "Gmail" })).not.toBeChecked();
  await expect(page.getByRole("switch", { name: "Google Calendar" })).toBeDisabled();
  await expect(page.locator(".know-source", { hasText: "Gmail" })).toContainText("Off while local-only mode is on");
});

test("the list is grouped with counts, and the page says where each fact came from", async ({ page }) => {
  await withPages(page);
  await expect(page.locator(".know-gh")).toHaveText(["People3", "Projects2", "Promises3", "Places1"]);
  await expect(page.locator(".know-item[aria-current='true']")).toContainText("Design lead at Northwind");
  const reader = page.locator(".know-reader");
  await expect(reader.locator(".know-kind")).toHaveText("Person");
  await expect(reader.locator(".know-from")).toContainText("From: call on 4 Nov, mail from Asha, 3 Nov");
  await expect(reader.locator(".know-h")).toHaveText(["Now", "Promises", "Good to know", "Linked"]);
  await expect(reader.locator(".know-line", { hasText: "Wants the hero photos" }).locator(".know-src")).toHaveText("mail, 3 Nov");
  await expect(reader.locator(".know-line", { hasText: "Works from Bengaluru" }).locator(".know-src")).toHaveText("meeting on 2 Nov");
  await expect(reader.getByRole("checkbox", { name: "Asha: share the new deck, by Mon 9 Nov" })).not.toBeChecked();
  await expect(reader.getByRole("checkbox", { name: "You: book the review room" })).toBeChecked();
  await reader.getByRole("button", { name: "Shop relaunch" }).click();
  await expect(page.locator(".know-reader h2")).toHaveText("Shop relaunch");
});

test("a call link opens that note, and a mail link opens Gmail", async ({ page }) => {
  await withPages(page);
  await page.locator(".know-line", { hasText: "Wants the hero photos" }).getByRole("button", { name: "mail, 3 Nov" }).click();
  expect(await mock(page, (m) => m.openedUrls())).toEqual(["https://mail.google.com/mail/u/0/#all/18c2"]);
  await page.locator(".know-line", { hasText: "The launch moves to 18 Nov" }).getByRole("button", { name: "call on 4 Nov" }).click();
  await expect(page.locator(".panel-head h1")).toHaveText("Notes");
  await expect(page.getByRole("heading", { name: "Launch date and checkout" })).toBeVisible();
});

test("ticking a promise moves it to done", async ({ page }) => {
  await withPages(page);
  const promises = page.locator(".know-reader section", { has: page.locator(".know-h", { hasText: "Promises" }) });
  await promises.getByRole("checkbox", { name: "Asha: share the new deck, by Mon 9 Nov" }).click();
  await expect(promises.getByRole("checkbox", { name: "Asha: share the new deck, by Mon 9 Nov" })).toBeChecked();
  await expect(promises.locator(".know-line").last()).toContainText("Asha: share the new deck");
  await expect(page.locator(".know-gh", { hasText: "Promises" })).toHaveText("Promises2");
  await expect(page.locator(".know-item", { hasText: "Share the new deck" })).toHaveAttribute("data-done", "true");
});

test("search finds words inside pages, marks them, and Up, Down and Enter open one", async ({ page }) => {
  await withPages(page);
  const box = page.getByRole("textbox", { name: "Search people, promises and everything on the pages" });
  await box.fill("invoice");
  await expect(page.locator(".know-search")).toContainText("3 pages");
  const results = page.getByRole("listbox", { name: "Pages that match" });
  await expect(results.getByRole("option")).toHaveCount(3);
  await expect(results.getByRole("option", { name: /Carl Mendes/ })).toContainText("“Asked whether the October invoice went out.”");
  await expect(results.getByRole("option", { name: /Send Carl/ })).toContainText("You · by Fri 6 Nov · mail from Carl, 3 Nov");
  await expect(results.locator("mark").first()).toHaveText("invoice");
  await expect(results.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await box.press("ArrowDown");
  await expect(results.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
  await box.press("ArrowUp");
  await box.press("Enter");
  await expect(page.locator(".know-reader h2")).toHaveText("Carl Mendes");
  await box.press("Escape");
  await expect(box).toHaveValue("");
  await expect(page.locator(".panel")).toBeVisible();
});

test("a fact fixed as plain text is marked as yours, and Cancel keeps the page as it was", async ({ page }) => {
  await withPages(page);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".know-crumb")).toHaveText("Knowledge › Asha Rao › Edit");
  const text = page.getByRole("textbox", { name: "The text of Asha Rao" });
  await expect(text).toHaveValue(/^# Asha Rao\n/);
  await text.fill((await text.inputValue()).replace("Bengaluru", "Pune"));
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".know-reader")).toContainText("Works from Bengaluru.");

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await text.fill((await text.inputValue()).replace("- Works from Bengaluru. (meeting on 2 Nov)", "- Moved to Pune in October."));
  await page.getByRole("button", { name: "Save" }).click();
  const fixed = page.locator(".know-line", { hasText: "Moved to Pune in October." });
  await expect(fixed.locator(".know-yours")).toHaveText("yours");
  await expect(page.locator(".know-reader")).not.toContainText("Bengaluru");
});

test("Open file opens the page's own Markdown file", async ({ page }) => {
  await withPages(page);
  await page.getByRole("button", { name: "Open file" }).click();
  expect(await mock(page, (m) => m.knowledgeOpened())).toEqual(["People/Asha Rao.md"]);
});

test("while the assistant looks something up, the island says what it is checking", async ({ page }) => {
  await page.evaluate(() => (window as never as { __meridian: { closePanel(): void } }).__meridian.closePanel());
  await mock(page, (m) => {
    m.publishWatched("watch:k");
    m.publishEvent("watch:k", { type: "activity", label: "Checking what I know about Asha" });
  });
  await expect(page.locator(".island")).toContainText("Checking what I know about");
  await expect(page.locator(".island").getByRole("button", { name: "Checking what I know about Asha", exact: true })).toBeVisible();
});
