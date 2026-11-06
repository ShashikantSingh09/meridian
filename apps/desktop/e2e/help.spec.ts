import { expect, test, type Page } from "@playwright/test";

// The fake stream is real to the page, so the microphone check opens and closes it the way it does on a PC.
test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } });

type Meridian = {
  openPanel(): void;
  updateSettings(p: object): Promise<void>;
  getState(): { tab: string; chat: { messages: { content: string }[] }; sessions: unknown[] };
  startSession(r: object): Promise<string | null>;
  refreshNotes(): Promise<void>;
  bridge: Record<string, (...args: never[]) => Promise<unknown>>;
};
type Mock = Record<string, (...args: never[]) => unknown>;

const meridian = <T>(page: Page, run: (m: Meridian, mock: Mock) => T | Promise<T>) =>
  page.evaluate(`(${run.toString()})(window.__meridian, window.__mock)`) as Promise<T>;

/** 3 pm, so the morning's own set stays out. */
const AFTERNOON = new Date(2026, 10, 6, 15, 0);

async function open(page: Page, { firstDay = false } = {}) {
  await page.clock.setFixedTime(AFTERNOON);
  await page.addInitScript((firstDay) => {
    if (!firstDay && !localStorage.getItem("meridian.firstSeen")) localStorage.setItem("meridian.firstSeen", "1");
    const device = (kind: string, deviceId: string, label: string) => ({ kind, deviceId, label, groupId: label });
    const list = [device("audioinput", "default", "Default - Realtek microphone"), device("audioinput", "mic-ac", "Realtek microphone"), device("audiooutput", "out-speakers", "Speakers (Realtek Audio)")];
    navigator.mediaDevices.enumerateDevices = async () => [...list] as MediaDeviceInfo[];
    // Kept on the page, so a test never touches the clipboard of the PC it runs on.
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => void Object.assign(window, { __copied: text }) } });
  }, firstDay);
  await page.goto("/");
  await page.waitForFunction(() => "__meridian" in window);
  await meridian(page, (m) => m.openPanel());
  await expect(page.locator(".panel")).toBeVisible();
}

const chips = (page: Page) => page.getByRole("group", { name: "Things to ask" }).getByRole("button");
const ask = (page: Page) => page.getByRole("textbox", { name: "Ask anything" });

