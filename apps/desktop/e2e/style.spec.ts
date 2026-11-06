import { expect, test, type Page } from "@playwright/test";

// Sounds like you, from the SentientStyle board. Gmail and Claude are the browser stand-in, and the
// tests hand out each page of sent mail themselves.

type Line = { key: string; text: string; mine: boolean };
type Mock = {
  setClaudeGmail(on: boolean): void;
  styleRead(read: number): void;
  styleFinish(emails?: number): void;
  styleFail(why: string): void;
  styleLearned(emails?: number): void;
  styleSaved(): { emails: number; lines: Line[] } | null;
};
type App = { updateSettings(p: object): Promise<void>; getState(): { notices: { title: string; body: string }[] } };

const drive = (page: Page, call: string, ...args: unknown[]) =>
  page.evaluate(([call, args]) => ((window as never as { __mock: Record<string, (...a: unknown[]) => unknown> }).__mock[call as string]!)(...(args as unknown[])), [call, args] as const);
const saved = (page: Page) => page.evaluate(() => (window as never as { __mock: Mock }).__mock.styleSaved());
const card = (page: Page) => page.getByRole("region", { name: "Sounds like you" });
const learn = (page: Page) => card(page).getByRole("button", { name: "Learn my style" });

async function openAssistant(page: Page) {
  await page.locator(".island").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Assistant", exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".island")).toHaveAttribute("data-view", "idle");
});

test("nothing is read until Learn my style is pressed", async ({ page }) => {
  await openAssistant(page);
  await expect(card(page)).toContainText("Drafts written the way you write.");
  await expect(card(page)).toContainText("Meridian reads your last 100 sent emails in Gmail");
  await expect(card(page)).toContainText("Read through your Claude account, read-only. Only the short note is kept, on this PC. The emails are not saved.");
  await expect(learn(page)).toBeEnabled();
  expect(await saved(page)).toBeNull();
});

test("with Gmail not connected, Learn my style stays off until Gmail answers", async ({ page }) => {
  await drive(page, "setClaudeGmail", false);
  await openAssistant(page);
  await expect(card(page)).toContainText("Gmail is not connected to your Claude account. Press Connect next to Gmail on Claude's page and sign in with Google, then come back.");
  await expect(learn(page)).toBeDisabled();
  await expect(card(page).getByRole("button", { name: "Connect Gmail" })).toBeVisible();

  await drive(page, "setClaudeGmail", true);
  await card(page).getByRole("button", { name: "Check again" }).click();
  await expect(learn(page)).toBeEnabled();
  await expect(card(page)).not.toContainText("Gmail is not connected");
});

test("learning shows the real count, keeps going with the panel closed, and says so on the island", async ({ page }) => {
  await openAssistant(page);
  await learn(page).click();
  await expect(card(page)).toContainText("Reading your sent mail");
  const bar = card(page).getByRole("progressbar", { name: "Emails read" });
  await expect(bar).toHaveAttribute("aria-valuenow", "0");

  await drive(page, "styleRead", 10);
  await expect(card(page).getByRole("status")).toHaveText("10 of 100 emails read");
  await drive(page, "styleRead", 37);
  await expect(bar).toHaveAttribute("aria-valuenow", "37");
  await expect(card(page)).toContainText("You can close the panel. It keeps going and tells you on the island when it is done.");

  await page.keyboard.press("Escape");
  await expect(page.locator(".island")).toHaveAttribute("data-view", "idle");
  await drive(page, "styleFinish", 100);
  await expect(page.locator(".island")).toHaveAttribute("data-view", "notification");
  await expect(page.locator(".island")).toContainText("Sounds like you");
  await expect(page.locator(".island")).toContainText("Learned from your last 100 sent emails");
  expect((await saved(page))?.emails).toBe(100);
});

