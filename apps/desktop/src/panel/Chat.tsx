import { useEffect, useRef, useState } from "react";
import { Icon } from "../lib/icons";
import { cancelChat, clearChat, isReady, selectProvider, sendChat, setListening, setTab, useApp } from "../lib/store";

export function Chat() {
  const chat = useApp((s) => s.chat);
  const providers = useApp((s) => s.providers);
  const localOnline = useApp((s) => s.localOnline);
  const pending = useApp((s) => s.chatPending);
  const [text, setText] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const ready = providers.filter((p) => isReady(p, localOnline));
  const first = ready[0]?.id;

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
        <select
          aria-label="Provider"
          value={chat.providerId ?? ""}
          onChange={(e) => void selectProvider(e.target.value)}
        >
          {ready.length === 0 && <option value="">No provider ready</option>}
          {ready.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
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
          (ready.length === 0 ? (
            <div className="empty">
              <p className="label">No AI provider is ready yet</p>
              <p className="meta">Add an API key, or start a local server such as Ollama or LM Studio.</p>
              <button className="solid" onClick={() => setTab("providers")}>Set up a provider</button>
            </div>
          ) : (
            <p className="meta center">Say something to start.</p>
          ))}
        {chat.messages.map((m, i) => (
          <div key={i} className="message" data-role={m.role}>
            {m.content || (pending && <span className="meta">Thinking</span>)}
          </div>
        ))}
      </div>

      <form className="composer" onSubmit={submit}>
        <button type="button" className="round" aria-label="Show microphone level" title="Microphone level preview. Speech to text arrives with voice." onClick={() => setListening(true)}>
          <Icon name="mic" size={14} />
        </button>
        <input
          aria-label="Message"
          placeholder="Message"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
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
