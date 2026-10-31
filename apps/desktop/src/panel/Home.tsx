// Home is a few live cards, each of which is either showing something real or
// inviting the one step that would make it so. No sample data here, ever.

import { rowEnter } from "@meridian/design-system/motion";
import { motion } from "motion/react";
import { span, timeOf } from "../island/live";
import { activeSessions } from "../island/machine";
import { AgentMark, Bars } from "../island/marks";
import { Artwork, Clock, hostOf } from "../island/views";
import { Icon } from "../lib/icons";
import { clearDraft, endFocus, openLink, openPanel, openSettings, sendChat, setDraft, setTab, startFocus, useApp } from "../lib/store";

const HOUR = 3_600_000;
const cardEnter = (i: number) =>
  ({ initial: { opacity: 0, y: 10, scale: 0.97 }, animate: { opacity: 1, y: 0, scale: 1 }, transition: { type: "spring", stiffness: 420, damping: 30, delay: i * 0.05 } }) as const;

function AgentsCard() {
  const sessions = useApp((s) => s.sessions);
  const focus = useApp((s) => s.focus);
  const active = activeSessions(sessions);
  const date = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

  if (active.length === 0) {
    return (
      <motion.section className="tile tile-clock" {...cardEnter(0)}>
        <Clock className="big-clock tabular" />
        <span className="meta">{date}</span>
        <span className="grow" />
        <div className="row">
          {focus ? <button className="ghost" onClick={endFocus}>End focus</button> : <button className="ghost" onClick={() => startFocus()}>Focus for 25 min</button>}
          <button className="ghost" onClick={() => setTab("agents")}>New task</button>
        </div>
      </motion.section>
    );
  }
  return (
    <motion.section className="tile tile-agents" {...cardEnter(0)}>
      <button className="row text-button" onClick={() => setTab("agents")}>
        <AgentMark agent={active[0].agent} size={20} />
        <span className="label grow">{active.length} {active.length === 1 ? "agent" : "agents"} working</span>
      </button>
      {active.slice(0, 3).map((s) => (
        <button key={s.id} className="agent-row" onClick={() => setTab("agents")}>
          <span className="row"><span className="label grow truncate">{s.agent}, {s.project}</span></span>
          <span className="doing truncate">{s.activity || "Working"}</span>
          <i className="shimmer" aria-hidden="true" />
        </button>
      ))}
    </motion.section>
  );
}

function NextCard() {
  const next = useApp((s) => s.activity.next);
  const accounts = useApp((s) => s.activity.accounts);
  const at = next ? timeOf(next.startsAt) : null;
  const left = at ? at - Date.now() : null;
  const soon = left !== null && left > 0 && left < HOUR;
  const fill = soon ? Math.round((1 - left! / HOUR) * 100) : 0;
  const minutes = soon ? Math.ceil(left! / 60_000) : null;

  return (
    <motion.section className="tile tile-next" {...cardEnter(1)}>
      <span className="ring" style={{ background: `conic-gradient(var(--state-waiting) ${fill}%, rgba(255, 159, 10, 0.16) ${fill}% 100%)` }}>
        <b className="tabular">{minutes ?? <Icon name="calendar" size={18} />}</b>
      </span>
      {next ? (
        <button className="grow text-button stacked" onClick={() => openPanel("day")}>
          <span className="tile-kicker">{left !== null && left > 0 ? `Next, in ${span(left)}` : "Next"}</span>
          <span className="tile-title truncate">{next.title}</span>
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
  return (
    <motion.section className="tile tile-music" {...cardEnter(2)}>
      <Artwork src={track?.artwork ?? null} size={52} />
      <button className="grow text-button stacked" onClick={() => setTab("media")}>
        <span className="tile-title truncate">{track?.title || track?.app || "Nothing playing"}</span>
        <span className="meta truncate">{track?.artist || (track ? track.app : "Any music app shows here")}</span>
      </button>
      <Bars playing={track?.playing ?? false} height={24} />
    </motion.section>
  );
}

function Feed() {
  const integrations = useApp((s) => s.integrations);
  const digests = useApp((s) => s.digests);
  const connected = integrations.filter((i) => i.connected);
  const rows = connected.flatMap((i) => (digests[i.id]?.items ?? []).slice(0, 2).map((item) => ({ source: i.name, item })));

  return (
    <motion.section className="tile tile-feed" {...cardEnter(3)}>
      <h2>From your providers</h2>
      {connected.length === 0 && (
        <button className="text-button" onClick={() => openSettings("providers")}>
          <span className="meta">Connect a provider to see your issues, mail and calendar here.</span>
        </button>
      )}
      {connected.length > 0 && rows.length === 0 && <p className="meta">Nothing fetched yet.</p>}
      <ul className="list">
        {rows.slice(0, 3).map(({ source, item }, i) => (
          <motion.li key={source + item.key} {...rowEnter(i)}>
            <button className="feed-row" disabled={!item.url} title={item.url ? `Open on ${hostOf(item.url)}` : undefined} onClick={() => item.url && openLink(item.url)}>
              <span className="label grow truncate">{item.title}</span>
              <span className="meta">{source}</span>
            </button>
          </motion.li>
        ))}
      </ul>
    </motion.section>
  );
}

function Today() {
  const sessions = useApp((s) => s.sessions);
  const midnight = new Date().setHours(0, 0, 0, 0);
  const done = sessions.filter((s) => s.status === "completed" && (s.endedAt ?? 0) >= midnight).length;
  return (
    <motion.button className="tile tile-today" {...cardEnter(4)} onClick={() => setTab("agents")}>
      <span className="tile-kicker">Today</span>
      <span className="tile-number tabular">{done}</span>
      <span className="meta">{done === 1 ? "task finished" : "tasks finished"}</span>
    </motion.button>
  );
}

export function Home() {
  const text = useApp((s) => s.draft);
  const pending = useApp((s) => s.chatPending);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = text.trim();
    if (!prompt || pending) return;
    clearDraft();
    setTab("chat");
    void sendChat(prompt);
  };

  return (
    <div className="home">
      <div className="bento">
        <AgentsCard />
        <NextCard />
        <MusicCard />
        <Feed />
        <Today />
      </div>
      <form className="composer" onSubmit={submit}>
        <input aria-label="Ask anything" placeholder="Ask anything" value={text} onChange={(e) => setDraft(e.target.value)} />
        <button className="round solid" aria-label="Send" disabled={!text.trim() || pending}>
          <Icon name="send" size={14} />
        </button>
      </form>
    </div>
  );
}
