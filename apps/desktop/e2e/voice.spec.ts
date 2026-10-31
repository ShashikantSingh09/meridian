import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

/** Half a second of quiet, a burst of sound, then a long quiet: what a short question looks like. */
function recording() {
  const rate = 16000;
  const seconds = [0.5, 1.2, 8];
  const count = Math.round(seconds.reduce((a, b) => a + b) * rate);
  const wav = Buffer.alloc(44 + count * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + count * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) {
    const at = i / rate;
    const loud = at > seconds[0]! && at < seconds[0]! + seconds[1]!;
    wav.writeInt16LE(loud ? Math.round(Math.sin(at * 2 * Math.PI * 300) * 12000) : 0, 44 + i * 2);
  }
  const path = join(tmpdir(), "meridian-test-speech.wav");
  writeFileSync(path, wav);
  return path;
}

// A recording stands in for the microphone, which drives a real turn through the real audio
// path: the mic, the worklet, and working out when speech has ended.
test.use({
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${recording()}%noloop`],
  },
});

type Mock = {
  setHeard(words: string): void;
  setPacks(ids: string[]): void;
  spoken(): string[];
  publishWatched(id: string): void;
};
type App = { startVoice(mode: string): Promise<void>; endConversation(): void; getState(): { voice: { phase: string } | null } };

const mock = (page: Page) => (fn: (m: Mock) => unknown) => page.evaluate(`(${fn.toString()})(window.__mock)`);
const island = (page: Page) => page.locator(".island");
const start = (page: Page, mode: string) => page.evaluate((m) => (window as never as { __meridian: App }).__meridian.startVoice(m), mode);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(island(page)).toBeVisible();
  await page.evaluate(() => {
    const m = (window as never as { __meridian: { updateSettings(s: unknown): void } }).__meridian;
    m.updateSettings({ onboarded: true });
  });
});

test("a spoken question goes to the AI, and the answer is read out", async ({ page }) => {
  await island(page).click();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("button", { name: "AI engine" }).click();
  await page.getByRole("menuitemradio", { name: "Anthropic" }).click();
  await page.keyboard.press("Escape");
  await mock(page)((m) => m.setHeard("what time is my flight"));

  await start(page, "turn");
  await expect(island(page)).toHaveAttribute("data-view", "voice");
  await expect(island(page)).toContainText("what time is my flight");

  await expect.poll(() => mock(page)((m) => m.spoken().length), { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(island(page)).toHaveAttribute("data-view", "idle", { timeout: 8_000 });

  const said = (await mock(page)((m) => m.spoken())) as string[];
  expect(said.join(" ")).toContain("browser stand-in");
  await island(page).click();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.locator('.message[data-role="user"]')).toContainText("what time is my flight");
});

test("the island always shows the microphone is open, and it can be stopped", async ({ page }) => {
  await mock(page)((m) => m.setHeard("hello"));
  await start(page, "hold");
  await expect(island(page)).toContainText("Listening");
  await island(page).getByRole("button", { name: "Stop talking" }).click();
  await expect(island(page)).toHaveAttribute("data-view", "idle");
});

test("a voice needs a key or a download before it can be used, and says so", async ({ page }) => {
  await island(page).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Voice", exact: true }).click();

  await page.getByRole("button", { name: /ElevenLabs/ }).first().click();
  await page.getByLabel("ElevenLabs API key").fill("sk_test");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("ElevenLabs API key")).toHaveAttribute("placeholder", "Key saved");
  await expect(page.getByLabel("ElevenLabs API key")).toHaveValue("");

  await page.getByRole("button", { name: /Kokoro/ }).first().click();
  await page.getByRole("button", { name: /Download, 328 MB/ }).click();
  await expect(page.getByRole("button", { name: "Hear Bella" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
});

test("hearing that is here still offers the engine it needs", async ({ page }) => {
  await mock(page)((m) => m.setPacks(["hearing"]));
  await island(page).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Voice", exact: true }).click();

  await page.getByRole("button", { name: /Download, 8 MB/ }).click();
  await expect(page.getByRole("button", { name: /Download/ })).toHaveCount(0);
});

test("every state of a conversation has its own face and words", async ({ page }) => {
  const show = (name: string | null) => page.evaluate((n) => (window as never as { __meridian: { showPreview(n: string | null): void } }).__meridian.showPreview(n), name);
  for (const [name, label, mood] of [
    ["voice listening", "Listening", "needs"],
    ["voice pause", "Still with you", "curious"],
    ["voice thinking", "Thinking", "curious"],
    ["voice speaking", "Speaking", "rest"],
  ]) {
    await show(name!);
    await expect(island(page)).toContainText(label!);
    await expect(page.locator(".island .face").last()).toHaveAttribute("data-mood", mood!);
  }
  await show(null);
});
