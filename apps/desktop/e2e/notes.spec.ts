import { expect, test, type Page } from "@playwright/test";

// The fake stream is real to the page, so the microphone opens and closes the way it does on a PC.
test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => "__meridian" in window);
  await page.evaluate(() => (window as never as { __meridian: { openPanel(): void } }).__meridian.openPanel());
  await expect(page.locator(".panel")).toBeVisible();
});

test.describe("Notes", () => {
  const openNotes = async (page: Page, hearing = "elevenlabs") => {
    await page.evaluate((voiceHearing) => (window as never as { __meridian: { updateSettings(p: object): Promise<void> } }).__meridian.updateSettings({ voiceHearing }), hearing);
    await page.getByRole("button", { name: "Notes", exact: true }).click();
  };
  const finish = (page: Page, lines = true) => page.evaluate((l) => (window as never as { __mock: { finishNote(l: boolean): void } }).__mock.finishNote(l), lines);
  const record = async (page: Page) => {
    await page.getByRole("button", { name: "Record", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  };

  test("with nothing yet, it says what happens to a call before it records one", async ({ page }) => {
    await openNotes(page);
    await expect(page.getByRole("heading", { name: "No notes yet" })).toBeVisible();
    await expect(page.locator(".notes-blank")).toContainText("Tell the people in the call that you are recording");
    await expect(page.locator(".notes-blank")).toContainText("goes to ElevenLabs");
    await expect(page.getByRole("button", { name: "Record", exact: true })).toBeVisible();
  });

  test("hearing on this PC cannot do this, and says where to change it", async ({ page }) => {
    await openNotes(page, "local");
    await expect(page.getByRole("heading", { name: "Notes need ElevenLabs or Deepgram" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Record", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Open Voice settings" }).click();
    await expect(page.locator(".settings")).toBeVisible();
  });

  test("a chosen microphone that has gone costs nobody a call", async ({ page }) => {
    await openNotes(page);
    await page.evaluate(() => (window as never as { __meridian: { updateSettings(p: object): Promise<void> } }).__meridian.updateSettings({ voiceMicrophone: "unplugged" }));
    await record(page);
    await expect(page.locator(".panel")).toContainText("Your microphone is not connected");
    await expect(page.locator(".note-state")).toContainText("Recording");
  });

  test("recording shows a clock in the head, and stopping writes the note", async ({ page }) => {
    await openNotes(page);
    await record(page);
    await expect(page.locator(".panel-head .note-clock")).toBeVisible();
    await expect(page.locator(".note-state")).toContainText("Recording");
    await expect(page.locator(".note-time")).toHaveText(/^0:0\d$/);
    await expect(page.locator(".notes-pane")).toContainText("go to ElevenLabs");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.locator(".panel-head .note-clock")).toHaveCount(0);
    await expect(page.locator(".notes-pane")).toContainText("Writing down who said what");
    await expect(page.locator(".note-row")).toContainText("Writing the notes");
    await finish(page);
    await expect(page.getByRole("heading", { name: "Launch date and checkout" })).toBeVisible();
    await expect(page.locator(".note-summary")).toContainText("Friday 6 November");
    await expect(page.locator(".note-todo")).toHaveCount(3);
  });

  test("with summaries off, the note waits for the button", async ({ page }) => {
    await openNotes(page);
    await record(page);
    await page.getByRole("switch", { name: "Summary by itself" }).click();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await finish(page);
    await expect(page.locator(".notes-pane")).toContainText("No summary yet.");
    await page.getByRole("button", { name: "Write the summary" }).click();
    await expect(page.locator(".note-summary")).toBeVisible();
  });

  test("people, to-dos and the title can all be changed", async ({ page }) => {
    await openNotes(page);
    await record(page);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await finish(page);
    await page.getByRole("button", { name: "Person 2" }).click();
    await page.getByRole("textbox", { name: "Name Person 2" }).fill("Priya");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: /Priya/ })).toBeVisible();
    const todo = page.getByRole("checkbox", { name: /Tell the client/ });
    await todo.click();
    await expect(todo).toHaveAttribute("aria-checked", "true");
    await expect(page.locator(".notes-pane")).toContainText("1 of 3");
    await page.locator(".note-title").getByRole("button", { name: "Launch date and checkout" }).click();
    await page.getByRole("textbox", { name: "Name this note" }).fill("My own name");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "My own name" })).toBeVisible();
  });

  test("the transcript shows who said what, with the times", async ({ page }) => {
    await openNotes(page);
    await record(page);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await finish(page);
    await page.getByRole("button", { name: "Transcript" }).click();
    await expect(page.locator(".note-line")).toHaveCount(4);
    await expect(page.locator(".note-line").nth(1)).toContainText("0:11");
    await expect(page.locator(".note-line").nth(1)).toContainText("चेकआउट");
    await expect(page.getByRole("button", { name: /You/ }).first()).toContainText("%");
  });

  test("nobody heard says so, and is not called a failure", async ({ page }) => {
    await openNotes(page);
    await record(page);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await finish(page, false);
    await expect(page.locator(".notes-pane")).toContainText("Nobody was heard in this recording.");
  });

  test("a failure keeps the recording, and Try again runs it again", async ({ page }) => {
    await openNotes(page);
    await record(page);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.evaluate(() => (window as never as { __mock: { failNote(why: string): void } }).__mock.failNote("The service says this account has run out."));
    await expect(page.locator(".note-card")).toContainText("The transcript could not be written");
    await expect(page.locator(".note-card")).toContainText("run out");
    await expect(page.locator(".note-card")).toContainText("The recording is kept");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator(".notes-pane")).toContainText("Writing down who said what");
  });

  test("deleting asks first, and goes back to nothing", async ({ page }) => {
    await openNotes(page);
    await record(page);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await finish(page);
    await page.getByRole("button", { name: "Delete this note" }).click();
    await expect(page.getByRole("alert")).toContainText("Delete this note?");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("heading", { name: "Launch date and checkout" })).toBeVisible();
    await page.getByRole("button", { name: "Delete this note" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("heading", { name: "No notes yet" })).toBeVisible();
  });

  test("copy and export hand over the note", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openNotes(page);
    await record(page);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await finish(page);
    await page.getByRole("button", { name: "Copy" }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("# Launch date and checkout");
    await page.getByRole("button", { name: "Export" }).click();
    await expect.poll(() => page.evaluate(() => (window as never as { __mock: { exportedTo(): string } }).__mock.exportedTo())).toContain("Launch date and checkout.md");
  });

  test("the red dot and clock stay on the island, and Stop is one click away", async ({ page }) => {
    await openNotes(page);
    await record(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".island")).toHaveAttribute("data-view", "note");
    await expect(page.locator(".note-bar .note-clock")).toBeVisible();
    await page.evaluate(() => (window as never as { __meridian: { setHovered(v: boolean): void } }).__meridian.setHovered(true));
    await page.locator(".note-stop").click();
    await expect(page.locator(".island")).toHaveAttribute("data-view", "note");
    await expect(page.locator(".island")).toContainText("Writing the notes");
    await finish(page);
    await expect(page.locator(".island")).toContainText("Notes ready: Launch date and checkout");
    await page.getByRole("button", { name: "See", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Launch date and checkout" })).toBeVisible();
  });

  test("anything else on the island leaves the red dot showing", async ({ page }) => {
    await openNotes(page);
    await record(page);
    await page.keyboard.press("Escape");
    await page.evaluate(() => (window as never as { __meridian: { pushNotice(n: object): void } }).__meridian.pushNotice({ tone: "info", title: "Something else", body: "Happening" }));
    await expect(page.locator(".island")).toHaveAttribute("data-view", "notification");
    await expect(page.locator(".note-dot")).toBeVisible();
  });
});

test("the dock is round, sits where the board puts it, and has Notes", async ({ page }) => {
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  // Measured once the panel has settled in, not while it is still arriving.
  await expect
    .poll(async () => {
      const item = await page.getByRole("button", { name: "Notes", exact: true }).boundingBox();
      return [item?.width, item?.height];
    })
    .toEqual([44, 44]);
  const dock = page.locator(".dock");
  await expect(dock).toHaveCSS("padding", "5px");
  await expect(dock).toHaveCSS("border-radius", "27px");
  await expect(dock.locator(".dock-pill")).toHaveCSS("border-radius", "22px");
  await expect(dock.getByRole("button")).toHaveCount(8);
  await expect(page.locator(".wake-dot")).toHaveCount(0);
});

