import { expect, test, type Page } from "@playwright/test";

// The fake stream is real to the page, so the level bar and the closing of the microphone are too.
test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } });

type App = { updateSettings(p: object): Promise<void>; getState(): { settings: Record<string, unknown> } };
type Mics = { asked: unknown[]; streams: MediaStream[]; sink: string | null; tones: number };

const app = (page: Page) => ({
  get: (key: string) => page.evaluate((k) => (window as never as { __meridian: App }).__meridian.getState().settings[k], key),
  set: (patch: object) => page.evaluate((p) => (window as never as { __meridian: App }).__meridian.updateSettings(p), patch),
});
const mics = (page: Page) => page.evaluate(() => {
  const { asked, streams, sink, tones } = (window as never as { __mics: Mics }).__mics;
  return { asked, active: streams.filter((s) => s.active).length, opened: streams.length, sink, tones };
});
const accent = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name, exact: true }).click();
const openDevices = (page: Page) => page.getByText("Microphone and headphones").click();

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const device = (kind: string, deviceId: string, label: string) => ({ kind, deviceId, label, groupId: label });
    const list = [
      device("audioinput", "default", "Default - Capture Input terminal (AC Interface)"),
      device("audioinput", "communications", "Communications - Headset (MiSuperBass)"),
      device("audioinput", "mic-ac", "Capture Input terminal (AC Interface)"),
      device("audioinput", "mic-headset", "Headset (MiSuperBass)"),
      device("audiooutput", "default", "Default - MiSuperBass"),
      device("audiooutput", "out-headset", "MiSuperBass"),
      device("audiooutput", "out-speakers", "Speakers (Realtek Audio)"),
    ];
    const state: Mics = { asked: [], streams: [], sink: null, tones: 0 };
    Object.assign(window, { __mics: state, __devices: list });
    navigator.mediaDevices.enumerateDevices = async () => [...list] as MediaDeviceInfo[];
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (asked) => {
      state.asked.push(asked!.audio);
      const stream = await real({ audio: true });
      state.streams.push(stream);
      return stream;
    };
    Object.assign(AudioContext.prototype, { setSinkId: async (id: string) => void (state.sink = id) });
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (when) {
      state.tones++;
      start.call(this, when);
    };
  });
  await page.goto("/");
  await expect(page.locator(".island")).toHaveAttribute("data-view", "idle");
  await page.locator(".island").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
});

test.describe("the column", () => {
  test("keeps every section, in the groups of the board", async ({ page }) => {
    const groups = await page.locator(".settings-group").evaluateAll((list) => list.map((g) => [...g.querySelectorAll(".settings-tab-label")].map((l) => l.textContent)));
    expect(groups).toEqual([
      ["General", "Themes", "Island"],
      ["Assistant", "Voice", "Wake words"],
      ["Screen", "Privacy"],
      ["AI models", "Providers", "Coding agents"],
      ["Updates", "About"],
    ]);
    await expect(page.locator(".settings-icon")).toHaveCount(13);
  });

  test("searching narrows it by what each page holds, and Enter goes to the first match", async ({ page }) => {
    const search = page.getByLabel("Search settings");
    await search.fill("microphone");
    await expect(page.locator(".settings-tab-label")).toHaveText(["Voice", "Wake words", "Privacy"]);
    await search.press("Enter");
    await expect(page.getByRole("heading", { name: "Voice", exact: true })).toBeVisible();

    await search.fill("no such setting");
    await expect(page.getByText("Nothing matches.")).toBeVisible();
    await expect(page.locator(".settings-tab")).toHaveCount(0);

    // Escape clears the box first, and only then closes the panel.
    await search.press("Escape");
    await expect(search).toHaveValue("");
    await expect(page.locator(".settings-tab")).toHaveCount(13);
    await expect(page.locator(".island")).toHaveAttribute("data-view", "expanded");
  });
});

