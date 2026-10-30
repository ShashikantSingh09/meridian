// What sits inside the island for each compact state. The face leads in every one of
// them; text only says what the face cannot.

import { useEffect, useMemo, useState } from "react";
import { Icon } from "../lib/icons";
import {
  answerApproval,
  assist,
  cancelSession,
  describeTime,
  dismissError,
  dismissNotice,
  dismissReminder,
  ignoreSuggestion,
  mediaAction,
  openLink,
  openPanel,
  setListening,
  setMediaOpen,
  snoozeReminder,
  useApp,
} from "../lib/store";
import { Face, type Mood } from "./faces";
import type { LineSegment } from "./line";
import { focusActivity } from "./live";
import { activeSessions, MULTITASK_MAX_ROWS, waitingApproval } from "./machine";
import { AgentMark, Bars, Sparks } from "./marks";
import { MeridianLine } from "./MeridianLine";
import { Progress } from "./Progress";
import { useMicLevel } from "./useMicLevel";

/** After this long with nothing to do and no pointer, the face falls asleep. */
const SLEEP_AFTER_MS = 10 * 60_000;

export const greetingWord = () => {
  const hour = new Date().getHours();
  return hour < 5 ? "Hello" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
};

function Mine({ mood, scale = 0.62, reduced }: { mood: Mood; scale?: number; reduced: boolean }) {
  const id = useApp((s) => s.settings.face);
  return <Face id={id} mood={mood} scale={scale} reduced={reduced} />;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return <span className="tabular">{`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}</span>;
}

const iconButton = (label: string, icon: Parameters<typeof Icon>[0]["name"], onClick: () => void, disabled = false) => (
  <button className="round" aria-label={label} title={label} onClick={onClick} disabled={disabled}>
    <Icon name={icon} size={14} />
  </button>
);

export function Clock({ className = "rest-time tabular" }: { className?: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Aligned to the minute, so the only repaint is the one that changes the digits.
    const timer = setTimeout(() => setNow(new Date()), 60_000 - (Date.now() % 60_000));
    return () => clearTimeout(timer);
  }, [now]);
  return <span className={className}>{now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>;
}

function Peek() {
  const next = useApp((s) => (s.settings.showNextMeeting ? s.activity.next : null));
  const sessions = useApp((s) => s.sessions);
  const active = activeSessions(sessions);
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  return (
    <div className="peek-card">
      <div className="row">
        <span className="peek-face"><Mine mood="rest" scale={0.86} reduced={false} /></span>
        <div className="grow stacked">
          <span className="peek-title">{greetingWord()}</span>
          <span className="meta">{today}</span>
        </div>
        <Clock className="peek-time tabular" />
      </div>
      <div className="peek-chips">
        <div className="peek-chip" data-tone="next">
          <span className="peek-chip-head">{next ? "Next" : "Nothing next"}</span>
          <span className="peek-chip-body truncate">{next ? `${next.title}${next.startsAt ? `, ${describeTime(next.startsAt)}` : ""}` : "Your day is clear"}</span>
        </div>
        <div className="peek-chip" data-tone="agents">
          <span className="peek-chip-head">{active.length === 0 ? "No agents running" : `${active.length} ${active.length === 1 ? "agent" : "agents"} running`}</span>
          <span className="peek-chip-body truncate">{active.length === 0 ? "Click to open" : active.map((s) => s.project).join(", ")}</span>
        </div>
      </div>
    </div>
  );
}

export function IdleView({ reduced, hovered, sliver }: { reduced: boolean; hovered: boolean; sliver: boolean }) {
  const clock = useApp((s) => s.settings.showClock);
  const greeting = useApp((s) => s.greeting);
  const [asleep, setAsleep] = useState(false);

  useEffect(() => {
    setAsleep(false);
    const timer = setTimeout(() => setAsleep(true), SLEEP_AFTER_MS);
    return () => clearTimeout(timer);
  }, [hovered]);

  if (greeting) {
    return (
      <div className="rest">
        <Mine mood="done" reduced={reduced} />
        <span className="greeting">{greetingWord()}</span>
      </div>
    );
  }
  if (sliver && !hovered) return null;
  if (hovered) return <Peek />;
  return (
    <div className="rest">
      <Mine mood={asleep ? "asleep" : "rest"} reduced={reduced} />
      {clock && <Clock />}
    </div>
  );
}

export function ListeningView({ reduced }: { reduced: boolean }) {
  const preview = useApp((s) => s.preview);
  const level = useMicLevel(preview === null);
  const segments = useMemo<LineSegment[]>(() => [{ mode: "listen", color: "--state-listening" }], []);
  return (
    <div className="row pad-pill">
      {preview === null && <span className="mic-dot" aria-label="Microphone on" />}
      <MeridianLine segments={segments} width={210} height={34} reduced={reduced} level={level} />
      <span className="grow" />
      {iconButton("Stop listening", "stop", () => setListening(false))}
    </div>
  );
}

export function ThinkingView({ reduced }: { reduced: boolean }) {
  const task = useApp((s) => s.chat.task);
  const provider = useApp((s) => s.providers.find((p) => p.id === s.chat.providerId)?.name);
  return (
    <div className="row pad-pill">
      <span className="orb" />
      <div className="grow stacked">
        <span className="label truncate">{provider ?? "Thinking"}</span>
        {task && <span className="meta truncate tiny">{task}</span>}
      </div>
      <Mine mood="working" scale={0.5} reduced={reduced} />
    </div>
  );
}

export function WorkingView({ reduced, hovered }: { reduced: boolean; hovered: boolean }) {
  const sessions = useApp((s) => s.sessions);
  const blocked = waitingApproval(sessions);
  const session = blocked ?? activeSessions(sessions)[0];
  if (!session) return null;

  if (blocked?.approval) {
    const { approval } = blocked;
    return (
      <div className="stack pad-card">
        <div className="row">
          <Mine mood="needs" scale={0.56} reduced={reduced} />
          <span className="grow label truncate">{blocked.agent} wants to run {approval.tool}</span>
          <span className="meta">{blocked.project}</span>
        </div>
        <code className="command" title={approval.summary}>{approval.summary}</code>
        <div className="row end">
          <button className="ghost" onClick={() => answerApproval(blocked.id, approval.id, false)}>Deny</button>
          <button className="allow" onClick={() => answerApproval(blocked.id, approval.id, true)}>Allow</button>
        </div>
      </div>
    );
  }

  const open = () => openPanel(session.surface === "chat" ? "chat" : "agents");

  if (hovered) {
    const recent = session.log.filter((l) => l.kind === "activity" || l.kind === "text").slice(-3);
    return (
      <div className="stack pad-card">
        <div className="row">
          <AgentMark agent={session.agent} />
          <button className="grow text-button" onClick={open}>
            <span className="label">{session.agent}</span>
            <span className="meta truncate">{session.title}</span>
          </button>
          <span className="meta"><Elapsed since={session.startedAt} /></span>
          {!session.watched && iconButton("Stop task", "stop", () => cancelSession(session.id))}
        </div>
        <div className="peek">
          {recent.length === 0 && <p className="meta">{session.activity || "Starting"}</p>}
          {recent.map((entry, i) => (
            <p key={i} className={entry.kind === "activity" ? "peek-tool truncate" : "meta truncate"}>
              {entry.text.split("\n").pop()}
            </p>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="row pad-pill">
      <AgentMark agent={session.agent} size={20} />
      <button className="grow text-button stacked" onClick={open}>
        <span className="label">{session.agent}</span>
        <span className="doing truncate">{session.activity || session.project}</span>
      </button>
      <Mine mood="working" scale={0.5} reduced={reduced} />
      <span className="meta"><Elapsed since={session.startedAt} /></span>
      {!session.watched && iconButton("Stop task", "stop", () => cancelSession(session.id))}
    </div>
  );
}

export function MultitaskView({ reduced }: { reduced: boolean }) {
  const sessions = useApp((s) => s.sessions);
  const active = useMemo(() => activeSessions(sessions), [sessions]);
  const shown = active.slice(0, MULTITASK_MAX_ROWS);
  return (
    <div className="stack pad-rows">
      {shown.map((s) => (
        <button key={s.id} className="session-row" onClick={() => openPanel(s.surface === "chat" ? "chat" : "agents")}>
          <AgentMark agent={s.agent} size={15} live={!reduced && s.status !== "waiting"} />
          <span className="label">{s.agent}</span>
          <span className="meta truncate grow">{s.activity || s.project}</span>
          <span className="meta"><Elapsed since={s.startedAt} /></span>
        </button>
      ))}
    </div>
  );
}

/** Mail can be forged and nothing here proves a sender, so a link always shows
 *  where it really goes. */
export const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
};

export function NotificationView({ reduced }: { reduced: boolean }) {
  const notice = useApp((s) => s.notices[0]);
  const sessions = useApp((s) => s.sessions);
  if (!notice) return null;
  const mood: Mood = notice.tone === "success" ? "done" : notice.tone === "urgent" ? "needs" : "rest";

  if (notice.eventId) {
    return (
      <div className="stack pad-card">
        <div className="row">
          <Mine mood={mood} scale={0.56} reduced={reduced} />
          <button className="grow text-button stacked" onClick={() => { dismissNotice(notice.id); openPanel("day"); }}>
            <span className="label truncate">{notice.title}</span>
            <span className="meta truncate">{notice.body}</span>
          </button>
          {iconButton("Dismiss", "close", () => dismissReminder(notice))}
        </div>
        <div className="row end">
          <button className="ghost" onClick={() => snoozeReminder(notice, 15)}>Snooze</button>
          <button className="ghost" onClick={() => { dismissNotice(notice.id); openPanel("day"); }}>Details</button>
          {notice.actions?.map((a) => (
            <button key={a.label} className="solid" title={a.url ?? undefined} onClick={() => a.url && openLink(a.url)}>{a.label} on {hostOf(a.url)}</button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="row pad-pill">
      <span className="notice-face">
        <Mine mood={mood} scale={0.56} reduced={reduced} />
        {notice.tone === "success" && !reduced && <Sparks />}
      </span>
      <button className="grow text-button stacked" onClick={() => { dismissNotice(notice.id); openPanel(notice.sessionId ? (sessions.find((s) => s.id === notice.sessionId)?.surface === "chat" ? "chat" : "agents") : undefined); }}>
        <span className="label truncate">{notice.title}</span>
        <span className="meta truncate">{notice.body}</span>
      </button>
      {iconButton("Dismiss", "close", () => dismissNotice(notice.id))}
    </div>
  );
}

export function ContextualView({ reduced }: { reduced: boolean }) {
  const suggestion = useApp((s) => s.suggestions[0]);
  if (!suggestion) return null;
  return (
    <div className="stack pad-card">
      <div className="row">
        <Mine mood="needs" scale={0.5} reduced={reduced} />
        <span className="grow label">{suggestion.title}</span>
      </div>
      <p className="body">{suggestion.body}</p>
      <div className="row end">
        <button className="ghost" onClick={() => ignoreSuggestion(suggestion)}>Ignore</button>
        <button className="ghost" onClick={() => assist(suggestion, "Explain this issue in plain terms.")}>Explain</button>
        <button className="ghost" onClick={() => assist(suggestion, "Suggest a fix for this.")}>Suggest fix</button>
        <button className="solid" onClick={() => assist(suggestion, "Analyze this error and tell me the likely cause.")}>Analyze</button>
      </div>
    </div>
  );
}

export function ScreenView({ reduced }: { reduced: boolean }) {
  return (
    <div className="row pad-pill">
      <Mine mood="working" scale={0.56} reduced={reduced} />
      <div className="grow stacked">
        <span className="label">Reading your screen</span>
        <span className="meta tiny">Stays on this PC until you share it</span>
      </div>
    </div>
  );
}

export function Artwork({ src, size }: { src: string | null; size: number }) {
  if (src) return <img className="artwork" src={src} alt="" style={{ width: size, height: size }} />;
  return <span className="artwork no-art" style={{ width: size, height: size }}><Icon name="music" size={Math.round(size * 0.5)} /></span>;
}

/** Small by default, like a Mac: artwork and bars. A click opens the album and its controls. */
export function MediaView({ open }: { open: boolean }) {
  const track = useApp((s) => s.media.current);
  if (!track) return null;
  if (!open) {
    return (
      <button className="media-closed" aria-label={`Now playing: ${track.title || track.app}. Open the player`} title={track.title} onClick={() => setMediaOpen(true)}>
        <Artwork src={track.artwork} size={24} />
        <Bars playing={track.playing} />
      </button>
    );
  }
  return (
    <div className="media-open">
      <div className="row">
        <Artwork src={track.artwork} size={56} />
        <button className="grow text-button stacked" onClick={() => openPanel("media")}>
          <span className="media-title truncate">{track.title || track.app}</span>
          <span className="meta truncate">{track.artist || track.app}</span>
        </button>
        <Bars playing={track.playing} height={22} />
      </div>
      <Progress />
      <div className="row media-controls">
        {iconButton("Previous", "previous", () => mediaAction({ action: "previous" }), !track.canPrevious)}
        {iconButton(track.playing ? "Pause" : "Play", track.playing ? "pause" : "play", () => mediaAction({ action: "toggle" }), !track.canToggle)}
        {iconButton("Next", "next", () => mediaAction({ action: "next" }), !track.canNext)}
      </div>
    </div>
  );
}

function Steps({ count, at, tone }: { count: number; at: number; tone: string }) {
  return (
    <div className="steps" style={{ "--tone": `var(${tone})` } as React.CSSProperties}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="step" data-done={i <= at} data-now={i === at} data-last={i === count - 1}>
          <i /><b data-done={i < at} />
        </span>
      ))}
    </div>
  );
}

function Route({ from, to, progress, tone }: { from: string; to: string; progress: number; tone: string }) {
  return (
    <div className="route" style={{ "--tone": `var(${tone})`, "--at": `${progress * 100}%` } as React.CSSProperties}>
      <span className="route-end">{from}</span>
      <span className="route-line">
        <i className="route-fill" />
        <span className="route-plane" data-flying={progress > 0 && progress < 1}><Icon name="plane" size={16} /></span>
      </span>
      <span className="route-end">{to}</span>
    </div>
  );
}

export function LiveView({ hovered }: { hovered: boolean }) {
  const live = useApp((s) => s.live[0]);
  const focus = useApp((s) => s.focus);
  const [now, setNow] = useState(() => Date.now());

  // Only a running timer needs the second hand.
  useEffect(() => {
    if (live?.kind !== "timer") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live?.kind]);

  if (!live) return null;
  const a = live.kind === "timer" && focus ? focusActivity(focus.endsAt, focus.minutes, now) : live;
  const tone = { "--tone": `var(${a.tone})` } as React.CSSProperties;
  const open = () => openPanel(a.kind === "timer" ? "home" : "day");

  if (!hovered) {
    return (
      <button className="live-closed" style={tone} onClick={open}>
        <span className="live-left truncate">{a.kind === "flight" && <Icon name="plane" size={14} />}{a.left}</span>
        <span className="live-right tabular">{a.right}</span>
      </button>
    );
  }
  return (
    <div className="live-open" style={tone}>
      <div className="row live-head">
        <button className="grow text-button stacked" onClick={open}>
          <span className="live-status">{a.status}</span>
          <span className="live-big tabular truncate">{a.big}</span>
        </button>
        <span className="stacked live-side">
          <span className="meta">{a.who}</span>
          <span className="live-detail truncate">{a.detail}</span>
        </span>
      </div>
      {a.route && <Route {...a.route} tone={a.tone} />}
      {a.steps && <Steps {...a.steps} tone={a.tone} />}
      <div className="row">
        <span className="grow meta truncate">{a.foot}</span>
        {a.action && <button className="live-action" title={a.action.url} onClick={() => openLink(a.action!.url)}>{a.action.label} on {hostOf(a.action.url)}</button>}
      </div>
    </div>
  );
}

/** A second thing going on, in a small bubble beside the island. */
export function Bubble() {
  const live = useApp((s) => s.live);
  const panelOpen = useApp((s) => s.panelOpen);
  const view = useApp((s) => s.islandView);
  const second = view === "live" ? live[1] : live[0];
  if (!second || panelOpen) return null;
  return (
    <span className="bubble" title={second.status} style={{ "--tone": `var(${second.tone})` } as React.CSSProperties}>
      <span className="bubble-ring"><b>{second.short}</b></span>
    </span>
  );
}

export function ErrorView({ reduced }: { reduced: boolean }) {
  const error = useApp((s) => s.errors[0]);
  if (!error) return null;
  return (
    <div className="row pad-pill">
      <Mine mood="error" scale={0.56} reduced={reduced} />
      <div className="grow stacked">
        <span className="label truncate">{error.title}</span>
        <span className="meta truncate" title={error.body}>{error.body}</span>
      </div>
      {error.retry && iconButton("Retry", "retry", () => { const retry = error.retry; dismissError(error.id); retry?.(); })}
      {iconButton("Dismiss", "close", () => dismissError(error.id))}
    </div>
  );
}
