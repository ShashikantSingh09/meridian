import { useState } from "react";
import { bridge } from "../lib/bridge";
import { Brand } from "../lib/brands";
import { isReady, openLink, refreshLocal, refreshProviders, signInAgent, signInProvider, updateSettings, useApp } from "../lib/store";
import type { Capabilities, ProviderInfo } from "../lib/types";

const CAP_LABELS: [keyof Capabilities, string][] = [
  ["streaming", "Streaming"],
  ["tools", "Tools"],
  ["vision", "Vision"],
  ["modelDiscovery", "Model list"],
  ["usage", "Usage"],
];

function ProviderCard({ provider }: { provider: ProviderInfo }) {
  const settings = useApp((s) => s.settings);
  const localOnline = useApp((s) => s.localOnline);
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const blocked = settings.localOnly && provider.kind !== "local";

  const run = async (action: () => Promise<string | void>) => {
    setBusy(true);
    setStatus(null);
    try {
      const text = await action();
      setStatus(text ? { ok: true, text } : null);
    } catch (err) {
      setStatus({ ok: false, text: String(err) });
    } finally {
      setBusy(false);
    }
  };

  const saveKey = () =>
    run(async () => {
      await bridge.setProviderKey(provider.id, key);
      setKey("");
      await refreshProviders();
      return "Key saved to Windows Credential Manager.";
    });

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

      {provider.needsKey && (
        <div className="field-row">
          <input
            type="password"
            aria-label={`${provider.name} API key`}
            placeholder={provider.hasKey ? "Key stored" : "API key"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          {key ? (
            <button className="solid" disabled={busy} onClick={saveKey}>Save</button>
          ) : provider.hasKey ? (
            <button
              className="ghost"
              disabled={busy}
              onClick={() => run(async () => { await bridge.clearProviderKey(provider.id); await refreshProviders(); })}
            >
              Remove
            </button>
          ) : null}
        </div>
      )}

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
  { id: "claude-code", name: "Claude", cta: "Sign in with Claude", explain: "Uses Claude Code and your own Claude account. Your password goes only to Anthropic.", install: "https://code.claude.com/docs/en/quickstart" },
  { id: "codex", name: "ChatGPT", cta: "Sign in with ChatGPT", explain: "Uses Codex and your own ChatGPT plan. Your password goes only to OpenAI.", install: "https://github.com/openai/codex" },
  { id: "openrouter", name: "OpenRouter", cta: "Sign in with OpenRouter", explain: "Hundreds of models from one account. There is no key to copy: it comes back by itself.", install: null },
] as const;

function SignIn() {
  const agents = useApp((s) => s.agents);
  const auth = useApp((s) => s.auth);
  const providers = useApp((s) => s.providers);
  const [current, setCurrent] = useState<(typeof SIGN_INS)[number]["id"]>("claude-code");
  const waiting = useApp((s) => s.signingIn.includes(current));

  const choice = SIGN_INS.find((s) => s.id === current)!;
  const isAgent = current !== "openrouter";
  const agent = agents.find((a) => a.id === current);
  const missing = isAgent && !agent?.installed;
  const done = current === "openrouter" ? providers.some((p) => p.id === "openrouter" && p.hasKey) : auth[current]?.signedIn === true;

  const go = () => (current === "openrouter" ? signInProvider(current, choice.name) : signInAgent(current, choice.name));

  return (
    <section className="stack">
      <div className="pick-grid">
        {SIGN_INS.map((s) => (
          <button key={s.id} className="sign-tile" aria-pressed={s.id === current} onClick={() => setCurrent(s.id)}>
            <Brand id={s.id} name={s.name} size={44} />
            {s.name}
          </button>
        ))}
      </div>
      <p className="meta">{choice.explain}</p>
      {done && <p className="meta ok" role="status">{choice.name} is connected.</p>}
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
    </section>
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
      <button className="quiet" aria-expanded={keys} onClick={() => setKeys(!keys)}>{keys ? "Hide API keys" : "Use an API key instead"}</button>
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