test.describe("starters on Home", () => {
  test("a quiet moment shows three that always work, never an empty row", async ({ page }) => {
    await open(page);
    await expect(chips(page)).toHaveText(["What's on tomorrow?", "Anything I owe people?", "Play some music"]);
  });

  test("the first day offers set-up steps, and a step drops off once it is done", async ({ page }) => {
    await open(page, { firstDay: true });
    await expect(chips(page)).toHaveText(["What can you do?", "Connect Gmail", "Set up wake words", "Take notes on my next call", "Play something calm"]);
    await expect(page.getByText("Once Meridian has seen a day or two")).toBeVisible();
    await meridian(page, (m) => m.updateSettings({ wakeEnabled: true }));
    await expect(chips(page).filter({ hasText: "Set up wake words" })).toHaveCount(0);
  });

  test("agents at work bring their own, and pointing at one says why it is there", async ({ page }) => {
    await open(page);
    await meridian(page, (m) => m.startSession({ agent: "claude-code", cwd: "C:\\Projects\\shop", prompt: "Fix the cart", model: null }));
    await expect(chips(page)).toHaveText(["Which one needs me?", "What are my agents doing?", "What's on tomorrow?", "Anything I owe people?"]);
    await chips(page).filter({ hasText: "What are my agents doing?" }).hover();
    await expect(page.getByRole("tooltip")).toHaveText("Because 1 agent is working");
    await chips(page).filter({ hasText: "Which one needs me?" }).hover();
    await expect(page.getByRole("tooltip")).toHaveText("Because shop is waiting for you");
  });

  test("a call that just ended comes first, with the person on it", async ({ page }) => {
    await open(page);
    await meridian(page, async (m, mock) => {
      await m.updateSettings({ voiceHearing: "elevenlabs" });
      const id = (await m.bridge.noteStart()) as string;
      await m.bridge.noteStop();
      mock.finishNote();
      await (m.bridge.noteRenameSpeaker as (id: string, speaker: string, name: string) => Promise<void>)(id, "p2", "Asha");
      await m.refreshNotes();
    });
    await expect(chips(page)).toHaveText(["Summarise my last call", "What did we agree?", "Draft the to-dos for Asha", "What's on tomorrow?"]);
    await chips(page).first().hover();
    await expect(page.getByRole("tooltip")).toContainText("Because your call with Asha ended at");
  });

  test("picking one fills the box and sends nothing until Enter", async ({ page }) => {
    await open(page);
    await chips(page).filter({ hasText: "Play some music" }).click();
    await expect(ask(page)).toHaveValue("Play some music");
    await expect(ask(page)).toBeFocused();
    await expect(page.getByText("Enter sends. Change the words first if you like.")).toBeVisible();
    await expect(page.locator(".starters")).toHaveAttribute("data-dim", "true");
    expect(await meridian(page, (m) => [m.getState().tab, m.getState().chat.messages.length, m.getState().sessions.length])).toEqual(["home", 0, 0]);

    await ask(page).press("Enter");
    await expect.poll(() => meridian(page, (m) => m.getState().chat.messages[0]?.content)).toBe("Play some music");
  });

  test("Settings › Assistant › Suggestions on Home hides them", async ({ page }) => {
    await open(page);
    await expect(chips(page)).toHaveCount(3);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Assistant", exact: true }).click();
    await page.getByRole("switch", { name: /Suggestions on Home/ }).uncheck();
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await expect(ask(page)).toBeVisible();
    await expect(page.locator(".starters")).toHaveCount(0);
  });
});

