import { spring } from "@meridian/design-system/motion";
import { motion } from "motion/react";
import { useRef, useState } from "react";
import { Icon, type IconName } from "../lib/icons";
import {
  captureScreen,
  cropCapture,
  discardCapture,
  setIncludeImage,
  setScreenQuestion,
  shareCapture,
  shareTarget,
  updateSettings,
  useApp,
} from "../lib/store";
import type { Settings } from "../lib/types";
import { Face, type Mood } from "../island/faces";

const QUESTIONS = ["What am I looking at?", "Explain this error", "What should I do next?", "Summarize this"];

const MODES: { value: Settings["screenMode"]; label: string; note: string; icon: IconName }[] = [
  { value: "off", label: "Off", note: "Nothing is ever read", icon: "off" },
  { value: "ondemand", label: "When I ask", note: "Only when you press a button", icon: "eye" },
  { value: "contextual", label: "Watch for errors", note: "Checks the window you are in", icon: "search" },
];

const INTERVALS = [10, 20, 60, 300];

/** Skipped whatever the user sets. The same list the capture code enforces. */
const ALWAYS_SKIPPED = ["Password managers", "Private browsing", "Password and security windows"];

/** Drag across the screenshot to narrow what gets read and shared. */
function Preview({ src }: { src: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  const point = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  return (
    <div
      ref={box}
      className="preview"
      title="Drag to select an area"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = point(e);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const p = point(e);
        const from = start.current;
        setDrag({ x: Math.min(p.x, from.x), y: Math.min(p.y, from.y), w: Math.abs(p.x - from.x), h: Math.abs(p.y - from.y) });
      }}
      onPointerUp={() => {
        start.current = null;
        if (drag && drag.w > 0.02 && drag.h > 0.02) void cropCapture(drag.x, drag.y, drag.w, drag.h);
        setDrag(null);
      }}
    >
      <img src={src} alt="Your screen, not yet shared with anyone" draggable={false} />
      {drag && (
        <div
          className="selection"
          style={{ left: `${drag.x * 100}%`, top: `${drag.y * 100}%`, width: `${drag.w * 100}%`, height: `${drag.h * 100}%` }}
        />
      )}
    </div>
  );
}

function CaptureReview() {
  const capture = useApp((s) => s.screen.capture)!;
  const question = useApp((s) => s.screen.question);
  const includeImage = useApp((s) => s.screen.includeImage);
  // Recomputed when the engine changes.
  useApp((s) => s.agentChat.agent ?? s.chat.providerId);
  const target = shareTarget();
  const sendsImage = includeImage && target.vision;

  return (
    <section className="stack">
      <div className="row">
        <h2 className="grow">{capture.window ? `${capture.window.process}: ${capture.window.title}` : "Selected area"}</h2>
        <span className="meta tabular">{capture.width} × {capture.height}</span>
      </div>
      <Preview src={capture.image} />

      {capture.signals.map((s) => (
        <div key={s.kind} className="signal">
          <p className="label">{s.title}</p>
          <p className="meta">{s.evidence}</p>
        </div>
      ))}

      {capture.text ? <pre className="ocr">{capture.text}</pre> : <p className="meta">No text was found in this capture.</p>}

      <div className="chips">
        {QUESTIONS.map((q) => (
          <button key={q} className="chip" aria-pressed={question === q} onClick={() => setScreenQuestion(q)}>{q}</button>
        ))}
      </div>
      <input aria-label="Question about the screen" placeholder="Ask about this" value={question} onChange={(e) => setScreenQuestion(e.target.value)} />

      <label className="setting toggle">
        <span className="stacked grow">
          <span className="label">Include the screenshot</span>
          <span className="meta">
            {target.vision ? "Otherwise only the text above is shared." : `${target.name} takes text only, so the screenshot stays here.`}
          </span>
        </span>
        <input type="checkbox" role="switch" checked={includeImage && target.vision} disabled={!target.vision} onChange={(e) => setIncludeImage(e.target.checked)} />
      </label>

      <p className="meta" role="status">
        Nothing has left this PC. Share sends your question, {capture.text.length.toLocaleString()} characters of text
        {sendsImage ? " and the screenshot" : ""} to {target.name}{target.local ? ", which runs on this machine" : ""}.
      </p>
      <div className="share-bar">
        <span className="grow" />
        <button className="ghost" onClick={discardCapture}>Discard</button>
        <button className="solid" disabled={!question.trim()} onClick={() => shareCapture(question.trim())}>Share with {target.name}</button>
      </div>
    </section>
  );
}

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

export function Desktop() {
  const face = useApp((s) => s.settings.face);
  const mode = useApp((s) => s.settings.screenMode);
  const paused = useApp((s) => s.settings.monitoringPaused);
  const interval = useApp((s) => s.settings.screenIntervalSecs);
  const screen = useApp((s) => s.screen);
  const contextual = mode === "contextual";
  const watching = contextual && !paused;

  const mood: Mood = mode === "off" ? "asleep" : screen.capturing || watching ? "working" : "rest";
  const headline = mode === "off" ? "Not looking" : watching ? "Watching for errors" : contextual ? "Paused" : "Looking only when you ask";

  return (
    <div className="page-scroll stack-lg aware">
      <header className="aware-hero">
        <span className="aware-stage"><Face id={face} mood={mood} /></span>
        <div className="stacked grow">
          <h2 className="aware-state">{headline}</h2>
          <p className="meta">Reading happens on this PC. Nothing leaves it until you press Share.</p>
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

      {mode !== "off" && !screen.capture && (
        <section className="stack-sm">
          <div className="aware-actions">
            <button className="aware-action" disabled={screen.capturing} onClick={() => void captureScreen("window")}>
              <Icon name="window" size={16} /> Look at this window
            </button>
            <button className="aware-action" disabled={screen.capturing} onClick={() => void captureScreen("screen")}>
              <Icon name="screen" size={16} /> Look at my screen
            </button>
          </div>
          <p className="aware-keys">Or press <kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>S</kbd> anywhere</p>
        </section>
      )}

      {screen.refused && <p className="meta bad" role="alert">{screen.refused}</p>}
      {screen.capture && <CaptureReview />}

      <NeverCapture />
    </div>
  );
}
