import { expect, test, type Page } from "@playwright/test";

// Fill this form, from the November 6 Fill this form board (figures 1 to 3, Show, When it does not have a
// value, the bank, Undo, No form on the page) and the Your details board (Add your details once?), on the
// browser stand-in for the core. The outlines window is tested on its own page at the end.

type Mock = {
  pressHereKey(): void;
  pickForm(on: boolean): void;
  offerHere(on: boolean): void;
  offerForm(on: boolean): void;
  holdHere(): void;
  releaseHere(): void;
  hereCalls(): string[];
  formNext(...outcomes: object[]): void;
  formUndoNext(...undos: object[]): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sampleForm(): any;
  askToFillForm(instruction: string): void;
  fillingBox(done: number, total: number, reading?: string | null): void;
  leaveThePage(): void;
  refuseUndo(why: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sampleSignUp(): any;
  fillOnThePage(field: number): void;
  refuseKeep(why: string | null): void;
  keyboard(): boolean[];
};
type App = {
  updateSettings(patch: object): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getState(): any;
  setHovered(on: boolean): void;
};
type Hooks = { __mock: Mock; __meridian: App };
const hooks = (page: Page, call: (w: Hooks) => unknown) => page.evaluate(`(${call.toString()})(window)`);
const island = (page: Page) => page.locator(".island");
const calls = (page: Page) => hooks(page, (w) => w.__mock.hereCalls()) as Promise<string[]>;
const fillOn = (page: Page) =>
  page.evaluate(() => {
    const app = (window as never as Hooks).__meridian;
    return app.updateSettings({ fill: { ...app.getState().settings.fill, on: true } });
  });
/** Ctrl Alt F with the cursor in a box of a form. */
const pressInForm = async (page: Page) => {
  await hooks(page, (w) => w.__mock.pickForm(true));
  await hooks(page, (w) => w.__mock.pressHereKey());
};
const point = (page: Page, on: boolean) => page.evaluate((on) => (window as never as Hooks).__meridian.setHovered(on), on);
/** The line after a fill, which the small pill opens to under the pointer. */
const filled = async (page: Page) => {
  await point(page, true);
  await expect(island(page)).toContainText("Filled 8 of 11 · 3 need you");
};
/** Show, from the line under the pointer. */
const openList = async (page: Page) => {
  await point(page, true);
  await island(page).getByRole("button", { name: "Show" }).click();
};
/** Naukri's sign-up form, filled, with its list open. */
const signUpList = async (page: Page) => {
  await hooks(page, (w) => w.__mock.formNext({ outcome: "filled", form: w.__mock.sampleSignUp() }));
  await pressInForm(page);
  await openList(page);
  await expect(island(page).getByRole("dialog", { name: "Filled 2 of 5 · 3 need you" })).toBeVisible();
};
const rowOf = (page: Page, label: string) => island(page).locator(".form-row", { hasText: label });
/** The sample form changed in the page, then queued as the next run's answer. */
const nextForm = (page: Page, change: string) => page.evaluate(`(() => { const form = window.__mock.sampleForm(); ${change}; window.__mock.formNext({ outcome: "filled", form }); })()`);
const mood = async (page: Page, feeling: string) => {
  await expect(island(page).locator(".face")).toHaveCount(1);
  await expect(island(page).locator(".face")).toHaveAttribute("data-mood", feeling);
};

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(island(page)).toHaveAttribute("data-view", "idle");
  await fillOn(page);
});

