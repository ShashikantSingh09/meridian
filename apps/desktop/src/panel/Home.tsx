import { useState } from "react";
import { Icon } from "../lib/icons";
import { isReady, sendChat, setTab, useApp } from "../lib/store";

export function Home() {
  const providers = useApp((s) => s.providers);
  const localOnline = useApp((s) => s.localOnline);
  const agents = useApp((s) => s.agents);
  const sessions = useApp((s) => s.sessions);
  const [text, setText] = useState("");

  const ready = providers.filter((p) => isReady(p, localOnline));
  const installed = agents.filter((a) => a.installed);
  const active = sessions.filter((s) => ["starting", "running", "waiting"].includes(s.status));
  const recent = sessions.slice(0, 4);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = text.trim();
    if (!prompt) return;
    setText("");
    setTab("chat");
    void sendChat(prompt);
  };

  return (
    <div className="page-scroll stack-lg">
      <header className="stack-sm">
        <h1>Command center</h1>
        <p className="meta">
          {active.length > 0
            ? `${active.length} ${active.length === 1 ? "agent" : "agents"} working`
            : "Nothing running"}
        </p>
      </header>

      <form className="composer" onSubmit={submit}>
        <input
          aria-label="Ask anything"
          placeholder="Ask anything"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="round solid" aria-label="Send" disabled={!text.trim()}>
          <Icon name="send" size={14} />
        </button>
      </form>

      <section className="tiles">
        <button className="tile" onClick={() => setTab("agents")}>
          <span className="tile-value tabular">{installed.length}<small> / {agents.length}</small></span>
          <span className="meta">Coding agents found</span>
        </button>
        <button className="tile" onClick={() => setTab("providers")}>
          <span className="tile-value tabular">{ready.length}<small> / {providers.length}</small></span>
          <span className="meta">Providers ready</span>
        </button>
        <button className="tile" onClick={() => setTab("agents")}>
          <span className="tile-value tabular">{sessions.length}</span>
          <span className="meta">Sessions this run</span>
        </button>
      </section>

      <section className="stack-sm">
        <h2>Recent</h2>
        {recent.length === 0 ? (
          <p className="meta">Sessions you start from Agents appear here.</p>
        ) : (
          <ul className="list">
            {recent.map((s) => (
              <li key={s.id}>
                <button className="list-row" onClick={() => setTab("agents")}>
                  <span className="status-dot" data-status={s.status} />
                  <span className="label">{s.agent}</span>
                  <span className="meta grow truncate">{s.project}</span>
                  <span className="meta">{s.status}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
