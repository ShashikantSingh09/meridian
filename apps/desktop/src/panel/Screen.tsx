// How much the app may see of the screen. Looking itself happens in Chat.

import { spring } from "@meridian/design-system/motion";
import { motion } from "motion/react";
import { useState } from "react";
import { Face, type Mood } from "../island/faces";
import { Icon, type IconName } from "../lib/icons";
import { updateSettings, useApp } from "../lib/store";
import type { Settings } from "../lib/types";

const MODES: { value: Settings["screenMode"]; label: string; note: string; icon: IconName }[] = [
  { value: "off", label: "Off", note: "Nothing is ever read", icon: "off" },
  { value: "ondemand", label: "When I ask", note: "Only when you press Look", icon: "eye" },
  { value: "contextual", label: "Watch for errors", note: "Checks the window you are in", icon: "search" },
];

const INTERVALS = [10, 20, 60, 300];

/** Skipped whatever the user sets. The same list the capture code enforces. */
const ALWAYS_SKIPPED = ["Password managers", "Private browsing", "Password and security windows"];

/** What is never captured, as chips. Enter adds one. */
function NeverCapture() {
  const exclusions = useApp((s) => s.settings.screenExclusions);
  const [text, setText] = useState("");
  const save = (list: string[]) => void updateSettings({ screenExclusions: list });

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const entry = text.trim();
    if (entry && !exclusions.includes(entry)) save([...exclusions, entry]);
    setText("");
  };

  return (
    <section className="stack-sm">
      <h2>Never capture</h2>
      <div className="tags">
        {ALWAYS_SKIPPED.map((name) => (
          <span key={name} className="tag-chip" data-fixed="true" title="Always skipped">
            <Icon name="lock" size={12} /> {name}
          </span>
        ))}
        {exclusions.map((name) => (
          <span key={name} className="tag-chip">
            {name}
            <button aria-label={`Allow ${name} again`} onClick={() => save(exclusions.filter((x) => x !== name))}>
              <Icon name="close" size={11} />
            </button>
          </span>
        ))}
        <form onSubmit={add}>
          <input className="tag-add" aria-label="Add an app or window to skip" placeholder="Add an app or window" value={text} onChange={(e) => setText(e.target.value)} />
        </form>
      </div>
    </section>
  );
}

export function ScreenSection() {
  const face = useApp((s) => s.settings.face);
  const mode = useApp((s) => s.settings.screenMode);
  const paused = useApp((s) => s.settings.monitoringPaused);
  const interval = useApp((s) => s.settings.screenIntervalSecs);
  const contextual = mode === "contextual";
  const watching = contextual && !paused;

  const mood: Mood = mode === "off" ? "asleep" : watching ? "working" : "rest";
  const headline = mode === "off" ? "Not looking" : watching ? "Watching for errors" : contextual ? "Paused" : "Looking only when you ask";

  return (
    <div className="stack-lg aware">
      <header className="aware-hero">
        <span className="aware-stage"><Face id={face} mood={mood} /></span>
        <div className="stacked grow">
          <h2 className="aware-state">{headline}</h2>
          <p className="meta">Reading happens on this PC. Nothing leaves it until you send a message.</p>
        </div>
      </header>

      <div className="aware-modes" role="group" aria-label="Screen awareness mode">
        {MODES.map((m) => (
          <button key={m.value} className="aware-mode" aria-pressed={mode === m.value} onClick={() => void updateSettings({ screenMode: m.value })}>
            {mode === m.value && <motion.span layoutId="aware-pill" className="aware-pill" transition={spring.hover} />}
            <Icon name={m.icon} size={16} />
            <span className="aware-mode-name">{m.label}</span>
            <span className="meta">{m.note}</span>
          </button>
        ))}
      </div>

      {contextual && (
        <section className="aware-watch">
          <label className="row grow toggle">
            <span className="label grow">Pause</span>
            <input type="checkbox" role="switch" aria-label="Pause monitoring" checked={paused} onChange={(e) => void updateSettings({ monitoringPaused: e.target.checked })} />
          </label>
          <span className="meta">Check every</span>
          <div className="segmented" role="group" aria-label="Check every">
            {INTERVALS.map((s) => (
              <button key={s} aria-pressed={interval === s} onClick={() => void updateSettings({ screenIntervalSecs: s })}>{s < 60 ? `${s}s` : `${s / 60}m`}</button>
            ))}
          </div>
        </section>
      )}

      {mode !== "off" && <p className="aware-keys">Press <kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>S</kbd> anywhere, or the eye in Chat</p>}

      <NeverCapture />
    </div>
  );
}
