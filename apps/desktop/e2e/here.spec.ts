import { expect, test, type Page } from "@playwright/test";

// Write here, from the November 6 Write here board, and asking from the island (Island upgrades, part a),
// whose answer goes into the box that had the cursor.

type Mock = {
  pressHereKey(): void;
  askToWriteHere(instruction: string): void;
  typeInTheBox(): void;
  hereNext(...outcomes: object[]): void;
  hereCalls(): string[];
  offerHere(on: boolean): void;
  holdHere(): void;
  releaseHere(): void;
  refuseUndo(why: string): void;
  seedPlaces(places: object[]): void;
  answerNext(answer: { text?: string; fail?: string }): void;
  setAuthed(on: boolean): void;
};
type App = {
  updateSettings(patch: object): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getState(): any;
  setHovered(on: boolean): void;
  startWriteHere(options?: object): Promise<void>;
  openPanel(tab?: string): void;
};
type Hooks = { __mock: Mock; __meridian: App };
const hooks = (page: Page, call: (w: Hooks) => unknown) => page.evaluate(`(${call.toString()})(window)`);
const island = (page: Page) => page.locator(".island");
const calls = (page: Page) => hooks(page, (w) => w.__mock.hereCalls()) as Promise<string[]>;
const places = (page: Page) => hooks(page, (w) => w.__meridian.getState().settings.fill.places) as Promise<{ id: string; fill: string; alwaysAsk: boolean }[]>;
const fillOn = (page: Page, patch: object = {}) =>
  page.evaluate((p) => {
    const app = (window as never as Hooks).__meridian;
    return app.updateSettings({ fill: { ...app.getState().settings.fill, on: true, ...p } });
  }, patch);
const pressKey = (page: Page) => hooks(page, (w) => w.__mock.pressHereKey());
const written = (page: Page) => expect(island(page)).toContainText("Written here · not sent");
/** The face once the content before it has gone. */
const mood = async (page: Page, feeling: string) => {
  await expect(island(page).locator(".face")).toHaveCount(1);
  await expect(island(page).locator(".face")).toHaveAttribute("data-mood", feeling);
};

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(island(page)).toHaveAttribute("data-view", "idle");
  await fillOn(page);
});

