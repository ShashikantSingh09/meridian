// Home is calm (D78): one card for what is happening now, then Ask, then a quiet line of things to ask. The card
// shows the first of: an agent that needs you or is at work, a note being recorded, a focus session, music
// playing, the next event today. With none of those it says so, and offers Focus and a new session. No sample
// data here, ever.

import { useEffect, useRef, useState } from "react";
import { span, timeOf } from "../island/live";
import { activeSessions, waitingApproval } from "../island/machine";
import { Bars } from "../island/marks";
import { Artwork, RecordingClock } from "../island/views";
import { Brand } from "../lib/brands";
import { Icon } from "../lib/icons";
import { ago } from "../lib/sessions";
import { firstSeen, goingFrom, pickStarters } from "../lib/starters";
import { clearDraft, describeTime, endFocus, openPanel, sendToEngine, setDraft, setTab, startFocus, timeToday, useApp } from "../lib/store";
import { startVoice } from "../lib/voice";

/** Only an event within this long is "now" enough for Home. */
const SOON = 12 * 3_600_000;

function NowCard() {
  const sessions = useApp((s) => s.sessions);
  const recording = useApp((s) => s.notes.notes.find((n) => n.id === s.notes.recording));
  const focus = useApp((s) => s.focus);
  const track = useApp((s) => (s.settings.mediaEnabled && s.media.current?.playing ? s.media.current : null));
  const tint = useApp((s) => (s.media.current?.artwork ? s.artTint : null));
  const next = useApp((s) => s.activity.next);
  const now = Date.now();
  const active = activeSessions(sessions);
  const waiting = waitingApproval(sessions);
  const lead = waiting ?? active[0];

  if (lead) {
    const others = active.length - 1;
    return (
      <button className="plate now" data-tone={waiting ? "waiting" : "working"} onClick={() => setTab("agents")}>
        <span className="row">
          <Brand id={lead.agentId} name={lead.agent} size={16} />
          <span className="label grow truncate">
            {lead.project} <span className="meta">· {lead.agent}</span>
          </span>
          <span className="meta tabular">{others > 0 ? `and ${others} more · ` : ""}{ago(lead.startedAt, now)}</span>
        </span>
        <span className="doing truncate">{waiting ? `Needs you: ${waiting.approval?.summary ?? "a decision"}` : lead.activity || "Working"}</span>
        {!waiting && <span className="now-pulse" aria-hidden="true"><i /></span>}
      </button>
    );
  }
  if (recording) {
    return (
      <button className="plate now" data-tone="recording" onClick={() => setTab("notes")}>
        <span className="row">
          <span className="label grow truncate">Recording a note</span>
          <RecordingClock since={recording.startedAt} />
        </span>
        <span className="doing truncate">Meridian writes it up when you stop.</span>
      </button>
    );
  }
  if (focus) {
    return (
      <div className="plate now">
        <span className="row">
          <span className="label grow truncate">Focusing</span>
          <span className="meta tabular">{span(Math.max(0, focus.endsAt - now))} left</span>
          <button className="ghost" onClick={endFocus}>End focus</button>
        </span>
      </div>
    );
  }
  if (track) {
    return (
      <button className="plate now now-music" data-tinted={tint !== null} style={tint ? ({ "--art": tint } as React.CSSProperties) : undefined} onClick={() => setTab("media")}>
        <span className="row">
          <Artwork src={track.artwork ?? null} size={44} />
          <span className="grow stacked">
            <span className="label truncate">{track.title || track.app}</span>
            <span className="meta truncate">{track.artist || track.app}</span>
          </span>
          <Bars playing height={18} />
        </span>
      </button>
    );
  }
  const at = next ? timeOf(next.startsAt) : null;
  if (next && at !== null && at > now && at - now < SOON) {
    return (
      <button className="plate now" onClick={() => openPanel("day")}>
        <span className="row">
          <span className="label grow truncate">{next.title}</span>
          <span className="meta tabular">in {span(at - now)}</span>
        </span>
        <span className="doing truncate">{next.startsAt ? (timeToday(next.startsAt) ?? describeTime(next.startsAt)) : "Today"}</span>
      </button>
    );
  }
  return (
    <div className="plate now">
      <span className="row">
        <span className="grow stacked">
          <span className="label">Nothing running</span>
          <span className="meta">Start an agent, or ask anything below.</span>
        </span>
        <button className="ghost" onClick={() => startFocus()}>Focus for 25 min</button>
        <button className="ghost" onClick={() => setTab("agents")}>New session</button>
      </span>
    </div>
  );
}

/** A few things to ask, so a blank box is never the first thing you see. */
function Starters({ dim, picked, onPick }: { dim: boolean; picked: boolean; onPick: (text: string) => void }) {
  const app = useApp((s) => s);
  const [since] = useState(firstSeen);
  const [over, setOver] = useState<string | null>(null);
  const going = goingFrom(app, Date.now(), since);
  const starters = pickStarters(going);
  const tip = starters.find((s) => s.text === over);
  return (
    <div className="starters" data-dim={dim}>
      <div className="starters-row" role="group" aria-label="Things to ask">
        {starters.map((s) => (
          <button key={s.text} type="button" className="starter" aria-describedby={tip === s ? "starter-why" : undefined} onPointerEnter={() => setOver(s.text)} onPointerLeave={() => setOver(null)} onFocus={() => setOver(s.text)} onBlur={() => setOver(null)} onClick={() => onPick(s.text)}>
            <Icon name={s.icon} size={14} />
            {s.text}
          </button>
        ))}
      </div>
      {tip && <span id="starter-why" className="starter-why" role="tooltip">{tip.why}</span>}
      {picked ? (
        <p className="meta">Enter sends. Change the words first if you like.</p>
      ) : (
        going.firstDays && <p className="meta">Once Meridian has seen a day or two, these turn into suggestions about your day.</p>
      )}
    </div>
  );
}

export function Home() {
  const text = useApp((s) => s.draft);
  const pending = useApp((s) => s.chatPending);
  const suggest = useApp((s) => s.settings.homeSuggestions);
  const box = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<string | null>(null);

  // The words go into the box with the caret after them, so they can be changed before Enter.
  useEffect(() => {
    const input = box.current;
    if (!picked || !input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [picked]);

  const pick = (words: string) => {
    setDraft(words);
    setPicked(words);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = text.trim();
    if (!prompt || pending) return;
    clearDraft();
    setTab("chat");
    void sendToEngine(prompt);
  };

  return (
    <div className="home board">
      <NowCard />
      <form className="composer" onSubmit={submit}>
        <button type="button" className="round" aria-label="Talk" title="Talk. Or hold Ctrl Alt V anywhere." onClick={() => void startVoice("turn")}>
          <Icon name="mic" size={15} />
        </button>
        <input ref={box} aria-label="Ask anything" placeholder="Ask anything" value={text} onChange={(e) => setDraft(e.target.value)} />
        <button className="round solid" aria-label="Send" disabled={!text.trim() || pending}>
          <Icon name="send" size={14} />
        </button>
      </form>
      {suggest && <Starters dim={text.trim() !== ""} picked={picked !== null && picked === text} onPick={pick} />}
    </div>
  );
}
