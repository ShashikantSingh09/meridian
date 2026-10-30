// What sits inside the island for each compact state. The line of light is the
// lead in every one of them; text only says what the line cannot.

import { useEffect, useMemo, useState } from "react";
import { Icon } from "../lib/icons";
import {
  answerApproval,
  cancelSession,
  dismissError,
  dismissNotice,
  dismissSuggestion,
  openPanel,
  sendChat,
  setListening,
  useApp,
} from "../lib/store";
import { activeSessions, MULTITASK_MAX_ROWS, waitingApproval, type SessionSummary } from "./machine";
import type { LineMode, LineSegment } from "./line";
import { MeridianLine } from "./MeridianLine";
import { useMicLevel } from "./useMicLevel";

const statusColor = (s: SessionSummary) =>
  s.status === "waiting" ? "--state-waiting" : "--state-working";

function Line({ mode, color, width, height, reduced, level }: {
  mode: LineMode;
  color: string;
  width: number;
  height: number;
  reduced: boolean;
  level?: () => number;
}) {
  const segments = useMemo<LineSegment[]>(() => [{ mode, color }], [mode, color]);
  return <MeridianLine segments={segments} width={width} height={height} reduced={reduced} level={level} />;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const text = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return <span className="tabular">{text}</span>;
}

const iconButton = (label: string, icon: Parameters<typeof Icon>[0]["name"], onClick: () => void) => (
  <button className="round" aria-label={label} title={label} onClick={onClick}>
    <Icon name={icon} size={14} />
  </button>
);

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Aligned to the minute, so the only repaint is the one that changes the digits.
    const timer = setTimeout(() => setNow(new Date()), 60_000 - (Date.now() % 60_000));
    return () => clearTimeout(timer);
  }, [now]);
  return <span className="meta tabular">{now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>;
}

export function IdleView({ reduced, hovered, sliver }: { reduced: boolean; hovered: boolean; sliver: boolean }) {
  const model = useApp((s) => s.chat.model ?? s.settings.defaultModel);
  const clock = useApp((s) => s.settings.showClock);
  if (sliver && !hovered) return null;
  if (!hovered) {
    return (
      <div className="pill-center ambient" data-clock={clock}>
        <Line mode="rest" color="--state-idle" width={clock ? 64 : 72} height={12} reduced={reduced} />
        {clock && <Clock />}
      </div>
    );
  }
  return (
    <div className="row pad-pill">
      <Line mode="rest" color="--state-idle" width={40} height={12} reduced={reduced} />
      <span className="grow label">{model ?? "Meridian"}</span>
      <kbd>Ctrl Alt Space</kbd>
    </div>
  );
}

export function ListeningView({ reduced }: { reduced: boolean }) {
  const preview = useApp((s) => s.preview);
  const level = useMicLevel(preview === null);
  return (
    <div className="row pad-pill">
      {preview === null && <span className="mic-dot" aria-label="Microphone on" />}
      <Line mode="listen" color="--state-listening" width={168} height={32} reduced={reduced} level={level} />
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
      <Line mode="think" color="--state-thinking" width={56} height={20} reduced={reduced} />
      <div className="grow stacked">
        <span className="label truncate">{provider ?? "Thinking"}</span>
        {task && <span className="meta truncate tiny">{task}</span>}
      </div>
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
          <Line mode="flare" color="--state-waiting" width={36} height={10} reduced={reduced} />
          <span className="grow label">{blocked.agent} wants to run {approval.tool}</span>
          <span className="meta">{blocked.project}</span>
        </div>
        <code className="command" title={approval.summary}>{approval.summary}</code>
        <div className="row end">
          <button className="ghost" onClick={() => answerApproval(blocked.id, approval.id, false)}>Deny</button>
          <button className="solid" onClick={() => answerApproval(blocked.id, approval.id, true)}>Allow</button>
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
          <Line mode="work" color="--state-working" width={36} height={10} reduced={reduced} />
          <button className="grow text-button" onClick={open}>
            <span className="label">{session.agent}</span>
            <span className="meta truncate">{session.title}</span>
          </button>
          <span className="meta"><Elapsed since={session.startedAt} /></span>
          {iconButton("Stop task", "stop", () => cancelSession(session.id))}
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
      <Line mode="work" color="--state-working" width={56} height={12} reduced={reduced} />
      <button className="grow text-button" onClick={open}>
        <span className="label">{session.agent}</span>
        <span className="meta truncate">{session.activity || session.project}</span>
      </button>
      <span className="meta"><Elapsed since={session.startedAt} /></span>
      {iconButton("Stop task", "stop", () => cancelSession(session.id))}
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
          <Line mode={s.status === "waiting" ? "flare" : "work"} color={statusColor(s)} width={32} height={10} reduced={reduced} />
          <span className="label">{s.agent}</span>
          <span className="meta truncate grow">{s.activity || s.project}</span>
          <span className="meta"><Elapsed since={s.startedAt} /></span>
        </button>
      ))}
    </div>
  );
}

export function NotificationView({ reduced }: { reduced: boolean }) {
  const notice = useApp((s) => s.notices[0]);
  const sessions = useApp((s) => s.sessions);
  if (!notice) return null;
  return (
    <div className="row pad-card">
      <Line mode="flare" color={notice.tone === "success" ? "--state-success" : "--state-notice"} width={36} height={10} reduced={reduced} />
      <button className="grow text-button stacked" onClick={() => { dismissNotice(notice.id); openPanel(notice.sessionId ? (sessions.find((s) => s.id === notice.sessionId)?.surface === "chat" ? "chat" : "agents") : undefined); }}>
        <span className="label">{notice.title}</span>
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
        <Line mode="flare" color="--state-context" width={36} height={10} reduced={reduced} />
        <span className="grow label">{suggestion.title}</span>
      </div>
      <p className="body">{suggestion.body}</p>
      <div className="row end">
        <button className="ghost" onClick={() => dismissSuggestion(suggestion.id)}>Dismiss</button>
        <button className="ghost" onClick={() => { dismissSuggestion(suggestion.id); openPanel("chat"); }}>Investigate</button>
        <button className="solid" onClick={() => { dismissSuggestion(suggestion.id); openPanel("chat"); void sendChat(suggestion.body); }}>Accept</button>
      </div>
    </div>
  );
}

export function ErrorView({ reduced }: { reduced: boolean }) {
  const error = useApp((s) => s.errors[0]);
  if (!error) return null;
  return (
    <div className="row pad-card">
      <Line mode="fracture" color="--state-error" width={36} height={12} reduced={reduced} />
      <div className="grow stacked">
        <span className="label">{error.title}</span>
        <span className="meta truncate" title={error.body}>{error.body}</span>
      </div>
      {error.retry && iconButton("Retry", "retry", () => { const retry = error.retry; dismissError(error.id); retry?.(); })}
      {iconButton("Dismiss", "close", () => dismissError(error.id))}
    </div>
  );
}
