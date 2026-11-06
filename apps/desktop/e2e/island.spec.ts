import { expect, test, type Page } from "@playwright/test";

const island = (page: Page) => page.locator(".island");
const preview = (page: Page, name: string | null) =>
  page.evaluate((n) => (window as never as { __meridian: { showPreview(n: string | null): void } }).__meridian.showPreview(n), name);

const useEngine = async (page: Page, name: string) => {
  await page.getByRole("button", { name: "AI engine" }).click();
  await page.getByRole("menuitemradio", { name }).click();
};

const openModels = async (page: Page) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "AI models", exact: true }).click();
  await page.getByRole("button", { name: "Use an API key instead" }).click();
};

const settled = async (page: Page) => {
  // Three polls in a row, 240 ms: closing holds the shape still for 90 ms before it pulls up, so two could match too soon.
  let last = "";
  let same = 0;
  await expect
    .poll(
      async () => {
        const box = JSON.stringify(await island(page).boundingBox());
        same = box === last ? same + 1 : 0;
        last = box;
        return same >= 3;
      },
      { intervals: [80] },
    )
    .toBe(true);
};

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(island(page)).toHaveAttribute("data-view", "idle");
});

test("every compact state renders its own content and stays on screen", async ({ page }) => {
  const expected: [string, string, string | null][] = [
    ["thinking", "thinking", "Thinking"],
    ["working", "working", "Editing"],
    ["to-do list", "working", "Step 3 of 5"],
    ["approval", "working", "Allow"],
    ["notification", "notification", "Claude Code finished"],
    ["finished", "notification", "Worked for"],
    ["stopped", "error", "dock-agent stopped"],
    ["contextual", "contextual", "Suggest fix"],
    ["multitask", "multitask", "billing-api"],
    ["error", "error", "Anthropic unreachable"],
  ];
  for (const [name, view, text] of expected) {
    await preview(page, name);
    await expect(island(page)).toHaveAttribute("data-view", view);
    if (text) await expect(island(page)).toContainText(text);
    await settled(page);
    const box = await island(page).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(860);
  }
});

test("hangs from the top edge of the window with a flat top", async ({ page }) => {
  const box = await island(page).boundingBox();
  expect(box!.y).toBe(0);
  const corners = await page.locator(".island-shape").evaluate((el) => {
    const style = getComputedStyle(el);
    return [style.borderTopLeftRadius, style.borderBottomLeftRadius];
  });
  expect(corners[0]).toBe("0px");
  expect(parseFloat(corners[1])).toBeGreaterThan(8);
  const outline = await page.locator(".island-body path").getAttribute("d");
  expect(outline).toMatch(/^M-[\d.]+ 0/);
  await expect(page.locator(".island-body path")).toHaveCount(1);
});

test("old and new content never show at once for long", async ({ page }) => {
  await preview(page, "notification");
  await settled(page);
  await preview(page, "error");
  await expect(page.locator(".island-content")).toHaveCount(1, { timeout: 400 });
});

test("the island is one element that morphs, never a swap", async ({ page }) => {
  const handle = await island(page).elementHandle();
  await preview(page, "working");
  await settled(page);
  await preview(page, "expanded");
  await settled(page);
  expect(await handle!.evaluate((el) => el.isConnected)).toBe(true);
  expect((await island(page).boundingBox())!.width).toBeGreaterThan(700);
});

test("a preview ends by itself, and what arrived meanwhile is not lost", async ({ page }) => {
  await page.evaluate(() => (window as never as { __mock: { publishWatched(id: string): void } }).__mock.publishWatched("watch:real"));
  await expect(island(page)).toContainText("Editing cart.ts");
  await preview(page, "error");
  await expect(island(page)).toContainText("Anthropic unreachable");
  await page.evaluate(() => (window as never as { __mock: { publishWatchedApproval(id: string): void } }).__mock.publishWatchedApproval("watch:real"));
  await expect(island(page)).toContainText("Anthropic unreachable");
  await expect(island(page)).toContainText("npm install stripe", { timeout: 10_000 });
});

test("a preview shows from the panel, gives focus back, and opening the panel ends it", async ({ page }) => {
  await island(page).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Island", exact: true }).click();
  await page.getByRole("button", { name: "working", exact: true }).click();
  await expect(island(page)).toHaveAttribute("data-view", "working");
  await page.evaluate(() => (window as never as { __meridian: { openPanel(): void } }).__meridian.openPanel());
  await expect(island(page)).toHaveAttribute("data-view", "expanded");
  await page.keyboard.press("Escape");
  await expect(island(page)).toHaveAttribute("data-view", "idle");
});

test("no sample music shows through a later preview", async ({ page }) => {
  await preview(page, "media");
  await expect(island(page)).toHaveAttribute("data-view", "media");
  await preview(page, "idle");
  await expect(island(page)).toHaveAttribute("data-view", "idle");
});

test("a long line stops at its ellipsis, short of the button beside it", async ({ page }) => {
  await page.evaluate(() =>
    (window as never as { __meridian: { pushNotice(n: object): void } }).__meridian.pushNotice({ tone: "info", title: "A very long title ".repeat(8), body: "A very long body ".repeat(8) }),
  );
  await expect(island(page)).toHaveAttribute("data-view", "notification");
  const text = await island(page).locator(".text-button .label").boundingBox();
  const dismiss = await island(page).getByRole("button", { name: "Dismiss" }).boundingBox();
  expect(text!.x + text!.width).toBeLessThanOrEqual(dismiss!.x);
});

test("the answers so far survive the pointer leaving", async ({ page }) => {
  const hover = (on: boolean) => page.evaluate((v) => (window as never as { __meridian: { setHovered(v: boolean): void } }).__meridian.setHovered(v), on);
  await page.evaluate(() => {
    const mock = (window as never as { __mock: { publishWatched(id: string): void; publishWatchedQuestion(id: string): void } }).__mock;
    mock.publishWatched("watch:h");
    mock.publishWatchedQuestion("watch:h");
  });
  await hover(true);
  await page.waitForTimeout(260);
  await island(page).getByRole("button", { name: "Amber" }).click();
  await expect(island(page)).toContainText("And then?");
  await hover(false);
  await page.waitForTimeout(320);
  await expect(island(page)).toContainText("And then?");
});

test("long words on the island never push its buttons off the edge", async ({ page }) => {
  await preview(page, "contextual");
  const long = "Error: something went wrong in a very long stack trace line ".repeat(4);
  await page.locator(".island .body").evaluate((el, text) => (el.textContent = text), long);
  await settled(page);
  const shape = await page.locator(".island-shape").boundingBox();
  const button = await island(page).getByRole("button", { name: "Ignore" }).boundingBox();
  expect(button!.y + button!.height).toBeLessThanOrEqual(shape!.y + shape!.height);
});

test("a long question leaves its answers and Skip on the island, and still shows two lines", async ({ page }) => {
  await page.evaluate(() => {
    const mock = (window as never as { __mock: { publishWatched(id: string): void; publishWatchedQuestion(id: string, multi: boolean): void } }).__mock;
    mock.publishWatched("watch:long");
    mock.publishWatchedQuestion("watch:long", true);
  });
  await expect(island(page)).toContainText("Which one?");
  await settled(page);
  const line = await page.locator(".question-text").evaluate((el) => {
    const shortHeight = el.getBoundingClientRect().height;
    el.textContent = "Which of these should this use, given everything we know about how it will be run later on? ".repeat(5);
    return shortHeight;
  });
  const shape = await page.locator(".island-shape").boundingBox();
  const text = await page.locator(".question-text").boundingBox();
  const skip = await island(page).getByRole("button", { name: "Skip" }).boundingBox();
  expect(skip!.y + skip!.height).toBeLessThanOrEqual(shape!.y + shape!.height);
  expect(text!.height).toBeGreaterThanOrEqual(line * 2 - 1);
});

test("the bubble stays on screen when the island sits on the right", async ({ page }) => {
  await page.evaluate(() => (window as never as { __meridian: { updateSettings(p: object): Promise<void> } }).__meridian.updateSettings({ islandAlign: "right" }));
  await page.evaluate(() => (window as never as { __mock: { addFlight(m: number): void } }).__mock.addFlight(31));
  await page.evaluate(() => (window as never as { __meridian: { refreshActivity(): Promise<void> } }).__meridian.refreshActivity());
  await page.evaluate(() => (window as never as { __meridian: { pushNotice(n: object): void } }).__meridian.pushNotice({ tone: "info", title: "Heads up", body: "" }));
  await expect(page.locator(".bubble")).toBeVisible();
  const bubble = await page.locator(".bubble").boundingBox();
  expect(bubble!.x).toBeGreaterThanOrEqual(0);
  expect(bubble!.x + bubble!.width).toBeLessThanOrEqual(860);
});

test("a tired face is startled awake by the pointer", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  await expect(island(page)).toHaveAttribute("data-view", "idle");
  await page.clock.fastForward(46_000);
  await expect(page.locator(".island .face")).toHaveAttribute("data-mood", "sleepy");
  await page.evaluate(() => (window as never as { __meridian: { setHovered(v: boolean): void } }).__meridian.setHovered(true));
  await page.clock.runFor(300);
  await expect(page.locator(".island .peek-face .face")).toHaveAttribute("data-mood", "needs");
});

type Hooks = {
  __mock: { setCharge(c: unknown): void; islandDrags(): boolean[]; placeIsland(p: string): void; islandResets(): number };
  __meridian: { refreshCharge(): Promise<void> };
};
/** Runs `call` in the page with its test hooks, as `call(window)`. */
const hooks = (page: Page, call: (w: Hooks) => unknown) => page.evaluate(`(${call.toString()})(window)`);

