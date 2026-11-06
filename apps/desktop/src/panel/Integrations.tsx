// Providers: every service that can feed the island, and what each one last returned.
// Connecting is one click and a login on the service's own page. Rows arrive one by one,
// because that is the moment the app shows it really reached a service.

import { rowEnter, spring } from "@meridian/design-system/motion";
import { AnimatePresence, animate, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { hostOf } from "../island/views";
import { Brand } from "../lib/brands";
import { Icon } from "../lib/icons";
import { checkClaudeConnectors, CLAUDE_CONNECTORS, connectIntegration, describeWhen, disconnectIntegration, fetchIntegration, openLink, useApp } from "../lib/store";
import type { FetchedItem, Integration } from "../lib/types";

const FIRST_GROUPS = ["Mail and calendar", "Work", "Development"];

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
            </button>
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}

function ThroughClaude({ integration: { id, name, viaClaude } }: { integration: Integration }) {
  const checking = useApp((s) => s.fetching.includes(id));

  if (checking) return <p className="meta">Checking your Claude account.</p>;
  if (viaClaude === "on") {
    return (
      <div className="stack">
        <div className="stack-sm">
          <p className="label">Connected through your Claude account</p>
          <p className="meta">Ask about it by voice or in chat. It is read only when you ask, only with reading tools, and what is read goes through Claude.</p>
        </div>
        <div className="row">
          <button className="ghost" onClick={() => openLink(CLAUDE_CONNECTORS)}>Manage in Claude</button>
        </div>
      </div>
    );
  }
  return (
    <div className="stack">
      <p className="meta">{name} connects through your Claude account, with Claude Code signed in on this PC. Press Connect next to {name} on Claude's page and sign in with Google, then come back.</p>
      <div className="row">
        <button className="solid" onClick={() => openLink(CLAUDE_CONNECTORS)}>Connect {name}</button>
        <button className="ghost" onClick={() => void checkClaudeConnectors()}>Check again</button>
      </div>
    </div>
  );
}

function Connect({ integration }: { integration: Integration }) {
  const waiting = useApp((s) => s.signingIn.includes(integration.id));

  if (integration.viaClaude) return <ThroughClaude integration={integration} />;
  if (!integration.ready) {
    return <p className="meta">Not available yet. {integration.name} accepts only registered apps, and this one has not been registered with them.</p>;
  }
  if (waiting) {
    return (
      <div className="stack-sm">
        <p className="label">Finish in your browser</p>
        <p className="meta">Log in on {integration.name}'s own page, then come back.</p>
      </div>
    );
  }
  return (
    <div className="stack">
      <p className="meta">Sign in on {integration.name}'s own page. Meridian never sees your password, and only ever calls read-only tools.</p>
      <div className="row">
        <button className="solid" onClick={() => void connectIntegration(integration)}>Connect {integration.name}</button>
      </div>
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
        <Brand id={integration.id} name={integration.name} size={46} />
        <div className="stacked grow">
          <h2 className="link-name">{integration.name}</h2>
          <span className="meta truncate">{integration.connected ? integration.account ?? "Connected" : integration.blurb}</span>
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
  const [selected, setSelected] = useState("gmail");
  const current = integrations.find((i) => i.id === selected) ?? integrations[0];
  useEffect(() => void checkClaudeConnectors(), []);
  if (!current) return <p className="meta">Loading providers.</p>;

  // Services that work with one click come first within each group.
  const sorted = [...integrations].sort((a, b) => {
    const rank = (i: Integration) => (FIRST_GROUPS.includes(i.group) ? FIRST_GROUPS.indexOf(i.group) : FIRST_GROUPS.length);
    return rank(a) - rank(b) || Number(b.ready) - Number(a.ready);
  });

  return (
    <div className="links-page">
      <header className="settings-head">
        <h1>Providers</h1>
        <p className="meta">Sign in once in your browser. Only read-only tools are used.</p>
      </header>
      <div className="links">
        <div className="links-grid" role="navigation" aria-label="Providers">
          {sorted.map((i) => (
            <button key={i.id} className="link-tile" aria-current={i.id === current.id ? "true" : undefined} data-ready={i.ready} onClick={() => setSelected(i.id)}>
              {i.id === current.id && <motion.span layoutId="link-pill" className="dock-pill" transition={spring.snap} />}
              <span className="link-mono">
                <Brand id={i.id} name={i.name} />
                {(i.connected || i.viaClaude === "on") && <i className="link-dot" title="Connected" />}
              </span>
              <span className="link-label">{i.name}</span>
            </button>
          ))}
        </div>
        <motion.div key={current.id} className="link-pane" initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} transition={spring.snap}>
          <Detail integration={current} />
        </motion.div>
      </div>
    </div>
  );
}