test.describe("Test and repair", () => {
  const row = (page: Page, name: string) => page.locator(".repair-row", { has: page.getByText(name, { exact: true }) });
  const status = (page: Page) => page.locator(".repair-head [role=status]");

  /** Six fine, and two that need you: hooks that went missing, and Gmail not connected on Claude's side. */
  async function openRepair(page: Page, setUp?: (m: Meridian, mock: Mock) => unknown) {
    await open(page);
    await meridian(page, async (m, mock) => {
      await m.updateSettings({ voiceHearing: "elevenlabs" });
      await (m.bridge.voiceKeySet as (p: string, k: string) => Promise<void>)("elevenlabs", "key");
      mock.loseHooks();
      mock.noRegisteredApps();
      (mock.setGmailOnClaude as (on: boolean) => void)(false);
    });
    if (setUp) await meridian(page, setUp);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "About", exact: true }).click();
    await page.getByRole("button", { name: /^Test and repair/ }).click();
    await expect(page.getByRole("heading", { name: "Test and repair" })).toBeVisible();
  }

  test("checks eight things on opening, and says which need you", async ({ page }) => {
    await openRepair(page);
    await expect(status(page)).toHaveText(/^Checked .* · 6 fine, 2 need you$/);
    await expect(page.locator(".repair-name")).toHaveText(["Microphone", "Wake words", "Speech", "AI sign-in", "Claude Code hooks", "Gmail", "Updates", "Notes recording"]);
    // Named as Windows names the device that opened, which here is the browser's fake one.
    await expect(row(page, "Microphone")).toContainText("Fake Default Audio Input · hears you");
    await expect(row(page, "Claude Code hooks")).toHaveAttribute("data-state", "needs");
    await expect(row(page, "Claude Code hooks")).toContainText("Missing from your Claude Code settings");
    await expect(row(page, "Gmail")).toContainText("Not connected to your Claude account");
  });

  test("Fix shows the lines it will add, puts the hooks back only after Add hooks, then checks again", async ({ page }) => {
    await openRepair(page);
    await row(page, "Claude Code hooks").getByRole("button", { name: "Fix" }).click();
    const review = page.getByRole("group", { name: "Review this change" });
    await expect(review).toContainText("This will add these lines");
    expect(await meridian(page, (_, mock) => mock.watching())).toBe(false);
    await review.getByRole("button", { name: "Add hooks" }).click();
    await expect(review).toHaveCount(0);
    await expect(row(page, "Claude Code hooks")).toContainText("Fixed. Added again and checked.");
    await expect(row(page, "Claude Code hooks")).toHaveAttribute("data-state", "fixed");
    expect(await meridian(page, (_, mock) => mock.watching())).toBe(true);
    await expect(status(page)).toHaveText(/7 fine, 1 needs you$/);
  });

  test("Gmail needs you on Claude's page, so Fix gives the steps", async ({ page }) => {
    await openRepair(page);
    await row(page, "Gmail").getByRole("button", { name: "Fix" }).click();
    await expect(row(page, "Gmail")).toContainText("This one needs you, on Claude's page:");
    await expect(row(page, "Gmail").getByRole("listitem")).toHaveText(["Open Claude's connectors page.", "Press Connect next to Gmail and sign in with Google.", "Come back and press Run again."]);
    await expect(row(page, "Gmail").getByRole("button", { name: "Open Claude's page" })).toBeVisible();

    await meridian(page, (_, mock) => (mock.setGmailOnClaude as (on: boolean) => void)(true));
    await row(page, "Gmail").getByRole("button", { name: "Run again" }).click();
    await expect(row(page, "Gmail")).toContainText("Connected through your Claude account");
  });

  test("Copy a report gives plain text with no messages, recordings, notes or project names", async ({ page }) => {
    await openRepair(page, async (m, mock) => {
      await m.bridge.watchSet(true as never);
      (mock.setHooksOff as (projects: string[]) => void)(["C:\\Projects\\shop"]);
      await m.updateSettings({ agentDefaultDir: "C:\\Projects\\shop" });
    });
    await expect(row(page, "Claude Code hooks")).toContainText("Turned off in 1 project: shop");
    await page.getByRole("button", { name: "Copy a report" }).click();
    await expect(page.getByText("Report copied. It has no messages, recordings or notes.")).toBeVisible();
    const report = await page.evaluate(() => (window as never as { __copied: string }).__copied);
    expect(report.split("\n")[1]).toBe("No messages, recordings or notes are in this report.");
    expect(report).toContain("Claude Code hooks needs you   off in 1 project");
    expect(report).toContain("Gmail             needs you   not connected");
    expect(report).not.toContain("shop");
  });

  test("Stop ends a run where it is, and leaves the rest unchecked", async ({ page }) => {
    await openRepair(page, (_, mock) => mock.holdConnectors());
    await expect(status(page)).toHaveText("Checking · 6 of 8");
    await expect(row(page, "Gmail")).toContainText("Asking your Claude account");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(row(page, "Gmail")).toContainText("Not checked");
    await expect(row(page, "Notes recording")).toContainText("Not checked");
    await expect(status(page)).toHaveText(/^Stopped at /);
    await meridian(page, (_, mock) => mock.releaseConnectors());
    await expect(row(page, "Gmail")).toContainText("Not checked");
  });

  test("the row in About shows the last result", async ({ page }) => {
    await openRepair(page);
    await expect(status(page)).toHaveText(/2 need you$/);
    await page.getByRole("button", { name: "About ›" }).click();
    await expect(page.getByRole("button", { name: /^Test and repair/ })).toContainText("2 need you");

    await meridian(page, async (m, mock) => {
      await m.bridge.watchSet(true as never);
      (mock.setGmailOnClaude as (on: boolean) => void)(true);
    });
    await page.getByRole("button", { name: /^Test and repair/ }).click();
    await expect(status(page)).toHaveText(/all 8 fine$/);
    await page.getByRole("button", { name: "About ›" }).click();
    await expect(page.getByRole("button", { name: /^Test and repair/ })).toContainText("All 8 fine");
  });
});
