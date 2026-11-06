import { describe, expect, it } from "vitest";
import { geometryFor } from "../island/machine";
import { both, filledLine, keptLine, listedRows, listRows, LIST_ROWS, sayIt, sourceOf } from "./form";
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
    expect(geometryFor("here", { ...ctx, here: "filled" })).toMatchObject({ w: 420, h: 46 });
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
