// Home is a set of live tiles (D80), then Ask, then a quiet line of things to ask. Now shows the character and the
// first of: an agent that needs you or is at work, a note being recorded, a focus session. With none of those it says
// so, and offers Focus and a new session. Beside it: the time, large; the next event today as a ring that empties as
// it nears; and music in its album's colour. Each tile opens its page. No sample data here, ever.

import { useEffect, useRef, useState } from "react";
import { Face, useReduced, type Mood } from "../island/faces";
import { span, timeOf } from "../island/live";
import { activeSessions, waitingApproval } from "../island/machine";
import { Bars, Transport } from "../island/marks";
import { Artwork, Clock, RecordingClock } from "../island/views";
import { Brand } from "../lib/brands";
import { Icon } from "../lib/icons";
import { ago } from "../lib/sessions";
import { firstSeen, goingFrom, pickStarters } from "../lib/starters";
import { clearDraft, describeTime, endFocus, openPanel, sendToEngine, setDraft, setTab, startFocus, timeToday, useApp } from "../lib/store";
import { startVoice } from "../lib/voice";
import { AskLap } from "./AskLap";
import { Spot } from "./Spot";

/** Only an event within this long is "next" enough for Home. */
const SOON = 12 * 3_600_000;

/** The character, large, in the mood of what is happening. */
function Character({ mood }: { mood: Mood }) {
  const face = useApp((s) => s.settings.face);
  const reduced = useReduced();
  return (
    <span className="now-face" aria-hidden="true">
      <Face id={face} mood={mood} scale={2.2} reduced={reduced} />
    </span>
  );
}

function NowCard() {
  const sessions = useApp((s) => s.sessions);
  const recording = useApp((s) => s.notes.notes.find((n) => n.id === s.notes.recording));
  const focus = useApp((s) => s.focus);
  const now = Date.now();
  const active = activeSessions(sessions);
  const waiting = waitingApproval(sessions);
  const lead = waiting ?? active[0];

  if (lead) {
    const second = active.find((s) => s.id !== lead.id);
    return (
      <button className="plate now tile" data-tone={waiting ? "waiting" : "working"} onClick={() => setTab("agents")}>
        <span className="tile-k">Now</span>
        <Character mood={waiting ? "needs" : "working"} />
        <span className="now-title">{waiting ? "Needs you" : active.length > 1 ? `Working on ${active.length} things` : "Working"}</span>
        <span className="now-line">
          <Brand id={lead.agentId} name={lead.agent} size={13} />
          <span className="label grow truncate">{lead.project}</span>
          <span className="meta tabular">{ago(lead.startedAt, now)}</span>
        </span>
        <span className="doing truncate">{waiting ? `Needs you: ${waiting.approval?.summary ?? "a decision"}` : lead.activity || "Working"}</span>
        {second && (
          <span className="now-line">
            <Brand id={second.agentId} name={second.agent} size={13} />
            <span className="label grow truncate">{second.project}</span>
            <span className="meta tabular">{active.length > 2 ? `and ${active.length - 2} more` : ago(second.startedAt, now)}</span>
          </span>
        )}
      </button>
    );
  }
  if (recording) {
    return (
      <button className="plate now tile" data-tone="recording" onClick={() => setTab("notes")}>
        <span className="tile-k">Now</span>
        <Character mood="listen" />
        <span className="now-title">Recording a note</span>
        <span className="now-line">
          <span className="doing grow truncate">Meridian writes it up when you stop.</span>
          <RecordingClock since={recording.startedAt} />
        </span>
      </button>
    );
  }
  if (focus) {
    return (
      <div className="plate now tile">
        <span className="tile-k">Now</span>
        <Character mood="rest" />
        <span className="now-title">Focusing</span>
        <span className="now-line">
          <span className="meta grow tabular">{span(Math.max(0, focus.endsAt - now))} left</span>
          <button className="ghost" onClick={endFocus}>End focus</button>
        </span>
      </div>
    );
  }
  return (
    <div className="plate now tile">
      <span className="tile-k">Now</span>
      <Character mood="rest" />
      <span className="now-title">Nothing running</span>
      <span className="meta">Start an agent, or ask anything below.</span>
      <span className="now-actions">
        <button className="ghost" onClick={() => startFocus()}>Focus for 25 min</button>
        <button className="ghost" onClick={() => setTab("agents")}>New session</button>
      </span>
    </div>
  );
}

