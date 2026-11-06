// Your details, as the core keeps them in a file on this PC. The checks are the ones in details.rs,
// so Save can wait until a value looks right. The core checks again before it writes.

export interface Profile {
  name: { en: string; hi: string };
  /** As 1991-08-14. */
  birth: string;
  email: string;
  phone: string;
  otherPhone: string;
  address: { lines: string; city: string; pin: string; state: string; hi: string };
  work: { company: string; title: string; department: string; employeeId: string; email: string; linkedin: string };
  /** ID numbers may be kept and used. Off until turned on. */
  ids: boolean;
}

export type IdKind = "pan" | "aadhaar" | "passport";

/** The ID numbers kept, masked, or null for one that is not. */
export type IdNumbers = Record<IdKind, string | null>;

export const emptyProfile: Profile = {
  name: { en: "", hi: "" },
  birth: "",
  email: "",
  phone: "",
  otherPhone: "",
  address: { lines: "", city: "", pin: "", state: "", hi: "" },
  work: { company: "", title: "", department: "", employeeId: "", email: "", linkedin: "" },
  ids: false,
};

/** Nothing added yet, so the page shows how to start. */
export function isEmpty(profile: Profile) {
  const texts = (value: unknown): string[] => (typeof value === "string" ? [value] : typeof value === "object" && value ? Object.values(value).flatMap(texts) : []);
  return !profile.ids && texts(profile).every((text) => !text.trim());
}

export function looksLikeEmail(text: string) {
  const [name, domain, ...more] = text.split("@");
  return more.length === 0 && !!name && domain !== undefined && !/\s/.test(text) && domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

/** Digits with the usual spaces, dashes and brackets, and a + only at the front. */
export function looksLikePhone(text: string) {
  const body = text.startsWith("+") ? text.slice(1) : text;
  const digits = body.replace(/\D/g, "").length;
  return /^[\d ()-]*$/.test(body) && digits >= 10 && digits <= 15;
}

/** A real day, after 1900 and not in the future. */
export function isBirth(text: string, today = new Date()) {
  const [y, m, d] = (/^(\d{4})-(\d{2})-(\d{2})$/.exec(text) ?? []).slice(1).map(Number);
  if (!y || !m || !d) return false;
  const day = new Date(y, m - 1, d);
  return day.getMonth() === m - 1 && day.getDate() === d && y >= 1900 && day <= today;
}

export type Check = "birth" | "email" | "phone" | "pin";

const CHECKS: Record<Check, [(text: string) => boolean, string]> = {
  birth: [isBirth, "Use a real date of birth, not in the future."],
  email: [looksLikeEmail, "An email looks like name@example.com."],
  phone: [looksLikePhone, "A phone number has 10 to 15 digits."],
  pin: [(text) => /^\d{6}$/.test(text), "A PIN code has 6 digits."],
};

/** What is wrong with one box, or null. An empty box is always fine. */
export function problem(check: Check, text: string) {
  const [ok, why] = CHECKS[check];
  return !text.trim() || ok(text.trim()) ? null : why;
}

/** As the core keeps a number: capitals with no spaces or dashes. */
export const tidyId = (text: string) => text.replace(/[\s-]/g, "").toUpperCase();

export function idProblem(kind: IdKind, number: string) {
  const n = tidyId(number);
  if (!n) return null;
  if (kind === "pan") return /^[A-Z]{5}\d{4}[A-Z]$/.test(n) ? null : "A PAN looks like ABCDE1234F.";
  if (kind === "aadhaar") return /^\d{12}$/.test(n) ? null : "An Aadhaar number has 12 digits.";
  return /^[A-Z\d]{6,9}$/.test(n) && /\d/.test(n) ? null : "A passport number has 6 to 9 letters and digits.";
}

/** 1991-08-14 as 14 Aug 1991. */
export function showBirth(text: string) {
  if (!isBirth(text)) return text;
  const [y, m, d] = text.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
