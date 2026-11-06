// Settings › Assistant › Sounds like you, as the SentientStyle board draws it: how the user writes,
// learned from their sent mail and kept as plain lines they can change. Nothing is read until they
// press Learn my style.

import { useEffect, useState } from "react";
import { Icon } from "../lib/icons";
import { CLAUDE_CONNECTORS, openLink, useApp } from "../lib/store";
import { checkGmail, forgetStyle, learnedFrom, learnStyle, loadStyle, saveLine, STYLE_EMAILS, stopLearning, useStyle, type StyleLine } from "../lib/style";
import "./sounds-like-you.css";

const LABELS: Record<string, string> = {
  greeting: "Greeting",
  signoff: "Sign-off",
  length: "Length",
  tone: "Tone",
  uses: "Words you use",
  avoids: "Words you avoid",
  languages: "Languages",
};

const LOCAL_ONLY = "Local-only mode is on, so Gmail is not read. Learning your style works again when it is off, under General.";

const PEN = <path d="M4 15.5 13.5 6l1.5 1.5L5.5 17H4Z" />;
const GLYPHS = {
  warn: <><path d="M10 3l8 14H2z" /><path d="M10 8v4M10 14.5v.5" /></>,
  bad: <><circle cx="10" cy="10" r="7.5" /><path d="M10 6.5v4M10 13.5v.5" /></>,
  few: <><circle cx="10" cy="10" r="7.5" /><path d="M10 9v4.5M10 6.5v.5" /></>,
};

