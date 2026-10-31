// Choosing how the panel looks. A theme shows the moment it is picked. One being edited paints the
// whole app as it changes, and is only kept on Save.

import { useEffect, useState } from "react";
import { Icon } from "../lib/icons";
import { getState, updateSettings, useApp } from "../lib/store";
import { activeTheme, applyTheme, THEMES } from "../lib/theme";
import type { CustomTheme, Settings } from "../lib/types";

const ACCENTS = [["#2a84ea", "Blue"], ["#17a2b8", "Teal"], ["#30b35a", "Green"], ["#ff9f0a", "Amber"], ["#e0527c", "Rose"], ["#8e6bff", "Violet"]] as const;
const DARK_WINDOWS = [["#0c0d14", "Ink"], ["#06263a", "Deep sea"], ["#30101f", "Plum"], ["#1b2a20", "Moss"], ["#2c2d30", "Graphite"]] as const;
const LIGHT_WINDOWS = [["#f1f3f7", "Paper"], ["#e3eef5", "Mist"], ["#f6e8ee", "Blush"], ["#e6f0e6", "Sage"], ["#ebebee", "Silver"]] as const;

const USES: [Settings["themeUse"], string][] = [["theme", "This theme"], ["windows", "Follow Windows"], ["time", "By time of day"]];

interface Look {
  id: string;
  name: string;
  note: string;
  top: string;
  low: string;
  accent: string;
  light: boolean;
}

/** A theme being edited. Glass applies to every theme, so it travels beside it and not in it. */
type Draft = CustomTheme & { glass: number };

const looksOf = (custom: CustomTheme[]): Look[] => [...THEMES, ...custom.map((t) => ({ ...t, note: t.light ? "Your light theme" : "Your dark theme", top: t.window, low: t.window }))];
const newThemeId = () => `custom-${Date.now()}`;

/** The panel in small, over a wallpaper, so a theme can be judged before it is chosen. */
function Mini({ look, tall }: { look: Pick<Look, "top" | "low" | "accent" | "light">; tall?: boolean }) {
  return (
    <span className="mini" data-light={look.light} data-tall={tall} aria-hidden="true" style={{ "--top": look.top, "--low": look.low, "--dot": look.accent } as React.CSSProperties}>
      <span className="mini-sheet"><i /><i /><i /><i /></span>
    </span>
  );
}

function Segmented<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: readonly (readonly [T, string])[]; onPick: (value: T) => void }) {
  return (
    <div className="setting">
      <span className="label">{label}</span>
      <div className="segmented" role="group" aria-label={label}>
        {options.map(([id, name]) => (
          <button key={id} aria-pressed={id === value} onClick={() => onPick(id)}>{name}</button>
        ))}
      </div>
    </div>
  );
}

function Glass({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <div className="slider">
      <span className="meta">Clear</span>
      <input type="range" aria-label="Glass" min={0} max={100} value={value} style={{ "--at": `${value}%` } as React.CSSProperties} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="meta">Tinted</span>
    </div>
  );
}

