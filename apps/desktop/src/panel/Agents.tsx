import { useEffect, useState } from "react";
import { bridge } from "../lib/bridge";
import { Icon } from "../lib/icons";
import { ago, blocksOf, changedFiles, doing, groupSessions, lastActive, limitName, limitStop, memoryUsed, modelName, recentLines, resetLabel, tileState, type FileChange, type Step } from "../lib/sessions";
import { cancelSession, clearAgentFocus, clearFinished, sendToSession, startSession, useApp, type SessionDetail, openSettings } from "../lib/store";
import { AgentMark } from "../island/marks";
import { ApprovalCard } from "../island/views";
import { LogLine, StepRow, useFollow } from "./LogLine";
import type { AgentId } from "../lib/types";

const LIVE = ["starting", "running", "waiting"];

type View = "activity" | "changes";

/** A run of tool actions, each with the end of anything it printed. */
function StepList({ steps, start }: { steps: Step[]; start: number }) {
  return (
    <div className="step-list">
      {steps.map((step, i) => (
        <div key={i}>
          <StepRow step={step} start={start} />
          {step.output?.map((line, n) => <div key={n} className="step-output" data-failed={step.failed}>{line}</div>)}
        </div>
      ))}
    </div>
  );
}

/** Each file an agent touched, and the lines it took out and put in. The agent reports no line
 *  numbers, so there are none to show. */
