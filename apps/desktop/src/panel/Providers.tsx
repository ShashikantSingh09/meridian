import { useState } from "react";
import { bridge } from "../lib/bridge";
import { Brand } from "../lib/brands";
import { Icon } from "../lib/icons";
import { hostOf, isReady, onThisPc, openLink, refreshLocal, refreshProviders, serverAddress, signInAgent, signInProvider, updateSettings, useApp } from "../lib/store";
import type { Capabilities, ProviderInfo } from "../lib/types";

const CAP_LABELS: [keyof Capabilities, string][] = [
  ["streaming", "Streaming"],
  ["tools", "Tools"],
  ["vision", "Vision"],
  ["modelDiscovery", "Model list"],
  ["usage", "Usage"],
];

type Status = { ok: boolean; text: string } | null;

/** Runs a click's work with the buttons held, and says how it went. */
function useRun(say: (status: Status) => void) {
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<string | void>) => {
    setBusy(true);
    say(null);
    try {
      const text = await action();
      say(text ? { ok: true, text } : null);
    } catch (err) {
      say({ ok: false, text: String(err) });
    } finally {
      setBusy(false);
    }
  };
  return [busy, run] as const;
}

/** A key kept in Windows Credential Manager. A stored key is never shown, only that there is one. */
function KeyField({ provider, hint, say }: { provider: ProviderInfo; hint: string; say: (status: Status) => void }) {
  const [key, setKey] = useState("");
  const [busy, run] = useRun(say);
  // A server on another machine that asks for a key is only found once it has it.
  const refresh = () => Promise.all([refreshProviders(), provider.kind === "local" ? refreshLocal() : null]);
  return (
    <div className="field-row">
      <input
        type="password"
        aria-label={`${provider.name} API key`}
        placeholder={provider.hasKey ? "Key stored" : hint}
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />
      {key ? (
        <button
          className="solid"
          disabled={busy}
          onClick={() => run(async () => { await bridge.setProviderKey(provider.id, key); setKey(""); await refresh(); return "Key saved to Windows Credential Manager."; })}
        >
          Save
        </button>
      ) : provider.hasKey ? (
        <button className="ghost" disabled={busy} onClick={() => run(async () => { await bridge.clearProviderKey(provider.id); await refresh(); })}>
          Remove
        </button>
      ) : null}
    </div>
  );
}

function ProviderCard({ provider }: { provider: ProviderInfo }) {
  const settings = useApp((s) => s.settings);
  const localOnline = useApp((s) => s.localOnline);
  const [status, setStatus] = useState<Status>(null);
  const [busy, run] = useRun(setStatus);
  const blocked = settings.localOnly && provider.kind !== "local";

  return (
    <article className="card" data-blocked={blocked}>
      <header className="row">
        <Brand id={provider.id} name={provider.name} size={28} />
        <h3 className="grow">{provider.name}</h3>
        <span className="status-dot" data-status={isReady(provider, localOnline) ? "completed" : "idle"} />
        <span className="tag">{provider.kind}</span>
      </header>

      <div className="caps">
        {CAP_LABELS.filter(([k]) => provider.capabilities[k]).map(([k, label]) => (
          <span key={k} className="cap">{label}</span>
        ))}
      </div>

      <label className="field">
        <span className="meta">Endpoint</span>
        <input
          defaultValue={provider.baseUrl}
          aria-label={`${provider.name} endpoint`}
          onBlur={(e) => {
            const value = e.target.value.trim();
            if (value && value !== provider.baseUrl)
              void updateSettings({ providerBaseUrls: { ...settings.providerBaseUrls, [provider.id]: value } });
          }}
        />
      </label>

      {provider.needsKey && <KeyField provider={provider} hint="API key" say={setStatus} />}

      <div className="row">
        <button className="ghost" disabled={busy || blocked} onClick={() => run(() => bridge.testProvider(provider.id))}>Test</button>
        {status && <span className={status.ok ? "meta ok" : "meta bad"} role="status">{status.text}</span>}
        {blocked && <span className="meta">Blocked by local-only mode</span>}
      </div>
    </article>
  );
}

/** The ways in that need no key. Each ends on the company's own sign-in page. */
const SIGN_INS = [
  { id: "claude-code", name: "Claude", note: "Sign in with Claude, through Claude Code", connected: "Connected through Claude Code", cta: "Sign in with Claude", explain: "Uses Claude Code and your own Claude account. Your password goes only to Anthropic.", install: "https://code.claude.com/docs/en/quickstart" },
  { id: "codex", name: "ChatGPT", note: "Sign in with ChatGPT, through Codex", connected: "Connected through Codex", cta: "Sign in with ChatGPT", explain: "Uses Codex and your own ChatGPT plan. Your password goes only to OpenAI.", install: "https://github.com/openai/codex" },
  { id: "openrouter", name: "OpenRouter", note: "Hundreds of models from one account", connected: "Connected", cta: "Sign in with OpenRouter", explain: "Hundreds of models from one account. There is no key to copy: it comes back by itself.", install: null },
] as const;

