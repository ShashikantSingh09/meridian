import { useEffect, useState } from "react";
import {
  addReminder,
  deleteEvent,
  describeTime,
  dismissEvent,
  importEmail,
  openLink,
  openSettings,
  refreshActivity,
  renameEvent,
  timeToday,
  useApp,
} from "../lib/store";
import { liveFrom, timeOf } from "../island/live";
import { hostOf } from "../island/views";
import { Icon } from "../lib/icons";
import type { Category, ContextEvent } from "../lib/types";

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

export function MyDay() {
  const { category, events, accounts } = useApp((s) => s.activity);
  const [pasting, setPasting] = useState(false);
  const from = `From ${accounts.length} connected ${accounts.length === 1 ? "account" : "accounts"} and your own reminders.`;

  useEffect(() => {
    void refreshActivity(category);
    // Each visit reads the current state of the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="day-page board">
      <div className="chips" role="group" aria-label="Show">
        {CATEGORIES.map((c) => (
          <button key={c.value} className="chip" aria-pressed={category === c.value} onClick={() => void refreshActivity(c.value)}>{c.label}</button>
        ))}
      </div>

      <div className="day-list">
        {pasting && <PasteEmail onClose={() => setPasting(false)} />}
        {events.map((e, i) => (
          <EventCard key={e.id} event={e} last={i === events.length - 1} />
        ))}
        {events.length > 0 && accounts.length > 0 && <p className="meta day-note">{from}</p>}
        {events.length === 0 && !pasting && (
          <div className="page-rest">
            <Icon name="calendar" size={34} />
            <p className="page-rest-title">Nothing here</p>
            <p className="meta">{accounts.length > 0 ? from : "Connect an account in Settings, or paste an email below."}</p>
            {accounts.length === 0 && <button className="solid" onClick={() => openSettings("providers")}>Connect an account</button>}
          </div>
        )}
      </div>

      <AddReminder onPaste={() => setPasting(!pasting)} />
    </div>
  );
}
