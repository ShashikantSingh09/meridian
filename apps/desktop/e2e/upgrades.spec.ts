import { expect, test, type Page } from "@playwright/test";

// The island upgrades from the November 6 board: closing pulls it back up, how long an agent worked,
// and answering its question by typing.

const island = (page: Page) => page.locator(".island");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hooks = (page: Page, call: (w: any) => unknown) => page.evaluate(`(${call.toString()})(window)`);
const send = (page: Page, id: string, event: object) =>
  page.evaluate(([i, e]) => (window as never as { __mock: { publishEvent(id: string, event: object): void } }).__mock.publishEvent(i as string, e as object), [id, event]);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(island(page)).toHaveAttribute("data-view", "idle");
});

test.describe("closing pulls it back up", () => {
  type Frame = { t: number; w: number; h: number; y: number; words: number; clock: number };
  const settled = async (page: Page) => {
    let last = "";
    await expect.poll(async () => {
      const box = JSON.stringify(await island(page).boundingBox());
      const same = box === last;
      last = box;
      return same;
    }, { intervals: [80] }).toBe(true);
  };

  /** Samples the island every frame from the next key press, or from `start()`, for a while. */
  const record = (page: Page, words: string) =>
    page.evaluate((selector) => {
      const w = window as never as { frames: Frame[]; t0: number | null; start(): void };
      w.frames = [];
      w.t0 = null;
      w.start = () => void (w.t0 ??= performance.now());
      addEventListener("keydown", w.start, { capture: true, once: true });
      const shape = document.querySelector(".island")!;
      const opacity = (el: Element | null | undefined) => (el ? Number(getComputedStyle(el.closest(".island-content")!).opacity) : -1);
      const tick = () => {
        const box = shape.getBoundingClientRect();
        if (w.t0 !== null) {
          const clock = document.querySelector(".island .rest.ambient");
          w.frames.push({ t: performance.now() - w.t0, w: box.width, h: box.height, y: box.y, words: opacity(document.querySelector(selector)), clock: opacity(clock) });
        }
        if (w.frames.length < 90) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, words);
  const frames = async (page: Page) => {
    await page.waitForTimeout(900);
    return page.evaluate(() => (window as never as { frames: Frame[] }).frames);
  };

  test("the words go first, then it rises and narrows, height first, and the clock comes back", async ({ page }) => {
    await island(page).click();
    await expect(island(page)).toHaveAttribute("data-view", "expanded");
    await settled(page);
    const open = (await island(page).boundingBox())!;
    await record(page, ".island .panel");
    await page.keyboard.press("Escape");
    const seen = await frames(page);
    await expect(island(page)).toHaveAttribute("data-view", "idle");
    const rest = (await island(page).boundingBox())!;
    expect(rest.height).toBeLessThan(60);

    // 0 to 90 ms: the shape holds while the words fade.
    const early = seen.filter((f) => f.t < 60);
    expect(early.length).toBeGreaterThan(0);
    for (const f of early) expect([Math.round(f.w), Math.round(f.h)]).toEqual([Math.round(open.width), Math.round(open.height)]);
    for (const f of seen.filter((f) => f.h < open.height - 2)) expect(f.words).toBeLessThan(0.15);

    // Then up and in, height first.
    const share = (from: number, to: number, at: number) => (from - at) / (from - to);
    const halfway = seen.find((f) => share(open.height, rest.height, f.h) >= 0.5)!;
    expect(share(open.width, rest.width, halfway.w)).toBeLessThan(share(open.height, rest.height, halfway.h));

    // At rest by about 300 ms, and the clock fades back in only after that.
    for (const f of seen.filter((f) => f.t >= 400)) {
      expect(Math.abs(f.w - rest.width)).toBeLessThanOrEqual(2);
      expect(Math.abs(f.h - rest.height)).toBeLessThanOrEqual(2);
    }
    for (const f of seen.filter((f) => f.t < 270)) expect(f.clock).toBeLessThan(0.05);
    expect(seen[seen.length - 1]!.clock).toBeGreaterThan(0.9);
  });

  test("with reduced motion it simply fades", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await island(page).click();
    await expect(island(page)).toHaveAttribute("data-view", "expanded");
    await settled(page);
    await record(page, ".island .panel");
    await page.keyboard.press("Escape");
    const seen = await frames(page);
    const rest = (await island(page).boundingBox())!;
    for (const f of seen.filter((f) => f.t >= 50)) expect(Math.round(f.h)).toBe(Math.round(rest.height));
  });

  test("a floating island pulls back to its own resting pill when a card goes", async ({ page }) => {
    await hooks(page, (w) => w.__mock.placeIsland("down"));
    await expect(island(page)).toHaveAttribute("data-place", "down");
    await hooks(page, (w) => w.__meridian.pushNotice({ id: "n1", tone: "info", title: "Parcel arriving", body: "Today" }, 60_000));
    await expect(island(page)).toHaveAttribute("data-view", "notification");
    await settled(page);
    const card = (await island(page).boundingBox())!;
    await record(page, ".island .notice-face");
    await hooks(page, (w) => (w.start(), w.__meridian.dismissNotice("n1")));
    const seen = await frames(page);
    const rest = (await island(page).boundingBox())!;
    expect(rest.height).toBeLessThan(card.height);
    for (const f of seen.filter((f) => f.t < 60)) expect(Math.round(f.h)).toBe(Math.round(card.height));
    // Where it was dragged to, in its own shape: a pill with all four corners round.
    for (const f of seen) expect(Math.round(f.y)).toBe(12);
    await expect(page.locator(".island-body path")).toHaveAttribute("d", /Z$/);
  });
});

test.describe("how long it worked", () => {
  test("while it works, the card shows the time so far, the step under way and the last few, and Stop stops it", async ({ page }) => {
    // Held still between steps, so each lands on its exact second.
    await page.clock.install({ time: new Date("2026-11-06T09:00:00") });
    await page.goto("/");
    await expect.poll(() => hooks(page, (w) => w.__meridian.getState().agents.length)).toBeGreaterThan(0);
    await page.clock.pauseAt(new Date("2026-11-06T09:00:10"));
    const id = (await hooks(page, (w) => w.__meridian.startSession({ agent: "claude-code", cwd: "C:\\Projects\\shop", prompt: "fix the cart quietly", model: null }))) as string;
    await page.clock.runFor(100);
    await page.clock.runFor(18_000);
    await send(page, id, { type: "activity", label: "Editing src/cart.ts" });
    await page.clock.runFor(41_000);
    await send(page, id, { type: "activity", label: "$ npm test" });
    await page.clock.runFor(41_000);
    await hooks(page, (w) => w.__meridian.setHovered(true));
    await page.clock.runFor(300);

    const card = page.locator(".stage-card");
    await expect(card).toContainText("Claude Code · shop");
    await expect(card).toContainText("Working · 1 min 40 s");
    await expect(page.locator(".stage-current")).toHaveText("Running npm test");
    const rows = page.locator(".step-log-row");
    await expect(rows).toHaveText(["0:18Read src/main.rs", "0:41Changed src/cart.ts", "0:41Running npm test"]);
    await expect(rows.last()).toHaveAttribute("data-now", "true");
    // The time and the step under way count on by themselves.
    await page.clock.runFor(5000);
    await expect(card).toContainText("Working · 1 min 45 s");
    await expect(rows.last()).toContainText("0:46");

    await expect(card.getByRole("button", { name: "Show all steps" })).toBeVisible();
    await card.getByRole("button", { name: "Stop", exact: true }).click();
    await page.clock.runFor(500);
    await expect(island(page)).not.toHaveAttribute("data-view", "working");
  });

  test("a session in a terminal can be followed but not stopped from the island, and Show all steps opens it", async ({ page }) => {
    await hooks(page, (w) => w.__mock.publishWatched("watch:s1"));
    await hooks(page, (w) => w.__meridian.setHovered(true));
    const card = page.locator(".stage-card");
    await expect(card).toContainText("Working ·");
    await expect(card.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await card.getByRole("button", { name: "Show all steps" }).click();
    await expect(island(page)).toHaveAttribute("data-view", "expanded");
    await expect(page.locator(".session-head")).toContainText("shop");
  });

  test("when it finishes, the card says how long it worked and what each step was, in plain words", async ({ page }) => {
    // Held still between steps, so each lands on its exact second.
    await page.clock.install({ time: new Date("2026-11-06T09:00:00") });
    await page.goto("/");
    await page.clock.pauseAt(new Date("2026-11-06T09:00:10"));
    const at = async (seconds: number, event: object) => {
      const now = (await page.evaluate(() => Date.now())) as number;
      await page.clock.runFor(Math.max(0, start + seconds * 1000 - now));
      await send(page, "watch:w", event);
    };
    await send(page, "watch:w", { type: "watched", agent: "Claude Code", cwd: "C:\\Projects\\shop", title: "Fix the cart total", pid: 4242 });
    const start = (await page.evaluate(() => Date.now())) as number;
    await at(3, { type: "activity", label: "Reading cart.ts" });
    await at(9, { type: "activity", label: "Reading total.ts" });
    await at(12, { type: "activity", label: "Reading tax.ts" });
    await at(15, { type: "activity", label: "Reading money.ts" });
    await at(18, { type: "activity", label: "Editing cart.ts" });
    await at(18, { type: "diff", path: "cart.ts", removed: ["a"], added: ["b"], linesRemoved: 1, linesAdded: 1 });
    await at(59, { type: "activity", label: "$ npm test" });
    await at(120, { type: "output", command: "npm test", lines: ["Tests  2 failed | 46 passed (48)"], failed: true });
    await at(124, { type: "activity", label: "Editing total.ts" });
    await at(146, { type: "activity", label: "$ npm test" });
    await at(180, { type: "output", command: "npm test", lines: ["Tests  48 passed (48)"], failed: false });
    await at(185, { type: "text", text: "The cart total is fixed." });
    await at(192, { type: "status", status: "completed" });
    await page.clock.runFor(1000);

    await expect(island(page)).toHaveAttribute("data-view", "notification");
    const card = page.locator(".stage-end");
    await expect(card).toContainText("Claude Code · shop");
    await expect(card).toContainText("Done");
    await expect(card).toContainText("Fix the cart total");
    await expect(card).toContainText("Worked for 3 min 12 s · 6 steps");
    await expect(page.locator(".step-log-row")).toHaveText([
      "0:18Read cart.ts and 3 other files",
      "0:41Changed cart.ts, 1 line",
      "1:05Ran npm test: 2 failed",
      "0:22Changed total.ts",
      "0:39Ran npm test: all 48 passed",
      "0:07Wrote a summary",
    ]);
    const [shape, last] = await Promise.all([page.locator(".island-shape").boundingBox(), page.locator(".stage-actions").boundingBox()]);
    expect(last!.y + last!.height).toBeLessThanOrEqual(shape!.y + shape!.height);
    await card.getByRole("button", { name: "Terminal" }).click();
    expect(await hooks(page, (w) => w.__mock.focused())).toEqual([4242]);
  });
});

test.describe("answering a question by typing", () => {
  const ask = (page: Page) => hooks(page, (w) => (w.__mock.publishWatched("watch:q"), w.__mock.publishWatchedQuestion("watch:q")));

  test("its own options show as buttons beside a box, Enter sends what was typed, and it folds back to the working line", async ({ page }) => {
    await ask(page);
    await expect(island(page)).toContainText("Has a question");
    await expect(island(page).getByRole("button", { name: "Teal" })).toBeVisible();
    await expect(island(page).getByRole("button", { name: "Amber" })).toBeVisible();
    const box = island(page).getByLabel("Type an answer");
    await expect(box).toHaveAttribute("placeholder", "Type an answer…");

    // Nothing is ever picked for the user: an empty box sends nothing.
    await box.click();
    await box.press("Enter");
    await expect(island(page)).toContainText("Which one?");
    expect(await hooks(page, (w) => w.__mock.lastAnswers())).toBeNull();
    await expect(island(page).locator('.question-option[aria-pressed="true"]')).toHaveCount(0);

    await box.fill("Rupees, but keep dollars for the US store");
    await expect(island(page).locator(".question-options")).toHaveAttribute("data-typing", "true");
    await box.press("Enter");
    await expect(island(page)).toContainText("And then?");
    await expect(box).toHaveValue("");
    await box.fill("Ship it on Friday");
    await box.press("Enter");

    await expect.poll(() => hooks(page, (w) => w.__mock.lastAnswers())).toEqual({ "Which one?": "Rupees, but keep dollars for the US store", "And then?": "Ship it on Friday" });
    await expect(island(page)).toContainText("Sent. Claude Code is working.");
    await expect(island(page).getByLabel("Type an answer")).toHaveCount(0);
    await expect(island(page)).toHaveAttribute("data-view", "working");
    // The island took the keyboard for the box and gave it back once the answer went.
    expect(await hooks(page, (w) => w.__mock.keyboard())).toEqual([true, false]);
  });

  test("answered in the terminal first, the question leaves the island by itself", async ({ page }) => {
    await ask(page);
    await expect(island(page)).toContainText("Which one?");
    await hooks(page, (w) => w.__mock.answerInTerminal("watch:q"));
    await expect(island(page)).toContainText("Answered in the terminal");
    await expect(island(page)).not.toContainText("Which one?");
    await expect(island(page)).not.toContainText("Answered in the terminal", { timeout: 6000 });
    await expect(island(page)).toContainText("Editing cart.ts");
  });
});