function ThemePick({ label, value, looks, onPick }: { label: string; value: string; looks: Look[]; onPick: (id: string) => void }) {
  return (
    <label className="setting">
      <span className="label">{label}</span>
      <span className="picker" data-plain="true">
        <select aria-label={label} value={value} onChange={(e) => onPick(e.target.value)}>
          {looks.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
        <Icon name="chevron" size={12} />
      </span>
    </label>
  );
}

function Swatches({ label, value, options, onPick }: { label: string; value: string; options: readonly (readonly [string, string])[]; onPick: (colour: string) => void }) {
  // A theme copied from a built-in one can hold a colour the swatches do not.
  const all = options.some(([colour]) => colour === value) ? options : [[value, "Current colour"] as const, ...options];
  return (
    <div className="stack card-block">
      <span className="label">{label}</span>
      <div className="swatches" role="group" aria-label={label}>
        {all.map(([colour, name]) => (
          <button key={colour} className="swatch" aria-label={name} title={name} aria-pressed={colour === value} style={{ background: colour }} onClick={() => onPick(colour)} />
        ))}
      </div>
    </div>
  );
}

/** Takes a custom theme out of everything that points at it, so nothing is left showing a theme that is gone. */
function deleteTheme(id: string) {
  const s = getState().settings;
  const instead = (chosen: string, fallback: string) => (chosen === id ? fallback : chosen);
  void updateSettings({
    customThemes: s.customThemes.filter((t) => t.id !== id),
    theme: instead(s.theme, "midnight"),
    themeDark: instead(s.themeDark, "midnight"),
    themeLight: instead(s.themeLight, "daylight"),
  });
}

function Editor({ start, onClose }: { start: Draft; onClose: () => void }) {
  const settings = useApp((s) => s.settings);
  const [draft, setDraft] = useState(start);
  const saved = settings.customThemes.some((t) => t.id === draft.id);
  const change = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const windows = draft.light ? LIGHT_WINDOWS : DARK_WINDOWS;

  useEffect(() => {
    applyTheme({ ...settings, theme: draft.id, themeUse: "theme", glass: draft.glass, customThemes: [...settings.customThemes.filter((t) => t.id !== draft.id), draft] });
  }, [draft, settings]);
  // Leaving by any way at all puts back whatever is really saved.
  useEffect(() => () => applyTheme(getState().settings), []);

  /** The window colours are per base, so a light theme never keeps a dark window. */
  const setBase = (base: "dark" | "light") => {
    const light = base === "light";
    const place = windows.findIndex(([colour]) => colour === draft.window);
    change({ light, window: (light ? LIGHT_WINDOWS : DARK_WINDOWS)[Math.max(place, 0)]![0] });
  };

  const save = () => {
    const { glass, ...theme } = { ...draft, name: draft.name.trim() || "My theme" };
    const customThemes = saved ? settings.customThemes.map((t) => (t.id === theme.id ? theme : t)) : [...settings.customThemes, theme];
    void updateSettings({ customThemes, glass, ...(saved ? {} : { theme: theme.id, themeUse: "theme" as const }) });
    onClose();
  };

  return (
    <section className="stack-lg">
      <header className="row theme-edit-head">
        <button className="round" aria-label="Back to themes" title="Back to themes" onClick={onClose}><span className="flip"><Icon name="chevron" size={14} /></span></button>
        <h1 className="grow">{saved ? "Edit theme" : "New theme"}</h1>
        {saved && <button className="ghost" onClick={() => change({ id: newThemeId(), name: `${draft.name} copy` })}>Duplicate</button>}
        {saved && <button className="ghost" onClick={() => { deleteTheme(draft.id); onClose(); }}>Delete</button>}
        <button className="solid" onClick={save}>Save</button>
      </header>
      <div className="theme-edit">
        <div className="stack-lg">
          <div className="stack">
            <label className="setting">
              <span className="label">Name</span>
              <input className="setting-input" aria-label="Theme name" maxLength={30} value={draft.name} onChange={(e) => change({ name: e.target.value })} />
            </label>
            <Segmented label="Base" value={draft.light ? "light" : "dark"} options={[["dark", "Dark"], ["light", "Light"]]} onPick={setBase} />
          </div>
          <Swatches label="Accent" value={draft.accent} options={ACCENTS} onPick={(accent) => change({ accent })} />
          <Swatches label="Window colour" value={draft.window} options={windows} onPick={(window) => change({ window })} />
          <div className="stack card-block">
            <span className="label">Glass</span>
            <Glass value={draft.glass} onChange={(glass) => change({ glass })} />
          </div>
        </div>
        <aside className="stack-sm theme-preview">
          <h2>Preview</h2>
          <Mini tall look={{ top: draft.window, low: draft.window, accent: draft.accent, light: draft.light }} />
          <p className="meta">Changes show on the whole app as you make them. Nothing is kept until you press Save.</p>
        </aside>
      </div>
    </section>
  );
}

export function ThemesSection() {
  const settings = useApp((s) => s.settings);
  const [editing, setEditing] = useState<Draft | null>(null);
  const looks = looksOf(settings.customThemes);
  // ponytail: read on render, so if Windows flips while this page is open the tick waits for the next render.
  const id = activeTheme(settings, matchMedia("(prefers-color-scheme: dark)").matches, new Date().getHours());
  const shown = looks.find((l) => l.id === id) ?? looks[0]!;
  const own = settings.customThemes.find((t) => t.id === shown.id);
  const timed = settings.themeUse === "time";
  const { glass } = settings;

  if (editing) return <Editor start={editing} onClose={() => setEditing(null)} />;

  return (
    <section className="stack-lg">
      <header className="settings-head">
        <h1>Themes</h1>
        <p className="meta">Pick one, change it, or make your own.</p>
      </header>
      <div className="theme-grid">
        {looks.map((look) => (
          <button key={look.id} className="theme-card" aria-pressed={look.id === shown.id} style={{ "--dot": look.accent } as React.CSSProperties} onClick={() => void updateSettings({ theme: look.id, themeUse: "theme" })}>
            <Mini look={look} />
            <span className="theme-card-name">
              <span className="stacked grow">
                <span className="label truncate">{look.name}</span>
                <span className="meta truncate">{look.note}</span>
              </span>
              {look.id === shown.id && <Icon name="check" size={14} />}
            </span>
          </button>
        ))}
      </div>
      <div className="row theme-actions">
        <button className="solid" onClick={() => setEditing({ id: newThemeId(), name: "New theme", light: false, accent: ACCENTS[0][0], window: DARK_WINDOWS[0][0], glass })}>New theme</button>
        <button className="ghost" onClick={() => setEditing(own ? { ...own, glass } : { id: newThemeId(), name: `My ${shown.name}`, light: shown.light, accent: shown.accent, window: shown.low, glass })}>Edit {shown.name}</button>
        {own && <button className="ghost" onClick={() => deleteTheme(own.id)}>Delete {own.name}</button>}
      </div>
      <div className="stack">
        <Segmented label="Use" value={settings.themeUse} options={USES} onPick={(themeUse) => void updateSettings({ themeUse })} />
        {settings.themeUse !== "theme" && (
          <>
            <ThemePick label={timed ? "At night" : "When Windows is dark"} value={settings.themeDark} looks={looks} onPick={(themeDark) => void updateSettings({ themeDark })} />
            <ThemePick label={timed ? "By day" : "When Windows is light"} value={settings.themeLight} looks={looks} onPick={(themeLight) => void updateSettings({ themeLight })} />
          </>
        )}
      </div>
      <div className="stack card-block">
        <span className="label">Glass</span>
        <Glass value={glass} onChange={(value) => void updateSettings({ glass: value })} />
        <p className="meta">If transparency effects are off in Windows, every theme goes solid.</p>
      </div>
    </section>
  );
}
