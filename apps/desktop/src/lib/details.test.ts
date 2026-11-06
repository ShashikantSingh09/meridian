import { describe, expect, it } from "vitest";
import { emptyProfile, idProblem, isBirth, isEmpty, problem, showBirth, tidyId } from "./details";

describe("Your details", () => {
  it("is empty until something is added, or ID numbers are turned on", () => {
    expect(isEmpty(emptyProfile)).toBe(true);
    expect(isEmpty({ ...emptyProfile, address: { ...emptyProfile.address, city: "  " } })).toBe(true);
    expect(isEmpty({ ...emptyProfile, address: { ...emptyProfile.address, city: "Bengaluru" } })).toBe(false);
    expect(isEmpty({ ...emptyProfile, ids: true })).toBe(false);
  });

  it("wants six digits in a PIN code", () => {
    expect(problem("pin", "560102")).toBeNull();
    expect(problem("pin", "56010")).toBe("A PIN code has 6 digits.");
    expect(problem("pin", "56O102")).toBe("A PIN code has 6 digits.");
    expect(problem("pin", "")).toBeNull();
  });

  it("checks emails and phone numbers the way the core does", () => {
    for (const ok of ["ravi@gmail.com", "ravi.s@northwind.co.in"]) expect(problem("email", ok)).toBeNull();
    for (const bad of ["ravi", "ravi@gmail", "ra vi@gmail.com", "@gmail.com", "a@b@c.com"]) expect(problem("email", bad)).toBe("An email looks like name@example.com.");
    for (const ok of ["+91 98201 44317", "9820144317", "080-2345-6789", "(080) 2345 6789"]) expect(problem("phone", ok)).toBeNull();
    for (const bad of ["98201", "98201 4431x", "91+9820144317"]) expect(problem("phone", bad)).toBe("A phone number has 10 to 15 digits.");
  });

  it("takes a date of birth that is a real day in the past", () => {
    const today = new Date(2026, 10, 6);
    expect(isBirth("1991-08-14", today)).toBe(true);
    expect(isBirth("1991-02-30", today)).toBe(false);
    expect(isBirth("1850-01-01", today)).toBe(false);
    expect(isBirth("2026-11-07", today)).toBe(false);
    expect(showBirth("1991-08-14")).toBe("14 Aug 1991");
  });

  it("tidies and checks ID numbers", () => {
    expect(tidyId(" abcde 1234k ")).toBe("ABCDE1234K");
    expect(idProblem("pan", "abcde1234k")).toBeNull();
    expect(idProblem("pan", "ABCD12345K")).toBe("A PAN looks like ABCDE1234F.");
    expect(idProblem("aadhaar", "1234 5678 8823")).toBeNull();
    expect(idProblem("aadhaar", "1234 5678 882")).toBe("An Aadhaar number has 12 digits.");
    expect(idProblem("passport", "A1234567")).toBeNull();
    expect(idProblem("passport", "ABCDEFG")).toBe("A passport number has 6 to 9 letters and digits.");
  });
});
