import { spring } from "@meridian/design-system/motion";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import { Brand } from "../lib/brands";
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
  shareCapture,
  openSettings,
  useApp,
} from "../lib/store";
import type { AgentId } from "../lib/types";
import { Face } from "../island/faces";
import { startVoice } from "../lib/voice";
import { LogLine } from "./LogLine";
import { LookButton, LookChips, lookGreeting, LookPill, seenName } from "./Look";
import { Markdown } from "./Markdown";
import { Menu } from "./Menu";

const LIVE = ["starting", "running", "waiting"];

/** Every AI that is ready, side by side. One click switches. */
function EnginePicker() {
  const providers = useApp((s) => s.providers);
  const localOnline = useApp((s) => s.localOnline);
  const agents = useApp((s) => s.agents);
  const providerId = useApp((s) => s.chat.providerId);
  const agent = useApp((s) => s.agentChat.agent);
  const current = agent ?? providerId;
  const engines = [...agents.filter((a) => a.installed), ...providers.filter((p) => isReady(p, localOnline))];

  if (engines.length === 0) {
    return <button className="engine-connect" onClick={() => openSettings("models")}>Connect an AI</button>;
  }
  return (
    <div className="engines" role="radiogroup" aria-label="AI engine">
      {engines.map((e) => (
        <button key={e.id} className="engine" role="radio" aria-checked={e.id === current} onClick={() => selectEngine(e.id)}>
          {e.id === current && <motion.span layoutId="engine-pill" className="engine-pill" transition={spring.hover} />}
          <span className="engine-label">
            <Brand id={e.id} name={e.name} size={18} />
            {e.name}
          </span>
        </button>
      ))}
      <button className="engine engine-add" aria-label="Add an AI" title="Add an AI" onClick={() => openSettings("models")}>
        <Icon name="plus" size={13} />
      </button>
    </div>
  );
}

/** The empty chat: the face, what it can do, and what it has just looked at. */
function ChatStart({ hello, note }: { hello: string; note: string }) {
  const face = useApp((s) => s.settings.face);
  const off = useApp((s) => s.settings.screenMode === "off");
  const capture = useApp((s) => s.screen.capture);
  const words = lookGreeting(hello, note, capture ? (seenName(capture.window?.process) ?? "that") : null, off);
  return (
    <div className="chat-start">
      <Face id={face} mood="rest" scale={1.4} />
      <p className="chat-hello">{words.hello}</p>
      <p className="meta">{words.note}</p>
      <LookChips />
    </div>
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
  const capture = useApp((s) => s.screen.capture);
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
    if (capture) return shareCapture(prompt);
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
        <Menu
          label="Conversation"
          value={session?.id ?? ""}
          items={[{ value: "", label: "New chat" }, ...conversations.map((c) => ({ value: c.id, label: c.title }))]}
          empty="New chat"
          onPick={(id) => (id ? selectAgentConversation(id) : newAgentConversation())}
        />
        <div className="segmented" role="group" aria-label="Mode">
          <button aria-pressed={mode === "general"} disabled={session !== null} onClick={() => setAgentMode("general")}>General</button>
          <button aria-pressed={mode === "project"} disabled={session !== null} onClick={() => setAgentMode("project")}>Project</button>
        </div>
        {auth?.plan && <span className="meta" title={`Signed in with ${auth.method}`}>{auth.plan}</span>}
      </header>

      <SignInBanner agent={agent} />
      <LookPill />

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
            <button className="allow" onClick={() => answerApproval(session.id, session.approval!.id, true)}>Allow</button>
          </div>
        </div>
      )}

      <div className="log" ref={log} aria-live="polite">
        {session === null ? (
          <ChatStart
            hello={mode === "general" ? "What can I do for you?" : "What should we work on?"}
            note={mode === "general" ? "Ask anything." : "I work in your folder, and ask before changing anything."}
          />
        ) : (
          session.log.map((entry, i) => <LogLine key={i} entry={entry} />)
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
        <button type="button" className="round" aria-label="Talk" title="Talk. Or hold Ctrl Alt V anywhere." onClick={() => void startVoice("turn")}>
          <Icon name="mic" size={14} />
        </button>
        <LookButton />
        <button type="button" className="round" aria-label="Reference a file" title="Reference a file" onClick={() => void attach()}>
          <Icon name="plus" size={14} />
        </button>
        <input
          aria-label="Message"
          placeholder={capture ? "Ask about what is here" : session ? "Ask on" : "Ask anything"}
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
  const face = useApp((s) => s.settings.face);
  const capture = useApp((s) => s.screen.capture);
  const chat = useApp((s) => s.chat);
  const providers = useApp((s) => s.providers);
  const localOnline = useApp((s) => s.localOnline);
  const agents = useApp((s) => s.agents);
  const pending = useApp((s) => s.chatPending);
  const [text, setText] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const ready = providers.filter((p) => isReady(p, localOnline));
  const first = ready[0]?.id;
  const firstAgent = agents.find((a) => a.installed)?.id;
  const noEngine = !first && !firstAgent;

  // Chat opens on an AI, so nobody meets an empty choice.
  useEffect(() => {
    if (chat.providerId) return;
    if (first) void selectProvider(first);
    else if (firstAgent) selectEngine(firstAgent);
  }, [chat.providerId, first, firstAgent]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [chat.messages]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = text.trim();
    if (!prompt || pending) return;
    setText("");
    if (capture) return shareCapture(prompt);
    void sendChat(prompt);
  };

  return (
    <div className="chat">
      <header className="row bar engine-bar">
        <EnginePicker />
        {chat.providerId && (
          <Menu
            label="Model"
            value={chat.model ?? ""}
            items={chat.models.map((m) => ({ value: m.id, label: m.label }))}
            empty={chat.model ?? "No models"}
            onPick={(id) => chat.providerId && void selectProvider(chat.providerId, id)}
          />
        )}
        {chat.usage && (
          <span className="meta tabular" title="Tokens in / out, as reported by the provider">
            {chat.usage.input} / {chat.usage.output}
          </span>
        )}
        <button className="pill-button" onClick={clearChat} disabled={chat.messages.length === 0}>New chat</button>
      </header>

      <LookPill />
      <div className="messages" ref={log} aria-live="polite">
        {chat.messages.length === 0 &&
          (noEngine ? (
            <div className="chat-start">
              <Face id={face} mood="asleep" scale={1.4} />
              <p className="chat-hello">Connect an AI to start</p>
              <p className="meta">Sign in with the account you already have, or run a model on this PC.</p>
              <button className="solid" onClick={() => openSettings("models")}>Choose your AI</button>
            </div>
          ) : (
            <ChatStart hello="What can I do for you?" note="Ask anything." />
          ))}
        {chat.messages.map((m, i) => (
          <div key={i} className="message" data-role={m.role}>
            {m.images?.map((src, n) => <img key={n} className="message-image" src={src} alt="Shared from your screen" />)}
            {m.role === "assistant" && m.content ? <Markdown text={m.content} /> : m.content || (pending && <span className="meta">Thinking</span>)}
          </div>
        ))}
      </div>

      <form className="composer" onSubmit={submit}>
        <button type="button" className="round" aria-label="Talk" title="Talk. Or hold Ctrl Alt V anywhere." onClick={() => void startVoice("turn")}>
          <Icon name="mic" size={14} />
        </button>
        <LookButton />
        <input aria-label="Message" placeholder={capture ? "Ask about what is here" : chat.messages.length ? "Ask on" : "Ask anything"} value={text} onChange={(e) => setText(e.target.value)} />
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
