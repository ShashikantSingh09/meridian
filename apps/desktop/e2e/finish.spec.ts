import { expect, test, type Page } from "@playwright/test";

// Finish this for me, from the November 6 Finish this for me board. The core runs the task; these
// check what the island shows for each figure, and that only the user's clicks answer it.

type View = Record<string, unknown>;
type Mock = { finishShow(view: View | null): void; finishCalls(): string[] };
type App = {
  updateSettings(patch: object): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getState(): any;
};
type Hooks = { __mock: Mock; __meridian: App };
const island = (page: Page) => page.locator(".island");
const calls = (page: Page) => page.evaluate(() => (window as never as Hooks).__mock.finishCalls());
/** As the core does while a task runs, and once the content before it has gone. */
const show = async (page: Page, view: View | null) => {
  await page.evaluate((v) => (window as never as Hooks).__mock.finishShow(v), view);
  await expect(page.locator(".island .island-content")).toHaveCount(1);
};
const button = (page: Page, name: string) => island(page).getByRole("button", { name, exact: true });
const mood = async (page: Page, feeling: string) => {
  await expect(island(page).locator(".face")).toHaveCount(1);
  await expect(island(page).locator(".face")).toHaveAttribute("data-mood", feeling);
};

const base = {
  phase: "working",
  app: "Northwind Expenses",
  now: "",
  steps: [],
  note: null,
  paused: null,
  ask: null,
  end: null,
  card: null,
};
const step = (at: number, text: string, from: string | null = null) => ({ at, text, from });
const working = (patch: View = {}) => ({ ...base, startedAt: Date.now() - 9_000, ...patch });
const asking = (ask: View) => working({ phase: "ask", ask: { id: "q1", button: null, ...ask } });
const ended = (end: View, patch: View = {}) => working({ phase: "ended", end: { site: null, worked: 112_000, steps: 9, clicks: 2, filled: 5, sent: false, body: "", ...end }, ...patch });
const card = (kind: string, title: string, body: string, extra: View = {}) => ({ ...base, phase: "card", startedAt: Date.now(), card: { kind, title, body, id: null, name: null, ...extra } });

const claimSteps = [
  step(2_000, "Read the claim form · 6 boxes"),
  step(11_000, "Found an Uber receipt for ₹2,340, 4 Nov", "mail"),
  step(16_000, "Filled name and employee ID"),
  step(24_000, "Picked 4 Nov in Expense date"),
  step(31_000, "Chose Travel › Cab in Category"),
];

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(island(page)).toHaveAttribute("data-view", "idle");
});