test.describe("a · a job application", () => {
  test("1 and 2 · Ctrl Alt F in the form fills the whole form, a box at a time, and never asks the AI from the page", async ({ page }) => {
    await hooks(page, (w) => w.__mock.holdHere());
    await pressInForm(page);
    await expect(island(page)).toHaveAttribute("data-view", "here");
    await expect(island(page)).toContainText("Reading the form…");
    await mood(page, "think");
    await hooks(page, (w) => w.__mock.fillingBox(4, 8));
    await expect(island(page)).toContainText("Filling in · 4 of 8");
    await expect(island(page).locator(".form-progress i")).toHaveAttribute("style", /width: 50%/);
    await hooks(page, (w) => w.__mock.releaseHere());
    await filled(page);
    expect(await calls(page)).toEqual([`form ${JSON.stringify({ instruction: null, text: null, allow: null, window: null })}`]);
  });

  test("3 · after it fills, the line offers Undo and Show, and nothing is sent", async ({ page }) => {
    await pressInForm(page);
    await filled(page);
    for (const name of ["Undo", "Show"]) await expect(island(page).getByRole("button", { name, exact: true })).toBeVisible();
    await expect(island(page)).not.toHaveAttribute("data-view", "expanded");
  });

  test("Show lists every box and where it came from, and Go to it goes to a box that is yours", async ({ page }) => {
    await pressInForm(page);
    await openList(page);
    const list = island(page).getByRole("dialog", { name: "Filled 8 of 11 · 3 need you" });
    await expect(list).toContainText("kestrellabs.in");
    await expect(list.locator(".form-row")).toHaveCount(11);
    const rowOf = (label: string) => list.locator(".form-row", { hasText: label });
    await expect(rowOf("Phone")).toContainText("+91 98201 44317");
    await expect(rowOf("Phone").locator(".form-src")).toHaveText("Your details");
    await expect(rowOf("Notice period").locator(".form-src")).toHaveText("Knowledge · Job search");
    await expect(rowOf("Why do you want").locator(".form-src")).toHaveText("Written by AI");
    await expect(rowOf("Create a password")).toContainText("Yours to fill");
    await expect(list).toContainText("Check it, then submit yourself.");
    await rowOf("Your CV").getByRole("button", { name: "Go to it" }).click();
    expect(await calls(page)).toContain("form go 9");
    await list.getByRole("button", { name: "Close" }).click();
    await filled(page);
  });

  test("one box can be put back from the list", async ({ page }) => {
    await pressInForm(page);
    await openList(page);
    const row = island(page).locator(".form-row", { hasText: "Current company" });
    await row.hover();
    await row.getByRole("button", { name: "Undo" }).click();
    await expect(row).toContainText("Put back");
    expect(await calls(page)).toContain("form undo 4");
  });

  test("when it does not have a value, it leaves the box empty, says why, and says what to say", async ({ page }) => {
    await nextForm(
      page,
      `form.rows[5] = { ...form.rows[5], state: "needs-you", value: "", origin: undefined, why: "Not in Your details or Knowledge" };
       form.rows[6] = { ...form.rows[6], state: "needs-you", value: "", origin: undefined, why: "Not in Your details or Knowledge" };
       form.filled = 6; form.need = 5`,
    );
    await pressInForm(page);
    await openList(page);
    const list = island(page).getByRole("dialog", { name: "Filled 6 of 11 · 5 need you" });
    await mood(page, "needs");
    await expect(list.locator(".form-row")).toHaveCount(5);
    // Why it was left is in the box to answer it in.
    await expect(list.locator(".form-row", { hasText: "Notice period" }).getByRole("textbox")).toHaveAttribute("placeholder", "Not in Your details or Knowledge");
    await expect(list.locator(".form-row", { hasText: "Notice period" }).getByRole("button", { name: "Go to it" })).toBeVisible();
    await expect(list.locator(".form-row", { hasText: "Create a password" }).getByRole("button")).toHaveCount(0);
    await expect(list).toContainText("Say it and it fills that box: “notice period …”");
    await list.getByRole("button", { name: "Show all 11" }).click();
    await expect(list.locator(".form-row")).toHaveCount(11);
  });

  test("Open Your details opens Settings › Your details", async ({ page }) => {
    await nextForm(page, `form.rows[5] = { ...form.rows[5], state: "needs-you", why: "Not in Your details or Knowledge" }; form.filled = 7; form.need = 4`);
    await pressInForm(page);
    await openList(page);
    await island(page).getByRole("button", { name: "Open Your details" }).click();
    await expect(page.getByRole("heading", { name: "Your details", exact: true })).toBeVisible();
  });

  test("saying a value carries on in the same form, through the assistant", async ({ page }) => {
    await hooks(page, (w) => w.__mock.askToFillForm("notice period 60 days"));
    await filled(page);
    expect((await calls(page))[0]).toContain(`"instruction":"notice period 60 days"`);
  });

  test("a value said into a filled form and then stopped with Esc leaves the form as it was", async ({ page }) => {
    await pressInForm(page);
    await filled(page);
    await hooks(page, (w) => w.__mock.formNext({ outcome: "stopped" }));
    await hooks(page, (w) => w.__mock.askToFillForm("notice period 60 days"));
    await filled(page);
    await expect(island(page).getByRole("button", { name: "Undo" })).toBeVisible();
    expect(await calls(page)).not.toContain("form done");
  });
});

