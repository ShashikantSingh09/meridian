// Small moving pieces shared by the island and the panel.

import { useMemo } from "react";
import { mediaAction } from "../lib/store";
import type { MediaAction, Track } from "../lib/types";

/** Our own spark, drawn here. It is not the official Claude logo: that is Anthropic's mark,
 *  and a public release would need their permission to use it. See DECISIONS, D34. */
function Spark({ size }: { size: number }) {
  const rays = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => {
        const angle = (i / 12) * Math.PI * 2;
        const reach = i % 3 === 0 ? 9.4 : i % 3 === 1 ? 7.6 : 8.5;
        return { x: 10 + Math.cos(angle) * reach, y: 10 + Math.sin(angle) * reach, x0: 10 + Math.cos(angle) * 2.2, y0: 10 + Math.sin(angle) * 2.2 };
      }),
    [],
  );
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      {rays.map((r, i) => (
        <line key={i} x1={r.x0} y1={r.y0} x2={r.x} y2={r.y} stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      ))}
    </svg>
  );
}

function Prompt({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 6.5 8.5 10 4 13.5M10.5 14H16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Whichever agent is at work, spinning while it does. */
export function AgentMark({ agent, size = 18, live = true }: { agent: string; size?: number; live?: boolean }) {
  const claude = agent.toLowerCase().includes("claude");
  return (
    <span className="mark" data-agent={claude ? "claude" : "other"} data-live={live}>
      {claude ? <Spark size={size} /> : <Prompt size={size} />}
    </span>
  );
}

/** Music bars. They rest flat when paused, and cost nothing then. */
export function Bars({ playing, count = 5, height = 16 }: { playing: boolean; count?: number; height?: number }) {
  return (
    <span className="bars" data-playing={playing} style={{ height }} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <i key={i} style={{ animationDuration: `${0.5 + ((i * 7) % 5) * 0.09}s`, animationDelay: `${-i * 0.17}s` }} />
      ))}
    </span>
  );
}

const GLYPHS = {
  play: <path d="M7 4.7c0-1.2 1.3-1.9 2.3-1.3l11.6 7.3c.9.6.9 2 0 2.6L9.3 20.6c-1 .6-2.3-.1-2.3-1.3z" />,
  pause: (
    <>
      <rect x="5.4" y="3.6" width="4.9" height="16.8" rx="1.7" />
      <rect x="13.7" y="3.6" width="4.9" height="16.8" rx="1.7" />
    </>
  ),
  next: (
    <>
      <path d="M2.4 6.6c0-1.1 1.2-1.8 2.2-1.2l8 5.4c.8.6.8 1.8 0 2.4l-8 5.4c-1 .6-2.2-.1-2.2-1.2z" />
      <path d="M11.8 6.6c0-1.1 1.2-1.8 2.2-1.2l8 5.4c.8.6.8 1.8 0 2.4l-8 5.4c-1 .6-2.2-.1-2.2-1.2z" />
    </>
  ),
  previous: (
    <g transform="matrix(-1 0 0 1 24 0)">
      <path d="M2.4 6.6c0-1.1 1.2-1.8 2.2-1.2l8 5.4c.8.6.8 1.8 0 2.4l-8 5.4c-1 .6-2.2-.1-2.2-1.2z" />
      <path d="M11.8 6.6c0-1.1 1.2-1.8 2.2-1.2l8 5.4c.8.6.8 1.8 0 2.4l-8 5.4c-1 .6-2.2-.1-2.2-1.2z" />
    </g>
  ),
};

/** Previous, play and next, the same wherever music appears: solid white, with play the largest. */
export function Transport({ track, size = 24 }: { track: Track; size?: number }) {
  const key = (label: string, glyph: keyof typeof GLYPHS, action: MediaAction, disabled: boolean, px: number) => (
    <button className="transport-key" aria-label={label} title={label} disabled={disabled} onClick={() => mediaAction(action)}>
      <svg width={px} height={px} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{GLYPHS[glyph]}</svg>
    </button>
  );
  return (
    <div className="transport">
      {key("Previous", "previous", { action: "previous" }, !track.canPrevious, size)}
      {key(track.playing ? "Pause" : "Play", track.playing ? "pause" : "play", { action: "toggle" }, !track.canToggle, Math.round(size * 1.34))}
      {key("Next", "next", { action: "next" }, !track.canNext, size)}
    </div>
  );
}

const SPARK_COLORS = ["var(--state-success)", "var(--state-notice)", "var(--state-listening)", "#ff8fd0"];

/** A one-shot burst when something finishes. */
export function Sparks() {
  const bits = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => {
        const angle = (i / 12) * Math.PI * 2;
        const reach = 22 + (i % 3) * 12;
        return { dx: Math.round(Math.cos(angle) * reach), dy: Math.round(Math.sin(angle) * reach * 0.8), delay: (i % 4) * 0.02, color: SPARK_COLORS[i % 4] };
      }),
    [],
  );
  return (
    <span className="sparks" aria-hidden="true">
      {bits.map((b, i) => (
        <i key={i} style={{ "--dx": `${b.dx}px`, "--dy": `${b.dy}px`, background: b.color, animationDelay: `${b.delay}s` } as React.CSSProperties} />
      ))}
    </span>
  );
}