test("a page that fails says where it stopped, and nothing half-learned is kept", async ({ page }) => {
  await openAssistant(page);
  await learn(page).click();
  await drive(page, "styleRead", 37);
  await drive(page, "styleFail", "Stopped at 37 of 100. Claude said Gmail is busy and to try again in a few minutes.");
  await expect(card(page)).toContainText("Not learned");
  await expect(card(page).getByRole("alert")).toHaveText("Stopped at 37 of 100. Claude said Gmail is busy and to try again in a few minutes.");
  await expect(card(page)).toContainText("Nothing was saved. Try again starts from the first email.");
  expect(await saved(page)).toBeNull();

  await card(page).getByRole("button", { name: "Try again" }).click();
  await expect(card(page).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
});

test("Stop keeps nothing and goes back to how it was", async ({ page }) => {
  await openAssistant(page);
  await learn(page).click();
  await drive(page, "styleRead", 20);
  await card(page).getByRole("button", { name: "Stop" }).click();
  await expect(learn(page)).toBeEnabled();
  await expect(card(page).getByRole("alert")).toHaveCount(0);
  expect(await saved(page)).toBeNull();
});

test("learned, it shows seven plain lines and what is kept", async ({ page }) => {
  await drive(page, "styleLearned", 100);
  await openAssistant(page);
  await expect(card(page)).toContainText("Learned from your last 100 sent emails · ");
  const keys = await card(page).locator(".style-line .style-key").allTextContents();
  expect(keys).toEqual(["Greeting", "Sign-off", "Length", "Tone", "Words you use", "Words you avoid", "Languages"]);
  await expect(card(page).getByRole("button", { name: /^Languages/ })).toContainText("English. Mixes in Hindi with family, like \"haan, done\".");
  await expect(card(page)).toContainText("Only this profile is kept, on this PC. The emails were read through your Claude account, read-only, and not saved.");
  await expect(card(page).getByRole("button", { name: "Learn again" })).toBeVisible();
  await expect(card(page)).not.toContainText("That is all the sent mail there was");
});

test("a line is changed in plain text: Esc puts it back, Enter saves it as yours, and Learn again keeps it", async ({ page }) => {
  await drive(page, "styleLearned", 100);
  await openAssistant(page);
  const signoff = card(page).getByRole("button", { name: /^Sign-off/ });
  const learned = await signoff.locator(".style-value").textContent();

  await signoff.click();
  const field = card(page).getByLabel("Sign-off");
  await expect(field).toHaveValue(learned!);
  await expect(card(page).getByRole("button", { name: /^Greeting/ })).toBeDisabled();
  await field.fill("\"Thanks,\" then \"Ravi\". Just \"R\" with people I write to often. Never \"Regards\".");
  await field.press("Escape");
  await expect(card(page).getByRole("button", { name: /^Sign-off/ })).toContainText(learned!);
  await expect(page.getByRole("heading", { name: "Assistant", exact: true })).toBeVisible();

  await card(page).getByRole("button", { name: /^Sign-off/ }).click();
  await card(page).getByLabel("Sign-off").fill("\"Thanks,\" then \"Ravi\". Just \"R\" with people I write to often.");
  await card(page).getByLabel("Sign-off").press("Enter");
  const mine = card(page).getByRole("button", { name: /^Sign-off/ });
  await expect(mine).toContainText("Your words");
  await expect(mine).toContainText("Just \"R\" with people I write to often.");
  expect((await saved(page))?.lines.find((line) => line.key === "signoff")?.mine).toBe(true);

  await card(page).getByRole("button", { name: "Learn again" }).click();
  await drive(page, "styleFinish", 100);
  await expect(card(page).getByRole("button", { name: /^Sign-off/ })).toContainText("Just \"R\" with people I write to often.");
  await expect(card(page).getByRole("button", { name: /^Greeting/ })).not.toContainText("Your words");
});

test("Forget asks once, then deletes the note", async ({ page }) => {
  await drive(page, "styleLearned", 100);
  await openAssistant(page);
  await card(page).getByRole("button", { name: "Forget" }).click();
  await expect(card(page)).toContainText("Forget your style?");
  await expect(card(page)).toContainText("Drafts go back to a plain, polite tone. The note on this PC is deleted. You can learn it again any time.");
  await card(page).getByRole("button", { name: "Cancel" }).click();
  await expect(card(page).locator(".style-line")).toHaveCount(7);
  expect(await saved(page)).not.toBeNull();

  await card(page).getByRole("button", { name: "Forget" }).click();
  await card(page).getByRole("button", { name: "Forget" }).click();
  await expect(learn(page)).toBeVisible();
  expect(await saved(page)).toBeNull();
});

test("with little sent mail, it says how much there was instead of guessing", async ({ page }) => {
  await drive(page, "styleLearned", 23);
  await openAssistant(page);
  await expect(card(page)).toContainText("Learned from 23 sent emails · ");
  await expect(card(page)).toContainText("That is all the sent mail there was. It will sound more like you if you learn again once you have sent more.");
  await expect(card(page).locator(".style-line")).toHaveCount(7);
});

test("local-only mode reads no mail, and leaves what was learned alone", async ({ page }) => {
  await page.evaluate(() => (window as never as { __meridian: App }).__meridian.updateSettings({ localOnly: true }));
  await openAssistant(page);
  await expect(card(page)).toContainText("Local-only mode is on, so Gmail is not read.");
  await expect(learn(page)).toBeDisabled();

  await drive(page, "styleLearned", 100);
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "General", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(card(page).getByRole("button", { name: "Learn again" })).toBeDisabled();
  await expect(card(page).locator(".style-line")).toHaveCount(7);
});
