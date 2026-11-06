// Knowledge: pages about the people, projects, promises and places in the user's life, with the
// list on the left and the page on the right. Each page is a Markdown file on this PC.

import { Fragment, useEffect, useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import { Icon, type IconName } from "../lib/icons";
import { marked, openSource, promiseOrder, promisesFor, shortSource, sourceTip, updatedWhen, updateKnowledge } from "../lib/knowledge";
import { pushError, setTab, showPage, updateSettings, useApp } from "../lib/store";
import type { KnowledgeHit, KnowledgeKind, KnowledgeLine, KnowledgePage, KnowledgePreferences, KnowledgeRef, KnowledgeSource, KnowledgeSourceStatus } from "../lib/types";
import "./knowledge.css";

const GROUPS: { kind: KnowledgeKind; label: string; one: string }[] = [
  { kind: "person", label: "People", one: "Person" },
  { kind: "project", label: "Projects", one: "Project" },
  { kind: "promise", label: "Promises", one: "Promise" },
  { kind: "place", label: "Places", one: "Place" },
];

const SOURCES: { id: KnowledgeSource; name: string; icon: IconName; tone: string; nouns: [string, string]; cloud?: boolean }[] = [
  { id: "notes", name: "Call notes", icon: "mic", tone: "#ff375f", nouns: ["call", "calls"] },
  { id: "gmail", name: "Gmail", icon: "mail", tone: "#ea4335", nouns: ["message", "messages"], cloud: true },
  { id: "calendar", name: "Google Calendar", icon: "calendar", tone: "#4285f4", nouns: ["event", "events"], cloud: true },
  { id: "chats", name: "Chats with Meridian", icon: "chat", tone: "#34b7a7", nouns: ["chat", "chats"] },
];

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));
const failed = (title: string) => (err: unknown) => pushError({ title, body: why(err) });
const anyOn = (prefs: KnowledgePreferences) => prefs.notes || prefs.gmail || prefs.calendar || prefs.chats;

function Marked({ text, query }: { text: string; query: string }) {
  return <>{marked(text, query).map((part, i) => (part.mark ? <mark key={i}>{part.text}</mark> : <Fragment key={i}>{part.text}</Fragment>))}</>;
}

function SourceLink({ source, short }: { source: KnowledgeRef; short?: boolean }) {
  return (
    <button className="know-src" title={`${source.label}. ${sourceTip(source.target)}`} onClick={() => openSource(source.target)}>
      {short ? shortSource(source.label) : source.label}
    </button>
  );
}

function FirstRun({ pick }: { pick: () => void }) {
  return (
    <div className="notes-blank know-first">
      <Icon name="book" size={34} />
      <h2>Nothing here yet</h2>
      <p className="meta">Meridian can keep pages about the people, projects, promises and places in your calls, mail and calendar. They stay on this PC as plain files you can read and change.</p>
      <div className="know-chips">
        {["People, like Asha Rao", "Projects, like the shop relaunch", 'Promises, like "send the invoice"', "Places, like the Pune office"].map((chip) => <span key={chip} className="chip">{chip}</span>)}
      </div>
      <div className="row know-first-buttons">
        <button className="ghost" onClick={() => setTab("home")}>Not now</button>
        <button className="solid" onClick={pick}>Pick sources</button>
      </div>
    </div>
  );
}

/** What a source says under its name: what it is, or what this update did with it. */
function sourceWords(source: (typeof SOURCES)[number], status: KnowledgeSourceStatus | undefined, running: boolean, calls: number, local: boolean) {
  if (source.cloud && local) return "Off while local-only mode is on";
  const count = (n: number) => `${n} new ${n === 1 ? source.nouns[0] : source.nouns[1]}`;
  if (status && running) {
    if (status.state === "waiting") return "Waiting";
    if (status.state === "reading") return "Reading";
    if (status.state === "read") return count(status.found);
    if (status.state === "done") return status.found ? `Done · ${count(status.found)}` : "Done · nothing new";
  }
  if (status?.state === "skipped") return "Skipped this time";
  return { notes: `${calls} ${calls === 1 ? "call" : "calls"} on this PC`, gmail: "Through your Claude account, read-only", calendar: "The last 90 days and the next 30", chats: "Typed and spoken" }[source.id];
}

