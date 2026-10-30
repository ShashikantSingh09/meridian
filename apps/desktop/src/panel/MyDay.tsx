import { useEffect, useState } from "react";
import {
  addReminder,
  deleteEvent,
  describeTime,
  dismissEvent,
  importEmail,
  openLink,
  refreshActivity,
  renameEvent,
  useApp,
} from "../lib/store";
import { hostOf } from "../island/views";
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

function EventCard({ event }: { event: ContextEvent }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(event.title);

  const save = () => {
    setEditing(false);
    if (title.trim() && title !== event.title) void renameEvent(event.id, title.trim());
  };

  return (
    <article className="event" data-status={event.status}>
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
          <span className="label grow truncate" title={event.title}>{event.title}</span>
        )}
        {event.status === "cancelled" && <span className="flag">Cancelled</span>}
        {event.status === "updated" && <span className="flag">Updated</span>}
        {event.confidence < CONFIDENT && <span className="flag" title={`Confidence ${Math.round(event.confidence * 100)}%`}>Unconfirmed</span>}
      </div>
      {event.startsAt && (
        <p className="meta">
          {describeTime(event.startsAt)}
          {event.startsAt.kind === "naive" && <span title="The source gave no time zone"> (no time zone stated)</span>}
        </p>
      )}
      {event.body && <p className="meta">{event.body}</p>}
      <p className="source-line truncate" title={event.sourceRef?.subject}>
        {event.sourceRef ? `From ${event.sourceRef.account}: ${event.sourceRef.subject}` : event.source === "user" ? "Added by you" : `From ${event.source}`}
      </p>
      <div className="event-actions">
        {event.suggestedActions.filter((a) => a.url).map((a) => (
          <button key={a.actionId} className="solid" title={a.url!} onClick={() => openLink(a.url!)}>{a.label} on {hostOf(a.url)}</button>
        ))}
        <button className="ghost" onClick={() => setEditing(true)}>Correct</button>
        <button className="ghost" onClick={() => void dismissEvent(event.id)}>Dismiss</button>
        <button className="ghost" onClick={() => void deleteEvent(event.id)}>Delete</button>
      </div>
    </article>
  );
}

function AddReminder() {
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
    <form className="field-row" onSubmit={add}>
      <input aria-label="Reminder" placeholder="Add a reminder" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input aria-label="When" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      <button className="ghost" disabled={!title.trim() || !when}>Add</button>
    </form>
  );
}

/** Works before any account is connected, and shows what extraction would see. */
function PasteEmail() {
  const [open, setOpen] = useState(false);
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

  if (!open) {
    return <button className="ghost" onClick={() => setOpen(true)}>Paste an email</button>;
  }
  return (
    <div className="stack">
      <input aria-label="Subject" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
      <input aria-label="From" placeholder="From" value={from} onChange={(e) => setFrom(e.target.value)} />
      <textarea aria-label="Email text" rows={5} placeholder="Paste the message" value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="row end">
        {result && <span className="meta grow" role="status">{result}</span>}
        <button className="ghost" onClick={() => setOpen(false)}>Close</button>
        <button className="solid" disabled={!subject.trim() || !body.trim()} onClick={() => void run()}>Read it</button>
      </div>
    </div>
  );
}

export function MyDay() {
  const { category, events, accounts } = useApp((s) => s.activity);

  useEffect(() => {
    void refreshActivity(category);
    // Each visit reads the current state of the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="page-scroll stack-lg">
      <header className="stack-sm">
        <p className="meta">
          {accounts.length > 0
            ? `From ${accounts.length} connected ${accounts.length === 1 ? "account" : "accounts"} and your own reminders.`
            : "Connect an account in Settings, or paste an email below."}
        </p>
      </header>

      <div className="chips">
        {CATEGORIES.map((c) => (
          <button key={c.value} className="chip" aria-pressed={category === c.value} onClick={() => void refreshActivity(c.value)}>{c.label}</button>
        ))}
      </div>

      <section className="stack">
        {events.length === 0 && <p className="meta">Nothing here.</p>}
        {events.map((e) => (
          <EventCard key={e.id} event={e} />
        ))}
      </section>

      <AddReminder />
      <PasteEmail />
    </div>
  );
}
