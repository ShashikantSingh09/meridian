import { Icon } from "../lib/icons";
import { Progress } from "../island/Progress";
import { Bars, Transport } from "../island/marks";
import { mediaAction, useApp } from "../lib/store";

export function Media() {
  const media = useApp((s) => s.media);
  const tint = useApp((s) => s.artTint);
  const track = media.current;
  const players = media.sessions.length > 1;

  return (
    <div className="media-page board">
      <section className="media-stage">
        {track?.artwork && tint && <i className="media-glow" style={{ "--art": tint } as React.CSSProperties} aria-hidden="true" />}
        {track ? (
          <>
            {track.artwork ? (
              <img className="artwork media-art" src={track.artwork} alt="" />
            ) : (
              <span className="artwork no-art media-art"><Icon name="music" size={54} /></span>
            )}
            <div className="media-info">
              <div className="row">
                <p className="media-title truncate grow" title={track.title}>{track.title || track.app}</p>
                <Bars playing={track.playing} height={20} />
              </div>
              <p className="meta truncate">{[track.artist, track.album, track.app].filter(Boolean).join(", ")}</p>
              <Progress />
              <Transport track={track} size={26} />
            </div>
          </>
        ) : (
          <>
            <span className="artwork no-art media-art" data-rest="true"><Icon name="music" size={50} /></span>
            <div className="media-rest">
              <p className="media-title">Nothing playing</p>
              <p className="meta">Start something in any music app and it appears here on its own.</p>
            </div>
          </>
        )}
      </section>

      {(players || media.recent.length > 0) && (
        <div className="media-lists">
          {players && (
            <section className="plate media-list">
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
            <section className="plate media-list">
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
      )}
    </div>
  );
}