test.describe("Write here", () => {
  test("Ctrl Alt F writes in the box, the eyes look up meanwhile, and the line offers Undo, Shorter and Warmer", async ({ page }) => {
    await hooks(page, (w) => w.__mock.holdHere());
    await pressKey(page);
    await expect(island(page)).toHaveAttribute("data-view", "here");
    await expect(island(page)).toContainText("Writing here…");
    await mood(page, "think");
    await hooks(page, (w) => w.__mock.releaseHere());
    await written(page);
    await mood(page, "done");
    for (const name of ["Undo", "Shorter", "Warmer"]) await expect(island(page).getByRole("button", { name })).toBeVisible();
    // Nothing opens in Chat, and nothing is asked of the AI that the core does not read itself.
    await expect(island(page)).not.toHaveAttribute("data-view", "expanded");
    expect(await calls(page)).toEqual([`start ${JSON.stringify({ instruction: null, text: null, allow: null, window: null })}`]);
  });

  test("Undo puts back what was in the box, and closes the line", async ({ page }) => {
    await pressKey(page);
    await written(page);
    await island(page).getByRole("button", { name: "Undo" }).click();
    await expect(island(page)).toHaveAttribute("data-view", "idle");
    expect(await calls(page)).toContain("undo");
  });

  test("an Undo that cannot put it back says why", async ({ page }) => {
    await hooks(page, (w) => w.__mock.refuseUndo("You changed the box since, so it keeps your words."));
    await pressKey(page);
    await written(page);
    await island(page).getByRole("button", { name: "Undo" }).click();
    await expect(island(page)).toContainText("You changed the box since, so it keeps your words.");
  });

  test("Shorter and Warmer rewrite it in place", async ({ page }) => {
    await pressKey(page);
    await written(page);
    await hooks(page, (w) => w.__mock.holdHere());
    await island(page).getByRole("button", { name: "Shorter" }).click();
    await expect(island(page)).toContainText("Writing here…");
    await hooks(page, (w) => w.__mock.releaseHere());
    await written(page);
    await island(page).getByRole("button", { name: "Warmer" }).click();
    await written(page);
    expect((await calls(page)).slice(1)).toEqual(["rewrite shorter", "rewrite warmer"]);
  });

  test("typing anything in the box closes the line", async ({ page }) => {
    await pressKey(page);
    await written(page);
    await hooks(page, (w) => w.__mock.typeInTheBox());
    await expect(island(page)).toHaveAttribute("data-view", "idle");
    expect(await calls(page)).toContain("done");
  });

  test("the assistant starts it with the user's own words", async ({ page }) => {
    await hooks(page, (w) => w.__mock.askToWriteHere("say I'll send it today"));
    await written(page);
    expect((await calls(page))[0]).toContain(`"instruction":"say I'll send it today"`);
  });

  test("from the panel, the panel closes first so the box under it has the cursor", async ({ page }) => {
    await hooks(page, (w) => w.__meridian.openPanel("chat"));
    await expect(island(page)).toHaveAttribute("data-view", "expanded");
    await pressKey(page);
    await written(page);
    expect(await hooks(page, (w) => w.__meridian.getState().panelOpen)).toBe(false);
  });

  test("a run stopped with Esc leaves nothing on the island", async ({ page }) => {
    await hooks(page, (w) => w.__mock.hereNext({ outcome: "stopped" }));
    await pressKey(page);
    await expect(island(page)).toHaveAttribute("data-view", "idle");
  });

  test("the key does nothing while Write here is off", async ({ page }) => {
    await fillOn(page, { on: false });
    // The core does not register the key then. Started anyway, the core says it is off.
    await hooks(page, (w) => w.__mock.hereNext({ outcome: "line", text: "Write here is off. Turn it on in Settings." }));
    await pressKey(page);
    await expect(island(page)).toContainText("Write here is off.");
  });
});

