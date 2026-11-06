import { expect, test, type Page } from "@playwright/test";

// Settings › Your details and Settings › Fill in the page, as the Your details board draws them.

type Fill = Record<string, unknown> & { sources: Record<string, boolean> };
type App = { updateSettings(p: object): Promise<void>; getState(): { settings: { fill: Fill; localOnly: boolean } } };
type Mock = { seedDetails(profile: object, ids?: object): void; idNumbersKept(): Record<string, string> };
type Hooks = { __meridian: App; __mock: Mock };

const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name, exact: true }).click();
const fill = (page: Page) => page.evaluate(() => (window as never as Hooks).__meridian.getState().settings.fill);
const setFill = (page: Page, patch: object) =>
  page.evaluate((p) => {
    const app = (window as never as Hooks).__meridian;
    return app.updateSettings({ fill: { ...app.getState().settings.fill, ...p } });
  }, patch);
const part = (page: Page, name: string) => page.getByRole("group", { name, exact: true });
const editing = (page: Page, name: string) => page.getByRole("form", { name, exact: true });

const RAVI = {
  name: { en: "Ravi Sharma", hi: "रवि शर्मा" },
  birth: "1991-08-14",
  email: "ravi.sharma84@gmail.com",
  phone: "+91 98201 44317",
  otherPhone: "",
  address: { lines: "Flat 702, Lotus Towers, 14th Main, HSR Layout", city: "Bengaluru", pin: "560102", state: "Karnataka", hi: "फ़्लैट 702, लोटस टावर्स, बेंगलुरु 560102, कर्नाटक" },
  work: { company: "Northwind Software", title: "Senior Product Designer", department: "Design", employeeId: "NW-20417", email: "ravi.s@northwind.in", linkedin: "linkedin.com/in/ravi-sharma-design" },
  ids: false,
};

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".island")).toHaveAttribute("data-view", "idle");
  await page.locator(".island").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
});

test("both pages have their own place in the column, and search finds them", async ({ page }) => {
  const search = page.getByLabel("Search settings");
  await search.fill("aadhaar");
  await expect(page.locator(".settings-tab-label")).toHaveText(["Your details"]);
  await search.fill("ctrl alt f");
  await expect(page.locator(".settings-tab-label")).toHaveText(["Fill in the page"]);
});

