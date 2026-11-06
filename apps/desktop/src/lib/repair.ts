// Test and repair: what each check makes of what it found, and the report to paste into an issue.
// The page gathers the facts. Judging them is kept here, apart, so it has tests of its own.

import { CLAUDE_CONNECTORS, projectName, type SettingsSection } from "./store";
import type { AgentId, WakeStatus } from "./types";

export type CheckId = "microphone" | "wake" | "speech" | "ai" | "hooks" | "gmail" | "updates" | "notes";

/** In the order they run. Each has its own time limit, so one stuck check cannot hold up the rest. */
export const CHECKS: { id: CheckId; name: string; limitMs: number }[] = [
  { id: "microphone", name: "Microphone", limitMs: 6_000 },
  { id: "wake", name: "Wake words", limitMs: 4_000 },
  { id: "speech", name: "Speech", limitMs: 8_000 },
  { id: "ai", name: "AI sign-in", limitMs: 10_000 },
  { id: "hooks", name: "Claude Code hooks", limitMs: 4_000 },
  // Asking the Claude account starts Claude Code, which takes a while.
  { id: "gmail", name: "Gmail", limitMs: 30_000 },
  { id: "updates", name: "Updates", limitMs: 15_000 },
  { id: "notes", name: "Notes recording", limitMs: 4_000 },
];

/** What Meridian can safely do itself, then check again. */
export type Fix = "hooks" | "microphone" | "output";

/** When only the user can fix it: the steps, and where to go. */
export interface Help {
  lead?: string;
  steps: string[];
  go?: { label: string; open?: SettingsSection; link?: string; signIn?: AgentId };
}

export interface Outcome {
  ok: boolean;
  /** One line, on the page. */
  line: string;
  /** For the report. Never a message, a recording, a note, an address or a project's name. */
  report: string;
  fix?: Fix;
  help?: Help;
}

export type RowState = "waiting" | "running" | "fine" | "needs" | "fixed" | "stopped";
export interface Row extends Omit<Outcome, "ok"> {
  id: CheckId;
  state: RowState;
}

/** The last run that checked everything, for the row in About. */
export interface RepairResult {
  fine: number;
  needs: number;
  at: number;
}

