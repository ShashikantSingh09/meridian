import { Icon } from "../lib/icons";
import { Progress } from "../island/Progress";
import { Bars, Transport } from "../island/marks";
import { mediaAction, useApp } from "../lib/store";

export function Media() {
  const media = useApp((s) => s.media);
  const track = media.current;

  return (
    <div className="page-scroll stack-lg">
      {track ? (
        <section className="now-playing">
          {track.artwork ? (
            <img className="artwork" src={track.artwork} alt="" style={{ width: 120, height: 120 }} />
          ) : (
            <span className="artwork" style={{ width: 120, height: 120 }}><Icon name="music" size={28} /></span>
          )}
          <div className="grow stack">
            <div className="row">
              <p className="tile-value truncate grow" title={track.title}>{track.title || track.app}</p>
              <Bars playing={track.playing} height={24} />
            </div>
            <p className="meta truncate">{[track.artist, track.album, track.app].filter(Boolean).join(" · ")}</p>
            <Progress />
            <Transport track={track} size={26} />
          </div>
        </section>
      ) : (
        <p className="meta">Nothing is playing. Start something in any music app and it appears here on its own.</p>
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
                  <span className="meta grow truncate">{s.title || (s.playing ? "Playing" : "Paused")}</span>
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
