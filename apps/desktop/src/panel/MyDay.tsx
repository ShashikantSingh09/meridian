import { useEffect, useRef, useState } from "react";
import {
  addReminder,
  deleteEvent,
  describeTime,
  dismissEvent,
  importEmail,
  mailThroughClaude,
  openLink,
  openSettings,
  readMailThroughClaude,
  refreshActivity,
  renameEvent,
  setCardFocus,
  timeToday,
  updateSettings,
  useApp,
} from "../lib/store";
import { liveFrom, timeOf } from "../island/live";
import { hostOf } from "../island/views";
import { bridge } from "../lib/bridge";
import {
  canCheck,
  cardLine,
  cardTag,
  cardText,
  cardTitle,
  checkCards,
  daySummary,
  dismissCard,
  draftOf,
  failureLine,
  hideCard,
  KINDS,
  laterOptions,
  laterToday,
  longDate,
  meetingsToday,
  openInGmail,
  parcelsOnTheWay,
  planSteps,
  planWhy,
  refreshCards,
  remindTonight,
  clockOf,
  dayMonth,
  stopKind,
  weekdayDate,
} from "../lib/cards";
import { Icon } from "../lib/icons";
import type { Card, CardKind, Category, ContextEvent } from "../lib/types";
import { Switch } from "./Fill";

const CATEGORIES: { value: Category; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "upcoming", label: "Upcoming" },
  { value: "travel", label: "Travel" },
  { value: "deliveries", label: "Deliveries" },
  { value: "meetings", label: "Meetings" },
  { value: "orders", label: "Orders" },
  { value: "importantDates", label: "Important dates" },
  { value: "completed", label: "Completed" },
];

/** Below this, the user is told it was a best guess from the text. */
const CONFIDENT = 0.7;

const TONES: Record<string, string> = {
  meeting: "var(--tint-amber)",
  appointment: "var(--tint-amber)",
  flight: "var(--tint-blue)",
  hotel: "var(--tint-blue)",
  rentalCar: "var(--tint-blue)",
  delivery: "var(--tint-green)",
  order: "var(--tint-green)",
};

/** The colour of a kind of thing, the same wherever it appears. */
export const toneOf = (kind: string) => TONES[kind] ?? "var(--tint-violet)";

const onToday = (event: ContextEvent) => new Date(timeOf(event.startsAt) ?? 0).toDateString() === new Date().toDateString();

