// Settings › Your details. The profile is kept in a file on this PC and put into forms by Meridian
// itself, so the AI only ever names a box ("phone goes here"). ID numbers are kept in Windows
// Credential Manager, off until turned on.

import { useEffect, useState } from "react";
import { bridge } from "../lib/bridge";
import { emptyProfile, idProblem, isEmpty, problem, showBirth, type Check, type IdKind, type IdNumbers, type Profile } from "../lib/details";
import { Icon } from "../lib/icons";

interface Field {
  /** Where it lives in the profile, like address.pin. */
  path: string;
  label: string;
  /** Of six columns. */
  span: 2 | 3 | 6;
  type?: "email" | "tel" | "date";
  check?: Check;
  hindi?: boolean;
}

interface Part {
  id: string;
  title: string;
  rows: [label: string, value: (p: Profile) => string, hindi?: boolean][];
  fields: Field[];
}

const PARTS: Part[] = [
  {
    id: "name",
    title: "Name and birth",
    rows: [["Name in English", (p) => p.name.en], ["Name in Hindi", (p) => p.name.hi, true], ["Date of birth", (p) => showBirth(p.birth)]],
    fields: [
      { path: "name.en", label: "Name in English", span: 6 },
      { path: "name.hi", label: "Name in Hindi", span: 6, hindi: true },
      { path: "birth", label: "Date of birth", span: 3, type: "date", check: "birth" },
    ],
  },
  {
    id: "contact",
    title: "Contact",
    rows: [["Email", (p) => p.email], ["Phone", (p) => p.phone], ["Other phone", (p) => p.otherPhone]],
    fields: [
      { path: "email", label: "Email", span: 6, type: "email", check: "email" },
      { path: "phone", label: "Phone", span: 3, type: "tel", check: "phone" },
      { path: "otherPhone", label: "Other phone", span: 3, type: "tel", check: "phone" },
    ],
  },
  {
    id: "address",
    title: "Home address",
    rows: [
      ["Address", (p) => p.address.lines],
      ["City, PIN code", (p) => [p.address.city, p.address.pin].filter(Boolean).join(", ")],
      ["State", (p) => p.address.state],
      ["In Hindi", (p) => p.address.hi, true],
    ],
    fields: [
      { path: "address.lines", label: "Address", span: 6 },
      { path: "address.city", label: "City", span: 2 },
      { path: "address.pin", label: "PIN code", span: 2, check: "pin" },
      { path: "address.state", label: "State", span: 2 },
      { path: "address.hi", label: "In Hindi, for forms in Hindi", span: 6, hindi: true },
    ],
  },
  {
    id: "work",
    title: "Work",
    rows: [
      ["Company", (p) => p.work.company],
      ["Job title", (p) => p.work.title],
      ["Department", (p) => p.work.department],
      ["Employee ID", (p) => p.work.employeeId],
      ["Work email", (p) => p.work.email],
      ["LinkedIn", (p) => p.work.linkedin],
    ],
    fields: [
      { path: "work.company", label: "Company", span: 3 },
      { path: "work.title", label: "Job title", span: 3 },
      { path: "work.department", label: "Department", span: 3 },
      { path: "work.employeeId", label: "Employee ID", span: 3 },
      { path: "work.email", label: "Work email", span: 6, type: "email", check: "email" },
      { path: "work.linkedin", label: "LinkedIn", span: 6 },
    ],
  },
];

const ID_ROWS: [IdKind, string][] = [["pan", "PAN"], ["aadhaar", "Aadhaar"], ["passport", "Passport"]];
const NO_IDS: IdNumbers = { pan: null, aadhaar: null, passport: null };

const clean = (err: unknown) => String(err).replace(/^Error: /, "");
const read = (profile: Profile, path: string) => path.split(".").reduce<unknown>((at, key) => (at as Record<string, unknown>)[key], profile) as string;