test.describe("when it cannot write", () => {
  test("with no box, or a password box, it says why in one line, and the line leaves after 3 seconds", async ({ page }) => {
    await page.clock.install();
    await page.goto("/");
    await fillOn(page);
    await hooks(page, (w) => w.__mock.hereNext({ outcome: "line", text: "Click in a text box first." }, { outcome: "line", text: "Password boxes are yours to fill." }));
    await pressKey(page);
    await expect(island(page)).toContainText("Click in a text box first.");
    await mood(page, "needs");
    await page.clock.runFor(3100);
    await expect(island(page)).toHaveAttribute("data-view", "idle");
    await pressKey(page);
    await expect(island(page)).toContainText("Password boxes are yours to fill.");
  });

  test("a new app asks the first time, and Always adds it to the list before writing", async ({ page }) => {
    await hooks(page, (w) => w.__mock.hereNext({ outcome: "ask", key: "ms-teams.exe", id: "ms-teams.exe", name: "Microsoft Teams", every: null }));
    await pressKey(page);
    const card = island(page).getByRole("alertdialog", { name: "Write here in Microsoft Teams?" });
    await expect(card).toContainText("Nothing in it is read until you say.");
    await expect(card.getByRole("button")).toHaveText(["Never", "Once", "Always"]);
    await card.getByRole("button", { name: "Always" }).click();
    await written(page);
    expect(await places(page)).toEqual([expect.objectContaining({ id: "ms-teams.exe", fill: "allowed" })]);
    expect((await calls(page))[1]).toContain(`"allow":null`);
  });

  test("Once writes this one time and remembers nothing, and Never remembers never", async ({ page }) => {
    const teams = { outcome: "ask", key: "ms-teams.exe", id: "ms-teams.exe", name: "Microsoft Teams", every: null };
    await hooks(page, (w) => w.__mock.hereNext({ outcome: "ask", key: "ms-teams.exe", id: "ms-teams.exe", name: "Microsoft Teams", every: null }));
    await pressKey(page);
    await island(page).getByRole("button", { name: "Once" }).click();
    await written(page);
    expect((await calls(page))[1]).toContain(`"allow":"ms-teams.exe"`);
    expect(await places(page)).toEqual([]);

    await page.evaluate((t) => (window as never as Hooks).__mock.hereNext(t), teams);
    await pressKey(page);
    await island(page).getByRole("button", { name: "Never" }).click();
    await expect(island(page)).toHaveAttribute("data-view", "idle");
    expect(await places(page)).toEqual([expect.objectContaining({ id: "ms-teams.exe", fill: "never" })]);
    expect((await calls(page)).filter((call) => call.startsWith("start"))).toHaveLength(3);
  });

  test("a bank asks every time, naming the site, and goes on the list as one that asks", async ({ page }) => {
    await hooks(page, (w) => w.__mock.hereNext({ outcome: "ask", key: "onlinesbi.sbi", id: "onlinesbi.sbi", name: "onlinesbi.sbi", every: "a bank" }));
    await pressKey(page);
    const card = island(page).getByRole("alertdialog", { name: "Write here on onlinesbi.sbi?" });
    await expect(card).toContainText("A bank asks every time.");
    await expect(card.getByRole("button")).toHaveText(["Not now", "Write here"]);
    await card.getByRole("button", { name: "Write here" }).click();
    await written(page);
    expect((await calls(page))[1]).toContain(`"allow":"onlinesbi.sbi"`);
    expect(await places(page)).toEqual([expect.objectContaining({ id: "onlinesbi.sbi", fill: "ask", alwaysAsk: true })]);
  });

  test("an app set to Never says so, and Allow puts it back on the list", async ({ page }) => {
    await hooks(page, (w) => w.__mock.seedPlaces([{ id: "ms-teams.exe", name: "Microsoft Teams", fill: "never", finish: false, alwaysAsk: false }]));
    await hooks(page, (w) => w.__mock.hereNext({ outcome: "off", id: "ms-teams.exe", name: "Microsoft Teams" }));
    await pressKey(page);
    const card = island(page).getByRole("alertdialog", { name: "Write here is off in Microsoft Teams" });
    await expect(card.getByRole("button")).toHaveText(["Not now", "Allow Microsoft Teams"]);
    await card.getByRole("button", { name: "Allow Microsoft Teams" }).click();
    await written(page);
    expect(await places(page)).toEqual([expect.objectContaining({ id: "ms-teams.exe", fill: "allowed" })]);
  });

  test("local-only mode with an online AI stops before reading, and Settings opens Fill in the page", async ({ page }) => {
    await hooks(page, (w) => w.__mock.hereNext({ outcome: "local", ai: "Claude" }));
    await pressKey(page);
    const card = island(page).getByRole("alertdialog", { name: "Local-only mode is on" });
    await expect(card).toContainText("Write here is set to use Claude, which is online. Pick an AI on this PC, or turn local-only mode off.");
    await card.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Fill in the page" })).toBeVisible();
  });

  test("when the AI does not answer the box is left as it was, and Try again asks once more", async ({ page }) => {
    await hooks(page, (w) => w.__mock.hereNext({ outcome: "failed", why: "Claude did not answer in 20 seconds. Nothing was put in the box." }));
    await pressKey(page);
    const card = island(page).getByRole("alertdialog", { name: "Could not write here" });
    await expect(card).toContainText("Claude did not answer in 20 seconds. Nothing was put in the box.");
    await mood(page, "error");
    await card.getByRole("button", { name: "Try again" }).click();
    await written(page);
    expect(await calls(page)).toContain("retry");
  });

  test("when the cursor moved to another box nothing goes in, and the reply can be copied", async ({ page }) => {
    await hooks(page, (w) => w.__mock.hereNext({ outcome: "moved", title: "You moved to another box" }));
    await pressKey(page);
    const card = island(page).getByRole("alertdialog", { name: "You moved to another box" });
    await expect(card).toContainText("So nothing was put in. The reply is kept for a minute.");
    await card.getByRole("button", { name: "Copy the reply" }).click();
    await expect(island(page)).toHaveAttribute("data-view", "idle");
    expect(await calls(page)).toContain("copy");
  });
});

