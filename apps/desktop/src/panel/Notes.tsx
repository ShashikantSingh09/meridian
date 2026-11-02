// Notes: a call from Record to a finished note, with the list on the left and the note on the right.

import { useEffect, useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import { Icon } from "../lib/icons";
import {
  clockOf,
  copiedFor,
  copyNote,
  currentNote,
  deleteNote,
  exportNote,
  personTone,
  retryNote,
  setSummaryByItself,
  startRecording,
  stopRecording,
  talkShares,
  useNoteLevels,
  useRunningClock,
  writeSummary,
} from "../lib/notes";
import { openSettings, pushError, showNote, useApp } from "../lib/store";
import type { Note, NoteLine, NoteSpeaker, NoteTodo } from "../lib/types";

const HEARING: Record<string, string> = { elevenlabs: "ElevenLabs", deepgram: "Deepgram" };

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const timeOf = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const minutesOf = (note: Note) => Math.max(1, Math.round(((note.endedAt ?? Date.now()) - note.startedAt) / 60_000));

function dayOf(ms: number) {
  const day = new Date(ms);
  return sameDay(day, new Date()) ? "Today" : day.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

function whenOf(note: Note) {
  const day = new Date(note.startedAt).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  return note.endedAt ? `${day} · ${timeOf(note.startedAt)} to ${timeOf(note.endedAt)}` : day;
}

function Row({ note, selected, working }: { note: Note; selected: boolean; working: boolean }) {
  const meta = note.status === "recording" ? "Recording" : note.status === "failed" ? "Could not be written" : note.status === "writing" || (working && note.lines.length === 0) ? "Writing the notes" : `${timeOf(note.startedAt)} · ${minutesOf(note)} min`;
  return (
    <button className="note-row" aria-current={selected ? "true" : undefined} onClick={() => showNote(note.id)}>
      <span className="label truncate">{note.title}</span>
      <span className="meta truncate" data-recording={note.status === "recording"}>
        {note.status === "recording" && <i className="rec-dot" aria-hidden="true" />}
        {meta}
      </span>
    </button>
  );
}

function List({ selected }: { selected: Note | null }) {
  const notes = useApp((s) => s.notes.notes);
  const recording = useApp((s) => s.notes.recording);
  const working = useApp((s) => s.notes.working);
  const byItself = useApp((s) => s.settings.notesSummary);
  const days = [...new Set(notes.map((note) => dayOf(note.startedAt)))];
  return (
    <div className="notes-list">
      {recording ? (
        <button className="record-button stop" onClick={() => void stopRecording()}><i aria-hidden="true" />Stop</button>
      ) : (
        <button className="record-button" onClick={() => void startRecording()}><i aria-hidden="true" />Record</button>
      )}
      <div className="notes-rows">
        {days.map((day) => (
          <div key={day} className="notes-day">
            <h2 className="note-label">{day}</h2>
            {notes.filter((note) => dayOf(note.startedAt) === day).map((note) => <Row key={note.id} note={note} selected={note.id === selected?.id} working={working.includes(note.id)} />)}
          </div>
        ))}
      </div>
      <div className="notes-foot">
        <p className="meta">Tell the people in the call that you are recording.</p>
        <label className="setting toggle">
          <span className="label">Summary by itself</span>
          <input type="checkbox" role="switch" checked={byItself} onChange={(e) => setSummaryByItself(e.target.checked)} />
        </label>
      </div>
    </div>
  );
}

/** Text that turns into a box when clicked, for naming a note or a person. */
function Rename({ value, label, onDone, render }: { value: string; label: string; onDone: (text: string) => void; render: (edit: () => void) => React.JSX.Element }) {
  const [text, setText] = useState<string | null>(null);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => box.current?.select(), [text === null]);
  if (text === null) return render(() => setText(value));
  const finish = () => {
    if (text.trim() && text.trim() !== value) onDone(text);
    setText(null);
  };
  return (
    <input
      ref={box}
      className="note-rename"
      aria-label={label}
      value={text}
      autoFocus
      onChange={(e) => setText(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish();
        if (e.key === "Escape") setText(null);
      }}
    />
  );
}

function Heading({ note, tools }: { note: Note; tools?: React.ReactNode }) {
  return (
    <div className="note-head">
      <div className="grow note-title">
        <Rename
          value={note.title}
          label="Name this note"
          onDone={(title) => void bridge.noteRename(note.id, title)}
          render={(edit) => <h2><button className="text-button truncate" title="Click to rename" onClick={edit}>{note.title}</button></h2>}
        />
        <p className="meta truncate">{whenOf(note)}</p>
      </div>
      {tools}
    </div>
  );
}

function Tools({ note, confirm }: { note: Note; confirm: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await copyNote(note.id).catch((err) => pushError({ title: "Could not copy this note", body: String(err) }));
    setCopied(true);
    setTimeout(() => setCopied(false), copiedFor);
  };
  return (
    <div className="note-tools">
      {note.status === "ready" && (
        <>
          <button className="ghost" onClick={() => void copy()}><Icon name={copied ? "check" : "copy"} size={14} />{copied ? "Copied" : "Copy"}</button>
          <button className="ghost" onClick={() => void exportNote(note)}><Icon name="save" size={14} />Export</button>
        </>
      )}
      <button className="round" aria-label="Delete this note" title="Delete" onClick={confirm}><Icon name="trash" size={15} /></button>
    </div>
  );
}

function ConfirmDelete({ note, cancel }: { note: Note; cancel: () => void }) {
  return (
    <div className="note-card note-confirm" role="alert">
      <span className="label grow">Delete this note{note.status === "ready" ? "" : " and its recording"}?</span>
      <button className="danger" onClick={() => void deleteNote(note.id)}>Delete</button>
      <button className="ghost" onClick={cancel}>Cancel</button>
    </div>
  );
}

function Person({ note, speaker, share }: { note: Note; speaker: NoteSpeaker; share: number | undefined }) {
  return (
    <Rename
      value={speaker.name}
      label={`Name ${speaker.name}`}
      onDone={(name) => void bridge.noteRenameSpeaker(note.id, speaker.id, name)}
      render={(edit) => (
        <button className="note-person" title="Click to rename" onClick={edit}>
          <i style={{ background: personTone(speaker.color) }} aria-hidden="true">{speaker.name.slice(0, 1).toUpperCase()}</i>
          {speaker.name}
          {share !== undefined && <span className="tabular">{share}%</span>}
        </button>
      )}
    />
  );
}

function ToDo({ note, todo }: { note: Note; todo: NoteTodo }) {
  const who = [todo.owner, todo.due].filter(Boolean).join(" · ");
  return (
    <button className="note-todo" role="checkbox" aria-checked={todo.done} onClick={() => void bridge.noteToggleTodo(note.id, todo.id)}>
      <i aria-hidden="true">{todo.done && <Icon name="check" size={12} />}</i>
      <span>
        <span className="note-todo-text">{todo.text}</span>
        {who && <span className="meta">{who}</span>}
      </span>
    </button>
  );
}

function Summary({ note }: { note: Note }) {
  const busy = useApp((s) => s.notes.working.includes(note.id));
  const write = () => void writeSummary(note.id).catch((err) => pushError({ title: "Could not write the summary", body: err instanceof Error ? err.message : String(err) }));
  if (!note.summary && note.keyPoints.length === 0 && note.todos.length === 0) {
    return (
      <div className="note-body">
        <p className="meta">{busy ? "Writing the summary." : "No summary yet."}</p>
        {!busy && <div><button className="solid" onClick={write}>Write the summary</button></div>}
      </div>
    );
  }
  const done = note.todos.filter((todo) => todo.done).length;
  return (
    <div className="note-body">
      {note.summary && <p className="note-summary">{note.summary}</p>}
      {note.keyPoints.length > 0 && (
        <>
          <h3 className="note-label">Key points</h3>
          <ul className="note-points">{note.keyPoints.map((point) => <li key={point}>{point}</li>)}</ul>
        </>
      )}
      {note.todos.length > 0 && (
        <>
          <div className="row">
            <h3 className="note-label grow">To do</h3>
            <span className="meta tabular">{done} of {note.todos.length}</span>
          </div>
          <div className="note-todos">{note.todos.map((todo) => <ToDo key={todo.id} note={note} todo={todo} />)}</div>
        </>
      )}
    </div>
  );
}

function Said({ line, speaker }: { line: NoteLine; speaker: NoteSpeaker | undefined }) {
  const tone = personTone(speaker?.color ?? 1);
  const name = speaker?.name ?? "Someone";
  return (
    <div className="note-line">
      <i style={{ background: tone }} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</i>
      <div>
        <div className="row note-who">
          <span className="note-name" style={{ color: tone }}>{name}</span>
          <span className="meta tabular">{clockOf(line.start)}</span>
        </div>
        <p>{line.text}</p>
      </div>
    </div>
  );
}

function Finished({ note }: { note: Note }) {
  const [tab, setTab] = useState<"summary" | "transcript">("summary");
  const [deleting, setDeleting] = useState(false);
  const shares = talkShares(note);
  useEffect(() => {
    setTab("summary");
    setDeleting(false);
  }, [note.id]);
  return (
    <div className="notes-pane">
      <Heading note={note} tools={<Tools note={note} confirm={() => setDeleting(true)} />} />
      {deleting && <ConfirmDelete note={note} cancel={() => setDeleting(false)} />}
      {note.lines.length === 0 ? (
        <p className="meta">Nobody was heard in this recording.</p>
      ) : (
        <>
          <div className="note-people">{note.speakers.map((speaker) => <Person key={speaker.id} note={note} speaker={speaker} share={shares.get(speaker.id)} />)}</div>
          <div className="chips" role="group" aria-label="Show">
            <button className="chip" aria-pressed={tab === "summary"} onClick={() => setTab("summary")}>Summary</button>
            <button className="chip" aria-pressed={tab === "transcript"} onClick={() => setTab("transcript")}>Transcript</button>
          </div>
          {tab === "summary" ? <Summary note={note} /> : <div className="note-body note-lines">{note.lines.map((line) => <Said key={line.id} line={line} speaker={note.speakers.find((s) => s.id === line.speaker)} />)}</div>}
        </>
      )}
    </div>
  );
}

function Level({ name, tone, level }: { name: string; tone: string; level: number }) {
  return (
    <div className="note-level">
      <span>{name}</span>
      <i aria-hidden="true"><b style={{ width: `${Math.min(100, Math.sqrt(level) * 100)}%`, background: tone }} /></i>
    </div>
  );
}

function Recording({ note }: { note: Note }) {
  const time = useRunningClock(note.startedAt);
  const levels = useNoteLevels();
  const hearing = useApp((s) => HEARING[s.settings.voiceHearing] ?? "the service you chose");
  return (
    <div className="notes-pane note-centred">
      <div>
        <div className="note-state"><i className="rec-dot" aria-hidden="true" />Recording</div>
        <div className="note-time tabular">{time}</div>
      </div>
      <div className="note-levels">
        <Level name="You" tone={personTone(0)} level={levels.you} />
        <Level name="Others" tone={personTone(1)} level={levels.others} />
      </div>
      <p className="meta note-explain">Your microphone and this PC's sound are being recorded. When you stop, they go to {hearing} to be written down, then the audio is deleted. Wake words wait until you stop.</p>
    </div>
  );
}

function Writing({ note }: { note: Note }) {
  return (
    <div className="notes-pane">
      <Heading note={note} />
      <div className="note-centred">
        <div className="note-progress" aria-hidden="true"><i /></div>
        <div className="stack-sm">
          <span className="note-writing">Writing down who said what</span>
          <span className="meta">Then the summary and the to-dos.</span>
        </div>
        <p className="meta">You can close this. The island says when the notes are ready.</p>
      </div>
    </div>
  );
}

function Failed({ note }: { note: Note }) {
  const [deleting, setDeleting] = useState(false);
  return (
    <div className="notes-pane">
      <Heading note={note} tools={<Tools note={note} confirm={() => setDeleting(true)} />} />
      <div className="note-card">
        <h3 className="note-writing">The transcript could not be written</h3>
        {note.error && <p className="meta">{note.error}</p>}
        <p className="meta">The recording is kept, so nothing is lost.</p>
        <div><button className="solid" onClick={() => retryNote(note.id)}>Try again</button></div>
      </div>
      {deleting && <ConfirmDelete note={note} cancel={() => setDeleting(false)} />}
    </div>
  );
}

function Blank({ title, body, action }: { title: string; body: string; action: React.JSX.Element }) {
  return (
    <div className="notes-blank">
      <Icon name="note" size={34} />
      <h2>{title}</h2>
      <p className="meta">{body}</p>
      {action}
    </div>
  );
}

export function Notes() {
  const notes = useApp((s) => s.notes.notes);
  const recording = useApp((s) => s.notes.recording);
  const selectedId = useApp((s) => s.selectedNote);
  const hearing = useApp((s) => s.settings.voiceHearing);
  const working = useApp((s) => s.notes.working);
  const note = currentNote(notes, selectedId, recording);

  if (!note) {
    const service = HEARING[hearing];
    if (!service) {
      return <Blank title="Notes need ElevenLabs or Deepgram" body="They write down a call in Hindi, English or both, and tell people apart. Hearing on this PC cannot do that yet." action={<button className="solid" onClick={() => openSettings("voice")}>Open Voice settings</button>} />;
    }
    return (
      <Blank
        title="No notes yet"
        body={`Record a call, and get who said what, a summary and the to-dos. Tell the people in the call that you are recording. Your call goes to ${service} to be written down and to your AI for the summary, then the audio is deleted.`}
        action={<button className="record-button" onClick={() => void startRecording()}><i aria-hidden="true" />Record</button>}
      />
    );
  }
  const writing = note.status === "writing" || (working.includes(note.id) && note.lines.length === 0 && note.status !== "ready");
  return (
    <div className="notes-page">
      <List selected={note} />
      {note.status === "recording" ? <Recording note={note} /> : writing ? <Writing note={note} /> : note.status === "failed" ? <Failed note={note} /> : <Finished note={note} />}
    </div>
  );
}
