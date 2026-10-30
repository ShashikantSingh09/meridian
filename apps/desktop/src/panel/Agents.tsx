import { useEffect, useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import { Icon } from "../lib/icons";
import { answerApproval, cancelSession, sendToSession, startSession, useApp, type SessionDetail, openSettings } from "../lib/store";
import { AgentMark } from "../island/marks";
import { LogLine } from "./LogLine";
import type { AgentId } from "../lib/types";

const LIVE = ["starting", "running", "waiting"];

function Session({ session }: { session: SessionDetail }) {
  const watching = useApp((s) => s.watching);
  const live = LIVE.includes(session.status);
  const [text, setText] = useState("");
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [session.log]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const message = text.trim();
    if (!message) return;
    setText("");
    void sendToSession(session.id, message);
  };

  return (
    <div className="session">
      <header className="row bar">
        <span className="status-dot" data-status={session.status} />
        <span className="label">{session.agent}</span>
        <span className="meta truncate grow">{session.project}{session.model ? ` · ${session.model}` : ""}</span>
        {session.watched && <span className="cap" title="Started in your own terminal">Terminal</span>}
        <button className="round" aria-label="Open project" title="Open project folder" onClick={() => void bridge.openProject(session.cwd)}>
          <Icon name="folder" size={14} />
        </button>
        {live && !session.watched && (
          <button className="round" aria-label="Stop session" title="Stop" onClick={() => cancelSession(session.id)}>
            <Icon name="stop" size={14} />
          </button>
        )}
      </header>

      {session.watched && !watching && (
        <div className="auth-banner" role="status">
          <span className="grow meta">Seen running in your terminal. To answer its questions from here, turn on following, then start a new session.</span>
          <button className="ghost" onClick={() => openSettings("agents")}>Turn on</button>
        </div>
      )}

      {session.approval && (
        <div className="approval">
          <span className="label">{session.approval.tool}</span>
          <code className="command">{session.approval.summary}</code>
          <div className="row end">
            <button className="ghost" onClick={() => answerApproval(session.id, session.approval!.id, false)}>Deny</button>
            <button className="allow" onClick={() => answerApproval(session.id, session.approval!.id, true)}>Allow</button>
          </div>
        </div>
      )}

      <div className="log" ref={log}>
        {session.log.map((entry, i) => (
          <LogLine key={i} entry={entry} />
        ))}
      </div>

      <footer className="row bar">
        {session.usage ? (
          <span className="meta tabular">
            {session.usage.input.toLocaleString()} in · {session.usage.output.toLocaleString()} out
            {session.usage.costUsd != null && ` · $${session.usage.costUsd.toFixed(4)}`}
          </span>
        ) : (
          <span className="meta">{session.status}</span>
        )}
      </footer>

      {!session.watched && (!session.restored || session.nativeId) && <form className="composer" onSubmit={submit}>
        <input
          aria-label="Instruction"
          placeholder={live ? "Send an instruction" : "Continue this session"}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="round solid" aria-label="Send instruction" disabled={!text.trim()}>
          <Icon name="send" size={14} />
        </button>
      </form>}
    </div>
  );
}

function NewSession({ onStarted }: { onStarted: (id: string) => void }) {
  const agents = useApp((s) => s.agents);
  const installed = agents.filter((a) => a.installed);
  const [agent, setAgent] = useState<AgentId | "">(installed[0]?.id ?? "");
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agent || !cwd.trim() || !prompt.trim()) return;
    const id = await startSession({ agent, cwd: cwd.trim(), prompt: prompt.trim(), model: null });
    if (id) onStarted(id);
  };

  return (
    <form className="new-session stack" onSubmit={start}>
      <h2>New session</h2>
      <div className="agent-cards">
        {agents.map((a) => (
          <label key={a.id} className="agent-card" data-disabled={!a.installed}>
            <input type="radio" name="agent" value={a.id} checked={agent === a.id} disabled={!a.installed} onChange={() => setAgent(a.id)} />
            <span className="label">{a.name}</span>
            <span className="meta truncate">{a.installed ? a.version ?? "Installed" : "Not found"}</span>
          </label>
        ))}
      </div>
      <div className="field-row">
        <input aria-label="Project folder" placeholder="Project folder" value={cwd} onChange={(e) => setCwd(e.target.value)} />
        <button
          type="button"
          className="ghost"
          onClick={async () => {
            const picked = await bridge.pickFolder();
            if (picked) setCwd(picked);
          }}
        >
          Browse
        </button>
      </div>
      <textarea aria-label="Task" placeholder="What should it do?" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <p className="meta">
        Runs with your own agent settings. Hooks and servers configured inside the folder load without a
        trust prompt, so start sessions only in folders you trust.
      </p>
      <div className="row end">
        <button className="solid" disabled={!agent || !cwd.trim() || !prompt.trim()}>Start</button>
      </div>
    </form>
  );
}

export function Agents() {
  const sessions = useApp((s) => s.sessions);
  const [selected, setSelected] = useState<string | null>(null);
  const session = sessions.find((s) => s.id === selected) ?? null;

  return (
    <div className="split">
      <aside className="session-list">
        <button className="list-row" data-active={session === null} onClick={() => setSelected(null)}>
          <Icon name="plus" size={14} />
          <span className="label">New session</span>
        </button>
        {sessions.map((s) => (
          <button key={s.id} className="list-row" data-active={s.id === selected} onClick={() => setSelected(s.id)}>
            <AgentMark agent={s.agent} size={16} live={s.status === "running" || s.status === "starting"} />
            <span className="stacked grow">
              <span className="label truncate">{s.agent}</span>
              <span className="meta truncate">{s.project}</span>
            </span>
          </button>
        ))}
      </aside>
      {session ? <Session session={session} /> : <NewSession onStarted={setSelected} />}
    </div>
  );
}
