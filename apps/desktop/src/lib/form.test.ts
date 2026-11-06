import { describe, expect, it } from "vitest";
import { geometryFor } from "../island/machine";
import { answerWith, both, detailName, filledLine, keptLine, listedRows, listRows, LIST_ROWS, pillLine, sayIt, sourceOf, typedHere } from "./form";
import { stepFor } from "./here";
import type { FormRow, FormSummary } from "./types";

const row = (field: number, label: string, state: FormRow["state"], origin?: FormRow["origin"], from = "", why = ""): FormRow => ({ field, label, kind: "plain-text", state, origin, from, value: "", why });

/** The job application on the board: 8 filled, the password, the CV and I agree left. */
const application = (): FormSummary => ({
  site: "kestrellabs.in",
  filled: 8,
  total: 11,
  need: 3,
  rows: [
    ...["Full name", "Email", "Phone", "LinkedIn", "Current company"].map((label, i) => row(i, label, "filled", "details")),
    row(5, "Notice period", "filled", "knowledge", "Job search"),
    row(6, "Expected salary", "filled", "knowledge", "Job search"),
    row(7, "Why join", "filled", "written-by-ai"),
    row(8, "Password", "yours"),
    row(9, "Your CV", "yours"),
    row(10, "I agree", "yours"),
  ],
  ids: [],
  details: null,
  canUndo: true,
  stopped: null,
  note: null,
});

/** The same form with no value for notice period and salary. */
const gaps = (): FormSummary => {
  const form = application();
  form.rows[5] = row(5, "Notice period", "needs-you", undefined, "", "Not in Your details or Knowledge");
  form.rows[6] = row(6, "Expected salary (₹ a year)", "needs-you", undefined, "", "Not in Your details or Knowledge");
  return { ...form, filled: 6, need: 5 };
};

const ctx = { hovered: false, rows: 0, approval: false };

describe("Fill this form on the island", () => {
  it("says how many boxes it filled and how many need you, as the line on the board does", () => {
    expect(filledLine(application())).toBe("Filled 8 of 11 · 3 need you");
    expect(filledLine(gaps())).toBe("Filled 6 of 11 · 5 need you");
    expect(filledLine({ ...application(), need: 0, filled: 11 })).toBe("Filled 11 of 11");
  });

  it("names where each value came from", () => {
    const form = application();
    expect(sourceOf(form.rows[0]!)).toBe("Your details");
    expect(sourceOf(form.rows[5]!)).toBe("Knowledge · Job search");
    expect(sourceOf(form.rows[7]!)).toBe("Written by AI");
    expect(sourceOf(row(0, "Amount", "filled", "mail"))).toBe("from mail");
    expect(sourceOf(row(0, "Amount", "filled", "said"))).toBe("You said");
  });

  it("lists every box, or first only the ones that need you when a box has no value", () => {
    expect(listedRows(application(), false)).toMatchObject({ missing: false });
    expect(listedRows(application(), false).rows).toHaveLength(11);
    const shown = listedRows(gaps(), false);
    expect(shown.missing).toBe(true);
    expect(shown.rows.map((r) => r.label)).toEqual(["Notice period", "Expected salary (₹ a year)", "Password", "Your CV", "I agree"]);
    expect(listedRows(gaps(), true).rows).toHaveLength(11);
  });

  it("grows the Show list a row a box, up to where it scrolls", () => {
    expect(listRows(application(), false)).toBe(11);
    expect(listRows(gaps(), false)).toBe(5 + 2);
    const long = { ...application(), rows: Array.from({ length: 30 }, (_, i) => row(i, `Box ${i}`, "filled", "details")) };
    expect(listRows(long, false)).toBe(LIST_ROWS);
    const list = geometryFor("here", { ...ctx, here: "list", formRows: 11 });
    expect(list.w).toBe(560);
    expect(list.h).toBeGreaterThan(geometryFor("here", { ...ctx, here: "list", formRows: 5 }).h);
    expect(geometryFor("here", { ...ctx, hovered: true, here: "filled" })).toMatchObject({ w: 420, h: 46 });
    expect(geometryFor("here", { ...ctx, here: "filling" }).h).toBe(46);
    for (const card of ["ids", "details"]) expect(geometryFor("here", { ...ctx, here: card }).w).toBe(430);
  });

  it("asks about an ID number first, then offers Your details, then shows the line", () => {
    expect(stepFor({ outcome: "filled", form: { ...application(), ids: ["PAN"], details: ["name"] } })).toMatchObject({ step: "ids", kind: "form" });
    expect(stepFor({ outcome: "filled", form: { ...application(), details: ["name", "email", "phone"] } })).toMatchObject({ step: "details" });
    expect(stepFor({ outcome: "filled", form: application() })).toMatchObject({ step: "filled", kind: "form" });
    expect(stepFor({ outcome: "single" })).toBeNull();
  });

  it("says what Undo kept, in the board's words", () => {
    expect(keptLine(["Email"])).toBe("You changed Email after it was filled, so Email keeps what you typed.");
    expect(keptLine(["Email", "Phone"])).toBe("You changed Email and Phone after they were filled, so they keep what you typed.");
    expect(keptLine([])).toBe("Each box has what it held before.");
    expect(both(["name", "email", "phone"])).toBe("name, email and phone");
  });

  it("tells the user what to say for a box with no value", () => {
    expect(sayIt("Notice period")).toBe("notice period");
    expect(sayIt("Expected salary (₹ a year)")).toBe("expected salary");
    expect(sayIt("Full name *")).toBe("full name");
  });
});