test.describe("Your details", () => {
  test("the first time, it is empty and offers to add them", async ({ page }) => {
    await nav(page, "Your details");
    await expect(page.getByText("Add your details once, and Meridian fills them in for you")).toBeVisible();
    await expect(page.getByText("They stay on this PC and never go to the AI.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete all my details" })).toHaveCount(0);

    await page.getByRole("button", { name: "Add my details" }).click();
    const form = editing(page, "Name and birth");
    await form.getByLabel("Name in English").fill("Ravi Sharma");
    await form.getByLabel("Name in Hindi").fill("रवि शर्मा");
    await form.getByLabel("Date of birth").fill("1991-08-14");
    await form.getByRole("button", { name: "Save" }).click();

    const shown = part(page, "Name and birth");
    await expect(shown).toContainText("Ravi Sharma");
    await expect(shown.locator('[lang="hi"]')).toHaveText("रवि शर्मा");
    await expect(shown).toContainText("14 Aug 1991");
    await expect(part(page, "Contact").getByRole("button", { name: "Add" })).toHaveCount(3);
  });

  test("with details added, five short sections show both scripts", async ({ page }) => {
    await page.evaluate((profile) => (window as never as Hooks).__mock.seedDetails(profile), RAVI);
    await nav(page, "Your details");
    for (const name of ["Name and birth", "Contact", "Home address", "Work", "ID numbers"]) await expect(part(page, name)).toBeVisible();
    await expect(part(page, "Home address")).toContainText("Bengaluru, 560102");
    await expect(part(page, "Home address").locator('[lang="hi"]')).toContainText("बेंगलुरु 560102");
    await expect(part(page, "Work")).toContainText("NW-20417");
    await expect(part(page, "Contact").getByRole("button", { name: "Add" })).toHaveCount(1);
    await expect(page.getByText("When a form needs your phone, the AI only says “phone goes here”.")).toBeVisible();
  });

  test("Save waits until the PIN code has 6 digits, and Cancel keeps what was there", async ({ page }) => {
    await page.evaluate((profile) => (window as never as Hooks).__mock.seedDetails(profile), RAVI);
    await nav(page, "Your details");
    await part(page, "Home address").getByRole("button", { name: "Edit" }).click();
    const form = editing(page, "Home address");
    await expect(form.getByLabel("City")).toHaveValue("Bengaluru");

    await form.getByLabel("PIN code").fill("56010");
    await expect(form.getByText("A PIN code has 6 digits.")).toBeVisible();
    await expect(form.getByLabel("PIN code")).toHaveAttribute("aria-invalid", "true");
    await expect(form.getByRole("button", { name: "Save" })).toBeDisabled();
    await form.getByRole("button", { name: "Cancel" }).click();
    await expect(part(page, "Home address")).toContainText("Bengaluru, 560102");

    await part(page, "Home address").getByRole("button", { name: "Edit" }).click();
    await editing(page, "Home address").getByLabel("PIN code").fill("560034");
    await editing(page, "Home address").getByLabel("City").fill("Bangalore");
    await editing(page, "Home address").getByRole("button", { name: "Save" }).click();
    await expect(part(page, "Home address")).toContainText("Bangalore, 560034");
  });

  test("an email and a phone number are checked before they are kept", async ({ page }) => {
    await nav(page, "Your details");
    await page.getByRole("button", { name: "Add my details" }).click();
    await editing(page, "Name and birth").getByRole("button", { name: "Cancel" }).click();
    await part(page, "Contact").getByRole("button", { name: "Edit" }).click();
    const form = editing(page, "Contact");
    await form.getByLabel("Email", { exact: true }).fill("ravi.sharma84");
    await form.getByLabel("Phone", { exact: true }).fill("98201");
    await expect(form.getByText("An email looks like name@example.com.")).toBeVisible();
    await expect(form.getByText("A phone number has 10 to 15 digits.")).toBeVisible();
    await expect(form.getByRole("button", { name: "Save" })).toBeDisabled();

    await form.getByLabel("Email", { exact: true }).fill("ravi.sharma84@gmail.com");
    await form.getByLabel("Phone", { exact: true }).fill("+91 98201 44317");
    await form.getByRole("button", { name: "Save" }).click();
    await expect(part(page, "Contact")).toContainText("+91 98201 44317");
  });

  test("ID numbers are off until turned on, show masked, and turning them off removes them", async ({ page }) => {
    await page.evaluate((profile) => (window as never as Hooks).__mock.seedDetails(profile), RAVI);
    await nav(page, "Your details");
    const ids = part(page, "ID numbers");
    await expect(ids.getByRole("switch", { name: "ID numbers" })).not.toBeChecked();
    await expect(ids).toContainText("PAN, Aadhaar and passport. Off unless you turn it on.");

    await ids.getByRole("switch", { name: "ID numbers" }).check();
    await expect(ids).toContainText("Kept in Windows Credential Manager on this PC. Never sent to the AI. Every fill that would use one asks you first, and names the site.");
    await expect(ids.getByRole("button", { name: "Add" })).toHaveCount(3);

    await ids.getByRole("button", { name: "Add" }).first().click();
    await ids.getByLabel("PAN").fill("ABCD12345K");
    await expect(ids.getByText("A PAN looks like ABCDE1234F.")).toBeVisible();
    await expect(ids.getByRole("button", { name: "Save" })).toBeDisabled();
    await ids.getByLabel("PAN").fill("abcde1234k");
    await ids.getByRole("button", { name: "Save" }).click();
    await expect(ids).toContainText("•••••1234K");
    await expect(ids).not.toContainText("ABCDE1234K");

    await ids.getByRole("button", { name: "Show" }).click();
    await expect(ids).toContainText("ABCDE1234K");
    await ids.getByRole("button", { name: "Hide" }).click();
    await expect(ids).toContainText("•••••1234K");

    // It stays on until the question is answered.
    await ids.getByRole("switch", { name: "ID numbers" }).click();
    await expect(page.getByText("Remove your ID numbers from this PC?")).toBeVisible();
    await expect(ids.getByRole("switch", { name: "ID numbers" })).toBeChecked();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(ids.getByRole("switch", { name: "ID numbers" })).not.toBeChecked();
    expect(await page.evaluate(() => (window as never as Hooks).__mock.idNumbersKept())).toEqual({});
  });

  test("Delete all my details asks first, then starts again from empty", async ({ page }) => {
    await page.evaluate((profile) => (window as never as Hooks).__mock.seedDetails({ ...profile, ids: true }, { aadhaar: "123456788823" }), RAVI);
    await nav(page, "Your details");
    await expect(part(page, "ID numbers")).toContainText("•••• •••• 8823");
    await page.getByRole("button", { name: "Delete all my details" }).click();
    await expect(page.getByText("Delete all your details from this PC?")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(part(page, "Name and birth")).toContainText("Ravi Sharma");

    await page.getByRole("button", { name: "Delete all my details" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText("Add your details once, and Meridian fills them in for you")).toBeVisible();
    expect(await page.evaluate(() => (window as never as Hooks).__mock.idNumbersKept())).toEqual({});
  });
});

test.describe("Fill in the page", () => {
  test.beforeEach(({ page }) => nav(page, "Fill in the page"));

  test("starts off, and the rows under a switch wait for it", async ({ page }) => {
    const main = page.getByRole("switch", { name: /^Write here and Fill this form/ });
    await expect(main).not.toBeChecked();
    await expect(page.getByRole("group", { name: "Key" }).locator("..")).toHaveAttribute("inert", "");
    await main.check();
    await expect(page.getByRole("group", { name: "Key" }).locator("..")).not.toHaveAttribute("inert");
    await expect(page.getByRole("button", { name: "Ctrl Alt F" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Off", exact: true }).click();
    expect(await fill(page)).toMatchObject({ on: true, key: "off", buttons: true, ai: "claude-code" });

    await page.getByRole("switch", { name: /^Buttons on the island/ }).uncheck();
    await expect(page.getByRole("button", { name: "AI that writes and fills" })).toContainText("Claude Code");
    expect((await fill(page)).buttons).toBe(false);
  });

  test("Finish this for me is experimental, off, and has its own AI", async ({ page }) => {
    const finish = page.getByRole("switch", { name: /^Finish this for me/ });
    await expect(finish).not.toBeChecked();
    await expect(page.locator(".fill-experimental")).toHaveText("Experimental");
    await expect(page.getByRole("button", { name: "AI for Finish this for me" }).locator("..").locator("..")).toHaveAttribute("inert", "");
    await finish.check();
    await expect(page.getByRole("button", { name: "AI for Finish this for me" })).toContainText("Claude, through Claude Code");
    expect(await fill(page)).toMatchObject({ finish: true, finishAi: "claude-code" });
  });

  test("local-only mode holds Finish this for me and mail as a source off", async ({ page }) => {
    await page.evaluate(() => (window as never as Hooks).__meridian.updateSettings({ localOnly: true }));
    await expect(page.getByRole("switch", { name: /^Finish this for me/ })).toBeDisabled();
    await expect(page.getByRole("switch", { name: /^Gmail and Calendar, when you ask/ })).toBeDisabled();
    await expect(page.getByRole("switch", { name: /^Gmail and Calendar, when you ask/ })).not.toBeChecked();
    await expect(page.getByText("Local-only mode is on, so the AI on this PC is used.")).toBeVisible();
  });

  test("apps and sites show how each was answered, banks ask every time, and the never-list is fixed", async ({ page }) => {
    const answered = [
      { id: "mail.google.com", name: "Gmail", fill: "allowed", finish: false, alwaysAsk: false },
      { id: "slack.exe", name: "Slack", fill: "allowed", finish: false, alwaysAsk: false },
      { id: "expenses.northwind.in", name: "Northwind Expenses", fill: "allowed", finish: true, alwaysAsk: false },
      { id: "ms-teams.exe", name: "Microsoft Teams", fill: "never", finish: false, alwaysAsk: false },
      { id: "onlinesbi.sbi", name: "onlinesbi.sbi", fill: "ask", finish: false, alwaysAsk: true },
    ];
    // The list belongs to the core, as the island's answers put it there.
    await page.evaluate((p) => (window as never as { __mock: { seedPlaces(p: object[]): void } }).__mock.seedPlaces(p), answered);
    await setFill(page, { finish: true, places: answered });
    const places = page.locator(".fill-places");
    await expect(places.locator(".fill-place")).toHaveCount(5);
    await expect(places.getByText("mail.google.com")).toBeVisible();
    await expect(page.getByRole("button", { name: "Filling in Gmail" })).toHaveText("Allowed");
    await expect(page.getByRole("button", { name: "Filling in Microsoft Teams" })).toHaveText("Never");
    await expect(page.getByRole("button", { name: "Filling in onlinesbi.sbi" })).toHaveText("Asks every time");
    await expect(places.getByText("Banks, tax and government · always ask")).toBeVisible();
    await expect(places.getByText("Terminals, Windows Settings, Windows Security, password managers, private browser windows and Meridian itself.")).toBeVisible();

    // A bank can be Never, but not Allowed.
    await page.getByRole("button", { name: "Filling in onlinesbi.sbi" }).click();
    await expect(page.getByRole("menu", { name: "Filling in onlinesbi.sbi" }).getByRole("menuitemradio")).toHaveText(["Asks every time", "Never"]);
    await page.keyboard.press("Escape");

    await expect(places.locator(".fill-place", { hasText: "Northwind Expenses" }).getByRole("button", { name: "Finish too" })).toHaveAttribute("aria-pressed", "true");
    await places.locator(".fill-place", { hasText: "Slack" }).getByRole("button", { name: "Finish too" }).click();
    await page.getByRole("button", { name: "Filling in Gmail" }).click();
    await page.getByRole("menu", { name: "Filling in Gmail" }).getByRole("menuitemradio", { name: "Never" }).click();
    await page.getByRole("button", { name: "Forget Microsoft Teams" }).click();

    const places_ = (await fill(page)).places as { name: string; fill: string; finish: boolean }[];
    expect(places_.map((p) => [p.name, p.fill, p.finish])).toEqual([
      ["Gmail", "never", false],
      ["Slack", "allowed", true],
      ["Northwind Expenses", "allowed", true],
      ["onlinesbi.sbi", "ask", false],
    ]);
  });

  test("values come from every source but a picture of the window, unless changed", async ({ page }) => {
    for (const name of ["Your details", "Knowledge pages", "Gmail and Calendar, when you ask", "Call notes", "Files you name", "Clipboard, when you say so"]) {
      await expect(page.getByRole("switch", { name: new RegExp(`^${name}`) })).toBeChecked();
    }
    const picture = page.getByRole("switch", { name: /^A picture of the window/ });
    await expect(picture).not.toBeChecked();
    await picture.check();
    await page.getByRole("switch", { name: /^Clipboard, when you say so/ }).uncheck();
    expect((await fill(page)).sources).toMatchObject({ picture: true, clipboard: false, details: true });
  });
});

test("Privacy says what local-only mode does to filling", async ({ page }) => {
  await nav(page, "Privacy");
  await page.getByRole("switch", { name: /^Local-only mode/ }).check();
  expect(await page.evaluate(() => (window as never as Hooks).__meridian.getState().settings.localOnly)).toBe(true);
  for (const row of ["Write here", "Fill this form"]) await expect(page.locator(".setting", { hasText: row }).first()).toContainText("on this PC");
  await expect(page.locator(".setting", { hasText: "Finish this for me" })).toContainText("Off");
  await expect(page.locator(".setting", { hasText: "Gmail and Calendar as a source" })).toContainText("Off");
  await expect(page.getByText("Filling forms works about the same, because Your details are put in by Meridian either way.")).toBeVisible();
});
