import { expect, test, type Page } from "@playwright/test";

// D78: the panel is the island grown. Each page has its own size, the tabs float in a capsule, state colour shows as
// light, the face rides into the panel's head, and Home shows one card for what is happening now.

type Meridian = { openPanel(): void; startSession(r: object): Promise<string | null> };

const meridian = <T>(page: Page, run: (m: Meridian) => T | Promise<T>) => page.evaluate(`(${run.toString()})(window.__meridian)`) as Promise<T>;
const island = (page: Page) => page.locator(".island");
const tab = (page: Page, name: string) => page.locator(".dock").getByRole("button", { name, exact: true });
const size = async (page: Page) => {
  const box = await island(page).boundingBox();
  return [Math.round(box!.width), Math.round(box!.height)];
};

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => "__meridian" in window);
  await meridian(page, (m) => m.openPanel());
  await expect(island(page)).toHaveAttribute("data-view", "expanded");
});

test("a session in Agents shows its character in its state, and how long, how many steps and how many lines", async ({ page }) => {
  await meridian(page, (m) => m.startSession({ agent: "claude-code", cwd: "C:\\Projects\\shop", prompt: "Fix the cart", model: null }));
  await page.locator(".now").click();
  await page.locator(".session-row, .list-row, button").filter({ hasText: "shop" }).first().click();
  const stats = page.locator(".session-stats");
  await expect(stats).toContainText(/Working for|Worked for/);
  await expect(stats).toContainText("Steps");
  await expect(stats).toContainText("Lines changed");
  await expect(page.locator(".session .session-face .face")).toHaveAttribute("data-mood", /working|needs/);
});

test("the island reshapes to each page, and the capsule follows its bottom edge", async ({ page }) => {
  await expect.poll(() => size(page)).toEqual([760, 470]);
  await tab(page, "Chat").click();
  await expect.poll(() => size(page)).toEqual([820, 540]);
  await tab(page, "Media").click();
  await expect.poll(() => size(page)).toEqual([720, 420]);
  const [shape, capsule] = await Promise.all([island(page).boundingBox(), page.locator(".capsule").boundingBox()]);
  expect(capsule!.y - (shape!.y + shape!.height)).toBeCloseTo(10, 0);
});

test("the face rides into the empty slot in the panel's head, and the head keeps no face of its own", async ({ page }) => {
  await expect(page.locator(".panel-head .face")).toHaveCount(0);
  await expect
    .poll(async () => {
      const [slot, face] = await Promise.all([page.locator(".face-slot").boundingBox(), page.locator(".riding-face .face").boundingBox()]);
      return Math.round(Math.abs(face!.x - slot!.x));
    })
    .toBeLessThanOrEqual(1);
});

test("the open panel glows in the state colour while an agent works or waits, and not when nothing is under way", async ({ page }) => {
  await expect(island(page)).not.toHaveAttribute("data-glowing", /.*/);
  await expect(page.locator(".now")).toContainText("Nothing running");
  await meridian(page, (m) => m.startSession({ agent: "claude-code", cwd: "C:\\Projects\\shop", prompt: "Fix the cart", model: null }));
  await expect(island(page)).toHaveAttribute("data-glowing", "true");
  // Blue while it works (--state-working), amber once it waits for you (--state-waiting).
  await expect(island(page)).toHaveCSS("--glow", /#4aa3ff|#ff9f0a/);
  await expect(page.locator(".now")).toContainText("shop");
  await page.locator(".now").click();
  await expect(tab(page, "Agents")).toHaveAttribute("aria-current", "page");
});

test("Home is live tiles (D80): now with the character, the time, the next event and music, then Ask", async ({ page }) => {
  await expect(page.locator(".home .tile")).toHaveCount(4);
  await expect(page.locator(".home .now .face")).toHaveAttribute("data-face", "lantern");
  await expect(page.locator(".home .time-tile")).toContainText(/\d:\d\d/);
  await expect(page.locator(".home .next-tile")).toContainText("Nothing else today");
  await expect(page.locator(".home .music-tile")).toContainText("Nothing playing");
  await expect(page.locator(".home .now")).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "Ask anything" })).toBeVisible();
  await expect(page.locator(".bento, .home-feed, .home-today, .big-clock")).toHaveCount(0);
  await expect(page.locator(".now").getByRole("button", { name: "Focus for 25 min" })).toBeVisible();
});