function write(profile: Profile, path: string, text: string) {
  const next = structuredClone(profile);
  const keys = path.split(".");
  const last = keys.pop()!;
  (keys.reduce<unknown>((at, key) => (at as Record<string, unknown>)[key], next) as Record<string, string>)[last] = text;
  return next;
}

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** One section, open for editing. Save waits until every box looks right. */
function EditPart({ part, profile, onCancel, onSave }: { part: Part; profile: Profile; onCancel: () => void; onSave: (next: Profile) => Promise<string | null> }) {
  const [draft, setDraft] = useState(profile);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const checked = part.fields.map((field) => ({ field, why: field.check ? problem(field.check, read(draft, field.path)) : null }));
  const problems = [...new Set(checked.flatMap(({ why }) => (why ? [why] : [])))];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (problems.length) return;
    setBusy(true);
    setFailed(await onSave(draft));
    setBusy(false);
  };

  return (
    <form className="stack details-part details-edit" aria-label={part.title} onSubmit={(e) => void submit(e)}>
      <h3>{part.title}</h3>
      <div className="details-fields">
        {checked.map(({ field, why }) => (
          <label key={field.path} className="field" style={{ gridColumn: `span ${field.span}` }}>
            <span className="label">{field.label}</span>
            <input
              type={field.type ?? "text"}
              lang={field.hindi ? "hi" : undefined}
              className={field.hindi ? "hindi" : undefined}
              max={field.type === "date" ? today() : undefined}
              aria-invalid={why ? true : undefined}
              value={read(draft, field.path)}
              onChange={(e) => setDraft(write(draft, field.path, e.target.value))}
            />
          </label>
        ))}
      </div>
      {[...problems, ...(failed ? [failed] : [])].map((why) => (
        <p key={why} className="meta bad" role="alert">{why}</p>
      ))}
      <div className="row end">
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
        <button className="solid" disabled={problems.length > 0 || busy}>Save</button>
      </div>
    </form>
  );
}

/** A number shows masked, with Show. Adding one is checked the way the core checks it. */
function IdRow({ kind, label, masked, onChanged }: { kind: IdKind; label: string; masked: string | null; onChanged: () => void }) {
  const [shown, setShown] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [failed, setFailed] = useState<string | null>(null);
  const why = idProblem(kind, text);

  const stop = () => {
    setAdding(false);
    setText("");
    setFailed(null);
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (why || !text.trim()) return;
    try {
      await bridge.detailsIdSet(kind, text);
      stop();
      onChanged();
    } catch (err) {
      setFailed(clean(err));
    }
  };
  const remove = async () => {
    await bridge.detailsIdSet(kind, "");
    setShown(null);
    onChanged();
  };

  if (adding) {
    return (
      <form className="setting details-row" onSubmit={(e) => void add(e)}>
        <span className="details-key">{label}</span>
        <span className="stacked grow">
          <input aria-label={label} autoComplete="off" spellCheck={false} aria-invalid={why ? true : undefined} value={text} onChange={(e) => setText(e.target.value)} />
          {(why ?? failed) && <span className="meta bad" role="alert">{why ?? failed}</span>}
        </span>
        <button type="button" className="ghost" onClick={stop}>Cancel</button>
        <button className="solid" disabled={!!why || !text.trim()}>Save</button>
      </form>
    );
  }
  return (
    <div className="setting details-row">
      <span className="details-key">{label}</span>
      {masked ? (
        <>
          <span className="details-value details-number grow">{shown ?? masked}</span>
          <button className="ghost" onClick={() => (shown ? setShown(null) : void bridge.detailsIdShow(kind).then(setShown))}>{shown ? "Hide" : "Show"}</button>
          <button className="ghost wake-remove" aria-label={`Remove ${label}`} title="Remove" onClick={() => void remove()}>
            <Icon name="close" size={13} />
          </button>
        </>
      ) : (
        <button className="details-add grow" onClick={() => setAdding(true)}>Add</button>
      )}
    </div>
  );
}

function Confirm({ question, note, yes, onYes, onNo }: { question: string; note: string; yes: string; onYes: () => void; onNo: () => void }) {
  return (
    <div className="stack details-confirm" role="alert">
      <span className="stacked grow">
        <span className="label">{question}</span>
        <span className="meta">{note}</span>
      </span>
      <div className="row end">
        <button className="ghost" onClick={onNo}>Cancel</button>
        <button className="danger" onClick={onYes}>{yes}</button>
      </div>
    </div>
  );
}