test("a laptop shows its charge beside the clock, with a bolt while it charges", async ({ page }) => {
  await expect(island(page)).toHaveAttribute("data-view", "idle");
  await expect(page.locator(".charge")).toHaveCount(0);
  const plain = (await island(page).boundingBox())!.width;

  await hooks(page, (w) => (w.__mock.setCharge({ percent: 64, plugged: false }), w.__meridian.refreshCharge()));
  await expect(page.locator(".charge")).toHaveAttribute("aria-label", "Battery 64%");
  await expect(page.locator(".charge-percent")).toHaveText("64%");
  await expect(page.locator(".charge-bolt")).toHaveCount(0);
  await expect.poll(async () => (await island(page).boundingBox())!.width).toBeGreaterThan(plain);

  await hooks(page, (w) => (w.__mock.setCharge({ percent: 64, plugged: true }), w.__meridian.refreshCharge()));
  await expect(page.locator(".charge")).toHaveAttribute("aria-label", "Battery 64%, charging");
  await expect(page.locator(".charge-bolt")).toHaveCount(1);

  await hooks(page, (w) => (w.__mock.setCharge({ percent: 12, plugged: false }), w.__meridian.refreshCharge()));
  await expect(page.locator(".charge")).toHaveAttribute("data-low", "true");
});

test("the island is dragged, not clicked, when the press moves", async ({ page }) => {
  await expect(island(page)).toHaveAttribute("data-view", "idle");
  await settled(page);
  const box = (await island(page).boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y + 60, { steps: 6 });
  await expect(island(page)).toHaveAttribute("data-dragging", "true");
  await page.mouse.up();
  expect(await hooks(page, (w) => w.__mock.islandDrags())).toEqual([true, false]);
  await expect(island(page)).not.toHaveAttribute("data-dragging", "true");
  await page.waitForTimeout(300);
  await expect(island(page)).toHaveAttribute("data-view", "idle");

  // A press that stays put is still a click.
  await island(page).click();
  await expect(island(page)).toHaveAttribute("data-view", "expanded");
});

test("floating it is a shape of its own, growing up from low on the screen, and goes back to the top", async ({ page }) => {
  await hooks(page, (w) => w.__mock.placeIsland("up"));
  await expect(island(page)).toHaveAttribute("data-place", "up");
  await expect(page.locator(".island-body path")).toHaveAttribute("d", /Z$/);
  await expect.poll(async () => { const b = (await island(page).boundingBox())!; return Math.round(b.y + b.height); }).toBe(660 - 12);

  await hooks(page, (w) => w.__mock.placeIsland("down"));
  await expect.poll(async () => Math.round((await island(page).boundingBox())!.y)).toBe(12);

  await island(page).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Island", exact: true }).click();
  await page.getByRole("button", { name: "Back to top center" }).click();
  await expect(island(page)).toHaveAttribute("data-place", "top");
  expect(await hooks(page, (w) => w.__mock.islandResets())).toBe(1);
  await expect(page.locator(".island-body path")).not.toHaveAttribute("d", /Z$/);
});

test("a new version found in the background says so once, and opens Updates", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  await expect(island(page)).toHaveAttribute("data-view", "idle");
  await page.evaluate(() => (window as never as { __mock: { setUpdate(s: unknown): void } }).__mock.setUpdate({ available: true, latest: "v0.9.0", message: "Version 0.9.0 is ready to install." }));
  await page.clock.fastForward(6 * 60 * 60_000);
  await expect(island(page)).toHaveAttribute("data-view", "notification");
  await expect(island(page)).toContainText("Meridian 0.9.0 is ready to install.");
  await island(page).getByText("Update ready").click();
  await expect(page.getByRole("heading", { name: "Updates" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Update now" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(island(page)).toHaveAttribute("data-view", "idle");
  await page.clock.fastForward(6 * 60 * 60_000);
  await page.clock.runFor(1000);
  await expect(island(page)).toHaveAttribute("data-view", "idle");
});

test("a sleeping face snores a little, then stops drawing", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  await expect(island(page)).toHaveAttribute("data-view", "idle");
  await page.clock.fastForward(121_000);
  await expect(page.locator(".island .face")).toHaveAttribute("data-mood", "asleep");
  await page.evaluate(() => {
    const face = document.querySelector(".island .face") as HTMLElement;
    const seen = window as never as { snores: number };
    seen.snores = 0;
    new MutationObserver(() => void (face.dataset.snore && seen.snores++)).observe(face, { attributes: true, attributeFilter: ["data-snore"] });
  });
  const snores = async () => page.evaluate(() => (window as never as { snores: number }).snores);
  await page.clock.runFor(120_000);
  const heard = await snores();
  expect(heard).toBeGreaterThan(0);
  expect(heard).toBeLessThanOrEqual(6);
  await page.clock.runFor(120_000);
  expect(await snores()).toBe(heard);
});

test("the listening preview never asks for the microphone", async ({ page }) => {
  await page.addInitScript(() => {
    (window as never as { micCalls: number }).micCalls = 0;
  });
  await page.goto("/");
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      (window as never as { micCalls: number }).micCalls += 1;
      throw new Error("denied");
    };
  });
  await preview(page, "listening");
  await expect(island(page)).toHaveAttribute("data-view", "listening");
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as never as { micCalls: number }).micCalls)).toBe(0);
  await expect(page.locator(".mic-dot")).toHaveCount(0);
});

test("the clock and hide options change the idle shape", async ({ page }) => {
  const width = async () => (await island(page).boundingBox())!.width;
  const setting = (patch: object) =>
    page.evaluate((p) => (window as never as { __meridian: { updateSettings(p: object): Promise<void> } }).__meridian.updateSettings(p), patch);

  await setting({ showClock: true });
  await settled(page);
  expect(await width()).toBeCloseTo(148, 0);

  await setting({ showClock: false, islandAutoHide: true });
  await settled(page);
  expect((await island(page).boundingBox())!.height).toBeCloseTo(6, 0);
});

test("a flight shows a countdown, and opens to the route when pointed at", async ({ page }) => {
  await page.evaluate(() => (window as never as { __mock: { addFlight(m: number): void } }).__mock.addFlight(31));
  await page.evaluate(() => (window as never as { __meridian: { refreshActivity(): Promise<void> } }).__meridian.refreshActivity());
  await expect(island(page)).toHaveAttribute("data-view", "live");
  await expect(island(page)).toContainText("DEL");
  await expect(island(page)).toContainText("31m");
  await page.evaluate(() => (window as never as { __meridian: { setHovered(v: boolean): void } }).__meridian.setHovered(true));
  await expect(island(page)).toContainText("Boarding soon");
  await expect(page.locator(".route")).toContainText("BOM");
});

test("the face can be changed, and an unknown one falls back", async ({ page }) => {
  await expect(page.locator(".island .face")).toHaveAttribute("data-face", "soft");
  const set = (face: string) => page.evaluate((f) => (window as never as { __meridian: { updateSettings(p: object): Promise<void> } }).__meridian.updateSettings({ face: f }), face);
  await set("cat");
  await expect(page.locator(".island .face")).toHaveAttribute("data-face", "cat");
  await set("from-a-newer-version");
  await expect(page.locator(".island .face")).toHaveAttribute("data-face", "soft");
});

test("the island can sit left or right, and stays on screen", async ({ page }) => {
  await page.evaluate(() => (window as never as { __meridian: { updateSettings(p: object): Promise<void> } }).__meridian.updateSettings({ islandAlign: "right" }));
  await expect(island(page)).toHaveAttribute("data-align", "right");
  await settled(page);
  const box = await island(page).boundingBox();
  expect(box!.x + box!.width).toBeCloseTo(844, 0);
  await preview(page, "expanded");
  await settled(page);
  expect((await island(page).boundingBox())!.x).toBeGreaterThanOrEqual(0);
});

test("playing media takes over an idle island and answers its controls", async ({ page }) => {
  const publish = (present: boolean) =>
    page.evaluate((p) => (window as never as { __mock: { publishMedia(p: boolean): void } }).__mock.publishMedia(p), present);
  await publish(true);
  await expect(island(page)).toHaveAttribute("data-view", "media");
  await settled(page);
  expect((await island(page).boundingBox())!.height).toBeCloseTo(46, 0);
  await expect(island(page)).toContainText("Northern Lights");
  await expect(island(page).getByRole("button", { name: "Pause" })).toHaveCount(0);

  const hover = (on: boolean) => page.evaluate((v) => (window as never as { __meridian: { setHovered(h: boolean): void } }).__meridian.setHovered(v), on);
  await hover(true);
  await expect(island(page).getByRole("button", { name: "Pause" })).toBeVisible();
  await settled(page);
  expect((await island(page).boundingBox())!.height).toBeCloseTo(172, 0);
  await hover(false);
  await expect(island(page).getByRole("button", { name: "Pause" })).toHaveCount(0);
  await settled(page);
  expect((await island(page).boundingBox())!.height).toBeCloseTo(46, 0);

  await page.getByRole("button", { name: /Open the player/ }).click();
  await expect(island(page).getByRole("button", { name: "Pause" })).toBeVisible();
  await settled(page);
  expect((await island(page).boundingBox())!.height).toBeCloseTo(172, 0);
  const room = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    return { above: box(".transport").top - box(".progress-row").bottom, below: box(".media-open").bottom - box(".transport").bottom };
  });
  expect(Math.abs(room.above - room.below), "the controls sit in the middle of the room under the progress bar").toBeLessThan(3);

  await page.getByRole("button", { name: "Pause" }).click();
  await expect(island(page)).toHaveAttribute("data-view", "idle");

  await publish(false);
  await expect(island(page)).toHaveAttribute("data-view", "idle");
});

