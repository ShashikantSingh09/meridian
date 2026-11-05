import { useEffect, useState } from "react";
import { bridge } from "../lib/bridge";
import { Brand } from "../lib/brands";
import { Icon } from "../lib/icons";
import { lastActive, memoryUsed } from "../lib/sessions";
import {
  addDraftFile,
  cancelChat,
  cancelSession,
  clearChat,
  clearDraft,
  isReady,
  newAgentConversation,
  pickEngine,
  pushError,
  refreshAuth,
  retryLast,
  selectAgentConversation,
  selectEngine,
  selectProvider,
  sendAgentChat,
  sendChat,
  setAgentCwd,
  setAgentMode,
  setDraft,
  shareCapture,
  openSettings,
  useApp,
  type LogEntry,
  type SessionDetail,
} from "../lib/store";
import type { AgentId } from "../lib/types";
import { Face } from "../island/faces";
import { ApprovalCard } from "../island/views";
import { speakable } from "../lib/turns";
import { say, startVoice } from "../lib/voice";
import { LogLine, useFollow } from "./LogLine";
import { LookButton, LookCard, LookChips } from "./Look";
import { Markdown } from "./Markdown";
import { Menu } from "./Menu";

const LIVE = ["starting", "running", "waiting"];
const ADD_ENGINE = "add";

/** The API chat has a single conversation, with no time on it, so it has a heading of its own. */
function ChatSide() {
  const sessions = useApp((s) => s.sessions);
  const agent = useApp((s) => s.agentChat.agent);
  const sessionId = useApp((s) => s.agentChat.sessionId);
  const messages = useApp((s) => s.chat.messages);
  const providerId = useApp((s) => s.chat.providerId);
  const providers = useApp((s) => s.providers);
  const localOnline = useApp((s) => s.localOnline);
  const [query, setQuery] = useState("");

  const wanted = query.trim().toLowerCase();
  const found = (title: string) => title.toLowerCase().includes(wanted);
  const midnight = new Date().setHours(0, 0, 0, 0);
  const talks = sessions.filter((s) => s.surface === "chat" && found(s.title)).sort((a, b) => lastActive(b) - lastActive(a));
  const today = talks.filter((s) => lastActive(s) >= midnight);
  const earlier = talks.filter((s) => lastActive(s) < midnight);

  const provider = providers.find((p) => p.id === providerId);
  const asked = chatTitle(messages);
  const open = asked !== null && found(asked);
  const toApi = () => {
    const id = providerId ?? providers.find((p) => isReady(p, localOnline))?.id;
    if (agent && id) selectEngine(id);
  };

  const row = (s: SessionDetail) => (
    <button
      key={s.id}
      className="conv"
      aria-current={agent === s.agentId && sessionId === s.id ? "true" : undefined}
      onClick={() => {
        if (agent !== s.agentId) selectEngine(s.agentId);
        selectAgentConversation(s.id);
      }}
    >
      <Brand id={s.agentId} name={s.agent} size={15} />
      <span className="truncate grow">{s.title}</span>
    </button>
  );

  return (
    <aside className="chat-side" aria-label="Conversations">
      <button className="chat-new" disabled={agent ? sessionId === null : messages.length === 0} onClick={() => (agent ? newAgentConversation() : clearChat())}>
        <Icon name="plus" size={14} /> New chat
      </button>
      <label className="chat-search">
        <Icon name="search" size={14} />
        <input aria-label="Search chats" placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="chat-convs">
        {open && (
          <>
            <p className="conv-head">Open</p>
            <button className="conv" aria-current={agent === null ? "true" : undefined} onClick={toApi}>
              <Brand id={providerId ?? ""} name={provider?.name ?? "AI"} size={15} />
              <span className="truncate grow">{asked}</span>
            </button>
          </>
        )}
        {today.length > 0 && <p className="conv-head">Today</p>}
        {today.map(row)}
        {earlier.length > 0 && <p className="conv-head">Earlier</p>}
        {earlier.map(row)}
        {wanted && !open && talks.length === 0 && <p className="meta conv-none">No chats match that.</p>}
      </div>
    </aside>
  );
}

