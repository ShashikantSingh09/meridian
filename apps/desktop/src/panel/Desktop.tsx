import { useRef, useState } from "react";
import { Icon } from "../lib/icons";
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

const QUESTIONS = ["What am I looking at?", "Explain this error", "What should I do next?", "Summarize this"];

const MODES: { value: Settings["screenMode"]; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "ondemand", label: "On demand" },
  { value: "contextual", label: "Contextual" },
];

const INTERVALS = [10, 20, 60, 300];

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
      <div className="row end">
        <button className="ghost" onClick={discardCapture}>Discard</button>
        <button className="solid" disabled={!question.trim()} onClick={() => shareCapture(question.trim())}>Share with {target.name}</button>
      </div>
    </section>
  );
}

export function Desktop() {
  const mode = useApp((s) => s.settings.screenMode);
  const paused = useApp((s) => s.settings.monitoringPaused);
  const interval = useApp((s) => s.settings.screenIntervalSecs);
  const exclusions = useApp((s) => s.settings.screenExclusions);
  const screen = useApp((s) => s.screen);
  const contextual = mode === "contextual";

  return (
    <div className="page-scroll stack-lg">
      <header className="stack-sm">
        <p className="meta">
          {mode === "off"
            ? "Off. Nothing on your screen is read."
            : contextual && !paused
              ? "Watching the active window for visible errors. Reading happens on this PC, and nothing is sent unless you choose to share it."
              : "Your screen is read only when you ask."}
        </p>
      </header>

      <div className="segmented" role="group" aria-label="Screen awareness mode">
        {MODES.map((m) => (
          <button key={m.value} aria-pressed={mode === m.value} onClick={() => void updateSettings({ screenMode: m.value })}>{m.label}</button>
        ))}
      </div>

      {contextual && (
        <section className="stack">
          <label className="setting toggle">
            <span className="stacked grow">
              <span className="label">Pause monitoring</span>
              <span className="meta">Stops at once, and stays stopped until you turn it back on.</span>
            </span>
            <input type="checkbox" role="switch" checked={paused} onChange={(e) => void updateSettings({ monitoringPaused: e.target.checked })} />
          </label>
          <label className="setting">
            <span className="label">Check every</span>
            <select value={interval} onChange={(e) => void updateSettings({ screenIntervalSecs: Number(e.target.value) })}>
              {INTERVALS.map((s) => (
                <option key={s} value={s}>{s < 60 ? `${s} seconds` : `${s / 60} minutes`}</option>
              ))}
            </select>
          </label>
        </section>
      )}

      {mode !== "off" && (
        <div className="row">
          <button className="ghost" disabled={screen.capturing} onClick={() => void captureScreen("window")}>
            <Icon name="eye" size={14} /> Active window
          </button>
          <button className="ghost" disabled={screen.capturing} onClick={() => void captureScreen("screen")}>Whole screen</button>
          <span className="meta grow">Or press Ctrl Alt S anywhere.</span>
        </div>
      )}

      {screen.refused && <p className="meta bad" role="alert">{screen.refused}</p>}
      {screen.capture && <CaptureReview />}

      <section className="stack">
        <h2>Never capture</h2>
        <p className="meta">
          Password managers, private browsing and sign-in windows are always skipped. Add your own, one per line, matched
          against the app name and window title.
        </p>
        <textarea
          aria-label="Excluded apps and windows"
          rows={3}
          defaultValue={exclusions.join("\n")}
          placeholder={"banking\nsalary.xlsx"}
          onBlur={(e) => void updateSettings({ screenExclusions: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean) })}
        />
      </section>
    </div>
  );
}