/** The time, large enough to read from across the desk. */
function TimeTile() {
  return (
    <div className="plate tile time-tile">
      <span className="tile-k">Time</span>
      <Clock className="tile-big tabular" />
      <span className="meta">{new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}</span>
    </div>
  );
}

/** The next event today. Within the hour the ring empties as it nears; further off it shows the hours. */
function NextTile() {
  const next = useApp((s) => s.activity.next);
  const now = Date.now();
  const at = next ? timeOf(next.startsAt) : null;
  if (!next || at === null || at <= now || at - now >= SOON) {
    return (
      <button className="plate tile next-tile" onClick={() => openPanel("day")}>
        <span className="tile-k">Next</span>
        <span className="next-row">
          <span className="next-ring" data-empty="true" aria-hidden="true"><Icon name="calendar" size={20} /></span>
          <span className="meta grow">Nothing else today</span>
        </span>
      </button>
    );
  }
  const minutes = Math.ceil((at - now) / 60_000);
  const soon = minutes <= 60;
  const R = 25;
  const round = 2 * Math.PI * R;
  return (
    <button className="plate tile next-tile" onClick={() => openPanel("day")}>
      <span className="tile-k">Next</span>
      <span className="next-row">
        <span className="next-ring" aria-hidden="true">
          <svg className="next-dial" width="60" height="60" viewBox="0 0 60 60">
            <circle cx="30" cy="30" r={R} className="next-track" />
            <circle cx="30" cy="30" r={R} className="next-left" strokeDasharray={round} strokeDashoffset={soon ? round * (1 - minutes / 60) : 0} transform="rotate(-90 30 30)" />
          </svg>
          <b className="tabular">{soon ? minutes : Math.round(minutes / 60)}</b>
          <i>{soon ? "min" : "h"}</i>
        </span>
        <span className="stacked grow">
          <span className="label truncate">{next.title}</span>
          <span className="meta truncate">{next.startsAt ? (timeToday(next.startsAt) ?? describeTime(next.startsAt)) : "Today"}</span>
        </span>
      </span>
      <span className="sr-only">in {span(at - now)}</span>
    </button>
  );
}

/** What is playing, lit by its album's colour. */
function MusicTile() {
  const track = useApp((s) => (s.settings.mediaEnabled ? s.media.current : null));
  const tint = useApp((s) => (s.media.current?.artwork ? s.artTint : null));
  if (!track) {
    return (
      <button className="plate tile music-tile" onClick={() => setTab("media")}>
        <span className="artwork no-art"><Icon name="music" size={24} /></span>
        <span className="stacked grow">
          <span className="label">Nothing playing</span>
          <span className="meta">Play something in any music app.</span>
        </span>
      </button>
    );
  }
  return (
    <div className="plate tile music-tile now-music" data-tinted={tint !== null} style={tint ? ({ "--art": tint } as React.CSSProperties) : undefined}>
      <button className="music-open" aria-label={`Open Media: ${track.title || track.app}`} onClick={() => setTab("media")}>
        <Artwork src={track.artwork ?? null} size={72} />
        <span className="stacked grow">
          <span className="music-name">
            <span className="label truncate">{track.title || track.app}</span>
            <Bars playing={track.playing} height={14} />
          </span>
          <span className="meta truncate">{track.artist || track.app}</span>
        </span>
      </button>
      <Transport track={track} size={20} />
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
      <div className="tiles">
        <Spot className="now-spot">
          <NowCard />
        </Spot>
        <TimeTile />
        <NextTile />
        <MusicTile />
      </div>
      <AskLap radius={24}>
      <form className="composer" onSubmit={submit}>
        <button type="button" className="round" aria-label="Talk" title="Talk. Or hold Ctrl Alt V anywhere." onClick={() => void startVoice("turn")}>
          <Icon name="mic" size={15} />
        </button>
        <input ref={box} aria-label="Ask anything" placeholder="Ask anything" value={text} onChange={(e) => setDraft(e.target.value)} />
        <button className="round solid" aria-label="Send" disabled={!text.trim() || pending}>
          <Icon name="send" size={14} />
        </button>
      </form>
      </AskLap>
      {suggest && <Starters dim={text.trim() !== ""} picked={picked !== null && picked === text} onPick={pick} />}
    </div>
  );
}