/** A conversation is called by the first thing asked in it. */
function chatTitle(messages: { role: string; content: string }[]) {
  return messages.find((m) => m.role === "user")?.content.split("\n")[0]?.slice(0, 60) ?? null;
}

/** Every AI that is ready, in one pill. One click switches. */
function EnginePicker() {
  const providers = useApp((s) => s.providers);
  const localOnline = useApp((s) => s.localOnline);
  const agents = useApp((s) => s.agents);
  const providerId = useApp((s) => s.chat.providerId);
  const agent = useApp((s) => s.agentChat.agent);
  const localOnly = useApp((s) => s.settings.localOnly);
  const current = agent ?? providerId ?? "";
  // Agents reach their makers' servers, so local-only mode does not offer them.
  const engines = [...agents.filter((a) => a.installed && !localOnly), ...providers.filter((p) => isReady(p, localOnline))];

  if (engines.length === 0) {
    return <button className="engine-connect" onClick={() => openSettings("models")}>Connect an AI</button>;
  }
  return (
    <Menu
      label="AI engine"
      value={current}
      items={[
        ...engines.map((e) => ({ value: e.id, label: e.name, icon: <Brand id={e.id} name={e.name} size={15} /> })),
        { value: ADD_ENGINE, label: "Add an AI", icon: <Icon name="plus" size={13} /> },
      ]}
      empty="Choose an AI"
      onPick={(id) => (id === ADD_ENGINE ? openSettings("models") : selectEngine(id))}
    />
  );
}