function Glyph({ size, children }: { size: number; children: React.ReactNode }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

function Note({ tone, glyph, children }: { tone: "info" | "warn" | "bad"; glyph?: keyof typeof GLYPHS; children: React.ReactNode }) {
  return (
    <div className="style-note" data-tone={tone} role={tone === "bad" ? "alert" : undefined}>
      {tone === "info" ? <Icon name="lock" size={14} /> : <Glyph size={14}>{GLYPHS[glyph ?? tone as keyof typeof GLYPHS]}</Glyph>}
      <span>{children}</span>
    </div>
  );
}

function Head({ note, children }: { note: string; children: React.ReactNode }) {
  return (
    <div className="style-head">
      <span className="style-icon"><Glyph size={15}>{PEN}<path d="M12 7.5 13.5 9" /></Glyph></span>
      <span className="stacked grow">
        <span className="label">Sounds like you</span>
        <span className="meta">{note}</span>
      </span>
      {children}
    </div>
  );
}

const learnedWhen = (at: string) => {
  const when = new Date(at);
  return `${when.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toLowerCase()}`;
};

/** Click a line to say it your way. Enter saves, Esc puts back what it said. */
function Lines({ lines }: { lines: StyleLine[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const edit = (line: StyleLine) => {
    setEditing(line.key);
    setDraft(line.text);
    setProblem(null);
  };
  const save = async () => {
    if (!editing || !draft.trim()) return;
    try {
      await saveLine(editing, draft);
      setEditing(null);
    } catch (err) {
      setProblem(String(err).replace(/^Error: /, ""));
    }
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void save();
    }
    if (e.key === "Escape") {
      // Puts the line back, and leaves the panel open.
      e.stopPropagation();
      setEditing(null);
    }
  };

  return (
    <div className="style-lines">
      {lines.map((line) =>
        line.key === editing ? (
          <div key={line.key} className="style-line editing">
            <label className="style-key" htmlFor="style-edit">{LABELS[line.key] ?? line.key}</label>
            <span className="style-edit">
              <textarea id="style-edit" autoFocus rows={2} maxLength={300} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} />
              {problem && <span className="meta bad" role="alert">{problem}</span>}
              <span className="row end">
                <button className="ghost" onClick={() => setEditing(null)}>Cancel</button>
                <button className="solid" disabled={!draft.trim()} onClick={() => void save()}>Save</button>
              </span>
            </span>
          </div>
        ) : (
          <button key={line.key} className="style-line" disabled={editing !== null} title="Change" onClick={() => edit(line)}>
            <span className="style-key">
              {LABELS[line.key] ?? line.key}
              {line.mine && <span className="style-mine">Your words</span>}
            </span>
            <span className="style-value">{line.text}</span>
            <span className="style-pen"><Glyph size={13}>{PEN}</Glyph></span>
          </button>
        ),
      )}
    </div>
  );
}

export function SoundsLikeYou() {
  const { profile, loaded, gmail, reading, failed } = useStyle();
  const localOnly = useApp((s) => s.settings.localOnly);
  const [forgetting, setForgetting] = useState(false);

  useEffect(() => void loadStyle(), []);
  // Learn my style stays off until Gmail answers, and Gmail is asked only while nothing is learned.
  const needsGmail = loaded && !profile && !localOnly && reading === null && gmail === null;
  useEffect(() => {
    if (needsGmail) void checkGmail();
  }, [needsGmail]);

  if (forgetting) {
    return (
      <section className="style-card" aria-label="Sounds like you">
        <span className="label">Forget your style?</span>
        <p className="style-text">Drafts go back to a plain, polite tone. The note on this PC is deleted. You can learn it again any time.</p>
        <div className="row end">
          <button className="ghost" onClick={() => setForgetting(false)}>Cancel</button>
          <button className="solid style-forget" onClick={() => void forgetStyle().then(() => setForgetting(false))}>Forget</button>
        </div>
      </section>
    );
  }

  if (reading !== null) {
    return (
      <section className="style-card" aria-label="Sounds like you">
        <Head note="Reading your sent mail">
          <button className="ghost" onClick={stopLearning}>Stop</button>
        </Head>
        <div className="style-count" role="status">
          <span className="tabular">{reading}</span>{" "}
          <span className="meta">of {STYLE_EMAILS} emails read</span>
        </div>
        <div className="level-track style-track" role="progressbar" aria-label="Emails read" aria-valuemin={0} aria-valuemax={STYLE_EMAILS} aria-valuenow={reading}>
          <i style={{ width: `${(reading / STYLE_EMAILS) * 100}%` }} />
        </div>
        <p className="meta">You can close the panel. It keeps going and tells you on the island when it is done.</p>
      </section>
    );
  }

  if (!profile) {
    const ready = !localOnly && gmail === "on";
    return (
      <section className="style-card" aria-label="Sounds like you">
        <Head note={failed ? "Not learned" : "Drafts written the way you write."}>
          <button className={ready ? "solid" : "ghost"} disabled={!ready} onClick={() => void learnStyle()}>{failed ? "Try again" : "Learn my style"}</button>
        </Head>
        {localOnly ? (
          <Note tone="warn">{LOCAL_ONLY}</Note>
        ) : failed ? (
          <>
            <Note tone="bad">{failed}</Note>
            <p className="meta">Nothing was saved. Try again starts from the first email.</p>
          </>
        ) : gmail === "off" ? (
          <>
            <Note tone="warn">Gmail is not connected to your Claude account. Press Connect next to Gmail on Claude's page and sign in with Google, then come back.</Note>
            <div className="row">
              <button className="solid" onClick={() => openLink(CLAUDE_CONNECTORS)}>Connect Gmail</button>
              <button className="ghost" onClick={() => void checkGmail()}>Check again</button>
            </div>
          </>
        ) : (
          <>
            <p className="style-text">Meridian reads your last {STYLE_EMAILS} sent emails in Gmail and writes a short note on how you write: how you greet and sign off, how long you go on, and how warm you are.</p>
            <Note tone="info">Read through your Claude account, read-only. Only the short note is kept, on this PC. The emails are not saved.</Note>
            {gmail !== "on" && <p className="meta" role="status">Checking your Claude account.</p>}
          </>
        )}
      </section>
    );
  }

  return (
    <section className="style-card" aria-label="Sounds like you">
      <Head note={`${learnedFrom(profile.emails)} · ${learnedWhen(profile.learnedAt)}`}>
        <button className="ghost" disabled={localOnly} onClick={() => void learnStyle()}>Learn again</button>
        <button className="ghost" onClick={() => setForgetting(true)}>Forget</button>
      </Head>
      {localOnly && <Note tone="warn">{LOCAL_ONLY}</Note>}
      {failed && (
        <>
          <Note tone="bad">{failed}</Note>
          <p className="meta">Your profile was not changed. Learn again starts from the first email.</p>
        </>
      )}
      {profile.emails < STYLE_EMAILS && <Note tone="warn" glyph="few">That is all the sent mail there was. It will sound more like you if you learn again once you have sent more.</Note>}
      <Lines lines={profile.lines} />
      <Note tone="info">Only this profile is kept, on this PC. The emails were read through your Claude account, read-only, and not saved.</Note>
    </section>
  );
}
