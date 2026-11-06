// Test and repair, under About: checks the parts that break most, and fixes what it safely can. It
// runs only when the page opens or Run again is pressed, and stops when the page closes. Each check
// reads what Settings already shows, through the same calls.

import { useEffect, useState } from "react";
import { bridge } from "../lib/bridge";
import { Icon } from "../lib/icons";
import { CHECKS, failure, judge, keepResult, keptResult, reportText, resultLine, resultOf, summaryLine, within, type CheckId, type Fix, type Help, type Outcome, type Row } from "../lib/repair";
import { checkForUpdates, getState, isReady, openLink, refreshAuth, refreshLocal, setRepair, setSettingsSection, setWatching, signInAgent, updateSettings, useApp } from "../lib/store";
import type { SettingsChange } from "../lib/types";
import { lastHeardWake } from "../lib/voice";
import { deviceName, isUnplugged } from "./Devices";
import { HookReview } from "./Follow";
import { HEARING } from "./Notes";
import { SPEAKERS } from "./Voice";

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const devices = () => navigator.mediaDevices.enumerateDevices();
const LISTEN_MS = 800;
/** A wave this far from silence, out of 128, is sound coming in. */
const SOUND = 3;

/** Opens the microphone for a moment to hear whether sound comes in, then closes it. Nothing is kept. */
async function listenBriefly(chosen: string | null): Promise<{ open: "heard" | "quiet" | "blocked" | "failed"; name: string }> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: chosen ? { deviceId: { exact: chosen } } : true });
  } catch (err) {
    return { open: (err as Error).name === "NotAllowedError" ? "blocked" : "failed", name: "" };
  }
  const context = new AudioContext();
  try {
    const meter = context.createAnalyser();
    context.createMediaStreamSource(stream).connect(meter);
    const samples = new Uint8Array(meter.fftSize);
    let loudest = 0;
    for (let waited = 0; waited < LISTEN_MS; waited += 100) {
      await new Promise((done) => setTimeout(done, 100));
      meter.getByteTimeDomainData(samples);
      for (const value of samples) loudest = Math.max(loudest, Math.abs(value - 128));
    }
    return { open: loudest >= SOUND ? "heard" : "quiet", name: deviceName(stream.getAudioTracks()[0] ?? { label: "" }) || "Your microphone" };
  } finally {
    stream.getTracks().forEach((track) => track.stop());
    void context.close();
  }
}

/** Every folder an agent has worked in, which is where a project can turn hooks off. */
function projectFolders() {
  const s = getState();
  const all = [s.settings.agentDefaultDir, ...s.sessions.filter((x) => x.mode === "project").map((x) => x.cwd)].filter((dir): dir is string => !!dir);
  const key = (dir: string) => dir.replace(/[\\/]+$/, "").toLowerCase();
  return all.filter((dir, i) => all.findIndex((other) => key(other) === key(dir)) === i);
}

