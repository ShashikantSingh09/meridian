import { PREVIEWS, showPreview, updateSettings, useApp } from "../lib/store";
import type { Settings } from "../lib/types";

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

function Toggle({ name, label, hint }: { name: "ambient" | "autostart" | "localOnly"; label: string; hint: string }) {
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

export function SettingsPage() {
  const glass = useApp((s) => s.glass);
  const systemPrompt = useApp((s) => s.settings.systemPrompt);
  const preview = useApp((s) => s.preview);

  return (
    <div className="page-scroll stack-lg">
      <h1>Settings</h1>

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
        <Toggle name="ambient" label="Ambient breathing" hint="The resting line fades slowly. Off means no idle animation at all." />
        <p className="meta">Glass: {glass ? "native backdrop active" : "tinted fallback"}</p>
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
            placeholder="Sent as the system prompt with every chat"
            onBlur={(e) => void updateSettings({ systemPrompt: e.target.value })}
          />
        </label>
      </section>

      <section className="stack">
        <h2>Privacy</h2>
        <p className="meta">
          This build reads no screen, clipboard, keyboard or window content. The microphone opens only while
          the listening view is on screen, shows a dot while open, and nothing is recorded. Chat text goes
          only to the provider you pick. No telemetry.
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