export function DetailsSection() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [ids, setIds] = useState<IdNumbers>(NO_IDS);
  const [editing, setEditing] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [asking, setAsking] = useState<"delete" | "ids" | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const refreshIds = () => void bridge.detailsIds().then(setIds, () => setIds(NO_IDS));
  useEffect(() => {
    bridge.detailsGet().then(setProfile, (err: unknown) => setFailed(clean(err)));
    refreshIds();
  }, []);

  const save = async (next: Profile) => {
    try {
      setProfile(await bridge.detailsSave(next));
      setFailed(null);
      return null;
    } catch (err) {
      return clean(err);
    }
  };
  const switchIds = async (on: boolean) => {
    setAsking(null);
    setFailed(await save({ ...profile!, ids: on }));
    refreshIds();
  };
  const deleteAll = async () => {
    setAsking(null);
    try {
      await bridge.detailsDelete();
      setProfile(emptyProfile);
      setIds(NO_IDS);
      setStarted(false);
      setEditing(null);
    } catch (err) {
      setFailed(clean(err));
    }
  };

  const head = (
    <header className="settings-head">
      <h1>Your details</h1>
      <p className="meta">Kept on this PC, and put into forms by Meridian itself.</p>
    </header>
  );
  const failure = failed && <p className="meta bad" role="alert">{failed}</p>;
  const start = () => {
    setStarted(true);
    setEditing("name");
  };
  const saveEdit = async (next: Profile) => {
    const why = await save(next);
    if (!why) setEditing(null);
    return why;
  };

  if (!profile) return <section className="stack-lg">{head}{failure}</section>;

  if (isEmpty(profile) && !started) {
    return (
      <section className="stack-lg">
        {head}
        <div className="stack details-start">
          <span className="details-eyes" aria-hidden="true"><i /><i /></span>
          <h3>Add your details once, and Meridian fills them in for you</h3>
          <p className="meta">Your name, contact, address and work. They stay on this PC and never go to the AI.</p>
          <button className="solid" onClick={start}>Add my details</button>
        </div>
        <p className="meta">Fill this form still works without them, from Knowledge and what you say.</p>
      </section>
    );
  }

  const anyId = Object.values(ids).some(Boolean);
  return (
    <section className="stack-lg">
      {head}
      {failure}
      {PARTS.map((part) =>
        editing === part.id ? (
          <EditPart key={part.id} part={part} profile={profile} onCancel={() => setEditing(null)} onSave={saveEdit} />
        ) : (
          <div className="stack details-part" key={part.id} role="group" aria-label={part.title}>
            <div className="setting details-head">
              <h3 className="grow">{part.title}</h3>
              <button className="ghost" disabled={editing !== null} onClick={() => setEditing(part.id)}>Edit</button>
            </div>
            {part.rows.map(([label, value, hindi]) => {
              const text = value(profile);
              return (
                <div className="setting details-row" key={label}>
                  <span className="details-key">{label}</span>
                  {text ? (
                    <span className={hindi ? "details-value hindi grow" : "details-value grow"} lang={hindi ? "hi" : undefined}>{text}</span>
                  ) : (
                    <button className="details-add grow" disabled={editing !== null} onClick={() => setEditing(part.id)}>Add</button>
                  )}
                </div>
              );
            })}
          </div>
        ),
      )}

      <div className="stack details-part" role="group" aria-label="ID numbers">
        <div className="setting toggle details-head">
          <h3 className="grow">ID numbers</h3>
          <input type="checkbox" role="switch" aria-label="ID numbers" checked={profile.ids} onChange={(e) => (!e.target.checked && anyId ? setAsking("ids") : void switchIds(e.target.checked))} />
        </div>
        {profile.ids ? (
          <>
            {ID_ROWS.map(([kind, label]) => <IdRow key={kind} kind={kind} label={label} masked={ids[kind]} onChanged={refreshIds} />)}
            <p className="details-info"><Icon name="lock" size={14} />Kept in Windows Credential Manager on this PC. Never sent to the AI. Every fill that would use one asks you first, and names the site. Turning this off removes them.</p>
          </>
        ) : (
          <p className="meta details-off">PAN, Aadhaar and passport. Off unless you turn it on. Without them, ID boxes are left for you.</p>
        )}
      </div>
      {asking === "ids" && <Confirm question="Remove your ID numbers from this PC?" note="They are taken out of Credential Manager. ID boxes are then left for you." yes="Remove" onYes={() => void switchIds(false)} onNo={() => setAsking(null)} />}

      <p className="details-info"><Icon name="lock" size={14} />Kept in a file on this PC. When a form needs your phone, the AI only says “phone goes here”. Meridian puts the number in itself. Nothing here is synced or backed up anywhere else.</p>
      {asking === "delete" ? (
        <Confirm question="Delete all your details from this PC?" note="Your name, contact, address, work and ID numbers. This cannot be undone." yes="Delete" onYes={() => void deleteAll()} onNo={() => setAsking(null)} />
      ) : (
        <div className="row end">
          <button className="ghost details-delete" onClick={() => setAsking("delete")}>Delete all my details</button>
        </div>
      )}
    </section>
  );
}
