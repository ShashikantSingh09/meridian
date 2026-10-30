// Looking at the screen happens in Chat, because the point of looking is to ask about it. What was
// seen sits in a pill above the conversation. Nothing has left this PC until a message is sent, and
// the pill can be opened to see exactly what would go.

import { useRef, useState } from "react";
import { Icon, type IconName } from "../lib/icons";
import { captureScreen, cropCapture, discardCapture, setIncludeImage, shareCapture, shareTarget, useApp } from "../lib/store";

const CHIPS: { label: string; prompt: string; icon: IconName; tone: string }[] = [
  { label: "Explain", prompt: "Explain what this shows.", icon: "bulb", tone: "#0a84ff" },
  { label: "Summarize", prompt: "Summarize this.", icon: "lines", tone: "#bf5af2" },
  { label: "Translate", prompt: "Translate this into English.", icon: "globe", tone: "#00c7d9" },
  { label: "Check spelling", prompt: "Check the spelling here and list any mistakes.", icon: "check", tone: "#30d158" },
];

const appName = (process: string) => process.replace(/\.exe$/i, "");

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

/** Exactly what would be shared, and the means to narrow it. */
function LookSheet() {
  const capture = useApp((s) => s.screen.capture)!;
  const includeImage = useApp((s) => s.screen.includeImage);
  // Recomputed when the engine changes.
  useApp((s) => s.agentChat.agent ?? s.chat.providerId);
  const target = shareTarget();
  const sendsImage = includeImage && target.vision;

  return (
    <section className="look-sheet stack-sm">
      <Preview src={capture.image} />
      {capture.signals.map((s) => (
        <div key={s.kind} className="signal">
          <p className="label">{s.title}</p>
          <p className="meta">{s.evidence}</p>
        </div>
      ))}
      {capture.text ? <pre className="ocr">{capture.text}</pre> : <p className="meta">No text was found in this capture.</p>}
      <label className="setting toggle">
        <span className="stacked grow">
          <span className="label">Include the screenshot</span>
          <span className="meta">{target.vision ? "Otherwise only the text above is shared." : `${target.name} takes text only, so the screenshot stays here.`}</span>
        </span>
        <input type="checkbox" role="switch" checked={sendsImage} disabled={!target.vision} onChange={(e) => setIncludeImage(e.target.checked)} />
      </label>
      <p className="meta" role="status">
        Nothing has left this PC. Sending shares your question, {capture.text.length.toLocaleString()} characters of text
        {sendsImage ? " and the screenshot" : ""} with {target.name}{target.local ? ", which runs on this machine" : ""}.
      </p>
    </section>
  );
}

/** What was looked at, above the conversation. */
export function LookPill() {
  const capture = useApp((s) => s.screen.capture);
  const refused = useApp((s) => s.screen.refused);
  const [open, setOpen] = useState(false);
  useApp((s) => s.agentChat.agent ?? s.chat.providerId);

  if (!capture) return refused ? <p className="meta bad look-refused" role="alert">{refused}</p> : null;
  return (
    <div className="look">
      <div className="row">
        <div className="look-pill">
          <i className="look-dot" />
          <button className="look-thumb" aria-label="See what would be shared" aria-expanded={open} onClick={() => setOpen(!open)}>
            <img src={capture.image} alt="" />
          </button>
          <span className="truncate">{capture.window ? appName(capture.window.process) : "Selected area"}</span>
          <button className="look-forget" aria-label="Forget this" onClick={discardCapture}><Icon name="close" size={11} /></button>
        </div>
        <span className="meta truncate">Goes to {shareTarget().name} with your next message</span>
      </div>
      {open && <LookSheet />}
    </div>
  );
}

/** The start of a chat: what the app can do from here, one click away. */
export function LookChips() {
  const capture = useApp((s) => s.screen.capture);
  const mode = useApp((s) => s.settings.screenMode);
  const capturing = useApp((s) => s.screen.capturing);

  if (capture) {
    return (
      <div className="chat-chips">
        {CHIPS.map((chip) => (
          <button key={chip.label} className="chat-chip" style={{ "--tone": chip.tone } as React.CSSProperties} onClick={() => shareCapture(chip.prompt)}>
            <Icon name={chip.icon} size={14} /> {chip.label}
          </button>
        ))}
      </div>
    );
  }
  if (mode === "off") return null;
  return (
    <div className="chat-chips">
      <button className="chat-chip" style={{ "--tone": "#0a84ff" } as React.CSSProperties} disabled={capturing} onClick={() => void captureScreen("window")}>
        <Icon name="window" size={14} /> This window
      </button>
      <button className="chat-chip" style={{ "--tone": "#30d158" } as React.CSSProperties} disabled={capturing} onClick={() => void captureScreen("screen")}>
        <Icon name="screen" size={14} /> Whole screen
      </button>
    </div>
  );
}

/** The greeting, which changes once there is something to talk about. */
export function lookGreeting(hello: string, note: string, seen: string | null, off: boolean) {
  if (seen) return { hello: `I see ${seen}. What do you want to know?`, note: "Pick one, or type your question." };
  return { hello, note: off ? note : `${note} Or let me look at your screen.` };
}

export const seenName = (process: string | undefined) => (process ? appName(process) : null);

/** The eye in the message box: look at the window you came from. */
export function LookButton() {
  const mode = useApp((s) => s.settings.screenMode);
  const capturing = useApp((s) => s.screen.capturing);
  if (mode === "off") return null;
  return (
    <button type="button" className="round" aria-label="Look" title="Look at the window you came from. Or press Ctrl Alt S anywhere." disabled={capturing} onClick={() => void captureScreen("window")}>
      <Icon name="eye" size={15} />
    </button>
  );
}