test("nothing on the island moves for ever, at rest, at work, waiting for an answer or playing music", async ({ page }) => {
  // Anything that moves redraws the whole window, so a state that lasts hours may only move now and then.
  await page.clock.install();
  await page.goto("/");
  const mock = (call: string) => page.evaluate(`window.__mock.${call}`);
  const endless = () =>
    page.evaluate(() => {
      const island = document.querySelector(".island")!;
      return document
        .getAnimations()
        .filter((a) => {
          const target = (a.effect as KeyframeEffect | null)?.target;
          return a.playState === "running" && a.effect?.getComputedTiming().iterations === Infinity && target && island.contains(target);
        })
        .map((a) => (a as CSSAnimation).animationName ?? "a script animation");
    });
  const tenSecondsIn = async (view: string) => {
    await expect(island(page)).toHaveAttribute("data-view", view);
    await page.clock.runFor(10_000);
    await expect(island(page)).toHaveAttribute("data-view", view);
    expect(await endless()).toEqual([]);
  };

  await tenSecondsIn("idle");
  await mock("publishMedia(true)");
  await tenSecondsIn("media");
  await expect(page.locator(".island .bars")).toHaveAttribute("data-playing", "true");
  await mock('publishWatched("watch:s1")');
  await tenSecondsIn("working");
  await mock('publishWatchedApproval("watch:s1")');
  await expect(island(page)).toContainText("Allow once");
  await tenSecondsIn("working");
  // Content that left is still there: the fake clock does not run Motion's exits.
  await expect(page.locator(".island .face").last()).toHaveAttribute("data-mood", "needs");
});

test("every face draws every mood", async ({ page }) => {
  await island(page).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Island", exact: true }).click();
  const faces = page.locator(".face-grid .face");
  const each = (name: string) => faces.evaluateAll((els, n) => els.map((el) => el.getAttribute(n)), name);
  await expect(faces).toHaveCount(8);
  expect(await each("data-face")).toEqual(["soft", "googly", "visor", "smile", "pixel", "cat", "horizon", "moons"]);
  const drawn = ["rest", "listen", "think", "speak", "heard", "notice", "working", "needs", "done", "error", "drag", "sleepy", "asleep"];
  // Only soft eyes draws these. The others show the nearest mood they have.
  const borrowed: Record<string, string> = { music: "rest", curious: "rest", wink: "done", love: "done", dizzy: "error" };
  for (const mood of [...drawn, ...Object.keys(borrowed)]) {
    await page.evaluate((m) => (window as never as { __meridian: { feel(m: string, ms: number): void } }).__meridian.feel(m, 60_000), mood);
    const shown = borrowed[mood] ?? mood;
    await expect.poll(() => each("data-mood")).toEqual([mood, ...Array<string>(7).fill(shown)]);
    // Something is drawn, at a size that can be seen.
    const seen = await faces.evaluateAll((els) => els.map((el) => { const b = el.getBoundingClientRect(); return el.children.length > 0 && b.width >= 8 && b.height >= 2; }));
    expect(seen, mood).toEqual(Array(8).fill(true));
  }
});

test("the face shows how it feels by its shape, and it passes", async ({ page }) => {
  const face = page.locator(".island .face");
  await expect(face).toHaveAttribute("data-mood", "rest");
  await page.evaluate(() => (window as never as { __meridian: { feel(m: string, ms: number): void } }).__meridian.feel("love", 400));
  await expect(face).toHaveAttribute("data-mood", "love");
  await expect(face).toHaveAttribute("data-mood", "rest");
});

test("the volume keys and the charger show for a moment, and the face reacts", async ({ page }) => {
  const publish = (level: unknown) =>
    page.evaluate((l) => (window as never as { __mock: { publishLevel(l: unknown): void } }).__mock.publishLevel(l), level);
  await publish({ kind: "volume", percent: 40, muted: false });
  await expect(island(page)).toHaveAttribute("data-view", "level");
  await expect(island(page)).toContainText("40");
  await publish({ kind: "volume", percent: 55, muted: false });
  await expect(island(page)).toContainText("55");
  await expect(page.locator(".island .face").last()).toHaveAttribute("data-mood", "done");
  await expect(island(page)).toHaveAttribute("data-view", "idle", { timeout: 4000 });

  await publish({ kind: "battery", percent: 64, plugged: true, saver: false, secondsLeft: null, secondsToFull: 4320, watts: 65, health: 92 });
  await expect(island(page)).toContainText("1 h 12 min until full");
  await expect(island(page)).toContainText("64%");
});

test("media steps aside for a notification, then returns", async ({ page }) => {
  await page.evaluate(() => (window as never as { __mock: { publishMedia(p: boolean): void } }).__mock.publishMedia(true));
  await expect(island(page)).toHaveAttribute("data-view", "media");
  await page.evaluate(() => (window as never as { __meridian: { pushNotice(n: object): void } }).__meridian.pushNotice({ tone: "info", title: "Heads up", body: "" }));
  await expect(island(page)).toHaveAttribute("data-view", "notification");
});

test("an urgent reminder stays, offers its action, and outranks media", async ({ page }) => {
  await page.evaluate(() => (window as never as { __mock: { publishMedia(p: boolean): void } }).__mock.publishMedia(true));
  await expect(island(page)).toHaveAttribute("data-view", "media");
  await page.evaluate(() =>
    (window as never as { __mock: { publishReminder(r: object): void } }).__mock.publishReminder({
      key: "r1",
      eventId: "e1",
      stage: { type: "lead", minutes: 15 },
      priority: "important",
      title: "Your meeting starts in 15 minutes",
      startsAt: { kind: "zoned", value: "2026-10-30T15:30:00+05:30" },
      approximateTime: false,
      actions: [{ label: "Join", actionId: "join", url: "https://example.com/meet" }],
    }),
  );
  await expect(island(page)).toHaveAttribute("data-view", "notification");
  // Mail can be forged, so a link always shows its real destination.
  await expect(island(page).getByRole("button", { name: "Join on example.com" })).toBeVisible();
  await island(page).getByRole("button", { name: "Snooze" }).click();
  await expect(island(page)).toHaveAttribute("data-view", "media");
});

test("reduced motion lands on the target size immediately", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await preview(page, "working");
  await expect(island(page)).toHaveAttribute("data-view", "working");
  await page.waitForTimeout(32);
  expect((await island(page).boundingBox())!.width).toBeCloseTo(324, 0);
});