function Changes({ files }: { files: FileChange[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const file = files.find((f) => f.path === picked) ?? files[0];
  if (!file) return <div className="changes"><p className="meta">No changes yet.</p></div>;
  const line = (change: "removed" | "added", sign: string, text: string, i: number) => (
    <div key={`${change}${i}`} className="change-line" data-change={change}><i>{sign}</i><span>{text}</span></div>
  );
  return (
    <div className="changes">
      <div className="change-files" role="group" aria-label="Files changed">
        {files.map((f) => (
          <button key={f.path} className="change-file" aria-pressed={f === file} onClick={() => setPicked(f.path)}>
            <span className="grow truncate">{f.path}</span>
            <span className="change-added">+{f.added}</span>
            <span className="change-removed">-{f.removed}</span>
          </button>
        ))}
      </div>
      <div className="change-body">
        {file.edits.map((edit, i) => {
          const shown = (edit.removed?.length ?? 0) + (edit.added?.length ?? 0);
          const lines = (edit.linesRemoved ?? 0) + (edit.linesAdded ?? 0);
          return (
            <div key={i} className="change-edit">
              {edit.removed?.map((text, n) => line("removed", "-", text, n))}
              {edit.added?.map((text, n) => line("added", "+", text, n))}
              {shown === 0 && <p className="change-note">Written in one go, {edit.linesAdded} {edit.linesAdded === 1 ? "line" : "lines"}.</p>}
              {shown > 0 && shown < lines && <p className="change-note">Cut short here. {lines} lines changed in all.</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Session({ session, view, setView }: { session: SessionDetail; view: View; setView: (view: View) => void }) {
  const watching = useApp((s) => s.watching);
  const limit = useApp((s) => limitStop(session, s.limits[session.agentId]?.windows, Date.now()));
  const live = LIVE.includes(session.status);
  const [text, setText] = useState("");
  const follow = useFollow(session.log, session.id, `${view}${session.approval?.id}`);
  const model = modelName(session.model);
  const memory = memoryUsed(session);
  const files = changedFiles(session.log);
  const numbers = [
    memory !== null && `${memory}% of memory`,
    session.usage?.costUsd != null && `$${session.usage.costUsd.toFixed(2)}`,
    session.usage && `${session.usage.input.toLocaleString()} in, ${session.usage.output.toLocaleString()} out`,
  ].filter(Boolean).join(", ");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const message = text.trim();
    if (!message) return;
    setText("");
    void sendToSession(session.id, message);
  };

  return (
    <div className="session">
      <header className="session-head">
        <div className="row">
          <span className="stacked grow">
            <span className="label truncate" title={session.title}>{session.title || session.project}</span>
            <span className="meta truncate">{session.project}, {doing(session)}</span>
          </span>
          {session.watched && <span className="cap" title="Started in your own terminal">Terminal</span>}
          <button className="round" aria-label="Open project" title="Open project folder" onClick={() => void bridge.openProject(session.cwd)}>
            <Icon name="folder" size={14} />
          </button>
          {live && !session.watched && (
            <button className="round" aria-label="Stop session" title="Stop" onClick={() => cancelSession(session.id)}>
              <Icon name="stop" size={14} />
            </button>
          )}
        </div>
        <div className="row session-facts">
          <div className="segmented session-tabs" role="group" aria-label="What to show">
            <button aria-pressed={view === "activity"} onClick={() => setView("activity")}>Activity</button>
            <button aria-pressed={view === "changes"} onClick={() => setView("changes")}>
              Changes{files.length > 0 && <span className="tabular"> +{files.reduce((n, f) => n + f.added, 0)} -{files.reduce((n, f) => n + f.removed, 0)}</span>}
            </button>
          </div>
          <span className="grow" />
          {model && <span className="session-fact"><AgentMark agent={session.agent} size={13} live={false} />{model}</span>}
          {numbers && <span className="meta truncate session-numbers" title="How full this conversation is, and what it has used">{numbers}</span>}
        </div>
      </header>

      {session.watched && !watching && (
        <div className="auth-banner" role="status">
          <span className="grow meta">Seen running in your terminal. To answer its questions from here, turn on following, then start a new session.</span>
          <button className="ghost" onClick={() => openSettings("agents")}>Turn on</button>
        </div>
      )}

      {limit && view === "activity" && (
        <div className="limit-stop">
          <div className="row">
            <span className="label grow">{session.agent.replace(/ (Code|CLI)$/, "")} limit reached</span>
            <span className="cap">{resetLabel(limit.resetsAt, Date.now())}</span>
          </div>
          <p>This session has stopped where it was. Nothing is lost, and you can carry on from here when the limit resets.</p>
        </div>
      )}

      {view === "changes" ? <Changes key={session.id} files={files} /> : (
        <div className="log" {...follow}>
          {blocksOf(session.log, session.status === "failed").map((block, i) =>
            "steps" in block ? <StepList key={i} steps={block.steps} start={session.startedAt} /> : <LogLine key={i} entry={block.entry} />,
          )}
        </div>
      )}

      {session.approval && (
        <div className="approval">
          <ApprovalCard sessionId={session.id} approval={session.approval} panel />
        </div>
      )}

      {!session.watched && (!session.restored || session.nativeId) && <form className="composer" onSubmit={submit}>
        <input
          aria-label="Instruction"
          placeholder={view === "changes" ? "Ask for a change to this" : live ? "Send an instruction" : "Continue this session"}
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

function Meter({ label, percent, note }: { label: string; percent: number; note?: string }) {
  const shown = Math.round(percent);
  return (
    <div className="meter" data-level={shown >= 100 ? "full" : shown >= 80 ? "high" : "fine"}>
      <span className="meter-name">{label}</span>
      <span className="meter-track" role="progressbar" aria-label={`${label} limit used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={shown}>
        <i style={{ width: `${Math.min(shown, 100)}%` }} />
      </span>
      <span className="meter-value">{shown}%</span>
      {note !== undefined && <span className="meter-note">{note}</span>}
    </div>
  );
}

const ACCOUNTS: { id: AgentId; name: string }[] = [
  { id: "claude-code", name: "Claude" },
  { id: "codex", name: "ChatGPT" },
];

/** The plan named the way the agent reports it, as in Claude Max. */
function usePlan(id: AgentId) {
  return useApp((s) => s.auth[id]?.plan ?? null);
}

function LimitCard({ onOpen, active }: { onOpen: () => void; active: boolean }) {
  const limits = useApp((s) => s.limits);
  const account = ACCOUNTS.find((a) => limits[a.id]);
  const plan = usePlan(account?.id ?? "claude-code");
  if (!account) {
    return (
      <button className="limit-card" data-active={active} onClick={onOpen}>
        <span className="label">Limits and models</span>
      </button>
    );
  }
  return (
    <button className="limit-card" data-active={active} onClick={onOpen}>
      <span className="label">{account.name}{plan ? ` ${plan[0]!.toUpperCase()}${plan.slice(1)}` : ""}</span>
      {limits[account.id]!.windows.map((w) => <Meter key={w.window} label={limitName(w.window)} percent={w.usedPercent} />)}
    </button>
  );
}

function Account({ id, name }: { id: AgentId; name: string }) {
  const seen = useApp((s) => s.limits[id]);
  const plan = usePlan(id);
  if (!seen) return null;
  const now = Date.now();
  return (
    <div className="limit-account">
      <div className="row">
        <AgentMark agent={id === "codex" ? "Codex CLI" : "Claude Code"} size={18} live={false} />
        <span className="label grow">{name}</span>
        {plan && <span className="cap">{plan[0]!.toUpperCase()}{plan.slice(1)}</span>}
      </div>
      {seen.windows.map((w) => <Meter key={w.window} label={limitName(w.window)} percent={w.usedPercent} note={resetLabel(w.resetsAt, now)} />)}
    </div>
  );
}

/** How much of each plan is used, and what is running. */
function Limits() {
  const limits = useApp((s) => s.limits);
  const sessions = useApp((s) => s.sessions);
  const running = sessions.filter((s) => s.surface !== "chat" && LIVE.includes(s.status));
  const times = Object.values(limits).map((l) => l.at);
  const updated = times.length ? new Date(Math.max(...times)).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toLowerCase() : null;
  return (
    <div className="page-scroll stack-lg limits">
      <div>
        <h1>Limits and models</h1>
        <p className="meta">How much of each plan is used, and what is running.</p>
      </div>
      {ACCOUNTS.map((a) => <Account key={a.id} {...a} />)}
      {running.length > 0 && (
        <section className="stack-sm">
          <h2>Running now</h2>
          <div className="limit-account">
            {running.map((s) => {
              const memory = memoryUsed(s);
              return (
                <div className="row" key={s.id}>
                  <AgentMark agent={s.agent} size={18} live={false} />
                  <span className="stacked grow">
                    <span className="label truncate">{s.project}</span>
                    <span className="meta truncate">{[modelName(s.model), s.watched ? "in your terminal" : null].filter(Boolean).join(", ") || s.agent}</span>
                  </span>
                  {memory !== null && <span className="meta">{memory}% of memory</span>}
                  <span className="label">{s.usage?.costUsd != null ? `$${s.usage.costUsd.toFixed(2)}` : "Plan"}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}
      <p className="meta">
        {updated ? `Updated ${updated}. ` : "Nothing reported yet. "}
        Claude Code and Codex report these while a session runs here, so they can be a few minutes old. Sessions in your own terminal do not report them.
      </p>
    </div>
  );
}

function Row({ session, active, now, onOpen }: { session: SessionDetail; active: boolean; now: number; onOpen: () => void }) {
  return (
    <button className="list-row session-row" data-active={active} onClick={onOpen}>
      <AgentMark agent={session.agent} size={18} live={session.status === "running" || session.status === "starting"} />
      <span className="stacked grow">
        <span className="session-top">
          <span className="label truncate grow">{session.project}</span>
          <span className="meta">{ago(lastActive(session), now)}</span>
        </span>
        <span className="session-doing">
          <span className="status-dot" data-status={session.approval ? "waiting" : session.status} />
          <span className="meta truncate">{doing(session)}</span>
        </span>
      </span>
    </button>
  );
}

/** One agent among the rest. A plain request can be answered here. A question or a plan needs reading. */
function Tile({ session, now, onOpen }: { session: SessionDetail; now: number; onOpen: () => void }) {
  const { approval } = session;
  const simple = approval && !approval.questions?.length && !approval.plan;
  return (
    <div className="agent-tile" data-needs={approval !== null}>
      <button className="agent-tile-head" onClick={onOpen}>
        <AgentMark agent={session.agent} size={20} live={false} />
        <span className="stacked grow">
          <span className="label truncate">{session.project}</span>
          <span className="session-doing">
            <span className="status-dot" data-status={approval ? "waiting" : session.status} />
            <span className="meta truncate">{tileState(session, now)}</span>
          </span>
        </span>
        {session.model && <span className="cap">{modelName(session.model)?.replace(/^Claude /, "")}</span>}
      </button>
      {simple ? (
        <ApprovalCard sessionId={session.id} approval={approval} />
      ) : (
        <div className="agent-tile-lines">
          {(approval ? [approval.summary] : recentLines(session)).map((line, i) => <div key={i} className="truncate">{line}</div>)}
        </div>
      )}
    </div>
  );
}

function AllAgents({ onOpen, onBack, onNew }: { onOpen: (id: string) => void; onBack: () => void; onNew: () => void }) {
  const sessions = useApp((s) => s.sessions);
  const now = Date.now();
  const { needs, running, finished, earlier } = groupSessions(sessions, now);
  return (
    <div className="agents-all">
      <div className="row">
        <h2 className="title grow">All agents</h2>
        <button className="ghost" onClick={onBack}>Back to list</button>
        <button className="solid" onClick={onNew}>New session</button>
      </div>
      <div className="agent-tiles">
        {[...needs, ...running, ...finished, ...earlier].map((s) => <Tile key={s.id} session={s} now={now} onOpen={() => onOpen(s.id)} />)}
      </div>
    </div>
  );
}

export function Agents() {
  const sessions = useApp((s) => s.sessions);
  const focus = useApp((s) => s.agentFocus);
  const [selected, setSelected] = useState<string | null>(focus?.id ?? null);
  const [view, setView] = useState<View>(focus?.view ?? "activity");
  const [showAll, setShowAll] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  const session = sessions.find((s) => s.id === selected) ?? null;
  const now = Date.now();
  const { needs, running, finished, earlier } = groupSessions(sessions, now);
  const open = (id: string | null) => {
    setSelected(id);
    setView("activity");
    setShowAll(false);
  };
  // Asked for from the island, which can happen while this page is already open.
  useEffect(() => {
    if (!focus) return;
    setSelected(focus.id);
    setView(focus.view);
    setShowAll(false);
    clearAgentFocus();
  }, [focus]);
  const row = (s: SessionDetail) => <Row key={s.id} session={s} active={s.id === selected} now={now} onOpen={() => open(s.id)} />;
  const group = (name: string, list: SessionDetail[], extra?: React.ReactNode) =>
    list.length > 0 && (
      <section>
        <h2 className="session-group"><span className="grow">{name}</span>{extra}<span>{list.length}</span></h2>
        {list.map(row)}
      </section>
    );

  if (showAll) return <AllAgents onOpen={open} onBack={() => setShowAll(false)} onNew={() => open(null)} />;

  return (
    <div className="split">
      <aside className="session-list">
        <div className="session-tools">
          <button className="session-new" data-active={selected === null} onClick={() => open(null)}>
            <Icon name="plus" size={14} />
            New session
          </button>
          {sessions.some((s) => s.surface !== "chat") && (
            <button className="session-all" aria-label="See all at once" title="See all at once" onClick={() => setShowAll(true)}>
              <Icon name="window" size={15} />
            </button>
          )}
        </div>
        <div className="session-rows">
          {group("Needs you", needs)}
          {group("Running", running)}
          {group("Finished", finished, finished.length + earlier.length > 0 && <button className="session-clear" onClick={clearFinished}>Clear</button>)}
          {earlier.length > 0 && (
            <section>
              <button className="session-group session-fold" aria-expanded={showEarlier} onClick={() => setShowEarlier(!showEarlier)}>
                <span className="grow">Earlier</span>
                <span>{earlier.length}</span>
              </button>
              {showEarlier && earlier.map(row)}
            </section>
          )}
        </div>
        <LimitCard active={selected === "limits"} onOpen={() => setSelected("limits")} />
      </aside>
      {selected === "limits" ? <Limits /> : session ? <Session session={session} view={view} setView={setView} /> : <NewSession onStarted={open} />}
    </div>
  );
}