test.describe("b · other places", () => {
  test("a bank asks first, before it reads a single box, and Fill this time fills it once", async ({ page }) => {
    await hooks(page, (w) => w.__mock.formNext({ outcome: "ask", key: "onlinesbi.sbi", id: "onlinesbi.sbi", name: "onlinesbi.sbi", every: "a bank" }));
    await pressInForm(page);
    const card = island(page).getByRole("alertdialog", { name: "Fill this form on onlinesbi.sbi?" });
    await expect(card).toContainText("Banks and government sites ask every time. Passwords and one-time codes stay yours.");
    await expect(card.getByRole("button")).toHaveText(["Not now", "Fill this time"]);
    await card.getByRole("button", { name: "Fill this time" }).click();
    await filled(page);
    expect((await calls(page))[1]).toContain(`"allow":"onlinesbi.sbi"`);
  });

  test("a new site asks the first time with Once, Always and Never", async ({ page }) => {
    await hooks(page, (w) => w.__mock.formNext({ outcome: "ask", key: "kestrellabs.in", id: "kestrellabs.in", name: "kestrellabs.in", every: null }));
    await pressInForm(page);
    const card = island(page).getByRole("alertdialog", { name: "Fill this form on kestrellabs.in?" });
    await expect(card.getByRole("button")).toHaveText(["Never", "Once", "Always"]);
    await card.getByRole("button", { name: "Once" }).click();
    await filled(page);
  });

  test("Undo puts every box back, and a box changed since keeps what was typed", async ({ page }) => {
    await page.evaluate(() => {
      const mock = (window as never as Hooks).__mock;
      mock.formUndoNext({ putBack: 7, kept: ["Email"], form: mock.sampleForm() });
    });
    await pressInForm(page);
    await filled(page);
    await island(page).getByRole("button", { name: "Undo" }).click();
    await expect(island(page)).toContainText("Put back 7 boxes");
    await expect(island(page)).toContainText("You changed Email after it was filled, so Email keeps what you typed.");
    expect(await calls(page)).toContain("form undo all");
  });

  test("an Undo after leaving the page says why", async ({ page }) => {
    await hooks(page, (w) => w.__mock.refuseUndo("You left the page, so it was left as it is."));
    await pressInForm(page);
    await filled(page);
    await island(page).getByRole("button", { name: "Undo" }).click();
    await expect(island(page)).toContainText("You left the page, so it was left as it is.");
  });

  test("no form on the page: nothing goes to the AI, and the line leaves after 3 seconds", async ({ page }) => {
    await page.clock.install();
    await page.goto("/");
    await fillOn(page);
    await hooks(page, (w) => w.__mock.formNext({ outcome: "line", text: "No form or text box here" }));
    await pressInForm(page);
    await expect(island(page)).toContainText("No form or text box here");
    await mood(page, "needs");
    await page.clock.runFor(3100);
    await expect(island(page)).toHaveAttribute("data-view", "idle");
  });

  test("leaving the page lets the form and its outlines go", async ({ page }) => {
    await pressInForm(page);
    await filled(page);
    await hooks(page, (w) => w.__mock.leaveThePage());
    await expect(island(page)).toHaveAttribute("data-view", "idle");
    expect(await calls(page)).toContain("form done");
  });

  test("a page with one box only goes to Write here, with the yes already given", async ({ page }) => {
    await hooks(page, (w) => w.__mock.formNext({ outcome: "single" }));
    await pressInForm(page);
    await expect(island(page)).toContainText("Written here · not sent");
    expect((await calls(page))[1]).toMatch(/^start /);
  });

  test("Ctrl Alt F in a reply box writes a reply instead", async ({ page }) => {
    await hooks(page, (w) => w.__mock.pickForm(false));
    await hooks(page, (w) => w.__mock.pressHereKey());
    await expect(island(page)).toContainText("Written here · not sent");
  });

  test("local-only mode with an online AI says so in the form's words", async ({ page }) => {
    await hooks(page, (w) => w.__mock.formNext({ outcome: "local", ai: "Claude" }));
    await pressInForm(page);
    await expect(island(page).getByRole("alertdialog", { name: "Local-only mode is on" })).toContainText("Fill this form is set to use Claude, which is online.");
  });

  test("a failed fill says nothing was put in, and Try again fills it again", async ({ page }) => {
    await hooks(page, (w) => w.__mock.formNext({ outcome: "failed", why: "Claude did not answer in 60 seconds. Nothing was put in." }));
    await pressInForm(page);
    const card = island(page).getByRole("alertdialog", { name: "Could not fill this form" });
    await card.getByRole("button", { name: "Try again" }).click();
    await filled(page);
    expect((await calls(page)).filter((call) => call.startsWith("form {"))).toHaveLength(2);
  });
});