/** A day reads by the clock, and anything on another day shows its date instead. */
function whenLabel(event: ContextEvent) {
  const by = event.kind === "delivery" && event.endsAt ? timeToday(event.endsAt) : null;
  if (by) return `By ${by}`;
  const at = timeOf(event.startsAt);
  if (at === null) return null;
  return onToday(event) ? (timeToday(event.startsAt!) ?? "Today") : new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function Route({ event }: { event: ContextEvent }) {
  const from = event.metadata.departureAirport;
  const to = event.metadata.arrivalAirport;
  if (typeof from !== "string" || typeof to !== "string") return null;
  const progress = liveFrom(event, Date.now())?.route?.progress ?? 0;
  return (
    <div className="day-route">
      <b>{from}</b>
      <span className="day-route-line" aria-hidden="true">
        <i style={{ width: `${progress * 100}%` }} />
      </span>
      <b>{to}</b>
    </div>
  );
}

function EventCard({ event, last }: { event: ContextEvent; last: boolean }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(event.title);
  const long = typeof event.metadata.departureAirport === "string";
  const primary = event.suggestedActions.filter((a) => a.url);
  const stated = event.startsAt && (!onToday(event) || event.startsAt.kind === "naive");

  const save = () => {
    setEditing(false);
    if (title.trim() && title !== event.title) void renameEvent(event.id, title.trim());
  };

  return (
    <div className="day-row" style={{ "--tone": toneOf(event.kind) } as React.CSSProperties}>
      <span className="day-time tabular">{whenLabel(event)}</span>
      <span className="day-node" data-last={last} aria-hidden="true" />
      <article className="plate event" data-status={event.status} data-long={long}>
        <div className="event-main">
          <div className="event-text">
            <div className="row">
              {editing ? (
                <input
                  aria-label="Title"
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={save}
                  onKeyDown={(e) => e.key === "Enter" && save()}
                />
              ) : (
                <span className="tile-title truncate" title={event.title}>{event.title}</span>
              )}
              {event.status === "cancelled" && <span className="flag">Cancelled</span>}
              {event.status === "updated" && <span className="flag">Updated</span>}
              {event.confidence < CONFIDENT && <span className="flag" title={`Confidence ${Math.round(event.confidence * 100)}%`}>Unconfirmed</span>}
            </div>
            {stated && (
              <p className="meta truncate">
                {describeTime(event.startsAt!)}
                {event.startsAt!.kind === "naive" && <span title="The source gave no time zone"> (no time zone stated)</span>}
              </p>
            )}
            {event.body && <p className="meta truncate" title={event.body}>{event.body}</p>}
            <p className="meta truncate" title={event.sourceRef?.subject}>
              {event.sourceRef ? `From ${event.sourceRef.account}: ${event.sourceRef.subject}` : event.source === "user" ? "Added by you" : `From ${event.source}`}
            </p>
          </div>
          {!long && <Actions event={event} primary={primary} onCorrect={() => setEditing(true)} />}
        </div>
        <Route event={event} />
        {long && <Actions event={event} primary={primary} onCorrect={() => setEditing(true)} />}
      </article>
    </div>
  );
}

/** What can be done with an item. Correct and Delete wait for the pointer on a short card. */
function Actions({ event, primary, onCorrect }: { event: ContextEvent; primary: ContextEvent["suggestedActions"]; onCorrect: () => void }) {
  return (
    <div className="event-actions">
      <button className="ghost event-extra" onClick={onCorrect}>Correct</button>
      <button className="ghost" onClick={() => void dismissEvent(event.id)}>Dismiss</button>
      <button className="ghost event-extra" onClick={() => void deleteEvent(event.id)}>Delete</button>
      {primary.map((a) => (
        <button key={a.actionId} className="solid" title={a.url!} onClick={() => openLink(a.url!)}>{a.label} on {hostOf(a.url)}</button>
      ))}
    </div>
  );
}

function AddReminder({ onPaste }: { onPaste: () => void }) {
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState("");

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !when) return;
    void addReminder(title.trim(), { kind: "naive", value: `${when}:00` });
    setTitle("");
    setWhen("");
  };

  return (
    <form className="composer" onSubmit={add}>
      <input aria-label="Reminder" placeholder="Add a reminder" value={title} onChange={(e) => setTitle(e.target.value)} />
      <label className="ghost day-pick">
        <Icon name="calendar" size={14} />
        {when ? new Date(when).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : "Pick a time"}
        <input aria-label="When" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      </label>
      <button type="button" className="ghost" onClick={onPaste}>Paste an email</button>
      <button className="round solid" aria-label="Add" disabled={!title.trim() || !when}>
        <Icon name="plus" size={15} />
      </button>
    </form>
  );
}

/** Works before any account is connected, and shows what extraction would see. */
function PasteEmail({ onClose }: { onClose: () => void }) {
  const [subject, setSubject] = useState("");
  const [from, setFrom] = useState("");
  const [body, setBody] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const run = async () => {
    const found = await importEmail(subject, from, body);
    setResult(found === 0 ? "Nothing reliable in that message, so nothing was added." : `Added ${found} ${found === 1 ? "item" : "items"}.`);
    if (found > 0) {
      setSubject("");
      setFrom("");
      setBody("");
    }
  };

  return (
    <div className="plate day-paste stack">
      <div className="row">
        <input className="grow" aria-label="Subject" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
        <input className="grow" aria-label="From" placeholder="From" value={from} onChange={(e) => setFrom(e.target.value)} />
      </div>
      <textarea aria-label="Email text" rows={5} placeholder="Paste the message" value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="row end">
        {result && <span className="meta grow" role="status">{result}</span>}
        <button className="ghost" onClick={onClose}>Close</button>
        <button className="solid" disabled={!subject.trim() || !body.trim()} onClick={() => void run()}>Read it</button>
      </div>
    </div>
  );
}

/** Gmail through the Claude account: what it is doing, what it found, and a way to read again. */
function ClaudeMail() {
  const { reading, said, failed } = useApp((s) => s.activity.claudeMail);
  return (
    <div className="row day-claude">
      <p className="meta grow" aria-live="polite">
        {reading ? "Reading Gmail through your Claude account. This takes about a minute." : said || "Gmail is read through your Claude account."}
      </p>
      {!reading && <button className="ghost" onClick={() => void readMailThroughClaude(true)}>{failed ? "Try again" : "Read again"}</button>}
    </div>
  );
}

// ── Cards you can act on ────────────────────────────────────────────────────

type Reply = Extract<Card, { kind: "reply" }>;
type Trip = Extract<Card, { kind: "trip" }>;
/** A line at the foot of the page for a few seconds, with Undo when there is something to undo. */
type Toast = { text: string; undo?: () => void; stop?: CardKind };
const TOAST_MS = 6000;