test.describe("Finish this for me", () => {
  test("2 · it reads first: the working card names the app, the time, what it is doing and where a line came from", async ({ page }) => {
    await show(page, working({ now: "Looking in your mail for the receipt", steps: [step(2_000, "Read the claim form · 6 boxes"), step(9_000, "Searching Gmail for “Uber” this week", "mail")], note: "It read your mail, so a new site will ask first." }));
    await expect(island(page)).toHaveAttribute("data-view", "finish");
    await expect(island(page)).toContainText("Finish this · Northwind Expenses");
    await expect(island(page)).toContainText(/Working · 0:(09|1\d)/);
    await expect(island(page)).toContainText("Looking in your mail for the receipt");
    await expect(island(page)).toContainText("0:02");
    await expect(island(page).locator(".finish-from")).toHaveText("from mail");
    await expect(island(page)).toContainText("It read your mail, so a new site will ask first.");
    await mood(page, "think");
    // Nothing shows in Chat.
    await expect(island(page)).not.toHaveAttribute("data-view", "expanded");
  });

  test("3 · while it works, each step with its time, the latest few, and Show all steps for the rest", async ({ page }) => {
    await show(page, working({ now: "Typing 2,340.00 in Amount", steps: claimSteps }));
    await expect(island(page)).toContainText("Typing 2,340.00 in Amount");
    await expect(island(page).locator(".finish-step")).toHaveCount(3);
    await expect(island(page)).toContainText("Chose Travel › Cab in Category");
    await button(page, "Show all steps").click();
    await expect(island(page).locator(".finish-step")).toHaveCount(5);
    await expect(island(page)).toContainText("Read the claim form · 6 boxes");
  });

  test("4 · Stop is always on the island and is the user's click", async ({ page }) => {
    await show(page, working({ now: "Typing in Amount", steps: claimSteps }));
    expect(await calls(page)).toEqual([]);
    await button(page, "Stop").click();
    expect(await calls(page)).toEqual(["stop"]);
  });

  test("4 · touching the mouse pauses it, and Continue picks up from the same step", async ({ page }) => {
    await show(page, working({ phase: "paused", paused: "Paused — you moved the mouse", startedAt: Date.now() - 41_000 }));
    await expect(island(page)).toContainText("Paused — you moved the mouse");
    await expect(island(page)).toContainText("0:41");
    await mood(page, "needs");
    await button(page, "Continue").click();
    expect(await calls(page)).toEqual(["continue"]);
  });

  test("5 · Submit waits for one click, shows the button it would press, and nothing answers by itself", async ({ page }) => {
    await show(page, asking({ kind: "commit", title: "Submit the expense claim for ₹2,340?", body: "Travel · Cab · 4 Nov · receipt attached. Goes to Priya Nair to approve.", button: "Submit", yes: "Submit", no: "Not yet" }));
    await expect(island(page).getByRole("alertdialog")).toContainText("Submit the expense claim for ₹2,340?");
    await expect(island(page).locator(".finish-button")).toHaveText("Submit");
    await expect(island(page)).toContainText("Goes to Priya Nair to approve.");
    await page.waitForTimeout(500);
    expect(await calls(page), "no answer goes without a click").toEqual([]);
    await button(page, "Submit").click();
    expect(await calls(page)).toEqual(["answer q1 yes"]);
  });

  test("5 · Not yet leaves the claim filled and unsent", async ({ page }) => {
    await show(page, asking({ kind: "commit", title: "Submit the expense claim for ₹2,340?", body: "", button: "Submit", yes: "Submit", no: "Not yet" }));
    await button(page, "Not yet").click();
    expect(await calls(page)).toEqual(["answer q1 no"]);
  });

  test("an upload asks too, naming the file and where it goes", async ({ page }) => {
    await show(page, asking({ kind: "upload", title: "Attach “Uber receipt 4 Nov.pdf”?", body: "From Downloads, 84 KB. To Receipt in Northwind Expenses.", yes: "Attach", no: "Skip" }));
    await expect(island(page)).toContainText("From Downloads, 84 KB. To Receipt in Northwind Expenses.");
    await button(page, "Skip").click();
    expect(await calls(page)).toEqual(["answer q1 no"]);
  });

  test("going to another site asks", async ({ page }) => {
    await show(page, asking({ kind: "site", title: "Go to riders.uber.com?", body: "To download the receipt. It read your mail in this task, so a new site needs your click.", yes: "Go there", no: "No" }));
    await expect(island(page)).toContainText("Go to riders.uber.com?");
    await button(page, "Go there").click();
    expect(await calls(page)).toEqual(["answer q1 yes"]);
  });

  test("a step it will not do: paying", async ({ page }) => {
    await show(page, ended({ kind: "payment", title: "Stopped at payment", site: "irctc.co.in", body: "Paying is yours. Everything before it is done: 1 seat on the 8:10 from Mumbai CSMT to Pune, Tue 10 Nov." }));
    await expect(island(page)).toContainText("Stopped at payment");
    await expect(island(page)).toContainText("irctc.co.in");
    await expect(island(page)).toContainText("Paying is yours.");
    await button(page, "Done").click();
    await expect(island(page)).toHaveAttribute("data-view", "idle");
    expect(await calls(page)).toEqual(["close"]);
  });

  test("6 · done, with what it did and the user's clicks", async ({ page }) => {
    const steps = [
      step(11_000, "Found the Uber receipt for ₹2,340 in Gmail"),
      step(38_000, "Filled name, ID, date, category and amount"),
      step(62_000, "You said Attach: Uber receipt 4 Nov.pdf"),
      step(80_000, "Wrote the description"),
      step(106_000, "You said Submit"),
      step(112_000, "Saw “Claim EXP-3381 submitted”"),
    ];
    await show(page, ended({ kind: "done", title: "Expense claim submitted", sent: true }, { steps }));
    await mood(page, "done");
    await expect(island(page)).toContainText("Finish this · Northwind Expenses");
    await expect(island(page)).toContainText("Expense claim submitted");
    await expect(island(page)).toContainText("Worked for 1 min 52 s · 9 steps · 2 clicks from you");
    await expect(island(page).locator(".finish-step")).toHaveCount(6);
    await expect(island(page)).toContainText("1:46");
    await expect(island(page)).toContainText("can't be undone from here");
    await button(page, "Close").click();
    await expect(island(page)).toHaveAttribute("data-view", "idle");
  });

  test("you pressed Stop: it says what it left, and Undo puts the boxes back", async ({ page }) => {
    await show(page, ended({ kind: "stopped", title: "Stopped after 5 steps", body: "Nothing was submitted. 4 boxes were filled.", filled: 4 }));
    await expect(island(page)).toContainText("Stopped after 5 steps");
    await expect(island(page)).toContainText("Nothing was submitted. 4 boxes were filled.");
    await button(page, "Undo the 4 boxes").click();
    await expect(island(page)).toContainText("Put back 4 boxes.");
    await expect(button(page, "Undo the 4 boxes")).toHaveCount(0);
    expect(await calls(page)).toEqual(["undo"]);
  });

  test("when it gets stuck it stops instead of guessing", async ({ page }) => {
    await show(page, ended({ kind: "failed", title: "Could not finish", body: "Category did not open after 3 tries. Stopped at step 4. Nothing was submitted. 3 boxes were filled." }, { steps: claimSteps }));
    await mood(page, "error");
    await expect(island(page)).toContainText("Category did not open after 3 tries.");
    await button(page, "Show steps").click();
    await expect(island(page).locator(".finish-step")).toHaveCount(5);
  });

  test("an app that is not on the list: Allow gives it Finish too and starts the task again", async ({ page }) => {
    await show(page, card("not-listed", "Tally Prime is not on your list", "Finish this for me has not been allowed in Tally Prime.", { id: "tally.exe", name: "Tally Prime" }));
    await expect(island(page)).toContainText("Tally Prime is not on your list");
    await button(page, "Allow Tally Prime").click();
    await expect.poll(() => calls(page)).toEqual(["again"]);
    const places = await page.evaluate(() => (window as never as Hooks).__meridian.getState().settings.fill.places);
    expect(places).toContainEqual({ id: "tally.exe", name: "Tally Prime", fill: "allowed", finish: true, alwaysAsk: false });
  });

  test("places it never works, local-only mode, and the experiment while it is off", async ({ page }) => {
    await show(page, card("never", "Not in a terminal", "Terminals, Windows Settings, Windows Security, password managers, private windows and Meridian itself are always off limits."));
    await expect(island(page)).toContainText("Not in a terminal");
    await expect(island(page).getByRole("button")).toHaveCount(1);
    await button(page, "Close").click();
    await expect(island(page)).toHaveAttribute("data-view", "idle");

    await show(page, card("local", "Off while local-only mode is on", "Finish this for me needs an online AI. Write here and Fill this form still work with the AI on this PC."));
    await expect(island(page)).toContainText("Off while local-only mode is on");
    await button(page, "Close").click();

    await show(page, card("off", "Finish this for me is an experiment", "It clicks and types in your apps. Turn it on in Settings to try it."));
    await button(page, "Settings").click();
    await expect(island(page)).toHaveAttribute("data-view", "expanded");
    await expect(page.getByRole("heading", { name: "Fill in the page" })).toBeVisible();
  });
});
