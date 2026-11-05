import { expect, test, type Page } from "@playwright/test";

// The fixes and features from the November 5 review: approvals that show everything, agent folders,
// the quiet-call offer, the terminal button, and asking before looking for updates.

const island = (page: Page) => page.locator(".island");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hooks = (page: Page, call: (w: any) => unknown) => page.evaluate(`(${call.toString()})(window)`);

const watched = (page: Page) => hooks(page, (w) => w.__mock.publishWatched("watch:s1"));
const ask = (page: Page, approval: Record<string, unknown>) => page.evaluate((a) => (window as never as { __mock: { publishEvent(id: string, e: unknown): void } }).__mock.publishEvent("watch:s1", { type: "approval", approval: a }), approval);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(island(page)).toHaveAttribute("data-view", "idle");
});

test("a long command says it is cut, and Allow waits until the whole of it is open", async ({ page }) => {
  await watched(page);
  const full = `npm run build && node scripts/publish.mjs ${"--flag ".repeat(40)}&& echo FINAL_MARKER`;
  await ask(page, { id: "w2", tool: "Bash", summary: full.slice(0, 240), full });
  await expect(island(page)).toContainText("more characters not shown");
  const allow = island(page).getByRole("button", { name: "Allow once" });
  await expect(allow).toBeDisabled();
  await expect(island(page)).not.toContainText("FINAL_MARKER");
  await island(page).getByRole("button", { name: "Show all" }).click();
  await expect(island(page)).toContainText("FINAL_MARKER");
  await expect(allow).toBeEnabled();
});

test("the command stays readable with the count and fold in the header", async ({ page }) => {
  await watched(page);
  await ask(page, { id: "c1", tool: "Bash", summary: "npm publish --access public" });
  const command = island(page).locator("code.command");
  await expect(command).toHaveText("npm publish --access public");
  // The fold sat on a row of its own once, and squeezed the command to a sliver.
  expect((await command.boundingBox())!.height).toBeGreaterThan(20);
  const header = await island(page).locator(".queue-fold").boundingBox();
  const title = await island(page).getByText("wants to run Bash").boundingBox();
  expect(Math.abs(header!.y + header!.height / 2 - (title!.y + title!.height / 2))).toBeLessThan(4);
});

test("a terminal's plan offers accepting edits on one line, for this session only", async ({ page }) => {
  await hooks(page, (w) => { w.__mock.publishWatched("watch:p"); w.__mock.publishWatchedPlan("watch:p"); });
  const buttons = island(page).locator(".plan-text + .row.end button");
  await expect(island(page).getByRole("button", { name: "Approve, and accept edits" })).toBeVisible();
  await expect(island(page)).toContainText("never the default");
  // Once the shape has grown: every button on one line, and none past the island's edge.
  await expect
    .poll(async () => {
      const boxes = await Promise.all((await buttons.all()).map((b) => b.boundingBox()));
      const shape = (await island(page).boundingBox())!;
      const middles = boxes.map((b) => b!.y + b!.height / 2);
      const oneLine = Math.max(...middles) - Math.min(...middles) < 2;
      return boxes.length === 3 && oneLine && boxes.every((b) => b!.x >= shape.x && b!.x + b!.width <= shape.x + shape.width);
    })
    .toBe(true);
  await island(page).getByRole("button", { name: "Approve, and accept edits" }).click();
  await expect.poll(() => hooks(page, (w) => w.__mock.lastAnswers())).toEqual({ mode: "acceptEdits" });
});

test("starting an agent names its folder, and a folder never used is not offered", async ({ page }) => {
  await watched(page);
  await ask(page, { id: "a1", tool: "Start an agent", summary: "Start an agent: clean up", folder: "C:\\Users\\Public\\Tools" });
  await expect(island(page)).toContainText("C:\\Users\\Public\\Tools");
  await expect(island(page)).toContainText("not one you have used before");
  await expect(island(page).getByRole("button", { name: "Start" })).toHaveCount(0);
  await island(page).getByRole("button", { name: "Deny" }).click();

  // The watched session works in C:\Projects\shop, so that folder is known.
  await ask(page, { id: "a2", tool: "Start an agent", summary: "Start an agent: fix the tests", folder: "C:\\Projects\\shop" });
  await expect(island(page)).toContainText("fix the tests");
  await expect(island(page)).toContainText("Full access");
  await expect(island(page).getByRole("button", { name: "Start" })).toBeVisible();
});

test("a quiet call offers to stop, counts down in place, and Keep recording answers it", async ({ page }) => {
  await hooks(page, (w) => w.__mock.quietCall(30));
  await expect(island(page)).toContainText("No one has spoken for 15 minutes");
  await expect(island(page)).toContainText("Stops in 0:30");
  await hooks(page, (w) => w.__mock.quietCall(12));
  await expect(island(page)).toContainText("Stops in 0:12");
  await island(page).getByRole("button", { name: "Keep recording" }).click();
  expect(await hooks(page, (w) => w.__mock.keptRecording())).toBe(1);
  await expect(island(page)).not.toContainText("No one has spoken");

  // Left alone, it stops and says why.
  await hooks(page, (w) => w.__mock.quietCall(5));
  await hooks(page, (w) => w.__mock.stoppedQuiet("n1"));
  await expect(island(page)).toContainText("Nobody spoke for 15 minutes");
});

test("a finish in a terminal you are watching stays quiet, and Terminal brings one forward", async ({ page }) => {
  await watched(page);
  await hooks(page, (w) => w.__mock.setInFront([4242]));
  await hooks(page, (w) => w.__mock.publishEvent("watch:s1", { type: "status", status: "completed" }));
  await page.waitForTimeout(400);
  await expect(island(page)).not.toHaveAttribute("data-view", "notification");

  await hooks(page, (w) => (w.__mock.setInFront([]), w.__mock.publishWatched("watch:s2")));
  await hooks(page, (w) => w.__mock.publishEvent("watch:s2", { type: "status", status: "completed" }));
  await expect(island(page).getByRole("button", { name: "Terminal" })).toBeVisible();
  await island(page).getByRole("button", { name: "Terminal" }).click();
  expect(await hooks(page, (w) => w.__mock.focused())).toEqual([4242]);
});

test("looking for updates is asked about once, and the answer is kept", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  await hooks(page, (w) => w.__meridian.updateSettings({ updateChecks: null }));
  await page.clock.fastForward(31_000);
  await expect(island(page)).toContainText("Check for new versions by itself?");
  const looks = await hooks(page, (w) => w.__mock.updateLooks());
  await island(page).getByText("Check for new versions by itself?").click();
  await expect(page.getByRole("heading", { name: "Updates" })).toBeVisible();
  // Opening the page before answering asks GitHub nothing.
  await page.clock.fastForward(2_000);
  expect(await hooks(page, (w) => w.__mock.updateLooks())).toBe(looks);
  await page.getByRole("button", { name: "Yes, check" }).click();
  await expect.poll(() => hooks(page, (w) => w.__mock.updateLooks())).toBeGreaterThan(looks as number);
  await expect(page.getByRole("switch", { name: /Check for new versions by itself/ })).toBeChecked();
  expect(await hooks(page, (w) => w.__meridian.getState().settings.updateChecks)).toBe(true);
});