/** Not now asks when to bring the card back. */
function NotNow({ id, onPicked }: { id: string; onPicked?: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open]);
  const keys = (e: React.KeyboardEvent) => {
    if (open && e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
    }
  };
  return (
    <span className="menu-root" ref={root} onKeyDown={keys}>
      <button className="ghost day-quiet" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>Not now</button>
      {open && (
        <span className="menu day-later-menu" role="menu" aria-label="Bring it back">
          {laterOptions(new Date()).map((o) => (
            <button key={o.label} className="menu-row" role="menuitem" onClick={() => { setOpen(false); onPicked?.(); void hideCard(id, o.until); }}>{o.label}</button>
          ))}
        </span>
      )}
    </span>
  );
}

function CardView({ card, now, focused, onOpen, onToast }: { card: Card; now: Date; focused: boolean; onOpen: (id: string) => void; onToast: (toast: Toast) => void }) {
  const kind = KINDS[card.kind];
  const self = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) self.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  const dismiss = () => {
    void dismissCard(card.id);
    onToast({ text: `Dismissed “${cardLine(card, now).title}”`, undo: () => void dismissCard(card.id, false), stop: card.kind });
  };
  const remind = async () => {
    const at = await remindTonight(card, now);
    onToast({ text: `A reminder is set for ${clockOf(at)}. The card is back then.` });
  };

  return (
    <section ref={self} className="plate day-card" data-kind={card.kind} data-focus={focused || undefined} aria-label={cardTitle(card, now)}>
      <span className="day-square" style={{ background: kind.tone }}><Icon name={kind.icon} size={14} /></span>
      <div className="day-card-main">
        <span className="day-tag">{cardTag(card, now)}</span>
        <h3 className="day-card-title">{cardTitle(card, now)}</h3>
        <p className="day-card-text">{cardText(card, now)}</p>
        <div className="day-card-acts">
          {card.kind === "reply" && (
            <>
              <button className="solid" onClick={() => onOpen(card.id)}>Read the draft</button>
              {card.link && <button className="ghost" title={hostOf(card.link)} onClick={() => void openInGmail(card)}>Open in Gmail</button>}
            </>
          )}
          {card.kind === "renewal" && (
            <>
              <button className="solid" onClick={() => void remind()}>Remind me tonight</button>
              {card.link && <button className="ghost" title={hostOf(card.link)} onClick={() => openLink(card.link!)}>Open</button>}
            </>
          )}
          {card.kind === "trip" && <button className="solid" onClick={() => onOpen(card.id)}>See the plan</button>}
        </div>
      </div>
      <div className="day-card-side">
        <NotNow id={card.id} />
        <button className="round day-x" aria-label="Dismiss" title="Dismiss" onClick={dismiss}>
          <Icon name="close" size={11} />
        </button>
      </div>
    </section>
  );
}

/** Everything a sheet over My Day shares: its heading, Close, and Escape closing only the sheet. */
function Sheet({ title, aside, onClose, children }: { title: string; aside: string; onClose: () => void; children: React.ReactNode }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);
  return (
    <div className="day-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="day-sheet"
        role="dialog"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          onClose();
        }}
      >
        <header className="day-sheet-head">
          <h3 className="grow truncate">{title}</h3>
          <span className="meta">{aside}</span>
          <button ref={close} className="round" aria-label="Close" title="Close" onClick={onClose}>
            <Icon name="close" size={13} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