test.describe("themes", () => {
  test.beforeEach(({ page }) => nav(page, "Themes"));

  test("shows the six themes, and choosing one changes the panel at once", async ({ page }) => {
    await expect(page.locator(".theme-card")).toHaveCount(6);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "midnight");
    const ink = () => page.locator(".settings-body h1").evaluate((el) => getComputedStyle(el).color);
    const dark = await ink();

    await page.getByRole("button", { name: /^Daylight/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "daylight");
    await expect(page.getByRole("button", { name: /^Daylight/ })).toHaveAttribute("aria-pressed", "true");
    expect(await ink()).not.toBe(dark);

    await page.getByRole("button", { name: /^Rose/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "rose");
    expect(await accent(page)).toBe("#e0527c");
    expect(await app(page).get("theme")).toBe("rose");
  });

  test("can follow Windows or the time of day, with a theme picked for each", async ({ page }) => {
    await expect(page.getByLabel("When Windows is dark")).toHaveCount(0);
    await page.getByRole("button", { name: "Follow Windows" }).click();

    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "daylight");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "midnight");
    await page.getByLabel("When Windows is dark").selectOption("ocean");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "ocean");
    await expect(page.getByRole("button", { name: /^Ocean/ })).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "By time of day" }).click();
    await expect(page.getByLabel("At night")).toHaveValue("ocean");
    await expect(page.getByLabel("By day")).toHaveValue("daylight");

    // Picking a card is a plain choice of that theme, whatever was following what.
    await page.getByRole("button", { name: /^Graphite/ }).click();
    await expect(page.getByRole("button", { name: "This theme" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "graphite");
  });

  test("the glass slider sets the tint of the sheet", async ({ page }) => {
    const glass = page.getByRole("slider", { name: "Glass" });
    await glass.fill("100");
    expect(await app(page).get("glass")).toBe(100);
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--glass-strength"))).toBe("1");
  });

  test("a new theme paints the app as it changes, and is only kept on Save", async ({ page }) => {
    await page.getByRole("button", { name: "New theme" }).click();
    await page.getByLabel("Theme name").fill("Sea glass");
    await page.getByRole("button", { name: "Teal" }).click();
    expect(await accent(page)).toBe("#17a2b8");

    await page.getByRole("button", { name: "Back to themes" }).click();
    expect(await accent(page)).toBe("#2a84ea");
    expect(await app(page).get("customThemes")).toEqual([]);

    await page.getByRole("button", { name: "New theme" }).click();
    await page.getByLabel("Theme name").fill("Sea glass");
    await page.getByRole("button", { name: "Teal" }).click();
    await page.getByRole("button", { name: "Deep sea" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await expect(page.locator(".theme-card")).toHaveCount(7);
    await expect(page.getByRole("button", { name: /^Sea glass/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "midnight");
    expect(await accent(page)).toBe("#17a2b8");
    expect(await app(page).get("customThemes")).toMatchObject([{ name: "Sea glass", light: false, accent: "#17a2b8", window: "#06263a" }]);
  });

  test("leaving for another page drops a theme being edited", async ({ page }) => {
    await page.getByRole("button", { name: "New theme" }).click();
    await page.getByRole("button", { name: "Rose" }).click();
    await nav(page, "General");
    expect(await accent(page)).toBe("#2a84ea");
  });

  test("a light base gets a light window, and reads as a light theme", async ({ page }) => {
    await page.getByRole("button", { name: "New theme" }).click();
    await page.getByRole("button", { name: "Light", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "daylight");
    await expect(page.getByRole("button", { name: "Paper" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await expect(page.getByRole("button", { name: "Ink" })).toHaveAttribute("aria-pressed", "true");
  });

  test("editing a built-in theme saves a copy, and leaves the original alone", async ({ page }) => {
    await page.getByRole("button", { name: "Edit Midnight" }).click();
    await expect(page.getByLabel("Theme name")).toHaveValue("My Midnight");
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: /^My Midnight/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Midnight/ })).toBeVisible();
  });

  test("a saved theme can be changed, copied and deleted, and nothing keeps pointing at it", async ({ page }) => {
    await page.getByRole("button", { name: "New theme" }).click();
    await page.getByLabel("Theme name").fill("Mine");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const id = ((await app(page).get("customThemes")) as { id: string }[])[0]!.id;
    await app(page).set({ themeDark: id, themeLight: id });

    await page.getByRole("button", { name: "Edit Mine" }).click();
    await page.getByRole("button", { name: "Amber" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".theme-card")).toHaveCount(7);
    expect(await accent(page)).toBe("#ff9f0a");

    await page.getByRole("button", { name: "Edit Mine" }).click();
    await page.getByRole("button", { name: "Duplicate" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".theme-card")).toHaveCount(8);
    await expect(page.getByRole("button", { name: /^Mine copy/ })).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Delete Mine copy" }).click();
    await expect(page.locator(".theme-card")).toHaveCount(7);
    await expect(page.getByRole("button", { name: /^Midnight/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "midnight");
    expect(await accent(page)).toBe("#2a84ea");

    await page.getByRole("button", { name: /^Mine/ }).click();
    await page.getByRole("button", { name: "Delete Mine" }).click();
    expect(await app(page).get("theme")).toBe("midnight");
    expect(await app(page).get("themeDark")).toBe("midnight");
    expect(await app(page).get("themeLight")).toBe("daylight");
  });
});

test.describe("assistant", () => {
  test.beforeEach(({ page }) => nav(page, "Assistant"));

  test("takes a name and what it calls you, and the preview follows", async ({ page }) => {
    await expect(page.getByLabel("Its name")).toHaveValue("Meridian");
    await page.getByLabel("Its name").fill("Mira");
    await expect(page.getByText("How Mira sounds")).toBeVisible();
    expect(await app(page).get("assistantName")).toBe("Mira");

    await page.getByLabel("What it calls you").fill("Shashi");
    await expect(page.getByText("Shashi, your flight leaves at 7:40")).toBeVisible();
    expect(await app(page).get("assistantCallsYou")).toBe("Shashi");

    await page.getByLabel("Its name").fill("");
    await expect(page.getByText("How Meridian sounds")).toBeVisible();
  });

  test("a personality is one of four, or your own words", async ({ page }) => {
    const calm = page.getByRole("button", { name: /^Calm/ });
    await expect(calm).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: /^Direct/ }).click();
    expect(await app(page).get("assistantStyle")).toBe("direct");
    await expect(page.getByText("7:40, gate 22. Leave by 5.")).toBeVisible();

    const own = page.getByLabel("In your own words");
    await own.fill("Talks like a pirate.");
    expect(await app(page).get("assistantStyle")).toBe("own");
    expect(await app(page).get("assistantPersonality")).toBe("Talks like a pirate.");
    await expect(page.locator(".persona[aria-pressed='true']")).toHaveCount(0);

    await own.fill("");
    expect(await app(page).get("assistantStyle")).toBe("calm");
    await expect(calm).toHaveAttribute("aria-pressed", "true");
  });

  test("links to the voice and the face, by their real names", async ({ page }) => {
    await app(page).set({ voiceProvider: "openai", face: "cat" });
    await expect(page.getByRole("button", { name: /^Voice OpenAI/ })).toBeVisible();
    await page.getByRole("button", { name: /^Face Cat/ }).click();
    await expect(page.getByRole("heading", { name: "Island", exact: true })).toBeVisible();
    await nav(page, "Assistant");
    await page.getByRole("button", { name: /^Voice OpenAI/ }).click();
    await expect(page.getByRole("heading", { name: "Voice", exact: true })).toBeVisible();
  });
});

test.describe("microphone and headphones", () => {
  test.beforeEach(({ page }) => nav(page, "Voice"));

  test("the microphone stays shut until the section is open, and shuts with it", async ({ page }) => {
    expect((await mics(page)).opened).toBe(0);
    await openDevices(page);
    await expect(page.getByText("The microphone is open while this section is.")).toBeVisible();
    expect((await mics(page)).active).toBe(1);
    await expect.poll(() => page.locator(".device-level i").evaluate((el) => parseFloat((el as HTMLElement).style.width))).toBeGreaterThan(0);

    await openDevices(page);
    await expect.poll(async () => (await mics(page)).active).toBe(0);

    await openDevices(page);
    await expect.poll(async () => (await mics(page)).active).toBe(1);
    await nav(page, "General");
    await expect.poll(async () => (await mics(page)).active).toBe(0);
  });

  test("lists real devices, after Same as Windows, and saves the choice by id", async ({ page }) => {
    await openDevices(page);
    const microphone = page.getByLabel("Microphone", { exact: true });
    const output = page.getByLabel("Headphones or speakers");
    await expect(microphone.locator("option")).toHaveText(["Same as Windows", "Capture Input terminal (AC Interface)", "Headset (MiSuperBass)"]);
    await expect(output.locator("option")).toHaveText(["Same as Windows", "MiSuperBass", "Speakers (Realtek Audio)"]);

    await microphone.selectOption({ label: "Headset (MiSuperBass)" });
    await output.selectOption({ label: "Speakers (Realtek Audio)" });
    expect(await app(page).get("voiceMicrophone")).toBe("mic-headset");
    expect(await app(page).get("voiceOutput")).toBe("out-speakers");
    await expect.poll(async () => (await mics(page)).asked.at(-1)).toEqual({ deviceId: { exact: "mic-headset" } });
    await expect.poll(async () => (await mics(page)).active).toBe(1);

    await microphone.selectOption({ label: "Same as Windows" });
    expect(await app(page).get("voiceMicrophone")).toBe(null);
  });

  test("plays through the chosen output", async ({ page }) => {
    await openDevices(page);
    await page.getByLabel("Headphones or speakers").selectOption({ label: "MiSuperBass" });
    // The panel's own chime is a tone too, so this counts from here.
    const before = (await mics(page)).tones;
    await page.getByRole("button", { name: "Play sound" }).click();
    await expect.poll(async () => (await mics(page)).tones).toBe(before + 1);
    expect((await mics(page)).sink).toBe("out-headset");
  });

  test("names the Windows default, and warns only when the choice differs from it", async ({ page }) => {
    await openDevices(page);
    const warning = page.getByText("different from your Windows default");
    const microphone = page.getByLabel("Microphone", { exact: true });
    await expect(page.getByText("which is Capture Input terminal (AC Interface) right now")).toBeVisible();
    await expect(warning).toHaveCount(0);
    await microphone.selectOption({ label: "Headset (MiSuperBass)" });
    await expect(warning).toBeVisible();
    await microphone.selectOption({ label: "Capture Input terminal (AC Interface)" });
    await expect(warning).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open Windows sound settings" })).toBeVisible();
  });

  test("a device that vanishes shows as unplugged, opens nothing, and is not swapped", async ({ page }) => {
    await app(page).set({ voiceMicrophone: "mic-headset" });
    await openDevices(page);
    await expect.poll(async () => (await mics(page)).active).toBe(1);

    await page.evaluate(() => {
      const w = window as never as { __devices: MediaDeviceInfo[] };
      w.__devices.splice(w.__devices.findIndex((d) => d.deviceId === "mic-headset"), 1);
      navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
    });
    const microphone = page.getByLabel("Microphone", { exact: true });
    await expect(page.getByText("Your chosen microphone is unplugged.", { exact: true })).toBeVisible();
    await expect(page.getByText("Your chosen microphone is unplugged, so it is not open.")).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("This is unplugged");
    await expect(microphone).toHaveValue("mic-headset");
    await expect(microphone.locator("option:checked")).toHaveText("Unplugged device");
    expect(await app(page).get("voiceMicrophone")).toBe("mic-headset");
    await expect.poll(async () => (await mics(page)).active).toBe(0);

    await page.evaluate(() => {
      const w = window as never as { __devices: MediaDeviceInfo[] };
      w.__devices.push({ kind: "audioinput", deviceId: "mic-headset", label: "Headset (MiSuperBass)", groupId: "b" } as MediaDeviceInfo);
      navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
    });
    await expect.poll(async () => (await mics(page)).active).toBe(1);
  });

  test("a missing id is not called unplugged before the microphone has been allowed", async ({ page }) => {
    await page.evaluate(() => {
      const w = window as never as { __devices: { deviceId: string; label: string }[] };
      for (const device of w.__devices) Object.assign(device, { deviceId: "", label: "" });
    });
    await app(page).set({ voiceMicrophone: "mic-headset" });
    await nav(page, "General");
    await nav(page, "Voice");
    await expect(page.getByText("Choose what Meridian hears and speaks through.")).toBeVisible();
    await expect(page.getByText("Your chosen microphone is unplugged.", { exact: true })).toHaveCount(0);
  });

  test("the Wake words page links straight to it", async ({ page }) => {
    await nav(page, "Wake words");
    await page.getByRole("button", { name: /^Microphone and headphones/ }).click();
    await expect(page.getByRole("heading", { name: "Voice", exact: true })).toBeAttached();
    await expect(page.getByLabel("Microphone", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Microphone", { exact: true })).toBeInViewport();
  });
});

test("pages that changed shape keep what they held", async ({ page }) => {
  await nav(page, "General");
  await expect(page.getByRole("heading", { name: "Startup and sound" })).toBeVisible();
  await nav(page, "Privacy");
  await expect(page.getByRole("heading", { name: "What stays true" })).toBeVisible();
  await expect(page.getByText("No telemetry.")).toBeVisible();
  await nav(page, "About");
  await expect(page.getByText("Look at the screen")).toBeVisible();
  await expect(page.locator(".keys kbd")).toHaveCount(9);
  await nav(page, "Coding agents");
  await expect(page.locator(".settings-body .brand")).toHaveCount(2);
});