const RUN: Record<CheckId, () => Promise<Outcome>> = {
  async microphone() {
    const chosen = getState().settings.voiceMicrophone;
    const list = await devices();
    const inputs = list.filter((d) => d.kind === "audioinput").length;
    const chosenGone = isUnplugged(list, "audioinput", chosen);
    const heard = inputs && !chosenGone ? await listenBriefly(chosen) : { open: "failed" as const, name: "" };
    return judge.microphone({ inputs, chosenGone, ...heard });
  },
  async wake() {
    const { settings, wake } = getState();
    const words = settings.wakeWords.filter((w) => w.on).map((w) => w.text);
    const taught = settings.wakeEnabled && words.length > 0 && (await bridge.wakeTaught(words)).length > 0;
    const heard = lastHeardWake();
    return judge.wake({ enabled: settings.wakeEnabled, state: wake.state, why: wake.why, taught, heard: heard && { word: heard.word, at: clock(heard.at) } });
  },
  async speech() {
    const { voiceProvider, voiceOutput } = getState().settings;
    const speaker = SPEAKERS.find((s) => s.id === voiceProvider) ?? SPEAKERS[SPEAKERS.length - 1]!;
    const status = await bridge.voiceStatus();
    const here = (id?: string) => status.packs.some((p) => p.id === id && p.installed);
    const missing = speaker.key && !status.keys.includes(speaker.id) ? "key" : speaker.pack && !(here(speaker.pack) && here("engine")) ? "download" : null;
    const outputGone = isUnplugged(await devices(), "audiooutput", voiceOutput);
    let voices: { note: string }[] = [];
    let failed: string | null = null;
    if (!missing) voices = await bridge.voiceList(speaker.id).catch((err: unknown) => ((failed = String(err)), []));
    return judge.speech({ name: speaker.name, missing, outputGone, voices, failed });
  },
  async ai() {
    const s = getState();
    if (s.settings.localOnly) {
      const online = await refreshLocal();
      const local = s.providers.find((p) => p.kind === "local" && online.some((o) => o.providerId === p.id));
      return judge.ai({ localOnly: true, local: local?.name ?? null, agent: null, provider: null });
    }
    // The same AI Chat would answer with: the one picked there, else a provider that is ready, else an agent.
    const provider = s.providers.find((p) => isReady(p, s.localOnline)) ?? null;
    const id = s.agentChat.agent ?? (provider ? null : (s.agents.find((a) => a.installed)?.id ?? null));
    const agent = s.agents.find((a) => a.id === id);
    const signedIn = agent ? ((await refreshAuth(agent.id))?.signedIn ?? null) : null;
    return judge.ai({ localOnly: false, local: null, agent: agent ? { id: agent.id, name: agent.name, signedIn } : null, provider: provider?.name ?? null });
  },
  async hooks() {
    const folders = projectFolders();
    return judge.hooks({ ...(await bridge.hooksHealth(folders)), projects: folders.length });
  },
  async gmail() {
    const s = getState();
    const direct = s.activity.accounts.some((a) => a.provider === "google");
    const registered = (await bridge.builtInClients())[0] || s.settings.googleClientId !== "";
    const claude = s.agents.some((a) => a.id === "claude-code" && a.installed);
    // Only asked when Gmail would come through the Claude account, because asking starts Claude Code.
    const onClaude = !s.settings.localOnly && !direct && !registered && claude && (await bridge.claudeConnectors())[0];
    return judge.gmail({ localOnly: s.settings.localOnly, direct, registered, claude, onClaude });
  },
  async updates() {
    const s = getState();
    const asks = !s.settings.localOnly && s.settings.updateChecks === true;
    const reached = asks ? await checkForUpdates() : true;
    const { update } = getState();
    return judge.updates({ localOnly: s.settings.localOnly, version: s.version, kind: s.updateKind, checks: s.settings.updateChecks, reached, latest: update.latest, available: asks && update.available, at: clock(Date.now()) });
  },
  async notes() {
    const { settings } = getState();
    const { keys } = await bridge.voiceStatus();
    const outputs = (await devices()).filter((d) => d.kind === "audiooutput").length;
    return judge.notes({ localOnly: settings.localOnly, service: HEARING[settings.voiceHearing] ?? null, hasKey: keys.includes(settings.voiceHearing), outputs });
  },
};

const BUSY: Partial<Record<CheckId, () => string>> = {
  microphone: () => "Listening for a moment…",
  hooks: () => {
    const n = projectFolders().length;
    return n ? `Looking in ${n === 1 ? "1 project" : `${n} projects`}…` : "Checking…";
  },
  gmail: () => "Asking your Claude account…",
  updates: () => "Asking GitHub…",
};

/** What Fix does for each thing Meridian can do itself, and what it says once it worked. Hooks go
 *  back through the same path as the switch under Coding agents. */
const FIXES: Record<Fix, { run: () => Promise<unknown>; done: string }> = {
  hooks: { run: () => setWatching(true), done: "Fixed. Added again and checked." },
  microphone: { run: () => updateSettings({ voiceMicrophone: null }), done: "Fixed. It uses the Windows microphone now." },
  output: { run: () => updateSettings({ voiceOutput: null }), done: "Fixed. It speaks through the Windows output now." },
};

let run = 0;
const rows = () => getState().repair.rows;
const setRow = (id: CheckId, patch: Partial<Row>) => setRepair({ rows: rows().map((r) => (r.id === id ? { ...r, ...patch } : r)) });
const waiting = (id: CheckId): Row => ({ id, state: "waiting", line: "Waiting", report: "" });

