import { expect, test, type Page } from "@playwright/test";

// D79: eight React Bits components, each in one place. These check each is where the decision puts it, and that
// the ones that must stay still at rest do.

type Meridian = { openPanel(): void; showPreview(name: string | null): void };
type Mock = { publishLevel(level: object): void; volumes: number[] };

const meridian = <T>(page: Page, run: (m: Meridian, mock: Mock) => T | Promise<T>) =>
  page.evaluate(`(${run.toString()})(window.__meridian, window.__mock)`) as Promise<T>;
const island = (page: Page) => page.locator(".island");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => "__meridian" in window);
});

test("the island's numbers roll, and still read as plain text", async ({ page }) => {
  await meridian(page, (m) => m.showPreview("working"));
  const clock = island(page).locator(".stage-clock");
  await expect(clock.locator(".counter").first()).toBeVisible();
  // What a screen reader hears is said once, from the hidden text, not from every numeral in the columns.
  await expect(clock.locator(".sr-only").last()).toHaveText(/^\d+:\d\d$/);
  await expect(clock.locator(".roll-digits").first()).toHaveAttribute("aria-hidden", "true");
});

test("thinking gets a sheen, and an agent finishing gets sparks round the face", async ({ page }) => {
  await meridian(page, (m) => m.showPreview("thinking"));
  await expect(island(page).locator(".label")).toHaveText(/./);
  await expect.poll(() => island(page).locator(".label").evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("linear-gradient");

  await meridian(page, (m) => m.showPreview("finished"));
  await expect.poll(() => page.locator(".spark-layer > span > *").count(), { timeout: 3000 }).toBeGreaterThan(0);
});

test("the volume can be set from the island, by pointer or by keys", async ({ page }) => {
  await meridian(page, (_, mock) => mock.publishLevel({ kind: "volume", percent: 40, muted: false }));
  const slider = page.getByRole("slider", { name: "Volume" });
  await expect(slider).toHaveAttribute("aria-valuenow", "40");
  // Once the island has settled, so the pointer lands on the slider and not on what is still leaving.
  await expect
    .poll(() => slider.evaluate((el) => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width * 0.4, r.y + r.height / 2)?.closest("[role=slider]") === el; }))
    .toBe(true);
  const box = (await slider.boundingBox())!;
  // Dragging on it moves the volume, not the island.
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => meridian(page, (_, mock) => mock.volumes.at(-1) ?? 0)).toBeGreaterThan(60);
  await slider.focus();
  await slider.press("End");
  await expect.poll(() => meridian(page, (_, mock) => mock.volumes.at(-1))).toBe(100);
});

test("Home's card has a spotlight and the Ask box a border that laps, and the greeting comes in once a day", async ({ page }) => {
  await page.evaluate(() => localStorage.removeItem("meridian.greetedOn"));
  await meridian(page, (m) => m.openPanel());
  await expect(page.locator(".now-spot.spotlight-card")).toBeVisible();
  await expect(page.locator(".ask-lap.star-border canvas")).toHaveCount(1);
  // The first opening today brings the greeting in word by word.
  await expect(page.locator(".panel-head h1 span").first()).toBeAttached();

  await page.keyboard.press("Escape");
  await expect(page.locator(".panel")).toHaveCount(0);
  await meridian(page, (m) => m.openPanel());
  // Opening again the same day shows it plainly.
  await expect(page.locator(".panel-body:not([aria-hidden]) .panel-head h1")).toHaveText(/^Good (morning|afternoon|evening)|^Hello$/);
  await expect(page.locator(".panel-body:not([aria-hidden]) .panel-head h1 span")).toHaveCount(0);
});

test("a list that scrolls softens at its bottom edge, and a short one does not", async ({ page }) => {
  await meridian(page, (m) => m.openPanel());
  await page.locator(".dock").getByRole("button", { name: "Settings", exact: true }).click();
  const reveal = () => page.locator(".settings-body .scroll-edge").evaluate((el) => getComputedStyle(el).getPropertyValue("--gradual-blur-reveal"));
  await expect.poll(reveal).toBe("0.000");
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Island", exact: true }).click();
  await expect.poll(reveal).toBe("1.000");
});
