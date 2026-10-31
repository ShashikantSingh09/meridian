import { useEffect, useState } from "react";
import { mediaAction, useApp } from "../lib/store";

const clock = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** Playback position, run on locally between reports. Shown only when asked for,
 *  so a playing track costs no repaints while it sits compact in the island. */
export function Progress() {
  const media = useApp((s) => s.media);
  const track = media.current;
  const [now, setNow] = useState(() => Date.now());
  const playing = track?.playing ?? false;

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [playing]);

  if (!track?.durationMs) return null;
  const elapsed = (track.positionMs ?? 0) + (playing ? Math.max(0, now - media.reportedAt) : 0);
  const fraction = Math.min(1, elapsed / track.durationMs);

  return (
    <div className="progress-row">
      <span>{clock(elapsed)}</span>
    <button
      className="progress"
      aria-label="Playback position"
      disabled={!track.canSeek}
      onClick={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        mediaAction({ action: "seek", positionMs: Math.round(((e.clientX - box.left) / box.width) * track.durationMs!) });
      }}
    >
      <span className="progress-track">
        <span className="progress-fill" style={{ display: "block", width: `${fraction * 100}%` }} />
      </span>
    </button>
      <span>{clock(track.durationMs)}</span>
    </div>
  );
}
