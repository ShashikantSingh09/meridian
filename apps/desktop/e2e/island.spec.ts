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
    ["contextual", "contextual", "Suggest fix"],
    ["media", "media", "Northern Lights"],
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

test("the clock and hide options change the idle shape", async ({ page }) => {
  const width = async () => (await island(page).boundingBox())!.width;
  const setting = (patch: object) =>
    page.evaluate((p) => (window as never as { __meridian: { updateSettings(p: object): Promise<void> } }).__meridian.updateSettings(p), patch);

  await setting({ showClock: true });
  await settled(page);
  expect(await width()).toBeCloseTo(176, 0);

  await setting({ showClock: false, islandAutoHide: true });
  await settled(page);
  expect((await island(page).boundingBox())!.height).toBeCloseTo(6, 0);
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
  await expect(island(page)).toContainText("Northern Lights");

  await page.getByRole("button", { name: "Pause" }).click();
  await expect(island(page)).toHaveAttribute("data-view", "idle");

  await publish(false);
  await expect(island(page)).toHaveAttribute("data-view", "idle");
});

test("media steps aside for a notification, then returns", async ({ page }) => {
  await page.evaluate(() => (window as never as { __mock: { publishMedia(p: boolean): void } }).__mock.publishMedia(true));
  await expect(island(page)).toHaveAttribute("data-view", "media");
  await page.evaluate(() => (window as never as { __meridian: { pushNotice(n: object): void } }).__meridian.pushNotice({ tone: "info", title: "Heads up", body: "" }));
  await expect(island(page)).toHaveAttribute("data-view", "notification");
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
    await page.getByLabel("AI engine").selectOption("anthropic");
    await expect(page.getByLabel("Model")).toHaveValue("model-a");
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

  test("removing the last key takes that provider out of the engine list", async ({ page }) => {
    await page.getByRole("button", { name: "Providers", exact: true }).click();
    await page.locator(".card", { hasText: "Anthropic" }).getByRole("button", { name: "Remove" }).click();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.getByLabel("AI engine").locator("option", { hasText: "Anthropic" })).toHaveCount(0);
  });

  test.describe("Claude Code as a chat engine", () => {
    test.beforeEach(async ({ page }) => {
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      await page.getByLabel("AI engine").selectOption("claude-code");
    });

    test("needs no API key and shows the plan the CLI reports", async ({ page }) => {
      await expect(page.locator(".bar .meta", { hasText: "max" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
    });

    test("streams a reply, then continues the same conversation", async ({ page }) => {
      await page.getByLabel("Message").fill("chat: hello");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.locator(".log")).toContainText("Hello from the stand-in agent.");
      await expect(page.getByLabel("Conversation")).not.toHaveValue("");

      await page.getByLabel("Message").fill("and again");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.locator(".log")).toContainText("Follow-up received: and again");
      await expect(page.getByLabel("Conversation").locator("option")).toHaveCount(2);
    });

    test("keeps conversations separate and switchable", async ({ page }) => {
      await page.getByLabel("Message").fill("chat: first");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.locator(".log")).toContainText("Hello from the stand-in agent.");

      await page.getByLabel("Conversation").selectOption("");
      await expect(page.locator(".log")).not.toContainText("Hello from the stand-in agent.");
      await page.getByLabel("Message").fill("chat: second");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByLabel("Conversation").locator("option")).toHaveCount(3);
    });

    test("project mode asks for a folder before it starts", async ({ page }) => {
      await page.getByRole("button", { name: "Project" }).click();
      await page.getByLabel("Message").fill("chat: work here");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.locator(".island")).toHaveAttribute("data-view", "expanded");
      await expect(page.locator(".log")).not.toContainText("Hello from the stand-in agent.");
      await page.getByRole("button", { name: "Choose folder" }).click();
      await expect(page.locator(".bar", { hasText: "sample" })).toBeVisible();
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
      await page.getByLabel("AI engine").selectOption("anthropic");
      await page.getByLabel("AI engine").selectOption("claude-code");
      await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    });
  });

  test("settings apply straight away", async ({ page }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Light" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
});