test.describe("Your details from a fill", () => {
  test("a form that needs details not added yet offers to add them once, and Not now shows what was filled", async ({ page }) => {
    await nextForm(page, `form.details = ["name", "email", "phone"]`);
    await pressInForm(page);
    const card = island(page).getByRole("alertdialog", { name: "Add your details once?" });
    await expect(card).toContainText("kestrellabs.in");
    await expect(card).toContainText("This form asks for your name, email and phone. Add them once and Meridian fills them every time.");
    await card.getByRole("button", { name: "Not now" }).click();
    await filled(page);
  });

  test("an ID number asks first, naming the site, and goes in only after the click", async ({ page }) => {
    await nextForm(page, `form.ids = ["PAN"]; form.site = "incometax.gov.in"`);
    await pressInForm(page);
    const card = island(page).getByRole("alertdialog", { name: "Put in your PAN on incometax.gov.in?" });
    await expect(card).toContainText("ID numbers ask every time, and they never go to the AI.");
    expect(await calls(page)).not.toContain("form ids true");
    await card.getByRole("button", { name: "Put it in" }).click();
    await filled(page);
    expect(await calls(page)).toContain("form ids true");
  });

  test("Not this time leaves the ID number for the user", async ({ page }) => {
    await nextForm(page, `form.ids = ["Aadhaar number"]`);
    await pressInForm(page);
    await island(page).getByRole("button", { name: "Not this time" }).click();
    await filled(page);
    expect(await calls(page)).toContain("form ids false");
  });
});

test.describe("the island's button", () => {
  test("Fill this form shows instead of Write here when the cursor is in a box of a form", async ({ page }) => {
    await hooks(page, (w) => w.__mock.offerHere(true));
    await hooks(page, (w) => w.__mock.offerForm(true));
    await hooks(page, (w) => w.__meridian.setHovered(true));
    await expect(island(page).getByRole("button", { name: "Write here" })).toHaveCount(0);
    await island(page).getByRole("button", { name: "Fill this form" }).click();
    await filled(page);
    expect((await calls(page))[0]).toMatch(/^form /);
  });
});

