import { Icon } from "../lib/icons";
import { Progress } from "../island/Progress";
import { mediaAction, useApp } from "../lib/store";

export function Media() {
  const media = useApp((s) => s.media);
  const track = media.current;

  return (
    <div className="page-scroll stack-lg">
      <h1>Media</h1>

      {track ? (
        <section className="now-playing">
          {track.artwork ? (
            <img className="artwork" src={track.artwork} alt="" style={{ width: 120, height: 120 }} />
          ) : (
            <span className="artwork" style={{ width: 120, height: 120 }}><Icon name="music" size={28} /></span>
          )}
          <div className="grow stack">
            <p className="tile-value truncate" title={track.title}>{track.title || "Unknown title"}</p>
            <p className="meta truncate">{[track.artist, track.album, track.app].filter(Boolean).join(" · ")}</p>
            <Progress />
            <div className="row">
              <button className="round" aria-label="Previous" disabled={!track.canPrevious} onClick={() => mediaAction({ action: "previous" })}>
                <Icon name="previous" size={16} />
              </button>
              <button className="round solid" aria-label={track.playing ? "Pause" : "Play"} disabled={!track.canToggle} onClick={() => mediaAction({ action: "toggle" })}>
                <Icon name={track.playing ? "pause" : "play"} size={16} />
              </button>
              <button className="round" aria-label="Next" disabled={!track.canNext} onClick={() => mediaAction({ action: "next" })}>
                <Icon name="next" size={16} />
              </button>
            </div>
          </div>
        </section>
      ) : (
        <p className="meta">Nothing is playing. Any app that publishes to Windows media controls appears here on its own.</p>
      )}

      {media.sessions.length > 1 && (
        <section className="stack-sm">
          <h2>Active players</h2>
          <ul className="list">
            {media.sessions.map((s) => (
              <li key={s.session}>
                <button className="list-row" data-active={s.session === track?.session} onClick={() => mediaAction({ action: "select", session: s.session })}>
                  <span className="status-dot" data-status={s.playing ? "running" : "idle"} />
                  <span className="label">{s.app}</span>
                  <span className="meta grow truncate">{s.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {media.recent.length > 0 && (
        <section className="stack-sm">
          <h2>Recently played</h2>
          <ul className="list">
            {media.recent.map((t) => (
              <li key={t.title} className="list-row">
                <span className="label truncate">{t.title}</span>
                <span className="meta grow truncate">{t.artist}</span>
                <span className="meta">{t.app}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
