import { FollowSwitch } from "./Follow";
import { Markdown } from "./Markdown";
import { ScreenSection } from "./Screen";
import { VoiceSection } from "./Voice";
import { spring } from "@meridian/design-system/motion";
import { motion } from "motion/react";
import { useState, useEffect } from "react";
import { Face, FACES, type Mood } from "../island/faces";
import { bridge } from "../lib/bridge";
import { checkForUpdates, clearHistory, feel, installUpdate, PREVIEWS, refreshAuth, setSettingsSection, showPreview, updateSettings, useApp, type SettingsSection } from "../lib/store";
import type { AgentInfo, Settings } from "../lib/types";
import { Integrations } from "./Integrations";
import { Providers } from "./Providers";

function Choice<K extends keyof Settings>({ name, label, options }: {
  name: K;
  label: string;
  options: { value: Settings[K]; label: string }[];
}) {
  const value = useApp((s) => s.settings[name]);
  return (
    <fieldset className="setting">
      <legend>{label}</legend>
      <div className="segmented">
        {options.map((o) => (
          <button key={String(o.value)} aria-pressed={value === o.value} onClick={() => void updateSettings({ [name]: o.value } as Partial<Settings>)}>
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

type Flag = "ambient" | "autostart" | "localOnly" | "showClock" | "islandAutoHide" | "mediaEnabled" | "monitoringPaused" | "showNextMeeting" | "sounds";

function Toggle({ name, label, hint }: { name: Flag; label: string; hint: string }) {
  const value = useApp((s) => s.settings[name]);
  return (
    <label className="setting toggle">
      <span className="stacked grow">
        <span className="label">{label}</span>
        <span className="meta">{hint}</span>
      </span>
      <input type="checkbox" role="switch" checked={value} onChange={(e) => void updateSettings({ [name]: e.target.checked })} />
    </label>
  );
}

function General() {
  const systemPrompt = useApp((s) => s.settings.systemPrompt);
  return (
    <section className="stack-lg">
      <h1>General</h1>
      <div className="stack">
        <Toggle name="autostart" label="Start with Windows" hint="Off by default." />
        <Toggle name="sounds" label="Sounds" hint="A soft chime when an agent finishes or needs you." />
        <Toggle name="localOnly" label="Local-only mode" hint="Requests to cloud providers are refused. Only servers on this machine are used." />
      </div>
      <label className="field">
        <span className="label">Custom instructions</span>
        <textarea
          rows={3}
          defaultValue={systemPrompt}
          placeholder="Sent as the system prompt with every API chat"
          onBlur={(e) => void updateSettings({ systemPrompt: e.target.value })}
        />
      </label>
    </section>
  );
}

const MOODS: [Mood, string][] = [
  ["done", "Happy"],
  ["error", "Sad"],
  ["needs", "Surprised"],
  ["curious", "Curious"],
  ["working", "Focused"],
  ["wink", "Wink"],
  ["love", "Love"],
  ["dizzy", "Dizzy"],
  ["sleepy", "Sleepy"],
  ["asleep", "Asleep"],
];

function FacePicker() {
  const chosen = useApp((s) => s.settings.face);
  const feeling = useApp((s) => s.feeling);
  return (
    <div className="stack">
      <h2>Face</h2>
      <div className="pick-grid">
        {FACES.map((f) => (
          <button key={f.id} className="pick" aria-pressed={f.id === chosen} title={f.note} onClick={() => void updateSettings({ face: f.id })}>
            <span className="pick-stage"><Face id={f.id} mood={feeling ?? "rest"} scale={0.8} /></span>
            <span className="pick-name">{f.name}</span>
          </button>
        ))}
      </div>
      <div className="chips" role="group" aria-label="Try a mood">
        {MOODS.map(([mood, label]) => (
          <button key={mood} className="chip" aria-pressed={feeling === mood} onClick={() => feel(mood, 2600)}>{label}</button>
        ))}
      </div>
    </div>
  );
}

function IslandSection() {
  const monitor = useApp((s) => s.settings.islandMonitor);
  const monitors = useApp((s) => s.monitors);
  const preview = useApp((s) => s.preview);
  return (
    <section className="stack-lg">
      <h1>Island</h1>
      <FacePicker />
      <div className="stack">
        <Choice name="islandAlign" label="Position" options={[
          { value: "left", label: "Left" },
          { value: "center", label: "Center" },
          { value: "right", label: "Right" },
        ]} />
        {monitors.length > 1 && (
          <label className="setting">
            <span className="label">Display</span>
            <select value={monitor} onChange={(e) => void updateSettings({ islandMonitor: e.target.value })}>
              <option value="primary">Primary</option>
              {monitors.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>
        )}
        <Choice name="animationSpeed" label="Animation speed" options={[
          { value: 0.75, label: "Relaxed" },
          { value: 1, label: "Normal" },
          { value: 1.35, label: "Quick" },
        ]} />
        <Choice name="motion" label="Motion" options={[
          { value: "system", label: "System" },
          { value: "full", label: "Full" },
          { value: "reduced", label: "Reduced" },
        ]} />
      </div>
      <div className="stack">
        <Toggle name="showClock" label="Show the time" hint="Beside the line while idle." />
        <Toggle name="showNextMeeting" label="Show the next meeting" hint="On the island when you point at it." />
        <Toggle name="mediaEnabled" label="Show what is playing" hint="Any player that publishes to Windows media controls." />
        <Toggle name="islandAutoHide" label="Hide when idle" hint="Shrinks to a sliver at the top of the screen, and returns on hover or activity." />
        <Toggle name="ambient" label="Ambient breathing" hint="The face breathes for a few seconds after activity, then rests." />
        <p className="meta">Hide it completely from the tray icon. The shortcut brings it back.</p>
      </div>
      <div className="stack">
        <h2>Preview island states</h2>
        <p className="meta">Shows each state with sample data for a few seconds, so you can judge the design.</p>
        <div className="chips">
          {PREVIEWS.map((p) => (
            <button key={p.name} className="chip" aria-pressed={preview === p.name} onClick={() => showPreview(p.name)}>{p.name}</button>
          ))}
        </div>
      </div>
    </section>
  );
}

function AgentRow({ agent }: { agent: AgentInfo }) {
  const auth = useApp((s) => s.auth[agent.id]);
  const signedIn = auth?.signedIn;
  const state = !agent.installed ? "Not installed" : signedIn === true ? `Signed in${auth?.plan ? `, ${auth.plan}` : ""}` : signedIn === false ? "Not signed in" : "Sign-in unknown";
  return (
    <div className="setting">
      <span className="stacked grow">
        <span className="label">{agent.name}</span>
        <span className="meta truncate" title={agent.path ?? undefined}>{agent.version ?? "Not found on PATH"}</span>
      </span>
      <span className="meta">{state}</span>
      {agent.installed && <button className="ghost" onClick={() => void refreshAuth(agent.id)}>Check</button>}
      {agent.installed && signedIn !== true && <button className="solid" onClick={() => void bridge.agentLogin(agent.id)}>Sign in</button>}
    </div>
  );
}

function AgentsSection() {
  const agents = useApp((s) => s.agents);
  const defaultDir = useApp((s) => s.settings.agentDefaultDir);
  const [picking, setPicking] = useState(false);

  const pickDir = async () => {
    setPicking(true);
    const dir = await bridge.pickFolder();
    setPicking(false);
    if (dir) void updateSettings({ agentDefaultDir: dir });
  };

  return (
    <section className="stack-lg">
      <h1>Coding agents</h1>
      <div className="stack">
        <FollowSwitch explain="Shows sessions started in any terminal, and lets you answer permission requests, questions and plans from the island. Adds hooks to your Claude Code settings file and keeps a backup. Turning this off removes them. Nothing leaves this PC." />
      </div>
      <div className="stack">
        {agents.map((a) => (
          <AgentRow key={a.id} agent={a} />
        ))}
        <div className="setting">
          <span className="stacked grow">
            <span className="label">Default project folder</span>
            <span className="meta truncate" title={defaultDir ?? undefined}>{defaultDir ?? "None"}</span>
          </span>
          <button className="ghost" disabled={picking} onClick={() => void pickDir()}>Choose</button>
        </div>
      </div>
    </section>
  );
}

function Privacy() {
  return (
    <section className="stack-lg">
      <h1>Privacy</h1>
      <Toggle name="monitoringPaused" label="Pause all monitoring" hint="Stops contextual awareness and background fetching at once. Also in the tray menu." />
      <p className="meta">
        Your screen is read only as set under Screen, always on this PC, and shared only from a preview you approve.
        No keystrokes or clipboard are read. The microphone opens only while the listening view is on screen, shows a dot
        while open, and nothing is recorded. Chat text goes only to the engine you pick. Providers are read with read-only
        tools, and what they return stays on this PC. No telemetry.
      </p>
      <div className="setting">
        <span className="stacked grow">
          <span className="label">Chat and session history</span>
          <span className="meta">Kept on this PC so it survives a restart. Shared images are not kept.</span>
        </span>
        <button className="ghost" onClick={clearHistory}>Clear history</button>
      </div>
    </section>
  );
}

/** Check for a new version and install it, right here. */
function UpdatesSection() {
  const version = useApp((s) => s.version);
  const update = useApp((s) => s.update);
  const busy = useApp((s) => s.updating);

  useEffect(() => {
    void checkForUpdates();
  }, []);

  const when = update.published ? new Date(update.published).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : null;
  return (
    <section className="stack-lg">
      <h1>Updates</h1>
      <div className="update-card">
        <div className="row">
          <span className="stacked grow">
            <span className="label">Meridian {version}</span>
            <span className="meta" role="status">{busy === "checking" ? "Checking" : busy === "installing" ? "Downloading and checking the update. Meridian will restart by itself." : update.message}</span>
          </span>
          <button className="ghost" disabled={busy !== null} onClick={() => void checkForUpdates()}>Check for updates</button>
          {update.available && <button className="solid" disabled={busy !== null} onClick={() => void installUpdate()}>Update now</button>}
        </div>
        {update.notes && (
          <>
            <h2>What is new in {update.latest?.replace(/^v/, "")}{when ? `, ${when}` : ""}</h2>
            <div className="update-notes"><Markdown text={update.notes} /></div>
          </>
        )}
      </div>
      <p className="meta">Updating ends any agent running here, so nothing installs until you press Update now. Downloads come from your private GitHub releases through the GitHub command line, and each one is checked against its published checksum.</p>
    </section>
  );
}

function About() {
  const version = useApp((s) => s.version);
  return (
    <section className="stack-lg">
      <h1>About Meridian</h1>
      <div className="stack">
        <div className="setting">
          <span className="stacked grow">
            <span className="label">Version {version}</span>
          </span>
          <button className="ghost" onClick={() => void bridge.openLogs()}>Open logs</button>
        </div>
      </div>
      <p className="meta">Set in Inter, used under the SIL Open Font License. Keyboard shortcut: Ctrl Alt Space opens the island from anywhere.</p>
    </section>
  );
}

const SECTIONS: { id: SettingsSection; label: string; page: () => React.JSX.Element }[] = [
  { id: "general", label: "General", page: General },
  { id: "island", label: "Island", page: IslandSection },
  { id: "voice", label: "Voice", page: VoiceSection },
  { id: "screen", label: "Screen", page: ScreenSection },
  { id: "models", label: "AI models", page: Providers },
  { id: "providers", label: "Providers", page: Integrations },
  { id: "agents", label: "Coding agents", page: AgentsSection },
  { id: "privacy", label: "Privacy", page: Privacy },
  { id: "updates", label: "Updates", page: UpdatesSection },
  { id: "about", label: "About", page: About },
];

export function SettingsPage() {
  const current = useApp((s) => s.settingsSection);
  const Section = SECTIONS.find((s) => s.id === current)!.page;
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings sections">
        {SECTIONS.map((s) => (
          <button key={s.id} className="settings-tab" aria-current={current === s.id ? "page" : undefined} onClick={() => setSettingsSection(s.id)}>
            {current === s.id && <motion.span layoutId="settings-pill" className="topnav-pill" transition={spring.hover} />}
            <span className="settings-tab-label">{s.label}</span>
          </button>
        ))}
      </nav>
      <motion.div key={current} className={current === "providers" ? "settings-body flush" : "settings-body"} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.14 }}>
        <Section />
      </motion.div>
    </div>
  );
}