/** Read the draft: the draft, what it was written from, and the three ways on. Nothing here sends. */
function DraftSheet({ card, onClose }: { card: Reply; onClose: () => void }) {
  const [draft, setDraft] = useState(card.draft);
  const [failed, setFailed] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [styled, setStyled] = useState(false);
  const first = card.who.split(/\s+/)[0] || card.who;

  const write = () => {
    setFailed("");
    draftOf(card).then(setDraft, (err) => setFailed(err instanceof Error ? err.message : String(err)));
  };
  useEffect(() => {
    if (!card.draft) write();
    void bridge.styleGet().then((profile) => setStyled(profile !== null)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id]);

  const save = async () => {
    if (editing === null || !editing.trim()) return;
    await bridge.cardsSetDraft(card.id, editing);
    setDraft(editing.trim());
    setEditing(null);
    void refreshCards();
  };
  const copy = async () => {
    if (!draft) return;
    await navigator.clipboard.writeText(draft);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Sheet title={`Reply to ${first}`} aside="Draft · not sent" onClose={onClose}>
      <p className="meta">To {card.who} · {/^re:/i.test(card.subject) ? card.subject : `Re: ${card.subject}`}</p>
      {editing !== null ? (
        <textarea className="day-draft" aria-label="Draft" rows={6} autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} />
      ) : draft ? (
        <div className="day-draft">{draft}</div>
      ) : failed ? (
        <div className="day-warn" role="alert">
          <Icon name="warn" size={14} />
          <span className="grow">The draft could not be written. {failed}</span>
          <button className="ghost" onClick={write}>Try again</button>
        </div>
      ) : (
        <p className="day-draft meta" aria-busy="true">Writing it{styled ? " in your style" : ""}…</p>
      )}
      <p className="meta">Written from {first}'s mail of {dayMonth(new Date(card.seen))}{styled ? ", in your style" : ""}.</p>
      <div className="day-info">
        <Icon name="lock" size={14} />
        <span>Meridian does not send this. Open in Gmail opens the thread, and Write here puts the draft in the reply box. You press Send.</span>
      </div>
      <div className="row end">
        {editing !== null ? (
          <>
            <button className="ghost" onClick={() => setEditing(null)}>Cancel</button>
            <button className="solid" disabled={!editing.trim()} onClick={() => void save()}>Save</button>
          </>
        ) : (
          <>
            <button className="ghost" disabled={!draft} onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
            <button className="ghost" disabled={!draft} onClick={() => setEditing(draft ?? "")}>Change it</button>
            <button className="solid" title={card.link ? hostOf(card.link) : undefined} disabled={!card.link} onClick={() => { onClose(); void openInGmail(card, draft); }}>Open in Gmail</button>
          </>
        )}
      </div>
    </Sheet>
  );
}

/** See the plan: a plan, not a booking. The site opens in the browser, and the seat and payment are the user's. */
function PlanSheet({ card, onClose }: { card: Trip; onClose: () => void }) {
  return (
    <Sheet title={card.title} aside={weekdayDate(new Date(card.starts))} onClose={onClose}>
      <ol className="day-steps">
        {planSteps(card).map((step, i) => (
          <li key={i}>
            <span className="day-step-n tabular">{i + 1}</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <p className="meta">{planWhy(card)}</p>
      <div className="row end">
        <NotNow id={card.id} onPicked={onClose} />
        <button className="solid" title={hostOf(card.site.url)} onClick={() => openLink(card.site.url)}>Open {card.site.name}</button>
      </div>
    </Sheet>
  );
}

/** The day's heading, then what needs the user, then what is still ahead today. */
function Today({ onOpen }: { onOpen: (id: string) => void }) {
  const { cards, failures, checking, checkedAt } = useApp((s) => s.cards);
  const all = useApp((s) => s.activity.all);
  const focus = useApp((s) => s.cardFocus);
  const ready = useApp(canCheck);
  const [toast, setToast] = useState<Toast | null>(null);
  const now = new Date();
  const summary = daySummary(cards.length, meetingsToday(all, now), parcelsOnTheWay(all));
  const later = laterToday(all, now);
  const checkedToday = checkedAt !== null && new Date(checkedAt).toDateString() === now.toDateString();

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!focus) return;
    const timer = setTimeout(() => setCardFocus(null), 2400);
    return () => clearTimeout(timer);
  }, [focus]);

  return (
    <>
      <header className="day-head">
        <h2>{longDate(now)}</h2>
        {summary && <p className="meta">{summary}</p>}
      </header>
      {cards.length > 0 && <h3 className="day-h">Needs you · {cards.length}</h3>}
      {failures.map((f) => (
        <div className="day-warn" key={f.source}>
          <Icon name="warn" size={14} />
          <span className="grow">{failureLine(f, new Date(checkedAt ?? Date.now()))}</span>
          <button className="ghost" disabled={checking} onClick={() => void checkCards()}>{checking ? "Checking…" : "Try again"}</button>
        </div>
      ))}
      {cards.map((card) => (
        <CardView key={card.id} card={card} now={now} focused={focus === card.id} onOpen={onOpen} onToast={setToast} />
      ))}
      {cards.length === 0 && failures.length === 0 && checkedToday && ready && (
        <div className="plate day-calm">
          <span className="day-happy" aria-hidden="true"><i /><i /></span>
          <p className="day-calm-title">Nothing needs you today</p>
          <p className="meta">Cards show up here when someone is waiting on a reply, something renews, or a trip has no booking.</p>
        </div>
      )}
      {later.length > 0 && (
        <>
          <h3 className="day-h">Later today</h3>
          {later.map((row) => (
            <div className="day-later" key={row.id}>
              <span className="day-later-time tabular">{row.time}</span>
              <span className="grow truncate">{row.title}</span>
              <span className="meta truncate">{row.where}</span>
            </div>
          ))}
        </>
      )}
      {toast && (
        <div className="day-toast" aria-live="polite">
          <span className="grow">{toast.text}</span>
          {toast.undo && <button className="ghost" onClick={() => { toast.undo?.(); setToast(null); }}>Undo</button>}
          {toast.stop && <button className="ghost" onClick={() => { void stopKind(toast.stop!); setToast(null); }}>{KINDS[toast.stop].stop}</button>}
        </div>
      )}
    </>
  );
}