function Sources({ back }: { back?: () => void }) {
  const prefs = useApp((s) => s.settings.knowledge);
  const status = useApp((s) => s.knowledge.status);
  const updatedAt = useApp((s) => s.knowledge.updatedAt);
  const calls = useApp((s) => s.knowledge.calls);
  const local = useApp((s) => s.settings.localOnly);
  const name = useApp((s) => s.settings.assistantName.trim() || "Meridian");
  const [error, setError] = useState("");
  const change = (patch: Partial<KnowledgePreferences>) => void updateSettings({ knowledge: { ...prefs, ...patch } });
  const update = () => {
    setError("");
    updateKnowledge().catch((err) => setError(why(err)));
  };
  const percent = status.total ? Math.round((status.done / status.total) * 100) : 0;
  return (
    <div className="page-scroll know-sources">
      <div className="row know-crumbs">
        {back && <button className="round" aria-label="Back to the pages" title="Back" onClick={back}><Icon name="chevron" size={14} /></button>}
        <span className="know-crumb">Knowledge › Sources</span>
      </div>
      <section className="know-card">
        {status.running ? (
          <div className="know-progress">
            <div className="row">
              <span className="grow stacked">
                <span className="label">Updating</span>
                <span className="meta tabular">
                  {status.total ? `${status.done} of ${status.total} new items` : "Looking for new items"}
                  {status.now && ` · now reading ${status.now}`}
                </span>
              </span>
              <button className="ghost" onClick={() => void bridge.knowledgeStop()}>Stop</button>
            </div>
            <div className="know-track" role="progressbar" aria-label="Items read" aria-valuemin={0} aria-valuemax={status.total} aria-valuenow={status.done}><i style={{ width: `${percent}%` }} /></div>
          </div>
        ) : (
          <div className="know-card-head">
            <span className="label">What it learns from</span>
            <span className="meta">Each source is off until you turn it on.</span>
          </div>
        )}
        {SOURCES.map((source) => {
          const state = status.sources.find((s) => s.id === source.id);
          const blocked = Boolean(source.cloud && local);
          const label = source.id === "chats" ? `Chats with ${name}` : source.name;
          return (
            <div key={source.id} className="know-source">
              <span className="know-square" style={{ background: prefs[source.id] && !blocked ? source.tone : undefined }}><Icon name={source.icon} size={14} /></span>
              <span className="grow stacked">
                <span className="label">{label}</span>
                <span className="meta">{prefs[source.id] || blocked ? sourceWords(source, state, status.running, calls, local) : status.running ? "Off" : sourceWords(source, undefined, false, calls, local)}</span>
                {state?.state === "skipped" && prefs[source.id] && (
                  <span className="know-warn" role="status">
                    <Icon name="warn" size={14} />
                    <span className="grow">{state.why}</span>
                    {state.signIn && <button className="ghost" onClick={() => void bridge.agentLogin("claude-code")}>Sign in again</button>}
                  </span>
                )}
              </span>
              <label className="toggle">
                <input type="checkbox" role="switch" aria-label={label} checked={prefs[source.id] && !blocked} disabled={blocked} onChange={(e) => change({ [source.id]: e.target.checked })} />
              </label>
            </div>
          );
        })}
        {!status.running && (
          <div className="know-source">
            <span className="grow label">{updatedAt ? `Updated ${updatedWhen(updatedAt)}` : "Not updated yet"}</span>
            <button className="ghost" disabled={!anyOn(prefs)} title={anyOn(prefs) ? undefined : "Turn on a source first"} onClick={update}>Update now</button>
          </div>
        )}
        {!status.running && (error || status.failed) && <p className="know-warn" role="alert"><Icon name="warn" size={14} /><span>{error || status.failed}</span></p>}
        <div className="know-when" role="radiogroup" aria-label="When to update">
          <span className="label">When to update</span>
          <label><input type="radio" name="know-when" checked={prefs.when === "idle"} onChange={() => change({ when: "idle" })} />When idle and plugged in</label>
          <label><input type="radio" name="know-when" checked={prefs.when === "manual"} onChange={() => change({ when: "manual" })} />Only when I press Update now</label>
        </div>
        <p className="know-info">
          <Icon name="lock" size={14} />
          <span>To write pages, it sends new notes, mail and chats to the AI you chose for the assistant. With local-only mode on, the AI on this PC writes them. Pages stay on this PC.</span>
        </p>
      </section>
      <p className="meta know-foot">Idle means no typing or mouse for 10 minutes. It stops the moment you come back.</p>
    </div>
  );
}