/** Naukri's sign-up form: the email not in Your details, the password, and Work status as one question. */
const signUp = (): FormSummary => ({
  ...application(),
  site: "naukri.com",
  filled: 2,
  total: 5,
  need: 3,
  rows: [
    row(0, "Full name", "filled", "details"),
    { ...row(1, "Email ID", "needs-you", undefined, "", "Not in Your details"), kind: "email", key: "email" },
    { ...row(2, "Password", "yours"), kind: "password" },
    row(3, "Mobile number", "filled", "details"),
    { ...row(4, "Work status", "needs-you"), kind: "radio", choices: [{ field: 4, label: "I'm experienced" }, { field: 5, label: "I'm a fresher" }] },
  ],
});

describe("Fill this form out of the way, and answered on the island", () => {
  it("waits as a small pill saying how many need you, and opens to the line under the pointer", () => {
    expect(pillLine(signUp())).toBe("3 need you");
    expect(pillLine({ ...signUp(), need: 1 })).toBe("1 needs you");
    expect(pillLine({ ...signUp(), need: 0 })).toBe("Filled");
    const pill = geometryFor("here", { ...ctx, here: "filled" });
    expect(pill).toMatchObject({ h: 46 });
    expect(pill.w).toBeLessThan(geometryFor("here", { ...ctx, hovered: true, here: "filled" }).w);
  });

  it("answers a box with a box for words, a question with a button a choice, and a box of yours not at all", () => {
    const [name, email, password, , status] = signUp().rows;
    expect([name, email, password, status].map((r) => answerWith(r!))).toEqual([null, "words", null, "choices"]);
    expect(answerWith({ ...row(6, "Country", "needs-you"), kind: "list" })).toBeNull();
    expect(answerWith({ ...row(7, "PAN", "ask-first") })).toBeNull();
    expect(answerWith({ ...row(8, "Notice period", "needs-you"), kind: "plain-text" })).toBe("words");
  });

  it("keeps a box answered on the island in the short list, for Add to Your details", () => {
    const form = signUp();
    form.rows[1] = { ...form.rows[1]!, state: "filled", origin: "typed", value: "ravi@example.com" };
    expect(listedRows(form, false).rows.map((r) => r.label)).toEqual(["Email ID", "Password", "Work status"]);
    expect(typedHere(form.rows[1]!)).toBe(true);
    expect(sourceOf(form.rows[1]!)).toBe("You typed");
    expect(detailName("address.city")).toBe("city");
  });

  it("counts the choices of one question as one row", () => {
    expect(listRows(signUp(), false)).toBe(3 + 2);
  });
});
