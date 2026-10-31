// Who the assistant is. These reach it through the instructions `setup` writes in actions.rs, which
// Claude Code and Codex read in a General chat.

import { faceById } from "../island/faces";
import { Icon } from "../lib/icons";
import { setSettingsSection, updateSettings, useApp } from "../lib/store";
import { SPEAKERS } from "./Voice";

const STYLES = [
  { id: "calm", name: "Calm", note: "Quiet, clear, unhurried", sample: "Your flight leaves at 7:40, from gate 22. You should leave by 5." },
  { id: "cheerful", name: "Cheerful", note: "Warm and upbeat", sample: "Good news, your flight leaves at 7:40 from gate 22! Leave by 5 and you will have plenty of time." },
  { id: "direct", name: "Direct", note: "Short answers, no chat", sample: "7:40, gate 22. Leave by 5." },
  { id: "playful", name: "Playful", note: "Light, with a little humour", sample: "Gate 22 at 7:40. Leave by 5, because the plane will not wait, I asked." },
];

export function AssistantSection() {
  const name = useApp((s) => s.settings.assistantName);
  const you = useApp((s) => s.settings.assistantCallsYou);
  const style = useApp((s) => s.settings.assistantStyle);
  const own = useApp((s) => s.settings.assistantPersonality);
  const provider = useApp((s) => s.settings.voiceProvider);
  const face = useApp((s) => s.settings.face);

  const sample = STYLES.find((s) => s.id === style)?.sample;
  const greeting = you.trim();
  const line = !sample ? "It follows your own words, above." : greeting ? `${greeting}, ${sample[0]!.toLowerCase()}${sample.slice(1)}` : sample;

  // Writing replaces the card. A card picked afterwards joins the words, and `setup` sends both.
  const writeOwn = (text: string) => void updateSettings({ assistantPersonality: text, assistantStyle: text.trim() ? "own" : style === "own" ? "calm" : style });

  return (
    <section className="stack-lg">
      <header className="settings-head">
        <h1>Assistant</h1>
        <p className="meta">Give it a name, and a way of talking.</p>
      </header>
      <div className="stack">
        <label className="setting">
          <span className="stacked grow">
            <span className="label">Its name</span>
            <span className="meta">What it calls itself. Wake words are set on their own page.</span>
          </span>
          <input className="setting-input" aria-label="Its name" placeholder="Meridian" maxLength={40} value={name} onChange={(e) => void updateSettings({ assistantName: e.target.value })} />
        </label>
        <label className="setting">
          <span className="stacked grow">
            <span className="label">What it calls you</span>
            <span className="meta">Leave empty and it uses no name.</span>
          </span>
          <input className="setting-input" aria-label="What it calls you" maxLength={40} value={you} onChange={(e) => void updateSettings({ assistantCallsYou: e.target.value })} />
        </label>
      </div>
      <h2>Personality</h2>
      <div className="persona-grid" role="group" aria-label="Personality">
        {STYLES.map((s) => (
          <button key={s.id} className="persona" aria-pressed={s.id === style} onClick={() => void updateSettings({ assistantStyle: s.id })}>
            <span className="label">{s.name}</span>
            <span className="meta">{s.note}</span>
          </button>
        ))}
      </div>
      <label className="field">
        <span className="label">In your own words</span>
        <textarea rows={2} placeholder="Talks like a friend who knows the code. Keeps it short." value={own} onChange={(e) => writeOwn(e.target.value)} />
      </label>
      <div className="stack card-block">
        <span className="meta">How {name.trim() || "Meridian"} sounds</span>
        <p className="preview-line">{line}</p>
      </div>
      <div className="stack">
        <button className="setting link-row" onClick={() => setSettingsSection("voice")}>
          <span className="label grow">Voice</span>
          <span className="meta">{SPEAKERS.find((s) => s.id === provider)?.name}</span>
          <Icon name="chevron" size={12} />
        </button>
        <button className="setting link-row" onClick={() => setSettingsSection("island")}>
          <span className="label grow">Face</span>
          <span className="meta">{faceById(face)!.name}</span>
          <Icon name="chevron" size={12} />
        </button>
      </div>
      <p className="meta">The name and personality go with each message to Claude Code or Codex in a General chat, as instructions. Coding agents keep their own settings, and API chats use Custom instructions under General.</p>
    </section>
  );
}