test.describe("c · out of the way, and answered on the island", () => {
  test("after a fill it waits as a small pill, and pointing opens the line with Undo", async ({ page }) => {
    await pressInForm(page);
    await expect(island(page)).toContainText("3 need you");
    await expect(island(page)).not.toContainText("Filled 8 of 11");
    await expect(island(page).getByRole("button")).toHaveCount(0);
    await mood(page, "needs");
    const small = (await island(page).boundingBox())!.width;
    expect(small).toBeLessThan(200);
    await point(page, true);
    await expect(island(page)).toContainText("Filled 8 of 11 · 3 need you");
    await expect(island(page).getByRole("button", { name: "Undo", exact: true })).toBeVisible();
    await expect.poll(async () => (await island(page).boundingBox())!.width).toBeGreaterThan(400);
    await point(page, false);
    await expect(island(page)).toContainText("3 need you");
    await expect(island(page).getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
  });

  test("with nothing left for the user, the pill says Filled", async ({ page }) => {
    await nextForm(page, `form.rows = form.rows.slice(0, 8); form.total = 8; form.need = 0`);
    await pressInForm(page);
    await expect(island(page).locator(".form-pill")).toHaveText("Filled");
    await mood(page, "done");
  });

  test("Work status is one question with a button for each choice, and a click puts that one in", async ({ page }) => {
    await signUpList(page);
    const status = rowOf(page, "Work status");
    await expect(status).toHaveCount(1);
    await expect(status.getByRole("button")).toHaveText(["I'm experienced", "I'm a fresher", "Go to it"]);
    await status.getByRole("button", { name: "I'm a fresher" }).click();
    await expect(status).toContainText("I'm a fresher");
    await expect(status.locator(".form-src")).toHaveText("You picked");
    await expect(status.getByRole("button", { name: "I'm experienced" })).toHaveCount(0);
    await expect(island(page).getByRole("dialog", { name: "Filled 3 of 5 · 2 need you" })).toBeVisible();
    expect(await calls(page)).toContain("form answer 5 yes");
  });

  test("a box that needs you takes your answer, and the island has the keyboard only while you type", async ({ page }) => {
    await signUpList(page);
    const email = rowOf(page, "Email ID");
    const box = email.getByRole("textbox", { name: "Answer for Email ID" });
    await expect(box).toHaveAttribute("placeholder", "Not in Your details");
    const before = ((await hooks(page, (w) => w.__mock.keyboard())) as boolean[]).length;
    await box.click();
    await box.fill("ravi.sharma84@gmail.com");
    expect(((await hooks(page, (w) => w.__mock.keyboard())) as boolean[]).slice(before)).toEqual([true]);
    await box.press("Enter");
    await expect(email).toContainText("ravi.sharma84@gmail.com");
    await expect(email.locator(".form-src")).toHaveText("You typed");
    expect(await calls(page)).toContain("form answer 1 ravi.sharma84@gmail.com");
    const keys = (await hooks(page, (w) => w.__mock.keyboard())) as boolean[];
    expect(keys.slice(before)).toEqual([true, false]);
    // The password stays yours: no box, no button.
    const password = rowOf(page, "Password");
    await expect(password.getByRole("textbox")).toHaveCount(0);
    await expect(password.getByRole("button")).toHaveCount(0);
    await expect(password).toContainText("Yours to fill");
  });

  test("what you typed is added to Your details in one tap, through its checks", async ({ page }) => {
    await signUpList(page);
    const email = rowOf(page, "Email ID");
    await email.getByRole("textbox").fill("ravi.sharma84@gmail.com");
    await email.getByRole("textbox").press("Enter");
    const add = email.getByRole("button", { name: "Add to Your details" });
    await expect(add).toHaveAttribute("title", "Keep it in Your details as your email");
    await hooks(page, (w) => w.__mock.refuseKeep("An email looks like name@example.com."));
    await add.click();
    await expect(island(page).locator(".form-said")).toHaveText("An email looks like name@example.com.");
    await hooks(page, (w) => w.__mock.refuseKeep(null));
    await add.click();
    await expect(email).toContainText("Added to Your details");
    await expect(email.getByRole("button", { name: "Add to Your details" })).toHaveCount(0);
    expect((await calls(page)).filter((call) => call === "form keep 1")).toHaveLength(2);
  });

  test("a work status picked from Your details says which detail picked it", async ({ page }) => {
    await page.evaluate(() => {
      const mock = (window as never as Hooks).__mock;
      const form = mock.sampleSignUp();
      form.rows[4] = { ...form.rows[4], state: "filled", origin: "details", from: "company", value: "I'm experienced", why: "" };
      Object.assign(form, { filled: 3, need: 2 });
      mock.formNext({ outcome: "filled", form });
    });
    await pressInForm(page);
    await openList(page);
    await island(page).getByRole("button", { name: "Show all 5" }).click();
    const status = rowOf(page, "Work status");
    await expect(status).toContainText("I'm experienced");
    await expect(status.locator(".form-src")).toHaveText("Your details");
    await expect(status.locator(".form-src")).toHaveAttribute("title", "Picked because Your details has your company");
  });

  test("a box you fill on the page itself needs you no more", async ({ page }) => {
    await signUpList(page);
    await expect(island(page).locator(".form-row")).toHaveCount(3);
    await hooks(page, (w) => w.__mock.fillOnThePage(1));
    await expect(island(page).getByRole("dialog", { name: "Filled 2 of 5 · 2 need you" })).toBeVisible();
    await expect(rowOf(page, "Email ID")).toHaveCount(0);
    await island(page).getByRole("button", { name: "Show all 5" }).click();
    await expect(rowOf(page, "Email ID")).toContainText("Done by you");
  });
});

test.describe("the outlines over the page", () => {
  test("a filled box fades from where it had got to, and stays still with reduced motion", async ({ page }) => {
    await page.goto("/outlines.html");
    const draw = (motion: string) =>
      page.evaluate((motion) => {
        const w = window as never as { draw(o: object[], motion: string): void };
        w.draw(
          [
            { x: 20, y: 20, w: 300, h: 26, look: "ok", age: 1000 },
            { x: 20, y: 70, w: 300, h: 26, look: "need", tag: ["need", "Needs you"] },
          ],
          motion,
        );
      }, motion);
    await draw("system");
    const boxes = page.locator(".ol-box");
    await expect(boxes.nth(0)).toHaveAttribute("data-fade", "");
    await expect(boxes.nth(0)).toHaveCSS("animation-delay", "2.4s");
    await expect(boxes.nth(0)).toHaveCSS("animation-name", "ol-fade");
    await expect(boxes.nth(1)).not.toHaveAttribute("data-fade", "");
    await draw("reduced");
    await expect(boxes.nth(0)).toHaveCSS("animation-name", "none");
  });

  test("green for filled, amber with a lock for yours, blue for the box being filled, and a tip on pointing", async ({ page }) => {
    await page.goto("/outlines.html");
    await page.evaluate(() => {
      const w = window as never as { draw(o: object[]): void; hover(i: number | null): void };
      w.draw([
        { x: 20, y: 20, w: 300, h: 26, look: "ok", tip: ["From Your details · Phone", "Put in by Meridian from this PC. The AI only chose the box; it never saw what went in."] },
        { x: 20, y: 70, w: 300, h: 26, look: "need", tag: ["lock", "Yours to fill"], tip: ["Yours to fill", "Password boxes are yours to fill."] },
        { x: 20, y: 120, w: 300, h: 60, look: "ok", tag: ["ai", "Written by AI"] },
        { x: 20, y: 200, w: 300, h: 26, look: "now" },
        { x: 20, y: 250, w: 300, h: 26, look: "ok", tag: ["mail", "from mail <b>x</b>"] },
      ]);
      w.hover(0);
    });
    const boxes = page.locator(".ol-box");
    await expect(boxes).toHaveCount(5);
    await expect(boxes.nth(0)).toHaveAttribute("data-look", "ok");
    await expect(boxes.nth(1).locator(".ol-tag")).toHaveText("Yours to fill");
    await expect(boxes.nth(1).locator(".ol-tag svg")).toHaveCount(1);
    await expect(boxes.nth(2).locator(".ol-tag")).toHaveAttribute("data-low", "");
    await expect(boxes.nth(3)).toHaveAttribute("data-look", "now");
    // Words from the page go in as text, never as markup.
    await expect(boxes.nth(4).locator(".ol-tag")).toHaveText("from mail <b>x</b>");
    await expect(page.locator(".ol-tip")).toContainText("From Your details · Phone");
    await expect(page.locator(".ol-tip")).toContainText("it never saw what went in");
    await page.evaluate(() => (window as never as { hover(i: number | null): void }).hover(null));
    await expect(page.locator(".ol-tip")).toHaveCount(0);
    await page.evaluate(() => (window as never as { draw(o: object[]): void }).draw([]));
    await expect(boxes).toHaveCount(0);
  });
});