test.describe("the island's button", () => {
  const hover = async (page: Page) => {
    await hooks(page, (w) => w.__meridian.setHovered(false));
    await hooks(page, (w) => w.__meridian.setHovered(true));
    await expect(island(page).getByRole("button", { name: "Ask anything" })).toBeVisible();
  };

  test("Write here shows when a box has the cursor, and writes there", async ({ page }) => {
    await hooks(page, (w) => w.__mock.offerHere(true));
    await hover(page);
    await island(page).getByRole("button", { name: "Write here" }).click();
    await written(page);
    expect(await calls(page)).toHaveLength(1);
  });

  test("it hides with no box, with the buttons off, and with Write here off", async ({ page }) => {
    await hover(page);
    await expect(island(page).getByRole("button", { name: "Write here" })).toHaveCount(0);
    await hooks(page, (w) => w.__mock.offerHere(true));
    await fillOn(page, { buttons: false });
    await hover(page);
    await expect(island(page).getByRole("button", { name: "Write here" })).toHaveCount(0);
    await fillOn(page, { on: false, buttons: true });
    await hover(page);
    await expect(island(page).getByRole("button", { name: "Write here" })).toHaveCount(0);
    // Fill this form is for a later version.
    await expect(island(page).getByRole("button", { name: "Fill this form" })).toHaveCount(0);
  });
});

