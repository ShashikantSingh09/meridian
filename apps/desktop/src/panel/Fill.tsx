// Settings › Fill in the page: Write here, Fill this form and Finish this for me. Only kept for now;
// the fill engine reads them. Rows under a switch that is off are dimmed and cannot be used.

import { Brand } from "../lib/brands";
import { Icon } from "../lib/icons";
import { isReady, setSettingsSection, updateSettings, useApp } from "../lib/store";
import type { FillPlace, FillSettings } from "../lib/types";
import { Menu } from "./Menu";

/** `off` holds it off, as local-only mode does. `inert` dims it under a switch that is off. */
function Switch({ label, hint, on, set, off, inert }: { label: React.ReactNode; hint: string; on: boolean; set: (on: boolean) => void; off?: boolean; inert?: boolean }) {
  return (
    <label className="setting toggle" inert={inert}>
      <span className="stacked grow">
        <span className="label">{label}</span>
        <span className="meta">{hint}</span>
      </span>
      <input type="checkbox" role="switch" checked={on && !off} disabled={off} onChange={(e) => set(e.target.checked)} />
    </label>
  );
}

const PLACE_STATES: { value: FillPlace["fill"]; label: string }[] = [
  { value: "allowed", label: "Allowed" },
  { value: "ask", label: "Asks every time" },
  { value: "never", label: "Never" },
];

const SOURCES: { key: keyof FillSettings["sources"]; label: string; hint: string }[] = [
  { key: "details", label: "Your details", hint: "Put in by Meridian. Never sent to the AI." },
  { key: "knowledge", label: "Knowledge pages", hint: "Only the lines that match the form." },
  { key: "mail", label: "Gmail and Calendar, when you ask", hint: "Through your Claude account. Marked from mail." },
  { key: "notes", label: "Call notes", hint: "When you name the call." },
  { key: "files", label: "Files you name", hint: "Like “use my CV”. Read on this PC." },
  { key: "clipboard", label: "Clipboard, when you say so", hint: "Never read unless you say “from my clipboard”." },
  { key: "picture", label: "A picture of the window", hint: "Off: Write here reads the window's text only." },
];

const LOCAL_ONLY = "Off while local-only mode is on.";

/** A web address shows under its name, the way Gmail shows mail.google.com. A program's name does not. */
const isSite = (place: FillPlace) => place.id.includes(".") && !/\.exe$/i.test(place.id) && place.id !== place.name;

