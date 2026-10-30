// The providers column: every service that can feed the island, and what each one
// last returned. Rows arrive one by one, because this is the moment the app shows
// it really reached a service.

import { rowEnter, spring } from "@meridian/design-system/motion";
import { AnimatePresence, animate, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../lib/icons";
import { hostOf } from "../island/views";
import {
  connectIntegration,
  describeWhen,
  disconnectIntegration,
  fetchIntegration,
  openLink,
  updateSettings,
  useApp,
} from "../lib/store";
import type { FetchedItem, Integration } from "../lib/types";

const GROUP_ORDER = ["Mail and calendar", "Work", "Development", "Customers", "Design", "Files", "Payments"];

/** A letter on a tile, never the vendor's mark: logos belong to their owners. */
function Monogram({ name, size = 24 }: { name: string; size?: number }) {
  const hue = [...name].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <span className="monogram" style={{ width: size, height: size, fontSize: size * 0.46, background: `hsl(${hue} 42% 26%)` }} aria-hidden="true">
      {name[0]}
    </span>
  );
}

/** Counts up to the number of rows, so a result reads as work done just now. */
function Count({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);
  useEffect(() => {
    const controls = animate(shown.current, value, {
      duration: 0.4,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => {
        shown.current = v;
        if (ref.current) ref.current.textContent = String(Math.round(v));
      },
    });
    return () => controls.stop();
  }, [value]);
  return <span ref={ref} className="tabular">0</span>;
}