const AGAIN = "Come back and press Run again.";
const ok = (line: string, report: string): Outcome => ({ ok: true, line, report });
const needs = (line: string, report: string, help?: Help): Outcome => ({ ok: false, line, report, help });
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** "Asha's AirPods" names a person, so the report keeps only "AirPods". */
const deviceOnly = (name: string) => name.replace(/^.*?['’]s\s+/, "");

export const judge = {
  microphone(f: { inputs: number; chosenGone: boolean; open: "heard" | "quiet" | "blocked" | "failed"; name: string }): Outcome {
    if (f.inputs === 0) return needs("No microphone found", "none found", { steps: ["Plug in a microphone or a headset.", "Press Run again."] });
    if (f.chosenGone) return { ok: false, line: "Your chosen microphone is unplugged", report: "chosen one unplugged", fix: "microphone" };
    if (f.open === "blocked") {
      return needs("Windows does not let Meridian use it", "blocked by Windows", {
        lead: "This one needs you, in Windows Settings:",
        steps: ["Open Settings, then Privacy and security, then Microphone.", "Turn on Let desktop apps access your microphone.", AGAIN],
      });
    }
    if (f.open === "failed") return needs("It would not open. Another app may be holding it.", "would not open", { steps: ["Close any app that may be using the microphone.", "Press Run again."] });
    return ok(`${f.name} · ${f.open === "heard" ? "hears you" : "opens"}`, deviceOnly(f.name));
  },

  wake(f: { enabled: boolean; state: WakeStatus["state"]; why: string; taught: boolean; heard: { word: string; at: string } | null }): Outcome {
    const go = { label: "Open Wake words", open: "wake" as const };
    if (!f.enabled) return ok("Off", "off");
    if (!f.taught) return needs("Not taught your voice yet", "not taught", { steps: ["Open Wake words.", "Press Teach next to a wake word, and say it each time it asks.", AGAIN], go });
    if (f.state === "failed") return needs(f.why || "Stopped listening", "stopped", { steps: ["Open Wake words and read what it says.", "Turn Listen for wake words off, then on again.", AGAIN], go });
    if (f.state === "paused") return ok(f.why ? `Paused. ${f.why}` : "Paused", "paused");
    if (f.state === "off") return ok(f.why || "Not listening right now", "not listening");
    return f.heard ? ok(`Last heard "${f.heard.word}" at ${f.heard.at}`, `last heard ${f.heard.at}`) : ok("Listening", "listening");
  },

  speech(f: { name: string; missing: "key" | "download" | null; outputGone: boolean; voices: { note: string }[]; failed: string | null }): Outcome {
    const go = { label: "Open Voice", open: "voice" as const };
    if (f.missing === "key") return needs(`${f.name} has no key yet`, "no key", { steps: ["Open Voice.", `Paste your ${f.name} key and press Save.`, AGAIN], go });
    if (f.missing === "download") return needs(`${f.name} is not downloaded yet`, "not downloaded", { steps: ["Open Voice.", `Press Download next to ${f.name}.`, AGAIN], go });
    if (f.outputGone) return { ok: false, line: "Your chosen speakers or headphones are unplugged", report: "chosen output unplugged", fix: "output" };
    if (f.failed || f.voices.length === 0) return needs(f.failed ?? `${f.name} has no voices`, "no voices", { steps: ["Open Voice, and choose another voice.", AGAIN], go });
    const languages = [...new Set(f.voices.map((v) => v.note).filter((note) => /^[a-z]{2,3}-[A-Z]{2}$/.test(note)))];
    const both = languages.some((l) => l.startsWith("en-")) && languages.some((l) => l.startsWith("hi-"));
    return ok(both ? "English and Hindi voices are ready" : `Speaks with ${f.name}`, languages.length ? languages.join(", ") : f.name);
  },

  ai(f: { localOnly: boolean; local: string | null; agent: { id: AgentId; name: string; signedIn: boolean | null } | null; provider: string | null }): Outcome {
    const models = { label: "Open AI models", open: "models" as const };
    if (f.localOnly) {
      return f.local
        ? ok(`${f.local}, on this PC`, `${f.local}, on this PC`)
        : needs("Local-only mode needs AI running on this PC", "nothing on this PC", { steps: ["Start Ollama or LM Studio on this PC.", "Open AI models, and check it is found.", AGAIN], go: models });
    }
    if (f.agent?.signedIn) return ok(f.agent.id === "claude-code" ? "Claude, through Claude Code" : `${f.agent.name}, signed in`, f.agent.name);
    if (f.agent) return needs(`${f.agent.name} is not signed in`, "not signed in", { steps: ["Press Sign in, and finish in the window that opens.", AGAIN], go: { label: "Sign in", signIn: f.agent.id } });
    if (f.provider) return ok(`${f.provider}, with your key`, f.provider);
    return needs("No AI is set up yet", "none", { steps: ["Open AI models.", "Sign in, add a key, or start AI on this PC.", AGAIN], go: models });
  },

  hooks(f: { on: boolean; inPlace: boolean; offIn: string[]; projects: number }): Outcome {
    if (!f.on) return ok("Following is off, so none are needed", "off");
    if (!f.inPlace) return { ok: false, line: "Missing from your Claude Code settings", report: "missing", fix: "hooks" };
    if (f.offIn.length > 0) {
      const names = f.offIn.map(projectName);
      const many = count(names.length, "project", "projects");
      return needs(`Turned off in ${many}: ${names.join(", ")}`, `off in ${many}`, {
        steps: [`Open .claude/settings.json in ${names[0]}, and settings.local.json if it has one.`, 'Take out "disableAllHooks": true.', AGAIN],
      });
    }
    return f.projects ? ok(`In place · ${count(f.projects, "project", "projects")}`, `in place, ${count(f.projects, "project", "projects")}`) : ok("In place", "in place");
  },

  gmail(f: { localOnly: boolean; direct: boolean; registered: boolean; claude: boolean; onClaude: boolean }): Outcome {
    if (f.localOnly) return ok("Off in local-only mode", "off, local-only");
    if (f.direct) return ok("Connected to your Google account", "connected");
    if (f.registered) {
      return needs("Not connected", "not connected", { steps: ["Open Providers.", "Press Connect Gmail, and sign in with Google.", AGAIN], go: { label: "Open Providers", open: "providers" } });
    }
    if (!f.claude) return needs("Gmail connects through Claude Code, which is not on this PC", "no Claude Code", { steps: ["Install Claude Code, and sign in.", AGAIN] });
    if (f.onClaude) return ok("Connected through your Claude account", "connected, through Claude");
    return needs("Not connected to your Claude account", "not connected", {
      lead: "This one needs you, on Claude's page:",
      steps: ["Open Claude's connectors page.", "Press Connect next to Gmail and sign in with Google.", AGAIN],
      go: { label: "Open Claude's page", link: CLAUDE_CONNECTORS },
    });
  },

  updates(f: { localOnly: boolean; version: string; kind: "setup" | "msi" | "portable"; checks: boolean | null; reached: boolean; latest: string | null; available: boolean; at: string }): Outcome {
    const base = `${f.version}, ${f.kind === "portable" ? "portable copy" : "installed copy"}`;
    if (f.localOnly) return ok(`${base} · checks are off in local-only mode`, `${f.version}, local-only`);
    // Asking GitHub waits for the user's yes, as everywhere else.
    if (f.checks !== true) return ok(`${base} · checking by itself is off`, `${f.version}, checks off`);
    if (!f.reached) return needs("Could not reach GitHub", "could not check", { steps: ["Check that this PC is online.", "Press Run again."] });
    if (f.available) {
      const latest = (f.latest ?? "").replace(/^v/, "");
      const how = f.kind === "portable" ? "Press the button to get it from its release page." : "Press Update now. Meridian restarts by itself.";
      return needs(`${latest} is ready to install`, `${latest} is out`, { steps: ["Open Updates.", how], go: { label: "Open Updates", open: "updates" } });
    }
    return ok(`${base} · checked ${f.at}`, `${f.version}, up to date`);
  },

  notes(f: { localOnly: boolean; service: string | null; hasKey: boolean; outputs: number }): Outcome {
    const go = { label: "Open Voice", open: "voice" as const };
    if (f.localOnly) return ok("Off in local-only mode", "off, local-only");
    if (!f.service) return needs("Notes need ElevenLabs or Deepgram", "no hearing service", { steps: ["Open Voice.", "Under How it hears you, choose ElevenLabs or Deepgram.", "Add its key, then press Run again."], go });
    if (!f.hasKey) return needs(`${f.service} has no key yet`, "no key", { steps: ["Open Voice.", `Choose ${f.service} as the voice, paste its key and press Save.`, AGAIN], go });
    if (f.outputs === 0) return needs("No speakers or headphones, so the call's sound cannot be recorded", "no output", { steps: ["Plug in speakers or headphones.", "Press Run again."] });
    return ok(`Ready. Your mic and the call's sound go to ${f.service}`, f.service);
  },
};

/** A check that runs past its limit gives way to the next. */
export function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, fail) => (timer = setTimeout(() => fail(new Error(`Took longer than ${ms / 1000} seconds`)), ms)));
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** A check that failed outright, said in one line. */
export function failure(err: unknown): Outcome {
  const said = (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 120);
  return { ok: false, line: said || "Something went wrong", report: said.startsWith("Took longer") ? "timed out" : "failed" };
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const DONE: RowState[] = ["fine", "needs", "fixed"];
const needYou = (n: number) => (n === 1 ? "1 needs you" : `${n} need you`);

/** Counted once every check has an answer. Null while any is waiting, or after a Stop. */
export function resultOf(rows: Row[], at: number): RepairResult | null {
  if (rows.length === 0 || !rows.every((r) => DONE.includes(r.state))) return null;
  const needs = rows.filter((r) => r.state === "needs").length;
  return { fine: rows.length - needs, needs, at };
}

/** "Checked 9:14 am · 6 fine, 2 need you" */
export function summaryLine(rows: Row[], at: number) {
  const done = rows.filter((r) => DONE.includes(r.state));
  const needs = done.filter((r) => r.state === "needs").length;
  const fine = done.length - needs;
  if (done.length < rows.length) return `Stopped at ${clock(at)} · ${fine} fine, ${needYou(needs)}`;
  return needs ? `Checked ${clock(at)} · ${fine} fine, ${needYou(needs)}` : `Checked ${clock(at)} · all ${fine} fine`;
}

/** For the row in About: all fine in green, or how many need you in amber. */
export const resultLine = (last: RepairResult) => (last.needs ? needYou(last.needs) : `All ${last.fine} fine · ${clock(last.at)}`);

const STATE: Record<RowState, string> = { fine: "fine", needs: "needs you", fixed: "fixed", waiting: "not checked", running: "not checked", stopped: "not checked" };

/** Plain text to paste into an issue. Only the version, the system and each check's short report. */
export function reportText(rows: Row[], about: { version: string; kind: "setup" | "msi" | "portable"; system: string }) {
  const lines = rows.map((row) => `${CHECKS.find((c) => c.id === row.id)!.name.padEnd(18)}${STATE[row.state].padEnd(12)}${row.report}`.trimEnd());
  const copy = about.kind === "portable" ? "portable" : "installed";
  return [`Meridian ${about.version}, ${copy} · ${about.system}`, "No messages, recordings or notes are in this report.", "", ...lines].join("\n");
}

const KEPT = "meridian.repair";

export function keptResult(): RepairResult | null {
  try {
    return JSON.parse(localStorage.getItem(KEPT) ?? "null") as RepairResult | null;
  } catch {
    return null;
  }
}

export function keepResult(result: RepairResult) {
  try {
    localStorage.setItem(KEPT, JSON.stringify(result));
  } catch {
    // The row in About shows it for this run all the same.
  }
}
