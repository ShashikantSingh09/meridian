import { expect, test, type Page } from "@playwright/test";

const island = (page: Page) => page.locator(".island");
const preview = (page: Page, name: string | null) =>
  page.evaluate((n) => (window as never as { __meridian: { showPreview(n: string | null): void } }).__meridian.showPreview(n), name);

const settled = async (page: Page) => {
  let last = "";
  await expect
    .poll(async () => {
      const box = JSON.stringify(await island(page).boundingBox());
      const same = box === last;
      last = box;
      return same;
    })
    .toBe(true);
};

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(island(page)).toHaveAttribute("data-view", "idle");
});

test("every compact state renders its own content and stays on screen", async ({ page }) => {
  const expected: [string, string, string | null][] = [
    ["thinking", "thinking", "Thinking"],
    ["working", "working", "Claude Code"],
    ["approval", "working", "Allow"],
    ["notification", "notification", "Claude Code finished"],
    ["contextual", "contextual", "Investigate"],
    ["multitask", "multitask", "Codex"],
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

test("the island is one element that morphs, never a swap", async ({ page }) => {
  const handle = await island(page).elementHandle();
  await preview(page, "working");
  await settled(page);
  await preview(page, "expanded");
  await settled(page);
  expect(await handle!.evaluate((el) => el.isConnected)).toBe(true);
  expect((await island(page).boundingBox())!.width).toBeGreaterThan(700);
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

test("reduced motion lands on the target size immediately", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await preview(page, "working");
  await expect(island(page)).toHaveAttribute("data-view", "working");
  await page.waitForTimeout(32);
  expect((await island(page).boundingBox())!.width).toBeCloseTo(372, 0);
});

test.describe("panel", () => {
  test.beforeEach(async ({ page }) => {
    await island(page).click();
    await expect(island(page)).toHaveAttribute("data-view", "expanded");
  });

  test("opens from the idle pill and closes with Escape", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Command center" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(island(page)).toHaveAttribute("data-view", "idle");
  });

  test("streams a chat reply and reports usage", async ({ page }) => {
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.getByLabel("Provider", { exact: true })).toHaveValue("anthropic");
    await page.getByLabel("Message").fill("hello");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator('.message[data-role="assistant"]')).toContainText("browser stand-in");
    await expect(page.locator(".bar .tabular")).toHaveText("12 / 9");
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
    await expect(page.locator(".session footer")).toContainText("1,200 in");
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
    await approval.getByRole("button", { name: "Allow" }).click();
    await expect(page.locator(".log")).toContainText("All tests pass.");
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
    await page.getByRole("button", { name: "Providers", exact: true }).click();
    const ollama = page.locator(".card", { hasText: "Ollama" });
    await expect(ollama.locator(".cap")).toHaveText(["Streaming", "Tools", "Model list"]);
    await expect(ollama.getByLabel("Ollama API key")).toHaveCount(0);
  });

  test("an API key field never echoes a stored key", async ({ page }) => {
    await page.getByRole("button", { name: "Providers", exact: true }).click();
    const key = page.getByLabel("Anthropic API key");
    await expect(key).toHaveAttribute("type", "password");
    await expect(key).toHaveValue("");
    await expect(key).toHaveAttribute("placeholder", "Key stored");
  });

  test("a chat with no provider ready offers a way forward", async ({ page }) => {
    await page.getByRole("button", { name: "Providers", exact: true }).click();
    await page.locator(".card", { hasText: "Anthropic" }).getByRole("button", { name: "Remove" }).click();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("button", { name: "Set up a provider" }).click();
    await expect(page.getByRole("heading", { name: "Providers" })).toBeVisible();
  });

  test("settings apply straight away", async ({ page }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Light" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
});