/** The empty chat: the face and what it can do. Once it has looked, the look takes this place. */
function ChatStart({ hello, note }: { hello: string; note: string }) {
  const face = useApp((s) => s.settings.face);
  const off = useApp((s) => s.settings.screenMode === "off");
  return (
    <div className="chat-start">
      <Face id={face} mood="rest" scale={1.4} />
      <p className="chat-hello">{hello}</p>
      <p className="meta">{off ? note : `${note} Or let me look at your screen.`}</p>
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

/** Steps show one by one while they happen. Afterwards they fold away, so the answer reads as an answer. */
function Steps({ lines, live, waiting }: { lines: string[]; live: boolean; waiting: boolean }) {
  const [open, setOpen] = useState(false);
  if (live || open) {
    return (
      <div className="plate chat-steps">
        {lines.map((line, i) => {
          const [verb, ...rest] = line.split(" ");
          const now = live && !waiting && i === lines.length - 1;
          return (
            <div key={i} className="chat-step" data-now={now}>
              {now ? <i className="live-dot" /> : <Icon name="check" size={13} />}
              <span>{verb}</span>
              <code className="truncate">{rest.join(" ")}</code>
            </div>
          );
        })}
        {!live && <button className="text-button look-more" aria-expanded="true" onClick={() => setOpen(false)}>Fold away</button>}
      </div>
    );
  }
  return (
    <button className="chat-steps-closed" aria-expanded="false" onClick={() => setOpen(true)}>
      <Icon name="chevron" size={11} /> {lines.length} {lines.length === 1 ? "step" : "steps"}
    </button>
  );
}

/** The session's log, with each run of steps gathered into one block. */
function Turns({ session, live }: { session: SessionDetail; live: boolean }) {
  const runs: (LogEntry | string[])[] = [];
  for (const entry of session.log) {
    const last = runs[runs.length - 1];
    if (entry.kind !== "activity") runs.push(entry);
    else if (Array.isArray(last)) last.push(entry.text);
    else runs.push([entry.text]);
  }
  return runs.map((run, i) =>
    Array.isArray(run) ? (
      <Steps key={i} lines={run} live={live && i === runs.length - 1} waiting={session.status === "waiting"} />
    ) : (
      <LogLine key={i} entry={run} />
    ),
  );
}

/** Under the latest answer. */
function ReplyActions({ text, retry }: { text: string; retry: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  const read = () => say(speakable(text)).catch((err: unknown) => pushError({ title: "Could not read that aloud", body: String(err) }));
  return (
    <div className="reply-actions">
      <button className="round" aria-label="Copy" title="Copy" onClick={() => void copy()}><Icon name={copied ? "check" : "copy"} size={14} /></button>
      <button className="round" aria-label="Try again" title="Try again" onClick={retry}><Icon name="retry" size={14} /></button>
      <button className="round" aria-label="Read aloud" title="Read aloud" onClick={() => void read()}><Icon name="lines" size={14} /></button>
    </div>
  );
}

function Composer({ start, placeholder, stop, canSend, onSend }: { start?: React.ReactNode; placeholder: string; stop: { title: string; run: () => void } | null; canSend: boolean; onSend: (prompt: string) => void }) {
  const text = useApp((s) => s.draft);
  const capture = useApp((s) => s.screen.capture);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = text.trim();
    if (prompt && canSend) onSend(prompt);
  };
  return (
    <form className="composer" onSubmit={submit}>
      {start}
      <LookButton />
      <input aria-label="Message" placeholder={capture ? "Ask about what is here" : placeholder} value={text} onChange={(e) => setDraft(e.target.value)} />
      <button type="button" className="round" aria-label="Talk" title="Talk. Or hold Ctrl Alt V anywhere." onClick={() => void startVoice("turn")}>
        <Icon name="mic" size={15} />
      </button>
      {stop ? (
        <button type="button" className="round stop" aria-label="Stop" title={stop.title} onClick={stop.run}>
          <Icon name="stop" size={14} />
        </button>
      ) : (
        <button className="round solid" aria-label="Send" disabled={!text.trim()}>
          <Icon name="send" size={14} />
        </button>
      )}
    </form>
  );
}

function AgentChat({ agent }: { agent: AgentId }) {
  const { mode: chosen, cwd, sessionId } = useApp((s) => s.agentChat);
  const capture = useApp((s) => s.screen.capture);
  const defaultDir = useApp((s) => s.settings.agentDefaultDir);
  const sessions = useApp((s) => s.sessions);
  const auth = useApp((s) => s.auth[agent]);
  const session = sessions.find((s) => s.surface === "chat" && s.agentId === agent && s.id === sessionId) ?? null;
  const live = session !== null && LIVE.includes(session.status);
  const files = useApp((s) => s.draftFiles);
  const follow = useFollow(session?.approval ?? session?.log, session?.id);
  const mode = session?.mode ?? chosen;
  const folder = cwd ?? defaultDir;
  const memory = session ? memoryUsed(session) : null;
  const last = session?.log[session.log.length - 1];
  const lastAsked = session?.log.findLast((entry) => entry.kind === "user")?.text;

  const send = (prompt: string) => {
    const references = files.map((f) => `- ${f}`).join("\n");
    clearDraft();
    if (capture) return shareCapture(prompt);
    void sendAgentChat(files.length > 0 ? `${prompt}\n\nReferenced files:\n${references}` : prompt);
  };

  const attach = async () => {
    const picked = await bridge.pickFile();
    if (picked) addDraftFile(picked);
  };

  const browse = async () => {
    const picked = await bridge.pickFolder();
    if (picked) setAgentCwd(picked);
  };

  return (
    <div className="chat">
      <header className="row bar chat-bar">
        <h2 className="chat-title truncate" title={session?.title}>{session?.title ?? "New chat"}</h2>
        {auth?.plan && <span className="meta" title={`Signed in with ${auth.method}`}>{auth.plan}</span>}
        <EnginePicker />
        <div className="segmented" role="group" aria-label="Mode">
          <button aria-pressed={mode === "general"} disabled={session !== null} onClick={() => setAgentMode("general")}>General</button>
          <button aria-pressed={mode === "project"} disabled={session !== null} onClick={() => setAgentMode("project")}>Project</button>
        </div>
      </header>

      <SignInBanner agent={agent} />
      <LookCard />

      {mode === "project" && (
        <div className="row bar chat-folder">
          <Icon name="folder" size={14} />
          <span className="truncate grow" title={folder ?? undefined}>{session?.cwd ?? folder ?? "No folder chosen"}</span>
          {session === null && <button className="ghost" onClick={() => void browse()}>Choose folder</button>}
          {session && <button className="ghost" onClick={() => void bridge.openProject(session.cwd)}>Open</button>}
        </div>
      )}

      <div className="log" {...follow} aria-live="polite">
        {session === null ? (
          !capture && (
            <ChatStart
              hello={mode === "general" ? "What can I do for you?" : "What should we work on?"}
              note={mode === "general" ? "Ask anything." : "I work in your folder, and ask before changing anything."}
            />
          )
        ) : (
          <Turns session={session} live={live} />
        )}
        {live && session?.log[session.log.length - 1]?.kind !== "activity" && session?.status !== "waiting" && <p className="meta">{session?.activity || "Working"}</p>}
        {session?.approval && (
          <div className="approval">
            <span className="approval-title">{session.agent} wants to run {session.approval.tool}</span>
            <ApprovalCard sessionId={session.id} approval={session.approval} />
          </div>
        )}
        {!live && last?.kind === "text" && <ReplyActions text={last.text} retry={() => lastAsked && void sendAgentChat(lastAsked)} />}
      </div>

      {files.length > 0 && (
        <div className="attachments">
          {files.map((f) => (
            <span key={f} className="attachment truncate" title={f}>{f.split(/[\\/]/).pop()}</span>
          ))}
        </div>
      )}

      {(session?.usage || memory !== null) && (
        <p className="meta tabular usage-line">
          {session?.usage && <span>{session.usage.input.toLocaleString()} in, {session.usage.output.toLocaleString()} out</span>}
          {memory !== null && <span>{memory}% of its memory used</span>}
        </p>
      )}

      <Composer
        start={
          <button type="button" className="round" aria-label="Reference a file" title="Reference a file" onClick={() => void attach()}>
            <Icon name="plus" size={15} />
          </button>
        }
        placeholder={session ? "Ask on" : "Ask anything"}
        stop={live ? { title: "Stop this turn", run: () => cancelSession(session.id) } : null}
        canSend
        onSend={send}
      />
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
  const follow = useFollow(chat.messages, null);
  const ready = providers.filter((p) => isReady(p, localOnline));
  const first = ready[0]?.id;
  const firstAgent = agents.find((a) => a.installed)?.id;
  const noEngine = !first && !firstAgent;
  const last = chat.messages[chat.messages.length - 1];

  useEffect(pickEngine, [chat.providerId, first, firstAgent]);

  const send = (prompt: string) => {
    clearDraft();
    if (capture) return shareCapture(prompt);
    void sendChat(prompt);
  };

  return (
    <div className="chat">
      <header className="row bar chat-bar">
        <h2 className="chat-title truncate">{chatTitle(chat.messages) ?? "New chat"}</h2>
        {chat.usage && (
          <span className="meta tabular" title="Tokens in / out, as reported by the provider">
            {chat.usage.input} / {chat.usage.output}
          </span>
        )}
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
      </header>

      <LookCard />
      <div className="messages" {...follow} aria-live="polite">
        {chat.messages.length === 0 &&
          !capture &&
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
        {!pending && last?.role === "assistant" && last.content && <ReplyActions text={last.content} retry={retryLast} />}
      </div>

      <Composer placeholder={chat.messages.length ? "Ask on" : "Ask anything"} stop={pending ? { title: "Stop this answer", run: cancelChat } : null} canSend={!pending} onSend={send} />
    </div>
  );
}

export function Chat() {
  const agent = useApp((s) => s.agentChat.agent);
  return (
    <div className="chat-page board">
      <ChatSide />
      {agent ? <AgentChat agent={agent} /> : <ApiChat />}
    </div>
  );
}