test.describe("asking from the island", () => {
  const ask = async (page: Page, question: string) => {
    await hooks(page, (w) => w.__meridian.setHovered(true));
    await island(page).getByRole("button", { name: "Ask anything" }).click();
    const box = island(page).getByRole("textbox", { name: "Ask anything" });
    await expect(box).toBeFocused();
    await expect(island(page)).toContainText("Enter sends · Esc closes · Hold Ctrl Alt V to talk instead");
    await box.fill(question);
    await box.press("Enter");
  };

  test("the question stays in view while it thinks, and the answer comes back on the island and in Chat", async ({ page }) => {
    await hooks(page, (w) => w.__mock.answerNext({ text: "Tuesday at 8:10 am, from Mumbai CSMT. It is not booked yet." }));
    await ask(page, "When is my train on Tuesday?");
    await expect(island(page)).toHaveAttribute("data-view", "ask");
    await expect(island(page)).toContainText("When is my train on Tuesday?");
    await mood(page, "think");
    await expect(island(page)).toContainText("Tuesday at 8:10 am, from Mumbai CSMT.");
    await island(page).getByRole("button", { name: "Open in Chat" }).click();
    await expect(island(page)).toHaveAttribute("data-view", "expanded");
    await expect(page.locator('.message[data-role="assistant"]')).toContainText("Tuesday at 8:10 am, from Mumbai CSMT. It is not booked yet.");
    expect(await calls(page)).toEqual([]);
  });

  test("with a box that had the cursor, the answer is written there instead, with Undo", async ({ page }) => {
    await hooks(page, (w) => w.__mock.offerHere(true));
    await hooks(page, (w) => w.__mock.answerNext({ text: "Tuesday at 8:10 am, from Mumbai CSMT." }));
    await ask(page, "When is my train on Tuesday?");
    await written(page);
    expect(await calls(page)).toEqual([`start ${JSON.stringify({ instruction: null, text: "Tuesday at 8:10 am, from Mumbai CSMT.", allow: null, window: 4242 })}`]);
    // What was told to the AI about the box is not shown as the user's words.
    await hooks(page, (w) => w.__meridian.openPanel("chat"));
    await expect(page.locator('.message[data-role="user"]')).toHaveText("When is my train on Tuesday?");
    await expect(page.getByText("written into the text box")).toHaveCount(0);
  });

  test("through Claude Code too, and the AI is told where its answer goes without the user seeing it", async ({ page }) => {
    await hooks(page, (w) => {
      (w.__meridian as never as { selectEngine(id: string): void }).selectEngine("claude-code");
      w.__mock.offerHere(true);
      w.__mock.answerNext({ text: "Tuesday at 8:10 am." });
    });
    await ask(page, "When is my train on Tuesday?");
    await written(page);
    const chat = await hooks(page, (w) => w.__meridian.getState().sessions[0]) as { prompt: string; log: { kind: string; text: string }[] };
    expect(chat.prompt).toContain("written into the text box the user is typing in");
    expect(chat.log[0]).toMatchObject({ kind: "user", text: "When is my train on Tuesday?" });
  });

  test("when a check says no, the answer falls back to the island", async ({ page }) => {
    await hooks(page, (w) => w.__mock.offerHere(true));
    await hooks(page, (w) => w.__mock.hereNext({ outcome: "line", text: "Password boxes are yours to fill." }));
    await hooks(page, (w) => w.__mock.answerNext({ text: "Tuesday at 8:10 am." }));
    await ask(page, "When is my train?");
    await expect(island(page)).toHaveAttribute("data-view", "ask");
    await expect(island(page)).toContainText("Tuesday at 8:10 am.");
    await expect(island(page)).not.toContainText("Password boxes");
  });

  test("a long answer shows its first lines, and the rest is in Chat", async ({ page }) => {
    const long = "You have three things this week. On Tuesday, the 8:10 to Pune for the 2 pm at the office. On Wednesday, the design review with Asha moved to 4 pm. On Friday, the October invoice is due to Carl, and the quarter closes.";
    await page.evaluate((text) => (window as never as Hooks).__mock.answerNext({ text }), long);
    await ask(page, "What is on this week?");
    await expect(island(page).getByRole("button", { name: "Open in Chat for the rest" })).toBeVisible();
    const lines = await island(page).locator(".ask-answer").evaluate((p) => Math.round(p.getBoundingClientRect().height / parseFloat(getComputedStyle(p).lineHeight)));
    expect(lines).toBe(3);
  });

  test("when it cannot answer it says why in one line and keeps the question, and Try again asks it again", async ({ page }) => {
    await hooks(page, (w) => w.__mock.answerNext({ fail: "The key was refused." }));
    await ask(page, "When is my train on Tuesday?");
    const card = island(page).getByRole("alertdialog", { name: "Could not answer" });
    await expect(card).toContainText("The key was refused. Your question is kept.");
    await mood(page, "error");
    await hooks(page, (w) => w.__mock.answerNext({ text: "Tuesday at 8:10 am." }));
    await card.getByRole("button", { name: "Try again" }).click();
    await expect(island(page)).toContainText("Tuesday at 8:10 am.");
  });

  test("when Claude Code is signed out it says so, and offers to sign in again", async ({ page }) => {
    await hooks(page, (w) => {
      (w.__meridian as never as { selectEngine(id: string): void }).selectEngine("claude-code");
      w.__mock.setAuthed(false);
      w.__mock.answerNext({ fail: "Not logged in" });
    });
    await ask(page, "When is my train on Tuesday?");
    const card = island(page).getByRole("alertdialog", { name: "Could not answer" });
    await expect(card).toContainText("Claude Code is signed out. Your question is kept.");
    await expect(card.getByRole("button")).toHaveText(["Close", "Sign in again"]);
    // The chat's own error is said here instead.
    expect(await hooks(page, (w) => w.__meridian.getState().errors.length)).toBe(0);
    await card.getByRole("button", { name: "Close" }).click();
    await expect(island(page)).toHaveAttribute("data-view", "idle");
  });

  test("Esc closes the field, and nothing is asked", async ({ page }) => {
    await hooks(page, (w) => w.__meridian.setHovered(true));
    await island(page).getByRole("button", { name: "Ask anything" }).click();
    await island(page).getByRole("textbox", { name: "Ask anything" }).press("Escape");
    await expect(island(page)).not.toHaveAttribute("data-view", "ask");
    expect(await hooks(page, (w) => w.__meridian.getState().sessions.length)).toBe(0);
  });
});

test("About lists Ctrl Alt F for Write here", async ({ page }) => {
  await hooks(page, (w) => w.__meridian.openPanel("settings"));
  await page.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator(".setting.shortcut", { hasText: "Write here" })).toContainText("CtrlAltF");
});