/** Keeps the result for the row in About, once every check has an answer. */
function remember() {
  const last = resultOf(rows(), getState().repair.at);
  if (!last) return;
  keepResult(last);
  setRepair({ last });
}

async function check(id: CheckId, mine: number) {
  // Stopped, or another run began, while a fix was being made.
  if (mine !== run) return null;
  setRow(id, { state: "running", line: BUSY[id]?.() ?? "Checking…", fix: undefined, help: undefined });
  const outcome = await within(CHECKS.find((c) => c.id === id)!.limitMs, RUN[id]()).catch(failure);
  if (mine !== run) return null;
  const { ok, ...rest } = outcome;
  setRow(id, { ...rest, state: ok ? "fine" : "needs" });
  return outcome;
}

/** Every check in turn, or only one. */
async function runChecks(only?: CheckId) {
  const mine = ++run;
  const ids = only ? [only] : CHECKS.map((c) => c.id);
  const before = rows().length ? rows() : CHECKS.map((c) => waiting(c.id));
  setRepair({ rows: before.map((r) => (ids.includes(r.id) ? waiting(r.id) : r)), ...(only ? {} : { at: Date.now() }) });
  for (const id of ids) {
    if (mine !== run) return;
    await check(id, mine);
  }
  if (mine === run) remember();
}

function stopChecks() {
  run++;
  setRepair({ rows: rows().map((r) => (r.state === "waiting" || r.state === "running" ? { ...r, state: "stopped", line: "Not checked", fix: undefined, help: undefined } : r)) });
}

async function fixCheck(id: CheckId) {
  const fix = rows().find((r) => r.id === id)?.fix;
  if (!fix) return;
  const mine = ++run;
  setRow(id, { state: "running", line: "Fixing…", fix: undefined });
  try {
    await FIXES[fix].run();
  } catch (err) {
    const { ok: _failed, ...said } = failure(err);
    if (mine === run) setRow(id, { ...said, state: "needs" });
    return;
  }
  const outcome = await check(id, mine);
  if (outcome?.ok) setRow(id, { state: "fixed", line: FIXES[fix].done });
  if (mine === run) remember();
}

function go(to: NonNullable<Help["go"]>) {
  if (to.open) setSettingsSection(to.open);
  if (to.link) openLink(to.link);
  if (to.signIn) void signInAgent(to.signIn, getState().agents.find((a) => a.id === to.signIn)?.name ?? "Claude Code");
}

/** "Windows 11", from what the webview reports. */
async function systemName() {
  type Hints = { getHighEntropyValues(hints: string[]): Promise<{ platform?: string; platformVersion?: string }> };
  const values = await (navigator as Navigator & { userAgentData?: Hints }).userAgentData?.getHighEntropyValues(["platformVersion"]).catch(() => null);
  if (values?.platform !== "Windows") return values?.platform || "Unknown system";
  return Number(values.platformVersion?.split(".")[0]) >= 13 ? "Windows 11" : "Windows 10";
}

function Mark({ state }: { state: Row["state"] }) {
  if (state === "running") return <span className="repair-mark" data-tone="busy" aria-hidden="true" />;
  if (state === "fine" || state === "fixed") return <span className="repair-mark" data-tone="fine" role="img" aria-label="Fine"><Icon name="check" size={11} /></span>;
  if (state === "needs") return <span className="repair-mark" data-tone="needs" role="img" aria-label="Needs you">!</span>;
  return <span className="repair-mark" data-tone="wait" aria-hidden="true" />;
}

