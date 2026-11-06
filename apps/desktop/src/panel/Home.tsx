// Home is a few live cards, each of which is either showing something real or
// inviting the one step that would make it so. No sample data here, ever.

import { rowEnter } from "@meridian/design-system/motion";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { span, timeOf } from "../island/live";
import { activeSessions } from "../island/machine";
import { Bars } from "../island/marks";
import { Artwork, Clock, hostOf } from "../island/views";
import { Brand } from "../lib/brands";
import { Icon } from "../lib/icons";
import { ago } from "../lib/sessions";
import { firstSeen, goingFrom, pickStarters } from "../lib/starters";
import { assist, clearDraft, describeTime, endFocus, openLink, openPanel, openSettings, sendToEngine, setDraft, setTab, startFocus, timeToday, useApp } from "../lib/store";
import { startVoice } from "../lib/voice";

const HOUR = 3_600_000;
/** The length of the ring in the Next card, for a radius of 25. */
const RING = 157;
/** What the empty feed offers to connect. */
const OFFERS = [
  { id: "gmail", name: "Gmail" },
  { id: "calendar", name: "Google Calendar" },
  { id: "github", name: "GitHub" },
  { id: "linear", name: "Linear" },
];
const cardEnter = (i: number) =>
  ({ initial: { opacity: 0, y: 10, scale: 0.97 }, animate: { opacity: 1, y: 0, scale: 1 }, transition: { type: "spring", stiffness: 420, damping: 30, delay: i * 0.05 } }) as const;

function CardActions() {
  const focus = useApp((s) => s.focus);
  return (
    <div className="row">
      {focus ? <button className="ghost" onClick={endFocus}>End focus</button> : <button className="ghost" onClick={() => startFocus()}>Focus for 25 min</button>}
      <button className="ghost" onClick={() => setTab("agents")}>New task</button>
    </div>
  );
}

function AgentsCard() {
  const sessions = useApp((s) => s.sessions);
  const active = activeSessions(sessions);
  const now = Date.now();
  const date = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

  if (active.length === 0) {
    return (
      <motion.section className="plate home-agents" {...cardEnter(0)}>
        <Clock className="big-clock tabular" />
        <span className="meta">{date}</span>
        <span className="grow" />
        <CardActions />
      </motion.section>
    );
  }
  return (
    <motion.section className="plate home-agents" data-busy="true" {...cardEnter(0)}>
      <button className="row text-button home-agents-head" onClick={() => setTab("agents")}>
        <i className="live-dot" />
        <span className="grow">{active.length} {active.length === 1 ? "agent" : "agents"} working</span>
      </button>
      {active.slice(0, 2).map((s) => (
        <button key={s.id} className="home-agent" data-agent={s.agentId} onClick={() => setTab("agents")}>
          <span className="row">
            <Brand id={s.agentId} name={s.agent} size={15} />
            <span className="label grow truncate">{s.agent}, {s.project}</span>
            <span className="meta tabular">{ago(s.startedAt, now)}</span>
          </span>
          <span className="doing truncate">{s.activity || "Working"}</span>
        </button>
      ))}
      <span className="grow" />
      <CardActions />
    </motion.section>
  );
}

function NextCard() {
  const next = useApp((s) => s.activity.next);
  const accounts = useApp((s) => s.activity.accounts);
  const at = next ? timeOf(next.startsAt) : null;
  const left = at ? at - Date.now() : null;
  const soon = left !== null && left > 0 && left < HOUR;
  const fill = soon ? 1 - left! / HOUR : 0;
  const minutes = soon ? Math.ceil(left! / 60_000) : null;
  const when = next?.startsAt ? (timeToday(next.startsAt) ?? describeTime(next.startsAt)) : null;
  const where = hostOf(next?.suggestedActions.find((a) => a.url)?.url ?? null);

  return (
    <motion.section className="plate home-next" {...cardEnter(1)}>
      <span className="next-ring">
        <svg aria-hidden="true" viewBox="0 0 58 58">
          <circle cx="29" cy="29" r="25" />
          {fill > 0 && <circle cx="29" cy="29" r="25" data-arc="true" strokeDasharray={RING} strokeDashoffset={RING * (1 - fill)} />}
        </svg>
        <b className="tabular">{minutes ?? <Icon name="calendar" size={18} />}</b>
      </span>
      {next ? (
        <button className="grow text-button stacked" onClick={() => openPanel("day")}>
          <span className="tile-kicker">{left !== null && left > 0 ? `Next, in ${span(left)}` : "Next"}</span>
          <span className="tile-title truncate">{next.title}</span>
          <span className="meta truncate">{[when, where].filter(Boolean).join(", ")}</span>
        </button>
      ) : (
        <button className="grow text-button stacked" onClick={() => openSettings("providers")}>
          <span className="tile-kicker">Your day is clear</span>
          <span className="tile-title truncate">{accounts.length === 0 ? "Connect a calendar" : "Nothing coming up"}</span>
        </button>
      )}
    </motion.section>
  );
}