function Results({ hits, query, active, open }: { hits: KnowledgeHit[]; query: string; active: number; open: (path: string) => void }) {
  if (hits.length === 0) return <p className="meta know-none">Nothing on any page matches.</p>;
  return (
    <div className="know-rows" role="listbox" aria-label="Pages that match">
      {GROUPS.map((group) => {
        const found = hits.filter((hit) => hit.kind === group.kind);
        if (found.length === 0) return null;
        return (
          <div key={group.kind} className="know-group">
            <h3 className="know-gh">{group.label}</h3>
            {found.map((hit) => (
              <button key={hit.path} role="option" aria-selected={hits[active]?.path === hit.path} className="note-row know-item" onClick={() => open(hit.path)}>
                <span className="label truncate"><Marked text={hit.title} query={query} /></span>
                <span className="meta truncate">{hit.quote ? <>“<Marked text={hit.snippet} query={query} />”</> : <Marked text={hit.snippet} query={query} />}</span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function List({ pages, selected }: { pages: KnowledgePage[]; selected: string | undefined }) {
  return (
    <div className="know-rows">
      {GROUPS.map((group) => {
        const inGroup = pages.filter((p) => p.kind === group.kind);
        if (inGroup.length === 0) return null;
        const { pages: shown, open } = group.kind === "promise" ? promiseOrder(inGroup) : { pages: inGroup, open: inGroup.length };
        return (
          <div key={group.kind} className="know-group">
            <h3 className="know-gh"><span className="grow">{group.label}</span><span className="tabular">{open}</span></h3>
            {shown.map((page) => (
              <button key={page.path} className="note-row know-item" data-done={page.kind === "promise" && page.subtitle === "Done"} aria-current={page.path === selected ? "true" : undefined} onClick={() => showPage(page.path)}>
                <span className="label truncate">{page.title}</span>
                <span className="meta truncate">{page.subtitle}</span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function Line({ page, line }: { page: KnowledgePage; line: KnowledgeLine }) {
  return (
    <div className="know-line" data-done={line.done === true}>
      {line.done !== null ? (
        <button className="know-box" role="checkbox" aria-checked={line.done} aria-label={line.text} onClick={() => void bridge.knowledgeTick(page.path, line.at, !line.done).catch(failed("Could not tick that promise"))}>
          {line.done && <Icon name="check" size={11} />}
        </button>
      ) : (
        line.bullet && <i className="know-dot" aria-hidden="true" />
      )}
      <span className="grow know-words">{line.text}</span>
      {line.yours ? <span className="know-yours" title="You wrote this, so no update changes it">yours</span> : line.source && <SourceLink source={line.source} short />}
    </div>
  );
}

function Reader({ page, pages, edit }: { page: KnowledgePage; pages: KnowledgePage[]; edit: () => void }) {
  const running = useApp((s) => s.knowledge.status.running);
  const promises = page.kind === "promise" ? [] : promisesFor(pages, page.title);
  const kind = GROUPS.find((g) => g.kind === page.kind)!.one;
  const sections = page.sections.map((section) => ({ heading: section.heading || (page.kind === "promise" ? "" : "Notes"), body: section.lines.map((line) => <Line key={line.at} page={page} line={line} />) }));
  if (promises.length > 0) {
    // Promises sit after what is happening now, as on the board.
    const at = sections.findIndex((s) => s.heading.toLowerCase() === "now") + 1;
    sections.splice(at, 0, { heading: "Promises", body: promises.map(({ page: from, line }) => <Line key={from.path} page={from} line={line} />) });
  }
  return (
    <article className="know-reader">
      <div className="row know-tools">
        <span className="chip know-kind">{kind}</span>
        <span className="grow" />
        <button className="ghost" disabled={running} title={running ? "Wait for the update to finish" : "Change this page as plain text"} onClick={edit}>Edit</button>
        <button className="ghost" onClick={() => void bridge.knowledgeOpen(page.path).catch(failed("Could not open the file"))}>Open file</button>
      </div>
      <h2>{page.title}</h2>
      {page.about && <p className="know-about">{page.about}</p>}
      <p className="meta know-from">
        Updated {updatedWhen(page.updated)}
        {page.sources.length > 0 && (
          <>
            {" · From: "}
            {page.sources.map((source, i) => (
              <Fragment key={source.label}>
                {i > 0 && ", "}
                <SourceLink source={source} />
              </Fragment>
            ))}
          </>
        )}
      </p>
      {sections.map((section, i) => (
        <section key={`${section.heading}${i}`}>
          {section.heading && <h3 className="know-h">{section.heading}</h3>}
          {section.body}
        </section>
      ))}
      {page.linked.length > 0 && (
        <section>
          <h3 className="know-h">Linked</h3>
          <div className="know-chips">
            {page.linked.map((title) => {
              const to = pages.find((p) => p.title.toLowerCase() === title.toLowerCase());
              return to ? <button key={title} className="chip" onClick={() => showPage(to.path)}>{title}</button> : <span key={title} className="chip">{title}</span>;
            })}
          </div>
        </section>
      )}
    </article>
  );
}

function Editor({ page, base, done }: { page: KnowledgePage; base: string; done: () => void }) {
  const [text, setText] = useState(base);
  const [error, setError] = useState("");
  const save = () => bridge.knowledgeSave(page.path, text, base).then(done, (err) => setError(why(err)));
  return (
    <div className="know-reader know-edit">
      <div className="row know-tools">
        <span className="grow know-crumb truncate">Knowledge › {page.title} › Edit</span>
        <button className="ghost" onClick={done}>Cancel</button>
        <button className="solid" onClick={() => void save()}>Save</button>
      </div>
      <textarea
        className="know-text"
        aria-label={`The text of ${page.title}`}
        value={text}
        spellCheck={false}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") done();
          if (e.key === "s" && e.ctrlKey) {
            e.preventDefault();
            void save();
          }
        }}
      />
      {error ? <p className="know-warn" role="alert"><Icon name="warn" size={14} /><span>{error}</span></p> : <p className="meta">A line you change or add is marked as yours, and no update rewrites it.</p>}
    </div>
  );
}

function Pages({ sources }: { sources: () => void }) {
  const pages = useApp((s) => s.knowledge.pages);
  const selected = useApp((s) => s.knowledgePage);
  const updatedAt = useApp((s) => s.knowledge.updatedAt);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KnowledgeHit[]>([]);
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<{ path: string; base: string } | null>(null);
  const asked = useRef("");
  const page = pages.find((p) => p.path === selected) ?? pages.find((p) => p.kind !== "promise") ?? pages[0]!;

  useEffect(() => {
    asked.current = query;
    if (!query.trim()) return setHits([]);
    // Only the answer to what is in the box now is shown, however the replies arrive.
    void bridge.knowledgeSearch(query).then((found) => {
      if (asked.current === query) {
        setHits(found);
        setActive(0);
      }
    });
  }, [query, pages]);

  const open = (path: string) => {
    setEditing(null);
    showPage(path);
  };
  const edit = () => void bridge.knowledgeRead(page.path).then((base) => setEditing({ path: page.path, base }), failed("Could not open the page"));
  // Reading order, as the groups show them, so Up and Down go where the eye does.
  const ordered = GROUPS.flatMap((g) => hits.filter((hit) => hit.kind === g.kind));

  return (
    <div className="know-page">
      <aside className="know-side">
        <label className="know-search" data-active={query !== ""}>
          <Icon name="search" size={14} />
          <input
            aria-label="Search people, promises and everything on the pages"
            placeholder="Search people, promises…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setActive((n) => Math.max(0, Math.min(ordered.length - 1, n + (e.key === "ArrowDown" ? 1 : -1))));
              } else if (e.key === "Enter" && ordered[active]) open(ordered[active].path);
              else if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
          />
          {query.trim() && <span className="meta tabular">{hits.length} {hits.length === 1 ? "page" : "pages"}</span>}
        </label>
        {query.trim() ? <Results hits={ordered} query={query} active={active} open={open} /> : <List pages={pages} selected={page.path} />}
        <button className="know-sources-button" onClick={sources}>
          <Icon name="settings" size={14} />
          <span className="grow">Sources</span>
          {updatedAt && <span className="meta">Updated {updatedWhen(updatedAt)}</span>}
        </button>
      </aside>
      {editing?.path === page.path ? <Editor key={page.path} page={page} base={editing.base} done={() => setEditing(null)} /> : <Reader page={page} pages={pages} edit={edit} />}
    </div>
  );
}

export function Knowledge() {
  const pages = useApp((s) => s.knowledge.pages);
  const prefs = useApp((s) => s.settings.knowledge);
  const [picking, setPicking] = useState(false);
  // Empty until sources are picked, and nothing is read before that.
  if (pages.length === 0 && !anyOn(prefs) && !picking) return <FirstRun pick={() => setPicking(true)} />;
  if (picking || pages.length === 0) return <Sources back={pages.length > 0 || !anyOn(prefs) ? () => setPicking(false) : undefined} />;
  return <Pages sources={() => setPicking(true)} />;
}