test.describe("what an agent is doing", () => {
  type Mock = { publishWatched(id: string): void; publishEvent(id: string, event: object): void; publishFailure(id: string, why: string): void; publishWatchedApproval(id: string): void };
  const send = (page: Page, event: object, id = "watch:a") =>
    page.evaluate(([i, e]) => (window as never as { __mock: Mock }).__mock.publishEvent(i as string, e as object), [id, event]);
  const watch = (page: Page, id = "watch:a") => page.evaluate((i) => (window as never as { __mock: Mock }).__mock.publishWatched(i), id);
  const hover = (page: Page, on: boolean) =>
    page.evaluate((v) => (window as never as { __meridian: { setHovered(v: boolean): void } }).__meridian.setHovered(v), on);
  const fits = async (page: Page, selector: string) => {
    await settled(page);
    const [shape, inner] = await Promise.all([page.locator(".island-shape").boundingBox(), page.locator(selector).last().boundingBox()]);
    expect(inner!.y + inner!.height).toBeLessThanOrEqual(shape!.y + shape!.height);
  };

  test("the pill says the stage, the file and how many real steps", async ({ page }) => {
    await watch(page);
    await send(page, { type: "activity", label: "Reading src/cart.ts" });
    await send(page, { type: "activity", label: "Retrying the API, attempt 2" });
    await send(page, { type: "activity", label: "$ npm test" });
    await expect(island(page)).toContainText("Running npm test");
    await expect(island(page)).toContainText("Step 3");
    await expect(island(page)).not.toContainText("%");
  });

  test("the stage card opens on the pointer, says what happened, and closes behind it", async ({ page }) => {
    await preview(page, "working");
    await hover(page, true);
    await expect(page.locator(".stage-card")).toContainText("Claude Code · dock-agent");
    await expect(page.locator(".step-log-row")).toHaveCount(3);
    await expect(page.locator(".step-log-row").first()).toContainText("Read src/island/machine.ts and 3 other files");
    await expect(page.locator(".step-log-row").last()).toContainText("Editing src/island/views.tsx, 2 lines");
    await fits(page, ".stage-actions");
    await hover(page, false);
    await expect(page.locator(".stage-card")).toHaveCount(0);
  });

  test("a click opens the stage card too", async ({ page }) => {
    await preview(page, "working");
    await island(page).getByRole("button", { name: /Editing/ }).click();
    await expect(page.locator(".stage-card")).toBeVisible();
    await expect(island(page)).toHaveAttribute("data-view", "working");
  });

  test("the agent's own list replaces the stages, and only while there is one", async ({ page }) => {
    await watch(page);
    await hover(page, true);
    await expect(page.locator(".step-log")).toBeVisible();
    await send(page, { type: "todos", items: [
      { id: "0", text: "Fix the resize", status: "completed" },
      { id: "1", text: "Add a test", status: "in_progress" },
      { id: "2", text: "Run the tests", status: "pending" },
    ] });
    await expect(page.locator(".stage-count")).toHaveText("Step 2 of 3");
    await expect(page.locator(".todo-line")).toHaveCount(3);
    await expect(page.locator(".step-log")).toHaveCount(0);
    await fits(page, ".todo-line");
    await hover(page, false);
    await expect(island(page)).toContainText("Step 2 of 3");
    await send(page, { type: "todos", items: [] });
    await hover(page, true);
    await expect(page.locator(".step-log")).toBeVisible();
  });

  test("a long list stays on the island", async ({ page }) => {
    await watch(page);
    const items = Array.from({ length: 12 }, (_, i) => ({ id: String(i), text: `Step number ${i}`, status: i < 7 ? "completed" : i === 7 ? "in_progress" : "pending" }));
    await send(page, { type: "todos", items });
    await hover(page, true);
    await expect(page.locator(".todo-line")).toHaveCount(6);
    await expect(page.locator(".stage-count")).toHaveText("Step 8 of 12");
    await expect(page.locator(".todo-list")).toContainText("Step number 7");
    await fits(page, ".todo-line");
  });

  test("a finished session shows each step it took and what came of it", async ({ page }) => {
    await watch(page);
    await send(page, { type: "activity", label: "Editing src/cart.ts" });
    await send(page, { type: "diff", path: "cart.ts", removed: ["a"], added: ["b"], linesRemoved: 1, linesAdded: 1 });
    await send(page, { type: "activity", label: "$ npm test" });
    await send(page, { type: "output", command: "npm test", lines: ["Tests  12 passed (12)"], failed: false });
    await send(page, { type: "text", text: "The cart now keeps its total." });
    await send(page, { type: "status", status: "completed" });
    await expect(island(page)).toHaveAttribute("data-view", "notification");
    await expect(island(page)).toContainText("Claude Code · shop");
    await expect(island(page)).toContainText("Worked for");
    await expect(page.locator(".step-log-row")).toContainText(["Changed src/cart.ts, 1 line", "Ran npm test: all 12 passed"]);
    await fits(page, ".stage-actions");
    await island(page).getByRole("button", { name: "See what changed" }).click();
    await expect(island(page)).toHaveAttribute("data-view", "expanded");
    await expect(page.getByRole("button", { name: /Changes \+1 -1/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".change-body")).toContainText("b");
  });

  test("a session with nothing to quote or compare still ends cleanly", async ({ page }) => {
    await watch(page);
    await send(page, { type: "status", status: "completed" });
    await expect(island(page)).toContainText("Worked for");
    await expect(island(page).getByRole("button", { name: "Open" })).toBeVisible();
    await expect(island(page).getByRole("button", { name: "See what changed" })).toHaveCount(0);
    await fits(page, ".stage-actions");
    await island(page).getByRole("button", { name: "Close" }).click();
    await expect(island(page)).toHaveAttribute("data-view", "idle");
  });

  test("with no steps to show, a long last message stops short of the buttons", async ({ page }) => {
    await send(page, { type: "watched", agent: "Claude Code", cwd: "C:\\Projects\\shop", title: "Fix the checkout", pid: 4242 });
    await send(page, { type: "text", text: "It went on and on. ".repeat(60) });
    await send(page, { type: "status", status: "completed" });
    await expect(island(page)).toContainText("It went on and on.");
    await fits(page, ".stage-actions");
  });

  test("a failed session says why in its own words, and waits", async ({ page }) => {
    await watch(page);
    await page.evaluate(() => (window as never as { __mock: Mock }).__mock.publishFailure("watch:a", "2 tests failed in cart.test.ts"));
    await expect(island(page)).toContainText("shop stopped");
    await expect(island(page)).toContainText("2 tests failed in cart.test.ts");
    await fits(page, ".stage-actions");
    await page.waitForTimeout(6500);
    await expect(island(page)).toContainText("shop stopped");
    await island(page).getByRole("button", { name: "Open" }).click();
    await expect(island(page)).toHaveAttribute("data-view", "expanded");
    await expect(page.locator(".session-head")).toContainText("shop");
  });

  test("several at once take a row each, with what needs the user first", async ({ page }) => {
    await preview(page, "multitask");
    await settled(page);
    const rows = page.locator(".stage-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText("dock-agent");
    await expect(rows.first()).toContainText("Needs you");
    await expect(rows.nth(1)).toContainText("Running npm test");
    await expect(rows.nth(2)).toContainText("Editing index.html");
    await fits(page, ".stage-row");
  });

  test("a request stays on the island, with the others shown under it", async ({ page }) => {
    await watch(page, "watch:one");
    await watch(page, "watch:two");
    await page.evaluate(() => (window as never as { __mock: Mock }).__mock.publishWatchedApproval("watch:two"));
    await expect(island(page).getByRole("button", { name: "Allow once" })).toBeVisible();
    await expect(page.locator(".stage-row")).toHaveCount(1);
    await expect(page.locator(".stage-row")).toContainText("Editing cart.ts");
    await fits(page, ".stage-row");
  });
});

test.describe("panel", () => {
  test.beforeEach(async ({ page }) => {
    await island(page).click();
    await expect(island(page)).toHaveAttribute("data-view", "expanded");
  });

  test("opens from the idle pill and closes with Escape", async ({ page }) => {
    await expect(page.getByRole("heading", { name: /Good|Hello/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(island(page)).toHaveAttribute("data-view", "idle");
  });

  test("streams a chat reply and reports usage", async ({ page }) => {
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await useEngine(page, "Anthropic");
    await expect(page.getByRole("button", { name: "Model" })).toContainText("Model A");
    await page.getByLabel("Message").fill("hello");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator('.message[data-role="assistant"]')).toContainText("browser stand-in");
    await expect(page.locator(".bar .tabular")).toHaveText("12 / 9");
  });

  test("a question from a terminal is answered in full from the Agents page", async ({ page }) => {
    await page.evaluate(() => {
      const mock = (window as never as { __mock: { publishWatched(id: string): void; publishWatchedQuestion(id: string): void } }).__mock;
      mock.publishWatched("watch:q");
      mock.publishWatchedQuestion("watch:q");
    });
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.locator(".session-row").first().click();
    const approval = page.locator(".approval");
    await expect(approval.getByRole("button", { name: "Allow" })).toHaveCount(0);
    await expect(approval).toContainText("A question, 1 of 2");
    await expect(approval.getByRole("button", { name: "Next" })).toBeDisabled();
    await approval.getByRole("button", { name: "Amber" }).click();
    await approval.getByRole("button", { name: "Next" }).click();
    await expect(approval).toContainText("A question, 2 of 2");
    await approval.getByRole("button", { name: "Ship it" }).click();
    await approval.getByRole("button", { name: "Done" }).click();
    await expect.poll(() => page.evaluate(() => (window as never as { __mock: { lastAnswers(): unknown } }).__mock.lastAnswers())).toEqual({ "Which one?": "Amber", "And then?": "Ship it" });
  });

  test.describe("a session's log", () => {
    type Mock = { publishWatched(id: string): void; publishEvent(id: string, event: object): void; publishWatchedApproval(id: string): void };
    const send = (page: Page, event: object, id = "watch:a") =>
      page.evaluate(([i, e]) => (window as never as { __mock: Mock }).__mock.publishEvent(i as string, e as object), [id, event]);
    const open = async (page: Page) => {
      await page.evaluate(() => (window as never as { __mock: Mock }).__mock.publishWatched("watch:a"));
      await page.getByRole("button", { name: "Agents", exact: true }).click();
      await page.locator(".session-row").first().click();
    };

    test("reads as steps with coloured verbs, keeping the conversation between them", async ({ page }) => {
      await open(page);
      await send(page, { type: "diff", path: "cart.ts", removed: ["a"], added: ["b", "c"], linesRemoved: 1, linesAdded: 2 });
      await send(page, { type: "activity", label: "$ npm test" });
      await send(page, { type: "output", command: "npm test", lines: ["Tests  2 passed (2)"], failed: false });
      await send(page, { type: "text", text: "All done." });
      await expect(page.locator(".step-row")).toHaveCount(2);
      await expect(page.locator(".step-row").first()).toContainText("cart.ts, 2 lines");
      await expect(page.locator('.step-row[data-kind="run"] .step-verb')).toHaveText("Run");
      await expect(page.locator(".step-output")).toContainText("2 passed");
      await expect(page.locator(".log")).toContainText("All done.");
      const colours = await page.locator(".step-verb").evaluateAll((els) => els.map((el) => getComputedStyle(el).color));
      expect(new Set(colours).size).toBe(2);
    });

    test("counts what changed from the real totals, and says when lines were cut short", async ({ page }) => {
      await open(page);
      await send(page, { type: "diff", path: "cart.ts", removed: ["old"], added: ["new"], linesRemoved: 3, linesAdded: 18 });
      await send(page, { type: "diff", path: "tax.ts", removed: [], added: [], linesRemoved: 0, linesAdded: 40 });
      await page.getByRole("button", { name: /Changes \+58 -3/ }).click();
      await expect(page.locator(".change-file")).toHaveCount(2);
      await expect(page.locator('.change-line[data-change="removed"]')).toHaveText(/old/);
      await expect(page.locator('.change-line[data-change="added"]')).toHaveText(/new/);
      await expect(page.locator(".change-note")).toContainText("21 lines changed in all");
      await page.getByRole("button", { name: /tax\.ts/ }).click();
      await expect(page.locator(".change-note")).toContainText("Written in one go, 40 lines");
      await expect(page.locator(".log")).toHaveCount(0);
    });

    test("shows a request under the steps, and it can still be answered from Changes", async ({ page }) => {
      await open(page);
      await page.evaluate(() => (window as never as { __mock: Mock }).__mock.publishWatchedApproval("watch:a"));
      const approval = page.locator(".approval");
      await expect(approval).toContainText("Wants to run a command");
      await expect(approval).toContainText("npm install stripe");
      await expect(approval.getByRole("button")).toHaveText(["Deny", "Allow once"]);
      await page.getByRole("button", { name: /^Changes/ }).click();
      await expect(approval.getByRole("button", { name: "Allow once" })).toBeVisible();
    });

    test("sees everything at once, answers from there, and goes back", async ({ page }) => {
      await open(page);
      await send(page, { type: "output", command: "npm test", lines: ["FAIL src/cart.test.ts"], failed: true });
      await page.getByRole("button", { name: "See all at once" }).click();
      await expect(page.getByRole("heading", { name: "All agents" })).toBeVisible();
      await expect(page.locator(".agent-tile")).toHaveCount(1);
      await expect(page.locator(".agent-tile")).toContainText("Edit src/cart.ts".replace("src/", ""));
      await page.evaluate(() => (window as never as { __mock: Mock }).__mock.publishWatchedApproval("watch:a"));
      await expect(page.locator(".agent-tile")).toContainText("npm install stripe");
      await expect(page.locator('.agent-tile[data-needs="true"]').getByRole("button", { name: "Deny" })).toBeVisible();
      await page.locator(".agent-tile-head").click();
      await expect(page.locator(".session-head")).toContainText("shop");
      await page.getByRole("button", { name: "See all at once" }).click();
      await page.getByRole("button", { name: "Back to list" }).click();
      await expect(page.locator(".session-list")).toBeVisible();
    });

    test("says when a limit stopped it", async ({ page }) => {
      await open(page);
      await page.evaluate(() => {
        const mock = (window as never as { __mock: Mock }).__mock;
        const resetsAt = Math.floor(Date.now() / 1000) + 3600;
        mock.publishEvent("watch:a", { type: "limits", windows: [{ window: "five_hour", usedPercent: 100, resetsAt }] });
        mock.publishEvent("watch:a", { type: "status", status: "failed", message: "Usage limit reached" });
      });
      await expect(page.locator(".limit-stop")).toContainText("Claude limit reached");
      await expect(page.locator('.step-row[data-kind="stop"]')).toContainText("Usage limit reached");
    });
  });

  test("a plan from a terminal is shown in full on the Agents page", async ({ page }) => {
    await page.evaluate(() => {
      const mock = (window as never as { __mock: { publishWatched(id: string): void; publishWatchedPlan(id: string): void } }).__mock;
      mock.publishWatched("watch:p");
      mock.publishWatchedPlan("watch:p");
    });
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.locator(".session-row").first().click();
    await expect(page.locator(".approval .plan-text li")).toHaveCount(2);
    await expect(page.locator(".approval").getByRole("button", { name: "Approve plan" })).toBeVisible();
  });

  test("the ask box on Home goes to the chosen AI and opens Chat", async ({ page }) => {
    await page.getByLabel("Ask anything").fill("hello from home");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator('.message[data-role="user"]')).toContainText("hello from home");
    await expect(page.locator('.message[data-role="assistant"]')).toContainText("browser stand-in");
  });

  test("the player sits in the middle of the Media page, clear of the dock, with the lists and without", async ({ page }) => {
    const publish = (over: object, others: object[] = []) =>
      page.evaluate(([o, rest]) => (window as never as { __mock: { publishMedia(p: boolean, o: unknown, r: unknown): void } }).__mock.publishMedia(true, o, rest), [over, others]);
    const measure = () =>
      page.evaluate(() => {
        const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
        const middleY = (r: DOMRect) => r.top + r.height / 2;
        const middleX = (r: DOMRect) => r.left + r.width / 2;
        const [head, dock, art, info, keys, lists] = [".panel-head", ".dock", ".media-art", ".media-info", ".transport", ".media-lists"].map(box);
        const main = document.querySelector("main.page")!;
        return {
          above: art!.top - head!.bottom,
          below: (lists?.top ?? dock!.top) - art!.bottom,
          lean: info ? Math.abs(middleY(info) - middleY(art!)) : 0,
          keysOff: info ? Math.abs(middleX(keys!) - middleX(info)) : 0,
          clear: dock!.top - (lists?.bottom ?? art!.bottom),
          spill: main.scrollHeight - main.clientHeight,
        };
      });
    const balanced = async (why: string) => {
      await settled(page);
      const room = await measure();
      expect(Math.abs(room.above - room.below), `${why}: as much room above as below`).toBeLessThan(3);
      expect(room.lean, `${why}: the words sit level with the picture`).toBeLessThan(3);
      expect(room.keysOff, `${why}: the keys are in the middle of their column`).toBeLessThan(1);
      expect(room.clear, `${why}: nothing reaches the dock`).toBeGreaterThanOrEqual(0);
      expect(room.spill, `${why}: the page has no scroll`).toBeLessThanOrEqual(0);
    };

    await page.getByRole("button", { name: "Media", exact: true }).click();
    await balanced("nothing playing");

    await publish({});
    await expect(page.locator(".media-title")).toHaveText("Northern Lights");
    await balanced("one player");

    await publish({ title: "First Light" });
    await publish({ title: "Long Road Home" });
    await expect(page.locator(".media-lists .list-row")).toHaveCount(2);
    await balanced("what played before");

    await publish({ title: "Monsoon Letters", session: "jio" }, [{ session: "chrome", app: "Chrome", title: "", playing: false }]);
    await expect(page.locator(".media-list")).toHaveCount(2);
    await balanced("two lists");

    for (const title of ["One", "Two", "Three", "Four", "Five"]) await publish({ title, session: "jio" }, [{ session: "chrome", app: "Chrome" }]);
    await expect(page.locator(".media-list").last().locator(".list-row")).toHaveCount(8);
    await balanced("long lists");

    await publish({ title: "A radio stream", durationMs: null, artwork: null });
    await expect(page.locator(".media-stage .progress-row")).toHaveCount(0);
    await expect(page.locator(".media-art")).toHaveClass(/no-art/);
    await balanced("no length and no picture");
  });

  test("what is being written survives the panel closing and changing page", async ({ page }) => {
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await useEngine(page, "Anthropic");
    await page.getByLabel("Message").fill("half a thought");
    await page.keyboard.press("Escape");
    await island(page).click();
    await expect(page.getByLabel("Message")).toHaveValue("half a thought");
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.getByLabel("Message")).toHaveValue("half a thought");
  });

  test("an urgent reminder is still waiting after the panel has been open", async ({ page }) => {
    await page.evaluate(() =>
      (window as never as { __mock: { publishReminder(r: object): void } }).__mock.publishReminder({
        key: "r2",
        eventId: "e1",
        stage: { type: "lead", minutes: 15 },
        priority: "important",
        title: "Your meeting starts in 15 minutes",
        startsAt: null,
        approximateTime: false,
        actions: [],
      }),
    );
    await page.keyboard.press("Escape");
    await expect(island(page)).toHaveAttribute("data-view", "notification");
    await page.evaluate(() => (window as never as { __meridian: { openPanel(): void } }).__meridian.openPanel());
    await expect(island(page)).toHaveAttribute("data-view", "expanded");
    await page.keyboard.press("Escape");
    await expect(island(page)).toHaveAttribute("data-view", "notification");
  });

  test("what went wrong shows in the panel, and can be retried or dismissed", async ({ page }) => {
    await page.evaluate(() => (window as never as { __mock: { publishWatched(id: string): void } }).__mock.publishWatched("watch:bad"));
    await page.evaluate(() => {
      const api = window as never as { __mock: { publishFailure(id: string, why: string): void } };
      api.__mock.publishFailure("watch:bad", `It stopped. ${"Something went wrong a long way down. ".repeat(40)}`);
    });
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("failed");
    expect((await alert.boundingBox())!.height).toBeLessThan(80);
    await expect(page.locator(".dock")).toBeVisible();
    await alert.getByRole("button", { name: "Dismiss" }).click();
    await expect(alert).toHaveCount(0);
  });

  test("New chat during a reply stops it, and the chat stays empty", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await useEngine(page, "Anthropic");
    await page.getByLabel("Message").fill("hello");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("button", { name: "New chat" }).click();
    await page.waitForTimeout(400);
    await expect(page.locator(".message")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a log stays where the reader left it, and follows again from the end", async ({ page }) => {
    const text = (words: string) =>
      page.evaluate((w) => (window as never as { __mock: { publishText(id: string, t: string): void } }).__mock.publishText("watch:long", w), words);
    await page.evaluate(() => (window as never as { __mock: { publishWatched(id: string): void } }).__mock.publishWatched("watch:long"));
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.locator(".session-row").first().click();
    await text("A line.\n\n".repeat(60));
    const log = page.locator(".log");
    const gap = () => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    await expect.poll(gap).toBeLessThan(2);

    // A scroll is reported on the next frame.
    const scrollTo = (top: number) => log.evaluate((el, at) => { el.scrollTop = at; return new Promise(requestAnimationFrame); }, top);
    await scrollTo(0);
    await text("Another.\n\n");
    await page.waitForTimeout(80);
    expect(await log.evaluate((el) => el.scrollTop)).toBe(0);

    await scrollTo(1_000_000);
    await text("And one more.\n\n");
    await expect.poll(gap).toBeLessThan(2);
  });

  test("a selection on a screenshot is measured against the picture itself", async ({ page }) => {
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await useEngine(page, "Anthropic");
    await page.getByRole("button", { name: "This window" }).click();
    await page.getByRole("button", { name: "See what would be shared" }).click();
    const [box, picture] = await Promise.all([page.locator(".preview").boundingBox(), page.locator(".preview img").boundingBox()]);
    expect(box!.width).toBeCloseTo(picture!.width, 0);
    expect(box!.width / box!.height).toBeCloseTo(16 / 9, 1);
  });

  test("a suggestion opens chat with its question written, and sends nothing", async ({ page }) => {
    await page.keyboard.press("Escape");
    await preview(page, "contextual");
    await island(page).getByRole("button", { name: "Suggest fix" }).click();
    await expect(island(page)).toHaveAttribute("data-view", "expanded");
    await expect(page.getByLabel("Message")).toHaveValue("Suggest a fix for this.");
    await expect(page.locator(".look-pill")).toBeVisible();
    await expect(page.locator('.message[data-role="user"]')).toHaveCount(0);
  });

  test("an update under way survives the panel closing", async ({ page }) => {
    await page.evaluate(() => (window as never as { __mock: { setUpdate(s: unknown): void } }).__mock.setUpdate({ available: true, latest: "v0.9.0", message: "Version 0.9.0 is ready to install." }));
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Updates", exact: true }).click();
    await page.getByRole("button", { name: "Update now" }).click();
    await page.keyboard.press("Escape");
    await island(page).click();
    await expect(page.getByText("Downloading and checking the update.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Update now" })).toBeDisabled();

    await page.evaluate(() => (window as never as { __mock: { failInstall(why: string): void } }).__mock.failInstall("The download does not match its checksum."));
    await expect(page.getByRole("alert")).toContainText("checksum");
    await expect(page.getByRole("button", { name: "Update now" })).toBeEnabled();
  });

  test("local-only mode checks for nothing, even on the Updates page", async ({ page }) => {
    await page.evaluate(() => (window as never as { __mock: { setUpdate(s: unknown): void } }).__mock.setUpdate({ message: "Reached GitHub." }));
    await page.evaluate(() => (window as never as { __meridian: { updateSettings(p: object): Promise<void> } }).__meridian.updateSettings({ localOnly: true }));
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Updates", exact: true }).click();
    await expect(page.getByText("Update checks are off in local-only mode.")).toBeVisible();
  });

  test("a sign-in under way survives the panel closing, and a failure reaches the island", async ({ page }) => {
    await page.evaluate(() => (window as never as { __mock: { holdConnect(): void } }).__mock.holdConnect());
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Providers", exact: true }).click();
    await page.getByRole("button", { name: "Linear" }).click();
    await page.getByRole("button", { name: "Connect Linear" }).click();
    await page.keyboard.press("Escape");
    await island(page).click();
    await page.getByRole("button", { name: "Linear" }).click();
    await expect(page.locator(".link-detail")).toContainText("Finish in your browser");
    await page.keyboard.press("Escape");
    await page.evaluate(() => (window as never as { __mock: { failConnect(why: string): void } }).__mock.failConnect("Linear said no."));
    await expect(island(page)).toHaveAttribute("data-view", "error");
    await expect(island(page)).toContainText("Could not sign in to Linear");
  });

  test("runs a session through approval to completion", async ({ page }) => {
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(page.getByText("Not found")).toBeVisible();
    await expect(page.getByRole("radio", { name: /Codex/ })).toBeDisabled();

    await page.getByLabel("Project folder").fill("C:\\Projects\\sample");
    await page.getByLabel("Task").fill("run the tests");
    await page.getByRole("button", { name: "Start" }).click();

    await expect(page.locator(".approval")).toContainText("cargo test --workspace");
    await page.locator(".approval").getByRole("button", { name: "Allow" }).click();
    await expect(page.locator(".log")).toContainText("All tests pass.");
    await expect(page.locator(".session-facts")).toContainText("1,200 in");
  });

  test("parallel requests are answered one at a time, none lost", async ({ page }) => {
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.getByLabel("Project folder").fill("C:\\Projects\\sample");
    await page.getByLabel("Task").fill("run parallel checks");
    await page.getByRole("button", { name: "Start" }).click();

    const approval = page.locator(".approval");
    await expect(approval).toContainText("cargo test --workspace");
    await approval.getByRole("button", { name: "Allow" }).click();
    await expect(approval).toContainText("cargo clippy");
    await page.waitForTimeout(450);
    await approval.getByRole("button", { name: "Allow" }).click();
    await expect(page.locator(".log")).toContainText("All tests pass.");
  });

  test("a double click cannot approve the request that appears under it", async ({ page }) => {
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.getByLabel("Project folder").fill("C:\\Projects\\sample");
    await page.getByLabel("Task").fill("run parallel checks");
    await page.getByRole("button", { name: "Start" }).click();

    const approval = page.locator(".approval");
    await expect(approval).toContainText("cargo test --workspace");
    await approval.getByRole("button", { name: "Allow" }).dblclick();
    await expect(approval).toContainText("cargo clippy");
    await page.waitForTimeout(100);
    await expect(approval).toContainText("cargo clippy");
  });

  test("denying a request ends it without running", async ({ page }) => {
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.getByLabel("Project folder").fill("C:\\Projects\\sample");
    await page.getByLabel("Task").fill("do something risky");
    await page.getByRole("button", { name: "Start" }).click();
    await page.locator(".approval").getByRole("button", { name: "Deny" }).click();
    await expect(page.locator(".approval")).toHaveCount(0);
    await expect(page.locator(".log")).not.toContainText("All tests pass.");
  });

  test("shows only the capabilities a provider has", async ({ page }) => {
    await openModels(page);
    const ollama = page.locator(".card", { hasText: "Ollama" });
    await expect(ollama.locator(".cap")).toHaveText(["Streaming", "Tools", "Model list"]);
    await expect(ollama.getByLabel("Ollama API key")).toHaveCount(0);
  });

  test("an API key field never echoes a stored key", async ({ page }) => {
    await openModels(page);
    const key = page.getByLabel("Anthropic API key");
    await expect(key).toHaveAttribute("type", "password");
    await expect(key).toHaveValue("");
    await expect(key).toHaveAttribute("placeholder", "Key stored");
  });

  test("the model list is the app's own, and works from the keyboard", async ({ page }) => {
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await useEngine(page, "Anthropic");
    const model = page.getByRole("button", { name: "Model" });
    await model.click();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(model).toContainText("Model B");
    await expect(page.getByRole("menu")).toHaveCount(0);

    await model.click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(model).toBeFocused();
  });

  test("looking at the screen happens in chat, and nothing goes until a message is sent", async ({ page }) => {
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await useEngine(page, "Anthropic");
    await page.getByRole("button", { name: "This window" }).click();
    await expect(page.locator(".look .tile-title")).toHaveText("Code");
    await expect(page.locator(".look-pill")).toContainText("Code");

    await page.getByRole("button", { name: "See what would be shared" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Nothing has left this PC" })).toBeVisible();
    await page.getByRole("button", { name: "Forget this" }).click();
    await expect(page.locator(".look-pill")).toHaveCount(0);

    await page.getByRole("button", { name: "Look", exact: true }).click();
    await expect(page.locator(".look-pill")).toBeVisible();
    await page.getByRole("button", { name: "Summarize" }).click();
    await expect(page.locator(".look-pill")).toHaveCount(0);
    await expect(page.locator('.message[data-role="user"]')).toContainText("Summarize this.");
    await expect(page.locator('.message[data-role="user"]')).toContainText("Error: Invalid reference");
  });

  test("a conversation carries on after a restart", async ({ page }) => {
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await useEngine(page, "Claude Code");
    await page.getByLabel("Message").fill("chat: hello");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".log")).toContainText("Hello from the stand-in agent.");
    await page.waitForTimeout(1100);

    await page.reload();
    await island(page).click();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await useEngine(page, "Claude Code");
    await page.locator(".conv").first().click();
    await expect(page.locator(".log")).toContainText("Hello from the stand-in agent.");

    await page.getByLabel("Message").fill("and one more thing");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".log")).toContainText("Follow-up received: and one more thing");
  });

  test("an update can be checked for and installed from the app", async ({ page }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Updates", exact: true }).click();
    await expect(page.getByText("You are on the latest version.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Update now" })).toHaveCount(0);

    await page.evaluate(() => (window as never as { __mock: { setUpdate(s: unknown): void } }).__mock.setUpdate({ available: true, latest: "v0.9.0", notes: "- Talking to it", message: "Version 0.9.0 is ready to install." }));
    await page.getByRole("button", { name: "Check for updates" }).click();
    await expect(page.getByText("Version 0.9.0 is ready to install.")).toBeVisible();
    await expect(page.locator(".update-notes li")).toHaveText("Talking to it");
    await page.getByRole("button", { name: "Update now" }).click();
    expect(await page.evaluate(() => (window as never as { __mock: { updateInstalled(): boolean } }).__mock.updateInstalled())).toBe(true);
  });

  test("what is new stays on the page once you are up to date", async ({ page }) => {
    await page.evaluate(() => (window as never as { __mock: { setUpdate(s: unknown): void } }).__mock.setUpdate({ notes: "- Talking to it" }));
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Updates", exact: true }).click();
    await expect(page.getByText("You are on the latest version.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "What is new in 0.3.0" })).toBeVisible();
    await expect(page.locator(".update-notes li")).toHaveText("Talking to it");
    await expect(page.getByRole("button", { name: "Update now" })).toHaveCount(0);
  });

  test("wake words are off until turned on, and can be set up and tried", async ({ page }) => {
    const mock = (call: string) => page.evaluate((c) => new Function("m", `m.${c}`)((window as never as { __mock: unknown }).__mock), call);
    await mock('wakeTeachEnd("Hey Meridian")');
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Wake words", exact: true }).click();
    await expect(page.getByRole("switch", { name: /Listen for wake words/ })).not.toBeChecked();
    await expect(page.getByText("Knows your voice")).toBeVisible();
    await expect(page.getByRole("button", { name: "Teach again" })).toBeVisible();

    const add = page.getByRole("button", { name: "Add", exact: true });
    await page.getByLabel("Add a wake word").fill("Suno Mira");
    await add.click();
    await expect(page.getByRole("switch", { name: "Suno Mira" })).toBeChecked();
    await page.getByRole("button", { name: "Remove Okay Meridian" }).click();
    await expect(page.getByRole("switch", { name: "Okay Meridian" })).toHaveCount(0);

    await page.getByLabel("Add a wake word").fill("wake 123");
    await expect(page.getByText("Use letters only.")).toBeVisible();
    await expect(add).toBeDisabled();
    await page.getByLabel("Add a wake word").fill("सुनो मीरा");
    await expect(add).toBeEnabled();
    await add.click();
    await expect(page.getByRole("switch", { name: "सुनो मीरा" })).toBeChecked();
    await page.getByLabel("Add a wake word").fill("suno mira");
    await expect(add).toBeDisabled();
    await expect(page.getByText("suno mira is already on the list.")).toBeVisible();
    // Written the way a name is written, it is still the phrase.
    await page.getByLabel("Add a wake word").fill("Hey, Jarvis!");
    await expect(add).toBeEnabled();
    await page.getByLabel("Add a wake word").press("Enter");
    await expect(page.getByRole("switch", { name: "Hey Jarvis" })).toBeChecked();
    await expect(page.getByLabel("Add a wake word")).toHaveValue("");

    await page.getByRole("button", { name: "Test", exact: true }).click();
    await expect(page.getByText("Getting ready.")).toBeVisible();
    await mock('setWakeState({ state: "listening", why: "" })');
    await expect(page.getByText("Say Hey Meridian now.")).toBeVisible();
    await mock('hearWake("Hey Meridian", true)');
    await expect(page.getByText("Heard Hey Meridian.")).toBeVisible();
    await expect(island(page)).toHaveAttribute("data-view", "expanded");
  });

  test("a word it was never taught cannot be tested, and a lesson with no microphone says so", async ({ page }) => {
    await page.goto("/");
    await page.locator(".island").click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Wake words", exact: true }).click();
    await expect(page.getByText("Teach it a wake word first.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Test", exact: true })).toBeDisabled();
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        throw new Error("No microphone was found.");
      };
    });
    await page.getByRole("button", { name: "Teach", exact: true }).first().click();
    await expect(page.getByRole("alert")).toContainText("No microphone was found.");
    await expect(page.getByRole("button", { name: "Teach", exact: true }).first()).toBeEnabled();
  });

  test("the island shows a dot only while the microphone is open for wake words, and says why it is not", async ({ page }) => {
    const set = (state: string, why: string) => page.evaluate(([s, w]) => (window as never as { __mock: { setWakeState(v: unknown): void } }).__mock.setWakeState({ state: s, why: w }), [state, why]);
    const dot = page.getByRole("img", { name: "Listening for a wake word" });
    await expect(dot).toHaveCount(0);
    await set("listening", "");
    await expect(dot).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Wake words", exact: true }).click();
    await set("paused", "Paused while another app is using the microphone.");
    await expect(dot).toHaveCount(0);
    await expect(page.getByText("Paused while another app is using the microphone.")).toBeVisible();
  });

  test("how much the app may see is set in Settings", async ({ page }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Screen", exact: true }).click();
    await page.getByRole("button", { name: "Watch for errors" }).click();
    await expect(page.getByRole("button", { name: "Watch for errors" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("switch", { name: "Pause monitoring" }).click();
    await expect(page.getByRole("switch", { name: "Pause monitoring" })).toBeChecked();

    await page.getByRole("button", { name: "Off" }).click();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.getByRole("button", { name: "Look", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "When I ask" }).click();

    const add = page.getByLabel("Add an app or window to skip");
    await add.fill("salary.xlsx");
    await add.press("Enter");
    await expect(add).toHaveValue("");
    await page.getByRole("button", { name: "Allow salary.xlsx again" }).click();
    await expect(page.getByRole("button", { name: "Allow salary.xlsx again" })).toHaveCount(0);
    await expect(page.getByText("Password managers")).toBeVisible();
  });

  test("removing the last key takes that provider out of the engine list", async ({ page }) => {
    await openModels(page);
    await page.locator(".card", { hasText: "Anthropic" }).getByRole("button", { name: "Remove" }).click();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("button", { name: "AI engine" }).click();
    await expect(page.getByRole("menuitemradio", { name: "Anthropic" })).toHaveCount(0);
  });

  test.describe("my day", () => {
    test.beforeEach(async ({ page }) => {
      await page.getByRole("button", { name: "My day" }).click();
    });

    test("shows each item with its source and flags a weak extraction", async ({ page }) => {
      const flight = page.locator(".event", { hasText: "Flight 6E 2341" });
      await expect(flight).toContainText("From me@example.com: Confirmation");
      await expect(flight.locator(".flag")).toHaveCount(0);
      await expect(page.locator(".event", { hasText: "Package" }).locator(".flag")).toHaveText("Unconfirmed");
    });

    test("filters by category", async ({ page }) => {
      await page.getByRole("button", { name: "Travel" }).click();
      await expect(page.locator(".event")).toHaveCount(1);
      await expect(page.locator(".event")).toContainText("Flight");
    });

    test("lets you correct and delete what was extracted", async ({ page }) => {
      const flight = page.locator(".event", { hasText: "Flight 6E 2341" });
      await flight.getByRole("button", { name: "Correct" }).click();
      await page.getByLabel("Title").fill("Flight to Delhi");
      await page.getByLabel("Title").press("Enter");
      await expect(page.locator(".event", { hasText: "Flight to Delhi" })).toBeVisible();
      await page.locator(".event", { hasText: "Flight to Delhi" }).getByRole("button", { name: "Delete" }).click();
      await expect(page.locator(".event", { hasText: "Flight to Delhi" })).toHaveCount(0);
    });

    test("adds a reminder of your own", async ({ page }) => {
      await page.getByLabel("Reminder").fill("Call the bank");
      await page.getByLabel("When").fill("2026-11-02T09:30");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.locator(".event", { hasText: "Call the bank" })).toContainText("Added by you");
    });

    test("reads Gmail through the Claude account when Google has no sign-in, at most every half hour", async ({ page }) => {
      const reads = () => page.evaluate(() => (window as never as { __mock: { claudeMailReads(): number } }).__mock.claudeMailReads());
      await expect(page.getByText("Read 2 messages through Claude, and found 1 plan.")).toBeVisible();
      await page.getByRole("button", { name: "Important dates" }).click();
      await expect(page.getByText(/^Nothing under Important dates\. \d+ items are under the other headings\.$/)).toBeVisible();
      await page.getByRole("button", { name: "Upcoming" }).click();
      await expect(page.locator(".event", { hasText: "Order 112-4455" })).toContainText("From Gmail, through Claude: Your order has shipped");
      await expect(page.getByText(/^From Gmail through your Claude account and your own reminders\.$/)).toBeVisible();
      expect(await reads()).toBe(1);

      await page.getByRole("button", { name: "Home", exact: true }).click();
      await page.getByRole("button", { name: "My day" }).click();
      await expect(page.getByText("Read 2 messages through Claude, and found 1 plan.")).toBeVisible();
      expect(await reads()).toBe(1);

      await page.evaluate(() => (window as never as { __mock: { failClaudeMail(why: string): void } }).__mock.failClaudeMail("Gmail is not connected. It connects at claude.ai/customize/connectors, in the Claude account Claude Code is signed in to."));
      await page.getByRole("button", { name: "Read again" }).click();
      await expect(page.getByText(/^Gmail is not connected\./)).toBeVisible();
      await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
      expect(await reads()).toBe(2);
    });

    test("reading an email says when it finds nothing", async ({ page }) => {
      await page.getByRole("button", { name: "Paste an email" }).click();
      await page.getByLabel("Subject").fill("Huge flight sale this weekend");
      await page.getByLabel("Email text").fill("Save 40 percent");
      await page.getByRole("button", { name: "Read it" }).click();
      await expect(page.getByRole("status")).toContainText("Nothing reliable");
    });
  });

  test("notification preferences include quiet hours", async ({ page }) => {
    await page.getByRole("button", { name: "Notifications" }).click();
    await page.getByRole("switch", { name: "Quiet hours" }).check();
    await expect(page.getByRole("switch", { name: "Quiet hours" })).toBeChecked();
  });

  test("an account can be connected and disconnected", async ({ page }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Providers", exact: true }).click();
    await page.getByRole("button", { name: "Gmail", exact: true }).click();
    await page.getByRole("button", { name: "Connect Gmail" }).click();
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
    await page.getByRole("button", { name: "Disconnect" }).click();
    await expect(page.getByRole("button", { name: "Disconnect" })).toHaveCount(0);
  });

  test("with no registered app, Gmail and Calendar go through the Claude account", async ({ page }) => {
    await page.evaluate(async () => {
      const app = window as never as { __mock: { noRegisteredApps(): void }; __meridian: { refreshIntegrations(): Promise<void> } };
      app.__mock.noRegisteredApps();
      await app.__meridian.refreshIntegrations();
    });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Providers", exact: true }).click();
    await page.locator(".link-tile", { hasText: "Gmail" }).click();
    await expect(page.locator(".link-detail")).toContainText("Connected through your Claude account");
    await expect(page.locator(".link-detail")).toContainText("goes through Claude");
    await expect(page.getByRole("button", { name: "Disconnect" })).toHaveCount(0);
    await page.getByRole("button", { name: "Google Calendar", exact: true }).click();
    await expect(page.getByRole("button", { name: "Connect Google Calendar" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();
    await page.getByRole("button", { name: "Outlook", exact: true }).click();
    await expect(page.locator(".link-detail")).toContainText("Not available yet");
  });

  test.describe("Claude Code as a chat engine", () => {
    test.beforeEach(async ({ page }) => {
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      await useEngine(page, "Claude Code");
    });

    test("needs no API key and shows the plan the CLI reports", async ({ page }) => {
      await expect(page.locator(".bar .meta", { hasText: "max" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
    });

    test("streams a reply, then continues the same conversation", async ({ page }) => {
      await page.getByLabel("Message").fill("chat: hello");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.locator(".log")).toContainText("Hello from the stand-in agent.");
      await expect(page.locator(".chat-title")).not.toHaveText("New chat");

      await page.getByLabel("Message").fill("and again");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.locator(".log")).toContainText("Follow-up received: and again");
      await expect(page.locator(".conv")).toHaveCount(1);
    });

    test("keeps conversations separate and switchable", async ({ page }) => {
      await page.getByLabel("Message").fill("chat: first");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.locator(".log")).toContainText("Hello from the stand-in agent.");

      await page.getByRole("button", { name: "New chat" }).click();
      await expect(page.locator(".log")).not.toContainText("Hello from the stand-in agent.");
      await page.getByLabel("Message").fill("chat: second");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.locator(".conv")).toHaveCount(2);

      await page.getByLabel("Search chats").fill("first");
      await expect(page.locator(".conv")).toHaveCount(1);
      await page.locator(".conv").click();
      await expect(page.locator(".chat-title")).toContainText("first");
    });

    test("project mode asks for a folder before it starts", async ({ page }) => {
      await page.getByRole("button", { name: "Project" }).click();
      await page.getByLabel("Message").fill("chat: work here");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.locator(".island")).toHaveAttribute("data-view", "expanded");
      await expect(page.getByRole("alert")).toContainText("Choose a project folder");
      await expect(page.getByLabel("Message")).toHaveValue("chat: work here");
      await expect(page.locator(".log")).not.toContainText("Hello from the stand-in agent.");
      await page.getByRole("button", { name: "Choose folder" }).click();
      await expect(page.locator(".bar", { hasText: "sample" })).toBeVisible();
    });

    test("after clearing history, the next message starts afresh and its reply shows", async ({ page }) => {
      await page.getByLabel("Message").fill("chat: hello");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.locator(".log")).toContainText("Hello from the stand-in agent.");
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Privacy", exact: true }).click();
      await page.getByRole("button", { name: "Clear history" }).click();
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      await expect(page.locator(".log")).not.toContainText("Hello from the stand-in agent.");
      await page.getByLabel("Message").fill("chat: again");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.locator(".log")).toContainText("Hello from the stand-in agent.");
    });

    test("referenced files travel with the message", async ({ page }) => {
      await page.getByRole("button", { name: "Reference a file" }).click();
      await expect(page.locator(".attachment")).toHaveText("notes.md");
      await page.getByLabel("Message").fill("chat: read this");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.locator(".log-user")).toContainText("notes.md");
    });

    test("a signed-out CLI offers its own sign-in", async ({ page }) => {
      await page.evaluate(() => (window as never as { __mock: { setAuthed(v: boolean): void } }).__mock.setAuthed(false));
      await useEngine(page, "Anthropic");
      await useEngine(page, "Claude Code");
      await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    });
  });

  test.describe("providers column", () => {
    test.beforeEach(async ({ page }) => {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Providers", exact: true }).click();
    });

    test("lists mail, calendar and MCP services by group", async ({ page }) => {
      const column = page.getByRole("navigation", { name: "Providers" });
      for (const name of ["Gmail", "Google Calendar", "Outlook", "Linear", "GitHub"]) {
        await expect(column.getByRole("button", { name })).toBeVisible();
      }
    });

    test("a service with open sign-in connects, then shows what it fetched", async ({ page }) => {
      await page.getByRole("button", { name: "Linear" }).click();
      await expect(page.locator(".link-detail")).toContainText("own page");
      await page.getByRole("button", { name: "Connect Linear" }).click();
      await expect(page.locator(".fetched-row")).toHaveCount(2);
      await expect(page.locator(".fetched")).toContainText("Fix the island hit area");
      await expect(page.locator(".link-feed h2")).toContainText("2 items");
      await expect(page.getByRole("navigation", { name: "Providers" }).locator(".link-dot")).toHaveCount(1);
    });

    test("a link says where it goes, and a row without one is not a button that does nothing", async ({ page }) => {
      await page.getByRole("button", { name: "Linear" }).click();
      await page.getByRole("button", { name: "Connect Linear" }).click();
      await expect(page.locator(".fetched-row").first()).toHaveAttribute("title", "Open on linear.example");
      await expect(page.locator(".fetched-row").nth(1)).toBeDisabled();
    });

    test("the read-only tools can be switched, and fetching marks the beam", async ({ page }) => {
      await page.getByRole("button", { name: "Linear" }).click();
      await page.getByRole("button", { name: "Connect Linear" }).click();
      await expect(page.locator(".fetched-row")).toHaveCount(2);
      await page.getByRole("button", { name: "search_issues" }).click();
      await expect(page.locator(".beam")).toHaveAttribute("data-on", "true");
      await expect(page.getByRole("button", { name: "search_issues" })).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(".beam")).toHaveAttribute("data-on", "false");
    });

    test("a server with dozens of tools still shows what it fetched", async ({ page }) => {
      await page.getByRole("button", { name: "Linear" }).click();
      await page.getByRole("button", { name: "Connect Linear" }).click();
      await expect(page.locator(".fetched-row")).toHaveCount(2);
      await page.locator(".link-feed .chips").evaluate((el) => {
        for (let i = 0; i < 40; i++) el.append(el.firstElementChild!.cloneNode(true));
      });
      const row = await page.locator(".fetched-row").last().boundingBox();
      const pane = await page.locator(".link-detail").boundingBox();
      expect(row!.y + row!.height).toBeLessThanOrEqual(pane!.y + pane!.height);
    });

    test("disconnecting drops what was fetched", async ({ page }) => {
      await page.getByRole("button", { name: "Linear" }).click();
      await page.getByRole("button", { name: "Connect Linear" }).click();
      await expect(page.locator(".fetched-row")).toHaveCount(2);
      await page.getByRole("button", { name: "Disconnect" }).click();
      await expect(page.getByRole("button", { name: "Connect Linear" })).toBeVisible();
      await expect(page.locator(".fetched-row")).toHaveCount(0);
    });

    test("no service ever asks for a key, and one not yet registered says so", async ({ page }) => {
      await page.getByRole("button", { name: "Slack" }).click();
      await expect(page.getByRole("button", { name: "Connect Slack" })).toHaveCount(0);
      await expect(page.locator(".link-detail")).toContainText("Not available yet");
      await expect(page.locator(".link-detail input")).toHaveCount(0);
    });
  });

  test.describe("Claude Code in another terminal", () => {
    const publish = (page: Page) =>
      page.evaluate(() => (window as never as { __mock: { publishWatched(id: string): void } }).__mock.publishWatched("watch:s1"));

    test("a session that started before the app still shows its permission request", async ({ page }) => {
      await page.keyboard.press("Escape");
      await page.evaluate(() => (window as never as { __mock: { publishWatchedApproval(id: string): void } }).__mock.publishWatchedApproval("watch:early"));
      await expect(island(page)).toContainText("npm install stripe");
      await expect(island(page)).toContainText("Your terminal");
    });

    test("is off until asked, and the toggle says what it changes", async ({ page }) => {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Coding agents", exact: true }).click();
      const toggle = page.getByRole("switch", { name: /Follow Claude Code in any terminal/ });
      await expect(toggle).not.toBeChecked();
      await expect(page.locator(".settings-body")).toContainText("keeps a backup");

      // Nothing is written until the exact change has been shown and confirmed.
      await toggle.click();
      const review = page.getByRole("group", { name: "Review this change" });
      await expect(review).toContainText("This will add these lines");
      await expect(review).toContainText("127.0.0.1");
      await expect(review).toContainText(".meridian-backup");
      await review.getByRole("button", { name: "Cancel" }).click();
      await expect(toggle).not.toBeChecked();
      expect(await page.evaluate(() => (window as never as { __mock: { watching(): boolean } }).__mock.watching())).toBe(false);

      await toggle.click();
      await page.getByRole("button", { name: "Add hooks" }).click();
      await expect(toggle).toBeChecked();
      expect(await page.evaluate(() => (window as never as { __mock: { watching(): boolean } }).__mock.watching())).toBe(true);
    });

    test("a question is answered on the island, one step at a time", async ({ page }) => {
      await page.keyboard.press("Escape");
      await page.locator(".island").evaluate(() => {
        const mock = (window as never as { __mock: { publishWatched(id: string): void; publishWatchedQuestion(id: string): void } }).__mock;
        mock.publishWatched("watch:q");
        mock.publishWatchedQuestion("watch:q");
      });
      const island = page.locator(".island");
      await expect(island).toContainText("Which one?");
      await island.getByRole("button", { name: "Amber" }).click();
      await expect(island).toContainText("And then?");
      await island.getByRole("button", { name: "Ship it" }).click();
      await expect.poll(() => page.evaluate(() => (window as never as { __mock: { lastAnswers(): unknown } }).__mock.lastAnswers())).toEqual({ "Which one?": "Amber", "And then?": "Ship it" });
    });

    test("a plan is read and approved on the island", async ({ page }) => {
      await page.keyboard.press("Escape");
      await page.locator(".island").evaluate(() => {
        const mock = (window as never as { __mock: { publishWatched(id: string): void; publishWatchedPlan(id: string): void } }).__mock;
        mock.publishWatched("watch:p");
        mock.publishWatchedPlan("watch:p");
      });
      const island = page.locator(".island");
      await expect(island).toContainText("has a plan");
      await expect(island.locator(".plan-text li")).toHaveCount(2);
      await island.getByRole("button", { name: "Approve plan" }).click();
      await expect(island.getByRole("button", { name: "Approve plan" })).toHaveCount(0);
    });

    test("appears as a session that can be followed but not steered", async ({ page }) => {
      await publish(page);
      await page.getByRole("button", { name: "Agents", exact: true }).click();
      await page.locator(".session-row").first().click();
      await expect(page.locator(".session-head")).toContainText("shop");
      await expect(page.getByText("Terminal", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Instruction")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Stop session" })).toHaveCount(0);
    });

    test("shows on the island, and asks for permission there", async ({ page }) => {
      await page.keyboard.press("Escape");
      await publish(page);
      await expect(island(page)).toHaveAttribute("data-view", "working");
      await expect(island(page)).toContainText("Editing cart.ts");
      await expect(island(page).getByRole("button", { name: "Stop task" })).toHaveCount(0);
      await page.evaluate(() => (window as never as { __mock: { publishWatchedApproval(id: string): void } }).__mock.publishWatchedApproval("watch:s1"));
      await expect(island(page)).toContainText("npm install stripe");
      await expect(island(page).getByRole("button", { name: "Allow" })).toBeVisible();
    });
  });

  test("chat survives a restart, without any images, and can be cleared", async ({ page }) => {
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await useEngine(page, "Anthropic");
    await page.getByLabel("Message").fill("remember this");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator('.message[data-role="assistant"]')).toContainText("browser stand-in");
    await page.waitForTimeout(1100);

    await page.reload();
    await island(page).click();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await useEngine(page, "Anthropic");
    await expect(page.locator('.message[data-role="user"]')).toContainText("remember this");

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Privacy", exact: true }).click();
    await page.getByRole("button", { name: "Clear history" }).click();
    await page.reload();
    await island(page).click();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await useEngine(page, "Anthropic");
    await expect(page.locator('.message[data-role="user"]')).toHaveCount(0);
  });

  test("first run shows the welcome steps until they are done", async ({ page }) => {
    await page.evaluate(() => (window as never as { __meridian: { updateSettings(p: object): Promise<void> } }).__meridian.updateSettings({ onboarded: false }));
    await expect(page.getByRole("heading", { name: /top of your screen/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Chat", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible();
  });

  test("settings apply straight away", async ({ page }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Island", exact: true }).click();
    await page.getByRole("button", { name: "Cat", exact: true }).click();
    await expect(page.locator(".panel-head .face")).toHaveAttribute("data-face", "cat");
    await page.getByRole("button", { name: "Reduced" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
  });
});
