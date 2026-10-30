import { useEffect, useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import { Icon } from "../lib/icons";
import {
  answerApproval,
  cancelChat,
  cancelSession,
  clearChat,
  isReady,
  newAgentConversation,
  refreshAuth,
  selectAgentConversation,
  selectEngine,
  selectProvider,
  sendAgentChat,
  sendChat,
  setAgentCwd,
  setAgentMode,
  setListening,
  setTab,
  useApp,
} from "../lib/store";
import type { AgentId } from "../lib/types";

const LIVE = ["starting", "running", "waiting"];

/** One selector for every engine, API or agent. */
function EnginePicker() {
  const providers = useApp((s) => s.providers);
  const localOnline = useApp((s) => s.localOnline);
  const agents = useApp((s) => s.agents);
  const providerId = useApp((s) => s.chat.providerId);
  const agent = useApp((s) => s.agentChat.agent);
  const ready = providers.filter((p) => isReady(p, localOnline));
  const installed = agents.filter((a) => a.installed);

  return (
    <select aria-label="AI engine" value={agent ?? providerId ?? ""} onChange={(e) => selectEngine(e.target.value)}>
      {ready.length === 0 && installed.length === 0 && <option value="">No engine ready</option>}
      {ready.length === 0 && installed.length > 0 && !agent && <option value="">Choose an engine</option>}
      {installed.length > 0 && (
        <optgroup label="Coding agents">
          {installed.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </optgroup>
      )}
      {ready.length > 0 && (
        <optgroup label="API and local models">
          {ready.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

function SignInBanner({ agent }: { agent: AgentId }) {
  const status = useApp((s) => s.auth[agent]);
  const name = useApp((s) => s.agents.find((a) => a.id === agent)?.name ?? agent);
  if (!status || status.signedIn !== false) return null;
  return (
    <div className="auth-banner" role="status">
      <span className="grow meta">{name} is not signed in. Sign-in happens in its own window, and this app never sees your credentials.</span>
      <button className="ghost" onClick={() => void refreshAuth(agent)}>Check again</button>
      <button className="solid" onClick={() => void bridge.agentLogin(agent)}>Sign in</button>
    </div>
  );
}

function AgentChat({ agent }: { agent: AgentId }) {
  const { mode, cwd, sessionId } = useApp((s) => s.agentChat);
  const defaultDir = useApp((s) => s.settings.agentDefaultDir);
  const sessions = useApp((s) => s.sessions);
  const auth = useApp((s) => s.auth[agent]);
  const conversations = sessions.filter((s) => s.surface === "chat" && s.agentId === agent);
  const session = conversations.find((s) => s.id === sessionId) ?? null;
  const live = session !== null && LIVE.includes(session.status);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const log = useRef<HTMLDivElement>(null);
  const folder = cwd ?? defaultDir;

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [session?.log]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = text.trim();
    if (!prompt) return;
    const references = files.map((f) => `- ${f}`).join("\n");
    setText("");
    setFiles([]);
    void sendAgentChat(files.length > 0 ? `${prompt}\n\nReferenced files:\n${references}` : prompt);
  };

  const attach = async () => {
    const picked = await bridge.pickFile();
    if (picked) setFiles((f) => [...f, picked]);
  };

  const browse = async () => {
    const picked = await bridge.pickFolder();
    if (picked) setAgentCwd(picked);
  };

  return (
    <div className="chat">
      <header className="row bar engine-bar">
        <EnginePicker />
        <select
          aria-label="Conversation"
          className="grow"
          value={session?.id ?? ""}
          onChange={(e) => (e.target.value ? selectAgentConversation(e.target.value) : newAgentConversation())}
        >
          <option value="">New conversation</option>
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>{c.title}</option>
          ))}
        </select>
        <div className="segmented" role="group" aria-label="Mode">
          <button aria-pressed={mode === "general"} disabled={session !== null} onClick={() => setAgentMode("general")}>General</button>
          <button aria-pressed={mode === "project"} disabled={session !== null} onClick={() => setAgentMode("project")}>Project</button>
        </div>
        {auth?.plan && <span className="meta" title={`Signed in with ${auth.method}`}>{auth.plan}</span>}
      </header>

      <SignInBanner agent={agent} />

      {mode === "project" && (
        <div className="row bar">
          <Icon name="folder" size={14} />
          <span className="meta truncate grow" title={folder ?? undefined}>{session?.cwd ?? folder ?? "No folder chosen"}</span>
          {session === null && <button className="ghost" onClick={() => void browse()}>Choose folder</button>}
          {session && <button className="ghost" onClick={() => void bridge.openProject(session.cwd)}>Open</button>}
        </div>
      )}

      {session?.approval && (
        <div className="approval">
          <span className="label">{session.agent} wants to run {session.approval.tool}</span>
          <code className="command" title={session.approval.summary}>{session.approval.summary}</code>
          <div className="row end">
            <button className="ghost" onClick={() => answerApproval(session.id, session.approval!.id, false)}>Deny</button>
            <button className="solid" onClick={() => answerApproval(session.id, session.approval!.id, true)}>Allow</button>
          </div>
        </div>
      )}

      <div className="log" ref={log} aria-live="polite">
        {session === null ? (
          <p className="meta center">
            {mode === "general"
              ? "General assistant: questions, research and explanations. No shell, no file edits, no project access."
              : "Project assistant: works in your folder, and asks before it changes anything."}
          </p>
        ) : (
          session.log.map((entry, i) => (
            <p key={i} className={`log-${entry.kind}`}>{entry.text}</p>
          ))
        )}
        {live && session?.status !== "waiting" && <p className="meta">{session?.activity || "Working"}</p>}
      </div>

      {files.length > 0 && (
        <div className="attachments">
          {files.map((f) => (
            <span key={f} className="attachment truncate" title={f}>{f.split(/[\\/]/).pop()}</span>
          ))}
        </div>
      )}

      {session?.usage && (
        <p className="meta tabular usage-line">
          {session.usage.input.toLocaleString()} in · {session.usage.output.toLocaleString()} out
        </p>
      )}

      <form className="composer" onSubmit={submit}>
        <button type="button" className="round" aria-label="Reference a file" title="Reference a file" onClick={() => void attach()}>
          <Icon name="plus" size={14} />
        </button>
        <input
          aria-label="Message"
          placeholder={session ? "Send a follow-up" : "Message"}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {live ? (
          <button type="button" className="round" aria-label="Stop" title="Stop this turn" onClick={() => cancelSession(session!.id)}>
            <Icon name="stop" size={14} />
          </button>
        ) : (
          <button className="round solid" aria-label="Send" disabled={!text.trim()}>
            <Icon name="send" size={14} />
          </button>
        )}
      </form>
    </div>
  );
}

function ApiChat() {
  const chat = useApp((s) => s.chat);
  const providers = useApp((s) => s.providers);
  const localOnline = useApp((s) => s.localOnline);
  const agents = useApp((s) => s.agents);
  const pending = useApp((s) => s.chatPending);
  const [text, setText] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const ready = providers.filter((p) => isReady(p, localOnline));
  const first = ready[0]?.id;
  const noEngine = ready.length === 0 && !agents.some((a) => a.installed);

  useEffect(() => {
    if (!chat.providerId && first) void selectProvider(first);
  }, [chat.providerId, first]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [chat.messages]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = text.trim();
    if (!prompt || pending) return;
    setText("");
    void sendChat(prompt);
  };

  return (
    <div className="chat">
      <header className="row bar">
        <EnginePicker />
        <select
          aria-label="Model"
          className="grow"
          value={chat.model ?? ""}
          onChange={(e) => chat.providerId && void selectProvider(chat.providerId, e.target.value)}
        >
          {chat.models.length === 0 && <option value="">{chat.model ?? "No models"}</option>}
          {chat.models.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        {chat.usage && (
          <span className="meta tabular" title="Tokens in / out, as reported by the provider">
            {chat.usage.input} / {chat.usage.output}
          </span>
        )}
        <button className="ghost" onClick={clearChat} disabled={chat.messages.length === 0}>New</button>
      </header>

      <div className="messages" ref={log} aria-live="polite">
        {chat.messages.length === 0 &&
          (noEngine ? (
            <div className="empty">
              <p className="label">No AI engine is ready yet</p>
              <p className="meta">Add an API key, or start a local server such as Ollama or LM Studio.</p>
              <button className="solid" onClick={() => setTab("providers")}>Set up a provider</button>
            </div>
          ) : (
            <p className="meta center">Say something to start.</p>
          ))}
        {chat.messages.map((m, i) => (
          <div key={i} className="message" data-role={m.role}>
            {m.images?.map((src, n) => <img key={n} className="message-image" src={src} alt="Shared from your screen" />)}
            {m.content || (pending && <span className="meta">Thinking</span>)}
          </div>
        ))}
      </div>

      <form className="composer" onSubmit={submit}>
        <button type="button" className="round" aria-label="Show microphone level" title="Microphone level preview. Speech to text arrives with voice." onClick={() => setListening(true)}>
          <Icon name="mic" size={14} />
        </button>
        <input aria-label="Message" placeholder="Message" value={text} onChange={(e) => setText(e.target.value)} />
        {pending ? (
          <button type="button" className="round" aria-label="Stop" onClick={cancelChat}>
            <Icon name="stop" size={14} />
          </button>
        ) : (
          <button className="round solid" aria-label="Send" disabled={!text.trim()}>
            <Icon name="send" size={14} />
          </button>
        )}
      </form>
    </div>
  );
}

export function Chat() {
  const agent = useApp((s) => s.agentChat.agent);
  return agent ? <AgentChat agent={agent} /> : <ApiChat />;
}