function CheckRow({ row, open, onOpen, busy }: { row: Row; open: boolean; onOpen: () => void; busy: boolean }) {
  const name = CHECKS.find((c) => c.id === row.id)!.name;
  const help = open && row.state === "needs" ? row.help : undefined;
  // Putting the hooks back changes the user's own Claude Code settings, so the lines are shown first, as the switch does.
  const [review, setReview] = useState<SettingsChange | null>(null);
  const fix = async () => {
    if (row.fix !== "hooks") return void fixCheck(row.id);
    try {
      setReview(await bridge.watchPreview(true));
    } catch (err) {
      const { ok: _failed, ...said } = failure(err);
      setRow(row.id, { ...said, state: "needs" });
    }
  };
  return (
    <>
    <div className="setting repair-row" data-state={row.state} data-check={row.id}>
      <Mark state={row.state} />
      <span className="label repair-name">{name}</span>
      {help ? (
        <span className="stacked grow repair-help">
          <span className="repair-line">{help.lead ?? "This one needs you:"}</span>
          <ol>{help.steps.map((step) => <li key={step}>{step}</li>)}</ol>
          <span className="row">
            {help.go && <button className="solid" onClick={() => go(help.go!)}>{help.go.label}</button>}
            <button className="ghost" disabled={busy} onClick={() => void runChecks(row.id)}>Run again</button>
          </span>
        </span>
      ) : (
        <span className="meta grow truncate repair-line" title={row.line}>{row.line}</span>
      )}
      {row.state === "needs" && !help && !review && (row.fix || row.help) && (
        <button className="ghost" disabled={busy} onClick={() => (row.fix ? void fix() : onOpen())}>Fix</button>
      )}
    </div>
    {review && (
      <HookReview
        change={review}
        on
        onCancel={() => setReview(null)}
        onConfirm={() => {
          setReview(null);
          void fixCheck(row.id);
        }}
      />
    )}
    </>
  );
}

const COPIED_MS = 4000;

export function RepairPage({ onBack }: { onBack: () => void }) {
  const { rows: shown, at } = useApp((s) => s.repair);
  const version = useApp((s) => s.version);
  const kind = useApp((s) => s.updateKind);
  const [open, setOpen] = useState<CheckId[]>([]);
  const [copied, setCopied] = useState(false);
  const checking = shown.some((r) => r.state === "waiting" || r.state === "running");
  const answered = shown.filter((r) => r.state !== "waiting" && r.state !== "running").length;

  // Only while the page is open. Leaving it stops whatever is left.
  useEffect(() => {
    void runChecks();
    return () => {
      if (getState().repair.rows.some((r) => r.state === "waiting" || r.state === "running")) stopChecks();
    };
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const again = () => {
    setOpen([]);
    void runChecks();
  };
  const copy = async () => {
    await navigator.clipboard.writeText(reportText(shown, { version, kind, system: await systemName() }));
    setCopied(true);
  };

  return (
    <section className="stack-lg repair">
      <header className="repair-head">
        <span className="stacked grow">
          <button className="text-button crumb" onClick={onBack}>About ›</button>
          <h1>Test and repair</h1>
          <span className="meta tabular" role="status">{checking ? `Checking · ${Math.min(answered + 1, shown.length)} of ${shown.length}` : shown.length ? summaryLine(shown, at) : ""}</span>
        </span>
        {checking ? (
          <button className="ghost" onClick={stopChecks}>Stop</button>
        ) : (
          <>
            <button className="ghost" onClick={() => void copy()}>Copy a report</button>
            <button className="solid" onClick={again}>Run again</button>
          </>
        )}
      </header>
      {copied && (
        <p className="repair-copied" role="status">
          <Mark state="fine" />
          Report copied. It has no messages, recordings or notes.
        </p>
      )}
      <div className="stack">
        {shown.map((row) => (
          <CheckRow key={row.id} row={row} open={open.includes(row.id)} onOpen={() => setOpen([...open, row.id])} busy={checking} />
        ))}
      </div>
      <p className="meta">The microphone opens for a moment while it is checked, and nothing is kept. Nothing here runs in the background.</p>
    </section>
  );
}

/** The row in About, with the last result. */
export function RepairRow({ onOpen }: { onOpen: () => void }) {
  const [kept] = useState(keptResult);
  const last = useApp((s) => s.repair.last) ?? kept;
  return (
    <button className="setting link-row repair-link" onClick={onOpen}>
      <span className="label grow">Test and repair</span>
      {last && <Mark state={last.needs ? "needs" : "fine"} />}
      {last && <span className={last.needs ? "warn" : "meta"}>{resultLine(last)}</span>}
      <Icon name="chevron" size={12} />
    </button>
  );
}