function Rows({ items }: { items: FetchedItem[] }) {
  return (
    <ul className="list fetched">
      <AnimatePresence initial={false}>
        {items.map((item, i) => (
          <motion.li key={item.key} layout="position" {...rowEnter(i)} exit={{ opacity: 0 }}>
            <button className="fetched-row" disabled={!item.url} title={item.url ? `Open on ${hostOf(item.url)}` : undefined} onClick={() => item.url && openLink(item.url)}>
              <span className="stacked grow">
                <span className="label truncate">{item.title}</span>
                {item.detail && <span className="meta truncate">{item.detail}</span>}
              </span>
              {item.when && <span className="meta tabular">{describeWhen(item.when)}</span>}
              {item.url && <Icon name="chevron" size={12} />}
            </button>
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}

function Connect({ integration }: { integration: Integration }) {
  const builtIn = useApp((s) => s.builtInClients[integration.id === "outlook" ? 1 : 0]);
  const googleId = useApp((s) => s.settings.googleClientId);
  const microsoftId = useApp((s) => s.settings.microsoftClientId);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [token, setToken] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const microsoft = integration.id === "outlook";
  const direct = integration.access === "account";
  const directId = microsoft ? microsoftId : googleId;

  const connect = async () => {
    setWaiting(true);
    setError(null);
    try {
      await connectIntegration(integration, { clientId: clientId.trim() || null, secret: secret || null, token: token.trim() || null });
    } catch (err) {
      setError(String(err));
    } finally {
      setWaiting(false);
    }
  };

  const ready = direct ? builtIn || directId !== "" : integration.access === "open" || clientId.trim() !== "" || token.trim() !== "";
  const needsRegistration = direct && !builtIn;

  return (
    <div className="stack">
      {integration.access === "open" && <p className="meta">Sign in on {integration.name}'s own page. No setup needed. Meridian only ever calls read-only tools.</p>}
      {integration.access === "tokenOrApp" && (
        <label className="field">
          <span className="meta">Personal access token, read-only scopes are enough</span>
          <input aria-label={`${integration.name} token`} type="password" value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
      )}
      {integration.access === "registeredApp" && (
        <p className="meta">{integration.name} accepts only registered apps. Enter a client ID from your own registration.</p>
      )}
      {(integration.access === "registeredApp" || integration.access === "tokenOrApp") && (
        <label className="field">
          <span className="meta">{integration.access === "tokenOrApp" ? "Or a client ID from your own registration" : "Client ID"}</span>
          <input aria-label={`${integration.name} client ID`} value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </label>
      )}
      {direct && builtIn && <p className="meta">Read-only sign-in in your browser. Mail is read on this PC, never sent to an AI.</p>}
      {needsRegistration && (
        <>
          <p className="meta">
            {microsoft ? "Microsoft" : "Google"} sign-in needs an app registration, which gives the ID below. Mail is read on
            this PC, never sent to an AI. Steps are in the Connecting accounts guide.
          </p>
          <label className="field">
            <span className="meta">{microsoft ? "Microsoft application ID" : "Google client ID"}</span>
            <input
              aria-label={microsoft ? "Microsoft client ID" : "Google client ID"}
              defaultValue={directId}
              onBlur={(e) => void updateSettings(microsoft ? { microsoftClientId: e.target.value.trim() } : { googleClientId: e.target.value.trim() })}
            />
          </label>
        </>
      )}
      {(integration.access === "registeredApp" || (needsRegistration && !microsoft)) && (
        <label className="field">
          <span className="meta">Client secret, if the registration has one</span>
          <input aria-label={`${integration.name} client secret`} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </label>
      )}
      <div className="row">
        <button className="solid" disabled={!ready || waiting} onClick={() => void connect()}>
          {waiting ? "Finish in your browser" : `Connect ${integration.name}`}
        </button>
      </div>
      {error && <p className="meta bad" role="status">{error}</p>}
    </div>
  );
}

function Detail({ integration }: { integration: Integration }) {
  const digest = useApp((s) => s.digests[integration.id]);
  const fetching = useApp((s) => s.fetching.includes(integration.id));
  const error = useApp((s) => s.fetchErrors[integration.id]);

  useEffect(() => {
    if (integration.connected && !digest) void fetchIntegration(integration);
    // Only the first look at a connected service fetches by itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [integration.id, integration.connected]);

  return (
    <div className="link-detail">
      <header className="row">
        <Monogram name={integration.name} size={36} />
        <div className="stacked grow">
          <h1 className="link-name">{integration.name}</h1>
          <span className="meta truncate">{integration.connected ? integration.account ?? "Connected, read-only" : integration.blurb}</span>
        </div>
        {integration.connected && (
          <>
            <button className="round" aria-label={`Fetch ${integration.name} again`} title="Fetch again" disabled={fetching} onClick={() => void fetchIntegration(integration)}>
              <Icon name="retry" size={14} />
            </button>
            <button className="ghost" onClick={() => void disconnectIntegration(integration)}>Disconnect</button>
          </>
        )}
      </header>

      <div className="beam" data-on={fetching} aria-hidden="true" />

      {!integration.connected && <Connect integration={integration} />}

      {integration.connected && (
        <div className="link-feed">
          <div className="row">
            <h2 className="grow">
              {digest ? <><Count value={digest.items.length} /> {digest.items.length === 1 ? "item" : "items"}</> : fetching ? "Reaching the service" : "Nothing yet"}
            </h2>
            {digest?.tool && <span className="meta" title="The read-only tool this came from">{digest.tool}</span>}
          </div>
          {error && <p className="meta bad" role="status">{error}</p>}
          {digest && digest.tools.length > 1 && (
            <div className="chips">
              {digest.tools.map((tool) => (
                <button key={tool} className="chip tool-chip" aria-pressed={tool === digest.tool} onClick={() => void fetchIntegration(integration, tool)}>{tool}</button>
              ))}
            </div>
          )}
          {digest && digest.items.length > 0 && <Rows items={digest.items} />}
          {digest?.text && <pre className="ocr fetched-text">{digest.text}</pre>}
          {digest && digest.items.length === 0 && !digest.text && !error && <p className="meta">The service answered, with nothing to show.</p>}
        </div>
      )}
    </div>
  );
}

export function Integrations() {
  const integrations = useApp((s) => s.integrations);
  const fetching = useApp((s) => s.fetching);
  const [selected, setSelected] = useState("gmail");

  const groups = useMemo(() => {
    const names = [...new Set(integrations.map((i) => i.group))];
    names.sort((a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b));
    return names.map((name) => ({ name, items: integrations.filter((i) => i.group === name) }));
  }, [integrations]);

  const current = integrations.find((i) => i.id === selected) ?? integrations[0];
  if (!current) return <p className="meta">Loading providers.</p>;

  return (
    <div className="links">
      <div className="links-column" role="navigation" aria-label="Providers">
        {groups.map((group) => (
          <section key={group.name} className="stack-sm">
            <h2 className="links-group">{group.name}</h2>
            {group.items.map((i) => (
              <button key={i.id} className="link-row" aria-current={i.id === current.id ? "true" : undefined} onClick={() => setSelected(i.id)}>
                {i.id === current.id && <motion.span layoutId="link-pill" className="topnav-pill" transition={spring.hover} />}
                <Monogram name={i.name} size={22} />
                <span className="label link-label truncate">{i.name}</span>
                {i.connected && <span className="status-dot link-dot" data-status={fetching.includes(i.id) ? "running" : "completed"} title="Connected" />}
              </button>
            ))}
          </section>
        ))}
      </div>
      <motion.div key={current.id} className="link-pane" initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} transition={spring.hover}>
        <Detail integration={current} />
      </motion.div>
    </div>
  );
}
