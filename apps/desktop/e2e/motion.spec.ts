import { expect, test, type Page } from "@playwright/test";

// The motion left over from the November 5 boards: the smiley's mouth, leaning while dragged, and a
// card that shows it is about to close.

const island = (page: Page) => page.locator(".island");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hooks = (page: Page, call: (w: any) => unknown) => page.evaluate(`(${call.toString()})(window)`);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(island(page)).toHaveAttribute("data-view", "idle");
});

test("the smiley's mouth moves while it speaks, even with no voice playing", async ({ page }) => {
  await hooks(page, (w) => w.__meridian.updateSettings({ face: "smile" }));
  await hooks(page, (w) => w.__meridian.feel("speak", 4000));
  const mouth = island(page).locator('.face[data-face="smile"] .mouth');
  await expect(mouth).toHaveCount(1);
  const shapes = new Set<string>();
  for (let i = 0; i < 12; i++) {
    shapes.add(await mouth.evaluate((m) => getComputedStyle(m).getPropertyValue("d")));
    await page.waitForTimeout(120);
  }
  // Opening and closing, not one fixed shape.
  expect(shapes.size).toBeGreaterThanOrEqual(3);
});

test("the smiley's mouth turns with its eyes", async ({ page }) => {
  await hooks(page, (w) => w.__meridian.updateSettings({ face: "smile" }));
  const mouth = island(page).locator('.face[data-face="smile"] .sm-mouth');
  await island(page).locator(".face").evaluate((f) => (f as HTMLElement).style.setProperty("--gx", "4px"));
  // A little less far than the eyes: 40% of their 4 px.
  await expect.poll(() => mouth.evaluate((m) => getComputedStyle(m).translate)).toMatch(/^1\.6px/);
});

test("dragged, the face leans the way it moves and squashes when let go", async ({ page }) => {
  await page.waitForTimeout(600);
  const box = (await island(page).boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y + 20, { steps: 6 });
  await expect(island(page)).toHaveAttribute("data-dragging", "true");
  const face = island(page).locator(".face").first();
  await expect(face).toHaveAttribute("data-mood", "drag");
  // The core reports the lean from how fast the island moves.
  await hooks(page, (w) => w.__mock.lean(4));
  await expect.poll(() => face.evaluate((f) => getComputedStyle(f).rotate)).toBe("4deg");
  // Held for longer than the old one-shot, it is still lifted.
  await page.waitForTimeout(1900);
  await expect(face).toHaveAttribute("data-mood", "drag");
  await page.mouse.up();
  await expect(face).toHaveAttribute("data-dropped", "");
  await expect(face).not.toHaveAttribute("data-mood", "drag");
  await expect(face).not.toHaveAttribute("data-dropped", "");
});

test("a card that closes by itself shows a line in its last 5 s, and Pin keeps it", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  await hooks(page, (w) => w.__meridian.pushNotice({ tone: "info", title: "Lunch with Asha", body: "In 10 minutes" }));
  await expect(island(page)).toHaveAttribute("data-view", "notification");
  await expect(island(page).locator(".closing-line")).toHaveCount(0);
  await page.clock.fastForward(1500);
  await expect(island(page).locator(".closing-line")).toHaveCount(1);
  await island(page).getByRole("button", { name: "Pin, keep it open" }).click();
  await expect(island(page).locator(".closing-line")).toHaveCount(0);
  await page.clock.fastForward(60_000);
  await expect(island(page)).toContainText("Lunch with Asha");
  await island(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(island(page)).not.toContainText("Lunch with Asha");
});

test("a card held by the pointer gets a fresh 5 s with the line once the pointer leaves", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  await hooks(page, (w) => w.__meridian.pushNotice({ tone: "info", title: "Parcel arriving", body: "Today" }));
  await hooks(page, (w) => w.__meridian.setHovered(true));
  await page.clock.runFor(10_000);
  await expect(island(page)).toContainText("Parcel arriving");
  await expect(island(page).locator(".closing-line")).toHaveAttribute("data-held", "true");
  await hooks(page, (w) => w.__meridian.setHovered(false));
  await page.clock.runFor(2000);
  await expect(island(page)).toContainText("Parcel arriving");
  await expect(island(page).locator(".closing-line")).not.toHaveAttribute("data-held", "true");
  await page.clock.runFor(6000);
  await expect(island(page)).not.toContainText("Parcel arriving");
});
