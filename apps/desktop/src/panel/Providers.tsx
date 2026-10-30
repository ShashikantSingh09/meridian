import { useState } from "react";
import { bridge } from "../lib/bridge";
import { isReady, refreshLocal, refreshProviders, updateSettings, useApp } from "../lib/store";
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
        <span className="status-dot" data-status={isReady(provider, localOnline) ? "completed" : "idle"} />
        <h3 className="grow">{provider.name}</h3>
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

export function Providers() {
  const providers = useApp((s) => s.providers);
  const [scan, setScan] = useState<string | null>(null);

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
          <h1>Providers</h1>
          <p className="meta">Keys stay in Windows Credential Manager. The interface can only see whether one exists.</p>
        </div>
        <button className="ghost" onClick={discover}>Find local servers</button>
      </header>
      {scan && <p className="meta" role="status">{scan}</p>}
      <div className="cards">
        {providers.map((p) => (
          <ProviderCard key={p.id} provider={p} />
        ))}
      </div>
    </div>
  );
}
