import { useState } from "react";
import { bridge } from "../lib/bridge";
import { PREVIEWS, refreshAuth, showPreview, updateSettings, useApp } from "../lib/store";
import type { AgentInfo, Settings } from "../lib/types";

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

type Flag = "ambient" | "autostart" | "localOnly" | "showClock" | "islandAutoHide";

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

export function SettingsPage() {
  const glass = useApp((s) => s.glass);
  const systemPrompt = useApp((s) => s.settings.systemPrompt);
  const monitor = useApp((s) => s.settings.islandMonitor);
  const defaultDir = useApp((s) => s.settings.agentDefaultDir);
  const monitors = useApp((s) => s.monitors);
  const agents = useApp((s) => s.agents);
  const preview = useApp((s) => s.preview);
  const [picking, setPicking] = useState(false);

  const pickDir = async () => {
    setPicking(true);
    const dir = await bridge.pickFolder();
    setPicking(false);
    if (dir) void updateSettings({ agentDefaultDir: dir });
  };

  return (
    <div className="page-scroll stack-lg">
      <h1>Settings</h1>

      <section className="stack">
        <h2>Dynamic Island</h2>
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
        <Toggle name="showClock" label="Show the time" hint="Beside the line while idle." />
        <Toggle name="islandAutoHide" label="Hide when idle" hint="Shrinks to a sliver. Move the pointer to it, or wait for activity, and it returns." />
        <p className="meta">Hide it completely from the tray icon. The shortcut brings it back.</p>
      </section>

      <section className="stack">
        <h2>Appearance</h2>
        <Choice name="theme" label="Theme" options={[
          { value: "system", label: "System" },
          { value: "dark", label: "Dark" },
          { value: "light", label: "Light" },
        ]} />
        <Choice name="motion" label="Motion" options={[
          { value: "system", label: "System" },
          { value: "full", label: "Full" },
          { value: "reduced", label: "Reduced" },
        ]} />
        <Toggle name="ambient" label="Ambient breathing" hint="The line breathes for a few seconds after activity, then rests." />
        <p className="meta">Glass: {glass ? "native backdrop active" : "tinted fallback"}</p>
      </section>

      <section className="stack">
        <h2>Coding agents</h2>
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
      </section>

      <section className="stack">
        <h2>Behaviour</h2>
        <Toggle name="autostart" label="Start with Windows" hint="Off by default." />
        <Toggle name="localOnly" label="Local-only mode" hint="Requests to cloud providers are refused. Only servers on this machine are used." />
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

      <section className="stack">
        <h2>Privacy</h2>
        <p className="meta">
          This build reads no screen, clipboard, keyboard or window content. The microphone opens only while
          the listening view is on screen, shows a dot while open, and nothing is recorded. Chat text goes
          only to the engine you pick. No telemetry.
        </p>
      </section>

      <section className="stack">
        <h2>Preview island states</h2>
        <p className="meta">Shows each state with sample data so you can judge the design.</p>
        <div className="chips">
          {PREVIEWS.map((p) => (
            <button key={p.name} className="chip" aria-pressed={preview === p.name} onClick={() => showPreview(p.name)}>{p.name}</button>
          ))}
        </div>
      </section>
    </div>
  );
}