function SignIn() {
  const agents = useApp((s) => s.agents);
  const auth = useApp((s) => s.auth);
  const providers = useApp((s) => s.providers);
  const [current, setCurrent] = useState<(typeof SIGN_INS)[number]["id"]>("claude-code");
  const waiting = useApp((s) => s.signingIn.includes(current));

  const signedIn = (id: (typeof SIGN_INS)[number]["id"]) => (id === "openrouter" ? providers.some((p) => p.id === "openrouter" && p.hasKey) : auth[id]?.signedIn === true);
  const choice = SIGN_INS.find((s) => s.id === current)!;
  const isAgent = current !== "openrouter";
  const agent = agents.find((a) => a.id === current);
  const missing = isAgent && !agent?.installed;
  const done = signedIn(current);

  const go = () => (current === "openrouter" ? signInProvider(current, choice.name) : signInAgent(current, choice.name));

  return (
    <>
      <div className="stack voice-tiles" role="group" aria-label="Sign in">
        {SIGN_INS.map((s) => (
          <button key={s.id} className="voice-tile" aria-pressed={s.id === current} onClick={() => setCurrent(s.id)}>
            <Brand id={s.id} name={s.name} size={26} />
            <span className="stacked grow">
              <span className="label truncate">{s.name}</span>
              <span className="meta truncate">{signedIn(s.id) ? s.connected : s.note}</span>
            </span>
            {signedIn(s.id) && <Icon name="check" size={15} />}
          </button>
        ))}
      </div>
      <p className="meta">{choice.explain}</p>
      {waiting && <p className="label" role="status">Finish in your browser</p>}
      {!done && !waiting && (
        <div className="row">
          {missing ? (
            <button className="solid" onClick={() => openLink(choice.install!)}>Install {agent?.name ?? choice.name} first</button>
          ) : (
            <button className="solid" onClick={() => void go()}>{choice.cta}</button>
          )}
        </div>
      )}
    </>
  );
}

/** A server on this PC, or at an address on another machine, which answers or does not. */
function LocalRow({ provider }: { provider: ProviderInfo }) {
  const settings = useApp((s) => s.settings);
  const running = useApp((s) => s.localOnline.includes(provider.id));
  const [status, setStatus] = useState<Status>(null);
  const [editing, setEditing] = useState(false);
  const [typed, setTyped] = useState("");
  const set = provider.id in settings.providerBaseUrls;
  const elsewhere = !onThisPc(provider.baseUrl);
  const host = elsewhere ? hostOf(provider.baseUrl) : null;

  const test = () =>
    bridge.testProvider(provider.id).then(
      (text) => setStatus({ ok: true, text }),
      (err) => setStatus({ ok: false, text: String(err) }),
    );

  const keep = async (address: string | null) => {
    const { [provider.id]: _old, ...others } = settings.providerBaseUrls;
    await updateSettings({ providerBaseUrls: address ? { ...others, [provider.id]: address } : others });
    setEditing(false);
    setStatus(null);
    await refreshLocal();
  };

  const save = () => {
    const address = serverAddress(typed, provider.baseUrl);
    if (address) void keep(address);
    else setStatus({ ok: false, text: "That is not an address. Try 192.168.1.20 or http://192.168.1.20:11434/v1" });
  };

  const said = status?.text ?? (running ? (host ? `Running on ${host}` : "Running") : host ? `Not answering at ${host}` : "Not running");
  return (
    <div className="stack-sm">
      <div className="setting">
        <Brand id={provider.id} name={provider.name} size={28} />
        <span className="stacked grow">
          <span className="label">{provider.name}</span>
          <span className={status ? (status.ok ? "meta ok truncate" : "meta bad truncate") : "meta"} role="status" title={status?.text}>{said}</span>
        </span>
        <button className="ghost" aria-expanded={editing} onClick={() => { setTyped(set ? provider.baseUrl : ""); setEditing(!editing); }}>Address</button>
        <button className="ghost" onClick={() => void test()}>Test</button>
      </div>
      {editing && (
        <div className="stack-sm">
          <div className="field-row">
            <input
              className="grow"
              aria-label={`${provider.name} address`}
              placeholder={provider.baseUrl}
              value={typed}
              autoFocus
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
            />
            <button className="solid" disabled={!typed.trim()} onClick={save}>Save</button>
            {set && <button className="ghost" onClick={() => void keep(null)}>Use this PC</button>}
          </div>
          <KeyField provider={provider} hint="API key, if that server asks for one" say={setStatus} />
          <p className="meta">For {provider.name} on another machine, type that machine's address, and its key if it has one. Your chats go over your network to it, so use an https address when that server has one. Leave it unset and Meridian finds {provider.name} on this PC.</p>
          {settings.localOnly && elsewhere && <p className="meta bad">Local-only mode is on, so another machine is not used.</p>}
        </div>
      )}
    </div>
  );
}

export function Providers() {
  const providers = useApp((s) => s.providers);
  const [scan, setScan] = useState<string | null>(null);
  const [keys, setKeys] = useState(false);

  const discover = async () => {
    setScan("Looking on this machine");
    try {
      const found = await refreshLocal();
      setScan(
        found.length === 0
          ? "No local server answered."
          : found.map((f) => `${f.providerId}: ${f.models.length} models`).join(" · "),
      );
    } catch (err) {
      setScan(String(err));
    }
  };

  return (
    <div className="page-scroll stack-lg">
      <header className="row">
        <div className="grow stack-sm">
          <h1>Choose your AI</h1>
          <p className="meta">Sign in with the account you already have.</p>
        </div>
        <button className="ghost" onClick={discover}>Find models on this PC</button>
      </header>
      {scan && <p className="meta" role="status">{scan}</p>}
      <SignIn />
      <h2>On this PC</h2>
      <div className="stack">
        {providers.filter((p) => p.kind === "local").map((p) => (
          <LocalRow key={p.id} provider={p} />
        ))}
      </div>
      <button className="ghost api-keys" aria-expanded={keys} onClick={() => setKeys(!keys)}>{keys ? "Hide API keys" : "Use an API key instead"}</button>
      {keys && (
        <div className="cards">
          {providers.map((p) => (
            <ProviderCard key={p.id} provider={p} />
          ))}
        </div>
      )}
    </div>
  );
}