export function FillSection() {
  const fill = useApp((s) => s.settings.fill);
  const localOnly = useApp((s) => s.settings.localOnly);
  const agents = useApp((s) => s.agents);
  const providers = useApp((s) => s.providers);
  const localOnline = useApp((s) => s.localOnline);
  const change = (patch: Partial<FillSettings>) => void updateSettings({ fill: { ...fill, ...patch } });
  const changePlace = (id: string, patch: Partial<FillPlace>) => change({ places: fill.places.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  const finishing = fill.finish && !localOnly;

  const engines = [...agents.filter((a) => a.installed), ...providers.filter((p) => isReady(p, localOnline))];
  const usual = fill.places.filter((p) => !p.alwaysAsk);
  const banks = fill.places.filter((p) => p.alwaysAsk);

  const place = (p: FillPlace) => (
    <div className="setting fill-place" key={p.id}>
      <Brand id={p.name.toLowerCase()} name={p.name} size={22} />
      <span className="stacked grow">
        <span className="label">{p.name}</span>
        {isSite(p) && <span className="meta">{p.id}</span>}
      </span>
      {finishing && p.fill === "allowed" && !p.alwaysAsk && (
        <button className="chip fill-finish" aria-pressed={p.finish} onClick={() => changePlace(p.id, { finish: !p.finish })}>Finish too</button>
      )}
      <Menu
        label={`Filling in ${p.name}`}
        value={p.fill === "allowed" && p.alwaysAsk ? "ask" : p.fill}
        items={PLACE_STATES.filter((s) => !(p.alwaysAsk && s.value === "allowed"))}
        empty="Asks every time"
        onPick={(value) => changePlace(p.id, { fill: value as FillPlace["fill"], finish: value === "allowed" && p.finish })}
      />
      <button className="ghost wake-remove" aria-label={`Forget ${p.name}`} title="Forget, so it asks again" onClick={() => change({ places: fill.places.filter((x) => x.id !== p.id) })}>
        <Icon name="close" size={13} />
      </button>
    </div>
  );

  return (
    <section className="stack-lg">
      <header className="settings-head">
        <h1>Fill in the page</h1>
        <p className="meta">Settings for Write here, Fill this form and Finish this for me.</p>
      </header>

      <div className="stack">
        <Switch label="Write here and Fill this form" hint="Write into the box you are in, or fill the form in front of you." on={fill.on} set={(on) => change({ on })} />
        <div className="setting" inert={!fill.on}>
          <span className="label grow">Key</span>
          <div className="segmented" role="group" aria-label="Key">
            <button aria-pressed={fill.key === "ctrl-alt-f"} onClick={() => change({ key: "ctrl-alt-f" })}>Ctrl Alt F</button>
            <button aria-pressed={fill.key === "off"} onClick={() => change({ key: "off" })}>Off</button>
          </div>
        </div>
        <Switch label="Buttons on the island" hint="Write here or Fill this form, when you point at it." on={fill.buttons} inert={!fill.on} set={(buttons) => change({ buttons })} />
        <div className="setting" inert={!fill.on}>
          <span className="stacked grow">
            <span className="label">AI that writes and fills</span>
            <span className="meta">{localOnly ? "Local-only mode is on, so the AI on this PC is used." : "Decides what goes where. Never sees Your details."}</span>
          </span>
          <Menu label="AI that writes and fills" value={fill.ai} items={engines.map((e) => ({ value: e.id, label: e.name, icon: <Brand id={e.id} name={e.name} size={15} /> }))} empty="Choose an AI" onPick={(ai) => change({ ai })} />
        </div>
      </div>

      <div className="stack">
        <Switch
          label={<>Finish this for me <span className="fill-experimental">Experimental</span></>}
          hint={localOnly ? `${LOCAL_ONLY} It needs an online AI.` : "Clicks and types in your apps. Asks before submit, send, pay, upload, delete or another site."}
          on={fill.finish}
          off={localOnly}
          set={(finish) => change({ finish })}
        />
        <div className="setting" inert={!finishing}>
          <span className="label grow">AI for Finish this for me</span>
          <Menu label="AI for Finish this for me" value={fill.finishAi} items={[{ value: "claude-code", label: "Claude, through Claude Code" }]} empty="Claude, through Claude Code" onPick={(finishAi) => change({ finishAi })} />
        </div>
      </div>
      <p className="meta">Off until you turn them on. Finish this for me stays off on its own switch, and starts only by voice or from the island. It runs on your Claude plan.</p>

      <h2>Apps and sites</h2>
      <div className="stack fill-places">
        {usual.map(place)}
        {usual.length === 0 && <p className="meta fill-none">None yet. A new app or site asks the first time: Once, Always or Never.</p>}
        <p className="fill-group">Banks, tax and government · always ask</p>
        {banks.map(place)}
        {banks.length === 0 && <p className="meta fill-none">They ask every time you fill in one, and show here.</p>}
        <p className="fill-group">Never, and can't be changed</p>
        <p className="fill-never">Terminals, Windows Settings, Windows Security, password managers, private browser windows and Meridian itself.</p>
      </div>
      <p className="meta">Finish this for me needs its own yes per app.</p>

      <h2>Where values come from</h2>
      <div className="stack">
        {SOURCES.map((s) => (
          <Switch
            key={s.key}
            label={s.label}
            hint={s.key === "mail" && localOnly ? LOCAL_ONLY : s.hint}
            on={fill.sources[s.key]}
            off={s.key === "mail" && localOnly}
            set={(on) => change({ sources: { ...fill.sources, [s.key]: on } })}
          />
        ))}
      </div>
      <p className="meta">The page itself and what you just said are always used. Every filled box shows which of these it came from.</p>
      <div className="stack">
        <button className="setting link-row" onClick={() => setSettingsSection("details")}>
          <span className="label grow">Your details</span>
          <span className="meta">Name, contact, address and work</span>
          <Icon name="chevron" size={12} />
        </button>
      </div>
    </section>
  );
}