/** Settings › My day: each kind of card can be turned off. */
export function MyDaySection() {
  const myDay = useApp((s) => s.settings.myDay);
  const localOnly = useApp((s) => s.settings.localOnly);
  const change = (patch: Partial<typeof myDay>) => void updateSettings({ myDay: { ...myDay, ...patch } }).then(refreshCards);
  return (
    <section className="stack-lg">
      <header className="settings-head">
        <h1>My day</h1>
        <p className="meta">Cards at the top of My Day, for the things that need you.</p>
      </header>
      <div className="stack">
        <Switch label="Replies people are waiting on" hint="After 2 days with no reply from you" on={myDay.replies} off={localOnly} set={(replies) => change({ replies })} />
        <Switch label="Renewals and free trials" hint="From receipts in Gmail" on={myDay.renewals} off={localOnly} set={(renewals) => change({ renewals })} />
        <Switch label="Trips with nothing booked" hint="From your calendar and booking mail" on={myDay.trips} off={localOnly} set={(trips) => change({ trips })} />
        <Switch label="Morning summary on the island" hint="Once, after 6 am" on={myDay.summary} off={localOnly} set={(summary) => change({ summary })} />
      </div>
      <p className="meta">
        {localOnly
          ? "Off while local-only mode is on, because Gmail and Google Calendar are read through your Claude account."
          : "Each kind can be turned off. All of them need Gmail or Google Calendar connected in your Claude account. They are only read, and nothing is sent, bought or booked."}
      </p>
    </section>
  );
}

export function MyDay() {
  const { category, events, accounts, claudeMail, all } = useApp((s) => s.activity);
  const throughClaude = useApp(mailThroughClaude);
  const [pasting, setPasting] = useState(false);
  const [sheet, setSheet] = useState<string | null>(null);
  const shown = useApp((s) => s.cards.cards.find((c) => c.id === sheet));
  const sources = [
    accounts.length > 0 && `${accounts.length} connected ${accounts.length === 1 ? "account" : "accounts"}`,
    throughClaude && !claudeMail.failed && claudeMail.at > 0 && "Gmail through your Claude account",
  ].filter(Boolean);
  const from = `From ${[...sources, "your own reminders"].join(", ").replace(/, ([^,]*)$/, " and $1")}.`;
  const connected = sources.length > 0;

  useEffect(() => {
    // Each visit reads the current state of the store, and Gmail through Claude when it is due.
    void refreshActivity(category).then(() => readMailThroughClaude());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="day-page board">
      <div className="day-list">
        <Today onOpen={setSheet} />
        <div className="chips" role="group" aria-label="Show">
          {CATEGORIES.map((c) => (
            <button key={c.value} className="chip" aria-pressed={category === c.value} onClick={() => void refreshActivity(c.value)}>{c.label}</button>
          ))}
        </div>
        {throughClaude && <ClaudeMail />}
        {pasting && <PasteEmail onClose={() => setPasting(false)} />}
        {events.map((e, i) => (
          <EventCard key={e.id} event={e} last={i === events.length - 1} />
        ))}
        {events.length > 0 && connected && <p className="meta day-note">{from}</p>}
        {events.length === 0 && !pasting && (
          <div className="page-rest">
            <Icon name="calendar" size={34} />
            <p className="page-rest-title">Nothing here</p>
            <p className="meta">
              {all.length > 0
                ? `Nothing under ${CATEGORIES.find((c) => c.value === category)?.label ?? "this"}. ${all.length} ${all.length === 1 ? "item is" : "items are"} under the other headings.`
                : connected ? from : throughClaude ? "Nothing yet from Gmail. Add a reminder, or paste an email below." : "Connect an account in Settings, or paste an email below."}
            </p>
            {!connected && !throughClaude && <button className="solid" onClick={() => openSettings("providers")}>Connect an account</button>}
          </div>
        )}
      </div>

      <AddReminder onPaste={() => setPasting(!pasting)} />
      {shown?.kind === "reply" && <DraftSheet card={shown} onClose={() => setSheet(null)} />}
      {shown?.kind === "trip" && <PlanSheet card={shown} onClose={() => setSheet(null)} />}
    </div>
  );
}