function MusicCard() {
  const track = useApp((s) => s.media.current);
  const tint = useApp((s) => (s.media.current?.artwork ? s.artTint : null));
  return (
    <motion.section className="plate home-music" data-tinted={tint !== null} style={tint ? ({ "--art": tint } as React.CSSProperties) : undefined} {...cardEnter(2)}>
      <Artwork src={track?.artwork ?? null} size={64} />
      <button className="grow text-button stacked" onClick={() => setTab("media")}>
        <span className="tile-title truncate">{track?.title || track?.app || "Nothing playing"}</span>
        <span className="meta truncate">{track?.artist || (track ? track.app : "Any music app shows here")}</span>
      </button>
      {track && <Bars playing={track.playing} height={20} />}
    </motion.section>
  );
}

function Feed() {
  const integrations = useApp((s) => s.integrations);
  const digests = useApp((s) => s.digests);
  const suggestions = useApp((s) => s.suggestions);
  const connected = integrations.filter((i) => i.connected);
  const rows = [
    // What the screen turned up comes first, because it is about what is happening now.
    ...suggestions.map((s) => ({
      key: s.id,
      title: s.title,
      source: "On your screen",
      mark: <span className="brand feed-idea" style={{ width: 22, height: 22 }}><Icon name="bulb" size={14} /></span>,
      url: null as string | null,
      open: () => assist(s, "Suggest a fix for this."),
    })),
    ...connected.flatMap((i) =>
      (digests[i.id]?.items ?? []).slice(0, 2).map((item) => ({
        key: i.id + item.key,
        title: item.title,
        source: i.name,
        mark: <Brand id={i.id} name={i.name} size={22} />,
        url: item.url,
        open: item.url ? () => openLink(item.url!) : undefined,
      })),
    ),
  ].slice(0, 3);

  return (
    <motion.section className="plate home-feed" {...cardEnter(3)}>
      <h2>{suggestions.length > 0 ? "Suggestions" : "From your providers"}</h2>
      {rows.length === 0 && connected.length === 0 && (
        <div className="home-connect">
          <span className="home-logos">{OFFERS.map((o) => <Brand key={o.id} id={o.id} name={o.name} size={26} />)}</span>
          <span className="meta grow">Connect a provider to see your issues, mail and calendar here.</span>
          <button className="ghost" onClick={() => openSettings("providers")}>Connect</button>
        </div>
      )}
      {rows.length === 0 && connected.length > 0 && <p className="meta">Nothing fetched yet.</p>}
      {rows.length > 0 && (
        <ul className="list">
          {rows.map((row, i) => (
            <motion.li key={row.key} {...rowEnter(i)}>
              <button className="feed-row" disabled={!row.open} title={row.url ? `Open on ${hostOf(row.url)}` : undefined} onClick={row.open}>
                {row.mark}
                <span className="label grow truncate">{row.title}</span>
                <span className="meta">{row.source}</span>
              </button>
            </motion.li>
          ))}
        </ul>
      )}
    </motion.section>
  );
}

function Today() {
  const sessions = useApp((s) => s.sessions);
  const midnight = new Date().setHours(0, 0, 0, 0);
  const done = sessions.filter((s) => s.status === "completed" && (s.endedAt ?? 0) >= midnight).length;
  return (
    <motion.button className="plate home-today" {...cardEnter(4)} onClick={() => setTab("agents")}>
      <span className="meta">Today</span>
      <span className="home-number tabular">{done}</span>
      <span className="meta">{done === 1 ? "task finished" : "tasks finished"}</span>
    </motion.button>
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
      <div className="bento">
        <AgentsCard />
        <NextCard />
        <MusicCard />
        <Feed />
        <Today />
      </div>
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
