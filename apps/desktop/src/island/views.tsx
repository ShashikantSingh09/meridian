// What sits inside the island for each compact state. The face leads in every one of
// them; text only says what the face cannot.

import type { Approval, Level } from "../lib/types";
import { bridge } from "../lib/bridge";
import { useEffect, useMemo, useState, useLayoutEffect, useRef } from "react";
import { Markdown } from "../panel/Markdown";
import { StepRow } from "../panel/LogLine";
import { Icon } from "../lib/icons";
import {
  answerApproval,
  feel,
  assist,
  cancelSession,
  describeTime,
  dismissError,
  dismissNotice,
  pinCard,
  dismissReminder,
  ignoreSuggestion,
  focusTerminal,
  foldApproval,
  planUse,
  keepRecording,
  knownFolder,
  openLink,
  openPanel,
  openSettings,
  openSession,
  openStages,
  setListening,
  setMediaOpen,
  snoozeReminder,
  useApp,
  type SessionDetail,
} from "../lib/store";
import { actionOf, asking, changedFiles, limitName, clock, endFacts, lastMessage, needsFirst, planSteps, spent, stageLine, stagesOf, stepsOf, thisTurn, todoStep, todoWindow, turnStart } from "../lib/sessions";
import { Face, type Mood } from "./faces";
import type { LineSegment } from "./line";
import { focusActivity } from "./live";
import { activeSessions, MULTITASK_MAX_ROWS, TODO_MAX_ROWS, waitingApproval, waitingCount } from "./machine";
import { AgentMark, Bars, Sparks, Transport } from "./marks";
import { MeridianLine } from "./MeridianLine";
import { Progress } from "./Progress";
import { story, type LevelStory } from "../lib/levels";
import { endConversation, voiceLevel, type VoiceState } from "../lib/voice";
import { openFailedNote, seeNote, stopRecording, useRunningClock } from "../lib/notes";
import { useMicLevel } from "./useMicLevel";

/** With nothing to do and no pointer, the face gets drowsy, then falls asleep. */
const SLEEPY_AFTER_MS = 45_000;
const ASLEEP_AFTER_MS = 2 * 60_000;
/** Hovering swaps the idle view for a new one, so being tired has to outlive it. */
let tiredOut = false;

export const greetingWord = () => {
  const hour = new Date().getHours();
  return hour < 5 ? "Hello" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
};

/** The face, showing how it feels about something that just happened, or else its mood here. */
function Mine({ mood, reduced }: { mood: Mood; reduced: boolean }) {
  const id = useApp((s) => s.settings.face);
  const feeling = useApp((s) => s.feeling);
  return <Face id={id} mood={feeling ?? mood} reduced={reduced} />;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="tabular">{clock(now - since)}</span>;
}

const iconButton = (label: string, icon: Parameters<typeof Icon>[0]["name"], onClick: () => void, disabled = false) => (
  <button className="round" aria-label={label} title={label} onClick={onClick} disabled={disabled}>
    <Icon name={icon} size={14} />
  </button>
);

/** Shown with the closing line, in the last seconds of a card that closes by itself. */
function PinButton({ id }: { id: string }) {
  const closing = useApp((s) => id in s.closing);
  return closing ? iconButton("Pin, keep it open", "pin", () => pinCard(id)) : null;
}

/** A line that runs out along the bottom in the last 5 s of a card that closes by itself, so it
 *  never goes without warning. It waits while the pointer holds the card. */
export function ClosingLine({ view }: { view: string }) {
  const id = useApp((s) => (view === "notification" ? s.notices[0]?.id : view === "error" ? s.errors[0]?.id : view === "contextual" ? s.suggestions[0]?.id : undefined));
  const at = useApp((s) => (id ? s.closing[id] : undefined));
  const hovered = useApp((s) => s.hovered);
  if (!at) return null;
  return <i key={at} className="closing-line" data-held={hovered || undefined} style={{ animationDuration: `${Math.max(0, at - Date.now())}ms` }} aria-hidden="true" />;
}

export function Clock({ className = "rest-time tabular" }: { className?: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Aligned to the minute, so the only repaint is the one that changes the digits.
    const timer = setTimeout(() => setNow(new Date()), 60_000 - (Date.now() % 60_000));
    return () => clearTimeout(timer);
  }, [now]);
  return <span className={className}>{now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>;
}

/** A laptop's charge at rest: how full, and a bolt while the charger is in. Low and off the charger turns it red. */
function ChargeGlyph() {
  const charge = useApp((s) => s.charge);
  if (!charge) return null;
  const said = `Battery ${charge.percent}%${charge.plugged ? ", charging" : ""}`;
  return (
    <span className="charge tabular" role="img" aria-label={said} title={said} data-plugged={charge.plugged || undefined} data-low={(!charge.plugged && charge.percent <= 20) || undefined}>
      <svg viewBox="0 0 24 12" aria-hidden="true">
        <rect className="charge-case" x="0.75" y="0.75" width="19.5" height="10.5" rx="3" />
        <rect className="charge-fill" x="2.5" y="2.5" width={Math.max(1.5, (16 * Math.min(100, charge.percent)) / 100)} height="7" rx="1.5" />
        <path className="charge-tip" d="M21.5 4.2v3.6c.9-.2 1.5-1 1.5-1.8s-.6-1.6-1.5-1.8z" />
        {charge.plugged && <path className="charge-bolt" d="M11.6 1.2 6.9 6.6h3.2l-1.3 4.2 4.9-5.6h-3.3z" />}
      </svg>
      <span className="charge-percent">{charge.percent}%</span>
    </span>
  );
}

function Peek({ reduced }: { reduced: boolean }) {
  const next = useApp((s) => (s.settings.showNextMeeting ? s.activity.next : null));
  const plan = useApp((s) => (s.settings.showUsage ? s.limits["claude-code"] ?? null : null));
  const sessions = useApp((s) => s.sessions);
  const active = activeSessions(sessions);
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  return (
    <div className="peek-card">
      <div className="row">
        <span className="peek-face"><Mine mood="rest" reduced={reduced} /></span>
        <div className="grow stacked">
          <span className="peek-title">{greetingWord()}</span>
          <span className="meta">{today}</span>
        </div>
        <Clock className="peek-time tabular" />
      </div>
      <div className="peek-chips">
        <div className="peek-chip" data-tone="next">
          <span className="peek-chip-head">{next ? "Next" : "Nothing next"}</span>
          <span className="peek-chip-body truncate">{next ? `${next.title}${next.startsAt ? `, ${describeTime(next.startsAt)}` : ""}` : "Your day is clear"}</span>
        </div>
        {plan && (
          <div className="peek-chip" data-tone="plan">
            <span className="peek-chip-head">Claude plan</span>
            <span className="peek-chip-body truncate">{plan.windows.map((w) => `${limitName(w.window)} ${Math.round(w.usedPercent)}%`).join(", ")}</span>
          </div>
        )}
        <div className="peek-chip" data-tone="agents">
          <span className="peek-chip-head">{active.length === 0 ? "No agents running" : `${active.length} ${active.length === 1 ? "agent" : "agents"} running`}</span>
          <span className="peek-chip-body truncate">{active.length === 0 ? "Click to open" : active.map((s) => s.project).join(", ")}</span>
        </div>
      </div>
    </div>
  );
}

/** How much of the Claude plan is used: a small ring, green under half, amber to 80%, red above. */
function UsageRing() {
  const use = useApp(planUse);
  if (!use) return null;
  const tone = use.percent < 50 ? "low" : use.percent <= 80 ? "mid" : "high";
  return (
    <span className="usage-ring" data-tone={tone} role="img" aria-label={`Claude plan ${Math.round(use.percent)}% used`} title={`Claude plan ${Math.round(use.percent)}% used`} style={{ "--used": `${Math.min(100, use.percent)}%` } as React.CSSProperties}>
      <span className="usage-hole" />
    </span>
  );
}

export function IdleView({ reduced, hovered, sliver }: { reduced: boolean; hovered: boolean; sliver: boolean }) {
  const clock = useApp((s) => s.settings.showClock);
  const charged = useApp((s) => s.settings.showBattery && s.charge !== null);
  const usage = useApp((s) => s.settings.showUsage);
  const greeting = useApp((s) => s.greeting);
  const [tired, setTired] = useState<Mood>("rest");

  // Asleep, the eyes do not follow the pointer, so the core need not report it.
  useEffect(() => {
    if (tired !== "asleep") return;
    void bridge.islandGaze(false);
    return () => void bridge.islandGaze(true);
  }, [tired]);

  useEffect(() => {
    if (hovered) {
      // Woken up: a moment of surprise.
      if (tiredOut) feel("needs", 800);
      return;
    }
    tiredOut = false;
    const drowsy = setTimeout(() => {
      tiredOut = true;
      setTired("sleepy");
    }, SLEEPY_AFTER_MS);
    const asleep = setTimeout(() => setTired("asleep"), ASLEEP_AFTER_MS);
    return () => {
      clearTimeout(drowsy);
      clearTimeout(asleep);
    };
  }, [hovered]);

  if (greeting) {
    return (
      <div className="rest">
        <Mine mood="rest" reduced={reduced} />
        <span className="greeting">{greetingWord()}</span>
      </div>
    );
  }
  if (sliver && !hovered) return null;
  if (hovered) return <Peek reduced={reduced} />;
  return (
    <div className="rest ambient">
      <Mine mood={tired} reduced={reduced} />
      {usage && <UsageRing />}
      {clock && <Clock />}
      {charged && <ChargeGlyph />}
    </div>
  );
}

/** The red dot and the time, wherever a recording shows. */
export function RecordingClock({ since }: { since: number }) {
  const time = useRunningClock(since);
  return (
    <span className="note-clock tabular" role="img" aria-label={`Recording, ${time}`}>
      <i aria-hidden="true" />
      {time}
    </span>
  );
}

export function NoteView({ hovered, reduced }: { hovered: boolean; reduced: boolean }) {
  const note = useApp((s) => s.notes.notes.find((n) => n.id === s.notes.recording));
  if (!note) {
    return (
      <div className="row pad-pill">
        <Mine mood="rest" reduced={reduced} />
        <span className="grow meta truncate">Writing the notes</span>
      </div>
    );
  }
  return (
    <div className="row pad-pill note-bar">
      <Mine mood="rest" reduced={reduced} />
      <span className="grow" />
      <RecordingClock since={note.startedAt} />
      {hovered && <button className="note-stop" onClick={(e) => { e.stopPropagation(); void stopRecording(); }}>Stop</button>}
    </div>
  );
}

export function ListeningView({ reduced }: { reduced: boolean }) {
  const preview = useApp((s) => s.preview);
  const level = useMicLevel(preview === null);
  const segments = useMemo<LineSegment[]>(() => [{ mode: "listen", color: "--state-listening" }], []);
  return (
    <div className="row pad-pill">
      {preview === null && <span className="mic-dot" aria-label="Microphone on" />}
      <MeridianLine segments={segments} width={210} height={34} reduced={reduced} level={level} />
      <span className="grow" />
      {iconButton("Stop listening", "stop", () => setListening(false))}
    </div>
  );
}

export function ThinkingView({ reduced }: { reduced: boolean }) {
  const task = useApp((s) => s.chat.task);
  const provider = useApp((s) => s.providers.find((p) => p.id === s.chat.providerId)?.name);
  return (
    <div className="row pad-pill">
      <span className="orb" />
      <div className="grow stacked">
        <span className="label truncate">{provider ?? "Thinking"}</span>
        {task && <span className="meta truncate tiny">{task}</span>}
      </div>
      <Mine mood="think" reduced={reduced} />
    </div>
  );
}

/** Claude Code has asked something. Each question gets its own step, then they all go back together.
 *  On the island a tap answers. The panel has room to choose first, then confirm. */
function QuestionCard({ sessionId, approval, panel }: { sessionId: string; approval: Approval; panel?: boolean }) {
  const questions = approval.questions!;
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [picked, setPicked] = useState<string[]>([]);
  const step = questions.length === 1 ? 0 : Object.keys(answers).length;
  const question = questions[Math.min(step, questions.length - 1)]!;
  const choosing = panel || question.multi;

  const finish = (pick: string | string[]) => {
    const next = { ...answers, [question.text]: pick };
    setPicked([]);
    if (Object.keys(next).length === questions.length) answerApproval(sessionId, approval.id, true, next);
    else setAnswers(next);
  };
  const toggle = (option: string) =>
    setPicked((p) => (!question.multi ? [option] : p.includes(option) ? p.filter((o) => o !== option) : [...p, option]));

  return (
    <>
      {panel && <span className="approval-kicker">A question{questions.length > 1 ? `, ${step + 1} of ${questions.length}` : ""}</span>}
      <p className="question-text" title={question.text}>{question.text}</p>
      <div className="question-options" role="group" aria-label={question.text}>
        {question.options.slice(0, 4).map((option, i) => (
          <button key={option} className="question-option" aria-pressed={choosing ? picked.includes(option) : undefined} onClick={() => (choosing ? toggle(option) : finish(option))}>
            <span className="truncate">{option}</span>
            {panel && question.details?.[i] && <span className="meta truncate">{question.details[i]}</span>}
          </button>
        ))}
      </div>
      <div className="row end">
        {!panel && questions.length > 1 && <span className="meta grow tabular">{step + 1} of {questions.length}</span>}
        <button className="ghost" onClick={() => answerApproval(sessionId, approval.id, false)}>Skip</button>
        {choosing && (
          <button className="allow" disabled={picked.length === 0} onClick={() => finish(question.multi ? picked : picked[0]!)}>
            {panel && step + 1 < questions.length ? "Next" : "Done"}
          </button>
        )}
      </div>
    </>
  );
}

function PlanCard({ sessionId, approval, panel }: { sessionId: string; approval: Approval; panel?: boolean }) {
  const steps = planSteps(approval.plan!);
  // Only Claude Code in a terminal can switch to accepting edits from the plan reply.
  const terminal = sessionId.startsWith("watch:");
  return (
    <>
      {panel && <span className="label">Plan ready to read{steps > 0 && <span className="meta"> {steps} {steps === 1 ? "step" : "steps"}</span>}</span>}
      <div className="plan-text"><Markdown text={approval.plan!} /></div>
      <div className="row end">
        <button className="ghost" onClick={() => answerApproval(sessionId, approval.id, false)}>Keep planning</button>
        {terminal && <span className="grow" />}
        {terminal && <button className="ghost" onClick={() => answerApproval(sessionId, approval.id, true, { mode: "acceptEdits" })}>Approve, and accept edits</button>}
        <button className="allow" onClick={() => answerApproval(sessionId, approval.id, true)}>Approve plan</button>
      </div>
      {terminal && <span className="meta plan-note">Accept edits lasts for this session only, and is never the default</span>}
    </>
  );
}

/** What is being asked and how to answer it, on the island and in the panel. Every answer here is
 *  one click on one request. There is deliberately no way to allow something ahead of time. */
export function ApprovalCard({ sessionId, approval, panel }: { sessionId: string; approval: Approval; panel?: boolean }) {
  if (approval.questions?.length) return <QuestionCard key={approval.id} sessionId={sessionId} approval={approval} panel={panel} />;
  if (approval.plan) return <PlanCard sessionId={sessionId} approval={approval} panel={panel} />;
  if (approval.tool === "Start an agent") return <StartAgentCard key={approval.id} sessionId={sessionId} approval={approval} panel={panel} />;
  return <CommandCard key={approval.id} sessionId={sessionId} approval={approval} panel={panel} />;
}

/** How much of a request the one line leaves out. */
const hiddenChars = (approval: Approval) => (approval.full ? (approval.length ?? [...approval.full].length) - [...approval.summary].length : 0);

/** In the island's header, as on the board: "1 of 3" when more than one request waits, and a way to
 *  fold this one away for later. */
function Queue({ sessionId }: { sessionId: string }) {
  const waiting = useApp((s) => waitingCount(s.sessions));
  return (
    <>
      {waiting > 1 && <span className="meta queue-count">1 of {waiting}</span>}
      <button className="round queue-fold" aria-label="Fold, answer later" title="Fold, answer later" onClick={() => foldApproval(sessionId)}><Icon name="close" size={11} /></button>
    </>
  );
}

/** A command, a path or anything else. When the line leaves something out it says so, and Allow
 *  waits until the whole request has been opened: nobody approves what they could not see. */
function CommandCard({ sessionId, approval, panel }: { sessionId: string; approval: Approval; panel?: boolean }) {
  const [open, setOpen] = useState(false);
  const hidden = hiddenChars(approval);
  const tooLong = approval.length != null;
  const ready = !approval.full || (open && !tooLong);
  return (
    <>
      {panel && <span className="approval-kicker">{asking(approval)}</span>}
      {open && approval.full ? (
        <code className="command whole">{approval.full}</code>
      ) : (
        <code className="command" title={approval.full ? undefined : approval.summary}>{approval.summary}</code>
      )}
      {approval.why && <span className="cut-note">{approval.why}</span>}
      <div className="row end">
        {approval.full && !open && <span className="cut-note grow">{hidden} more characters not shown</span>}
        {open && tooLong && <span className="cut-note grow">Too long to show in full. Deny it, or run it yourself.</span>}
        {approval.full && !open && <button className="text-button show-all" onClick={() => setOpen(true)}>Show all</button>}
        <button className="ghost" onClick={() => answerApproval(sessionId, approval.id, false)}>Deny</button>
        <button className="allow" disabled={!ready} title={ready ? undefined : "Open the whole request first"} onClick={() => answerApproval(sessionId, approval.id, true)}>Allow once</button>
      </div>
    </>
  );
}

/** The assistant asking to start an agent: the task, the folder it would work in, and that it gets
 *  the same full access as one started by hand. A folder the user never worked in is not offered. */
function StartAgentCard({ sessionId, approval, panel }: { sessionId: string; approval: Approval; panel?: boolean }) {
  const folder = useApp((s) => approval.folder || s.settings.agentDefaultDir || "");
  const known = useApp((s) => knownFolder(folder, s));
  const task = approval.summary.replace(/^Start an agent: /, "");
  return (
    <>
      {panel && <span className="approval-kicker">{asking(approval)}</span>}
      <span className="label approval-task">{task}</span>
      <div className="row approval-chips">
        <span className="approval-chip truncate" title={folder}><Icon name="folder" size={12} />{folder || "No folder chosen"}</span>
        <span className="approval-chip">Full access</span>
      </div>
      {known ? (
        <div className="row end">
          <span className="cut-note grow">Uses your Claude Code settings and this folder's hooks</span>
          <button className="ghost" onClick={() => answerApproval(sessionId, approval.id, false)}>Deny</button>
          <button className="allow" onClick={() => answerApproval(sessionId, approval.id, true)}>Start</button>
        </div>
      ) : (
        <>
          <p className="approval-warn">This folder is not one you have used before. Start it yourself from Agents if you meant it.</p>
          <div className="row end">
            <button className="ghost" onClick={() => answerApproval(sessionId, approval.id, false)}>Deny</button>
          </div>
        </>
      )}
    </>
  );
}

/** One session among others: its project, and the stage it is at. */
function SessionLine({ session }: { session: SessionDetail }) {
  const { text, kind } = stageLine(session);
  return (
    <button className="stage-row" data-kind={kind} onClick={() => openSession(session.id)}>
      <AgentMark agent={session.agent} size={18} live={false} />
      <span className="label grow">{session.project}</span>
      <span className="stage-now truncate">{text}</span>
    </button>
  );
}

/** What is open while the pointer is on the island: the list the agent keeps, or else every stage so far. */
function StageCard({ session }: { session: SessionDetail }) {
  const todos = session.todos ?? [];
  const head = (right: React.ReactNode) => (
    <div className="row stage-head">
      <AgentMark agent={session.agent} size={18} live={false} />
      <button className="grow text-button" onClick={() => openSession(session.id)}>
        <span className="label">{session.project}</span>
        <span className="meta truncate">{session.title}</span>
      </button>
      {right}
      {!session.watched && iconButton("Stop task", "stop", () => cancelSession(session.id))}
    </div>
  );
  if (todos.length > 0) {
    return (
      <div className="stage-card">
        {head(<span className="stage-count tabular">{todoStep(todos)}</span>)}
        <ul className="todo-list">
          {todoWindow(todos, TODO_MAX_ROWS).map((todo) => (
            <li key={todo.id} className="todo-line" data-status={todo.status}>
              <i aria-hidden="true" />
              <span className="truncate">{todo.text}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const start = turnStart(session);
  return (
    <div className="stage-card">
      {head(<span className="meta"><Elapsed since={start} /></span>)}
      <div className="stage-bars">
        {stagesOf(session).map((stage) => (
          <div key={stage.name} className="stage-bar" data-state={stage.state}>
            <i />
            <span className="stage-name">{stage.name}</span>
            <span className="stage-note truncate">{stage.note}</span>
          </div>
        ))}
      </div>
      <div className="stage-steps">
        {stepsOf(thisTurn(session)).slice(-4).map((step, i) => <StepRow key={i} step={step} start={start} />)}
      </div>
    </div>
  );
}

export function WorkingView({ reduced, hovered }: { reduced: boolean; hovered: boolean }) {
  const sessions = useApp((s) => s.sessions);
  const blocked = waitingApproval(sessions);
  const session = blocked ?? activeSessions(sessions)[0];
  if (!session) return null;

  if (blocked?.approval) {
    const { approval } = blocked;
    const asks = approval.questions?.length ? "asks" : approval.plan ? "has a plan" : approval.tool === "Action" ? "needs your OK" : `wants to run ${approval.tool}`;
    const others = activeSessions(sessions).filter((s) => s.id !== blocked.id).slice(0, MULTITASK_MAX_ROWS - 1);
    return (
      <div className="stack pad-card">
        <div className="row">
          <Mine mood="needs" reduced={reduced} />
          <span className="grow label truncate">{blocked.agent} {asks}</span>
          <span className="meta">{blocked.project}</span>
          <Queue sessionId={blocked.id} />
        </div>
        <ApprovalCard sessionId={blocked.id} approval={approval} />
        {others.map((s) => <SessionLine key={s.id} session={s} />)}
      </div>
    );
  }

  if (hovered) return <StageCard session={session} />;

  const { word, what } = session.status === "starting" ? { word: "Starting", what: "" } : actionOf(session.activity);
  const todos = session.todos ?? [];
  const steps = stepsOf(thisTurn(session)).length;
  return (
    <div className="row pad-pill stage-pill">
      <AgentMark agent={session.agent} size={20} live={false} />
      {/* The space keeps the two lines apart for a screen reader, and for anything that copies them. */}
      <button className="grow text-button stacked" onClick={openStages}>
        <span className="label truncate">{word}</span>{" "}
        <span className="doing truncate">{what || session.project}</span>
      </button>
      <span className="stage-clock">
        {todos.length > 0 ? <span>{todoStep(todos)}</span> : steps > 0 && <span>Step {steps}</span>}
        <Elapsed since={turnStart(session)} />
      </span>
      <Mine mood="working" reduced={reduced} />
    </div>
  );
}

export function MultitaskView() {
  const sessions = useApp((s) => s.sessions);
  const shown = useMemo(() => needsFirst(activeSessions(sessions)).slice(0, MULTITASK_MAX_ROWS), [sessions]);
  return (
    <div className="stack pad-rows">
      {shown.map((s) => <SessionLine key={s.id} session={s} />)}
    </div>
  );
}

/** How a session came out, in its own words, for a moment before it moves to Notifications. */
function FinishedCard({ noticeId, title, session, reduced }: { noticeId: string; title: string; session: SessionDetail; reduced: boolean }) {
  const message = lastMessage(session);
  const facts = endFacts(session);
  const changed = changedFiles(session.log).length > 0;
  return (
    <div className="stack pad-card stage-end" data-tone="done">
      <div className="row">
        <span className="notice-face">
          <Mine mood="done" reduced={reduced} />
          {!reduced && <Sparks />}
        </span>
        <span className="grow label truncate">{title}</span>
        <span className="meta tabular">{spent((session.endedAt ?? Date.now()) - turnStart(session))}</span>
      </div>
      {message && <p className="stage-message">{message}</p>}
      {facts && <p className="meta truncate">{facts}</p>}
      <div className="row end stage-actions">
        <PinButton id={noticeId} />
        <button className="stage-button" onClick={() => dismissNotice(noticeId)}>Dismiss</button>
        {session.pid ? <button className="stage-button" onClick={() => { dismissNotice(noticeId); void focusTerminal(session); }}>Terminal</button> : null}
        <button className="stage-button" data-main="true" onClick={() => { dismissNotice(noticeId); openSession(session.id, changed ? "changes" : "activity"); }}>
          {changed ? "See what changed" : "Open"}
        </button>
      </div>
    </div>
  );
}

/** What went wrong, in the agent's words. It stays until someone has seen it, which can be hours,
 *  so its face holds still: anything moving would redraw the whole window for all of that time. */
function StoppedCard({ errorId, body, session }: { errorId: string; body: string; session: SessionDetail }) {
  return (
    <div className="stack pad-card stage-end" data-tone="bad">
      <div className="row">
        <Mine mood="error" reduced />
        <span className="grow label truncate">{session.project} stopped</span>
        <span className="meta tabular">{spent((session.endedAt ?? Date.now()) - turnStart(session))}</span>
      </div>
      <p className="stage-message">{body}</p>
      <div className="row end stage-actions">
        <PinButton id={errorId} />
        <button className="stage-button" onClick={() => dismissError(errorId)}>Dismiss</button>
        <button className="stage-button" data-main="true" onClick={() => { dismissError(errorId); openSession(session.id); }}>Open</button>
      </div>
    </div>
  );
}

/** Mail can be forged and nothing here proves a sender, so a link always shows
 *  where it really goes. */
export const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
};

export function NotificationView({ reduced }: { reduced: boolean }) {
  const notice = useApp((s) => s.notices[0]);
  const sessions = useApp((s) => s.sessions);
  if (!notice) return null;
  // Anything else is news, so the face glances at it as it arrives.
  const mood: Mood = notice.tone === "success" ? "done" : notice.tone === "urgent" ? "needs" : "notice";
  const ended = notice.finished && sessions.find((s) => s.id === notice.sessionId);
  if (ended) return <FinishedCard noticeId={notice.id} title={notice.title} session={ended} reduced={reduced} />;

  if (notice.quiet) {
    return (
      <div className="stack pad-card">
        <div className="row">
          <span className="rec-dot" aria-hidden="true" />
          <span className="grow label truncate">{notice.title}</span>
          <span className="quiet-left" role="timer">Stops in 0:{String(notice.quiet).padStart(2, "0")}</span>
        </div>
        <div className="row end">
          <button className="ghost" onClick={() => void stopRecording()}>Stop now</button>
          <button className="allow" onClick={keepRecording}>Keep recording</button>
        </div>
      </div>
    );
  }

  if (notice.note) {
    const id = notice.note;
    return (
      <div className="row pad-pill">
        <Mine mood={mood} reduced={reduced} />
        <span className="grow note-ready truncate">{notice.title}: {notice.body}</span>
        <button className="ghost" onClick={() => seeNote(notice.id, id)}>See</button>
      </div>
    );
  }

  if (notice.eventId) {
    return (
      <div className="stack pad-card">
        <div className="row">
          <Mine mood={mood} reduced={reduced} />
          <button className="grow text-button stacked" onClick={() => { dismissNotice(notice.id); openPanel("day"); }}>
            <span className="label truncate">{notice.title}</span>
            <span className="meta truncate">{notice.body}</span>
          </button>
          {iconButton("Dismiss", "close", () => dismissReminder(notice))}
        </div>
        <div className="row end">
          <button className="ghost" onClick={() => snoozeReminder(notice, 15)}>Snooze</button>
          <button className="ghost" onClick={() => { dismissNotice(notice.id); openPanel("day"); }}>Details</button>
          {notice.actions?.map((a) => (
            <button key={a.label} className="solid" title={a.url ?? undefined} onClick={() => a.url && openLink(a.url)}>{a.label} on {hostOf(a.url)}</button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="row pad-pill">
      <span className="notice-face">
        <Mine mood={mood} reduced={reduced} />
        {notice.tone === "success" && !reduced && <Sparks />}
      </span>
      <button className="grow text-button stacked" onClick={() => { dismissNotice(notice.id); if (notice.update) openSettings("updates"); openPanel(notice.sessionId ? (sessions.find((s) => s.id === notice.sessionId)?.surface === "chat" ? "chat" : "agents") : undefined); }}>
        <span className="label truncate">{notice.title}</span>
        <span className="meta truncate">{notice.body}</span>
      </button>
      <PinButton id={notice.id} />
      {iconButton("Dismiss", "close", () => dismissNotice(notice.id))}
    </div>
  );
}

export function ContextualView({ reduced }: { reduced: boolean }) {
  const suggestion = useApp((s) => s.suggestions[0]);
  if (!suggestion) return null;
  return (
    <div className="stack pad-card">
      <div className="row">
        <Mine mood="needs" reduced={reduced} />
        <span className="grow label">{suggestion.title}</span>
      </div>
      <p className="body">{suggestion.body}</p>
      <div className="row end">
        <PinButton id={suggestion.id} />
        <button className="ghost" onClick={() => ignoreSuggestion(suggestion)}>Ignore</button>
        <button className="ghost" onClick={() => assist(suggestion, "Explain this issue in plain terms.")}>Explain</button>
        <button className="ghost" onClick={() => assist(suggestion, "Suggest a fix for this.")}>Suggest fix</button>
        <button className="solid" onClick={() => assist(suggestion, "Analyze this error and tell me the likely cause.")}>Analyze</button>
      </div>
    </div>
  );
}

export function ScreenView({ reduced }: { reduced: boolean }) {
  return (
    <div className="row pad-pill">
      <Mine mood="working" reduced={reduced} />
      <div className="grow stacked">
        <span className="label">Reading your screen</span>
        <span className="meta tiny">Stays on this PC until you share it</span>
      </div>
    </div>
  );
}

export function Artwork({ src, size }: { src: string | null; size: number }) {
  if (src) return <img className="artwork" src={src} alt="" style={{ width: size, height: size }} />;
  return <span className="artwork no-art" style={{ width: size, height: size }}><Icon name="music" size={Math.round(size * 0.5)} /></span>;
}

/** Small by default, like a Mac: artwork and bars. A click opens the album and its controls. */
/**
 * One line that, when it does not fit, slides to show the rest while the pointer is on it. This
 * replaces the browser's tooltip, which draws badly over a transparent always-on-top window.
 */
function Slide({ text, moving, className }: { text: string; moving: boolean; className: string }) {
  const line = useRef<HTMLSpanElement>(null);
  const [hidden, setHidden] = useState(0);
  useLayoutEffect(() => {
    const el = line.current;
    if (el) setHidden(Math.max(0, el.scrollWidth - el.clientWidth));
  }, [text]);
  const style = { "--slide": `-${hidden}px`, "--slide-time": `${Math.max(3, hidden / 30)}s` } as React.CSSProperties;
  return (
    <span ref={line} className={`slide ${className}`} data-moving={moving && hidden > 0} style={style}>
      <span>{text}</span>
    </span>
  );
}

export function MediaView({ open }: { open: boolean }) {
  const track = useApp((s) => s.media.current);
  const hovered = useApp((s) => s.hovered);
  if (!track) return null;
  if (!open) {
    return (
      <button className="media-closed" aria-label={`Now playing: ${track.title || track.app}. Open the player`} onClick={() => setMediaOpen(true)}>
        <Artwork src={track.artwork} size={32} />
        <span className="stacked grow">
          <Slide className="label" text={track.title || track.app} moving={hovered} />
          <Slide className="meta" text={track.artist || track.app} moving={hovered} />
        </span>
        <Bars playing={track.playing} height={18} />
      </button>
    );
  }
  return (
    <div className="media-open">
      <div className="row">
        <Artwork src={track.artwork} size={64} />
        <button className="grow text-button stacked" onClick={() => openPanel("media")}>
          <Slide className="media-title" text={track.title || track.app} moving={hovered} />
          <Slide className="meta" text={track.artist || track.app} moving={hovered} />
        </button>
        <Bars playing={track.playing} height={22} />
      </div>
      <Progress />
      <div className="transport-room"><Transport track={track} /></div>
    </div>
  );
}

function LevelIcon({ level, story, reduced }: { level: Level; story: LevelStory; reduced: boolean }) {
  if (level.kind === "battery") {
    const fill = Math.max(1, (level.percent / 100) * 10);
    return (
      <span className="level-icon" data-zap={Boolean(story.zap) && !reduced} style={{ color: story.tone }}>
        <svg width="21" height="21" viewBox="0 0 20 20" aria-hidden="true">
          {story.bolt ? (
            <path d="M11.2 2.2 4.6 11.3h4.5l-.6 6.5 6.9-9.6h-4.7z" fill="currentColor" />
          ) : (
            <>
              <rect x="2.5" y="6" width="13" height="8" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <rect x="4" y="7.6" width={fill} height="4.8" rx="1.2" fill="currentColor" />
              <path d="M17 8.8v2.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </>
          )}
        </svg>
      </span>
    );
  }
  if (level.kind === "brightness") {
    return (
      <span className="level-icon" style={{ color: story.tone }}>
        <svg width="21" height="21" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
          <circle cx="10" cy="10" r={2.2 + (level.percent / 100) * 1.6} fill="currentColor" />
          <path opacity={0.35 + (level.percent / 100) * 0.65} d="M10 2.6v1.8M10 15.6v1.8M2.6 10h1.8M15.6 10h1.8M4.8 4.8l1.3 1.3M13.9 13.9l1.3 1.3M15.2 4.8l-1.3 1.3M6.1 13.9l-1.3 1.3" />
        </svg>
      </span>
    );
  }
  return (
    <span className="level-icon" style={{ color: story.tone }}>
      <svg width="21" height="21" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3.5 7.6v4.8h3l4 3.4V4.2l-4 3.4Z" fill="currentColor" />
        {level.muted ? <path d="m13.4 7.8 4.2 4.4M17.6 7.8l-4.2 4.4" /> : level.percent > 0 && <path d="M13.4 7.4a3.6 3.6 0 0 1 0 5.2" />}
        {!level.muted && level.percent > 50 && <path d="M15.6 5.2a6.8 6.8 0 0 1 0 9.6" />}
      </svg>
    </span>
  );
}

const VOICE_WORDS = { listening: "Listening", pause: "Still with you", thinking: "Thinking", speaking: "Speaking" };
const VOICE_MOODS: Record<VoiceState["phase"], Mood> = { listening: "listen", pause: "listen", thinking: "think", speaking: "speak" };
const WAVE_BARS = 26;
/** Speech changes at the rate of syllables, so 30 a second is plenty, and a sixth of a 180 Hz display. */
const WAVE_FRAME_MS = 33;
/** The face follows the voice in steps: up to 2 while it listens, 3 while it speaks. Quieter than this is none. */
const VOICE_STEPS = { listen: 2, speak: 3 };
const VOICE_GATE = 0.12;
/** Quiet for this long after speaking counts as a pause. */
const PAUSE_BLINK_MS = 350;

/** Bars that follow the real sound, so it is plain the app can hear you. The face beside them
 *  follows it too, rising in 25 ms and falling in 110 ms, and only redraws when its step changes. */
function Wave({ tone, reduced, steps, listening }: { tone: string; reduced: boolean; steps: number; listening: boolean }) {
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (reduced) return;
    const heights = new Array<number>(WAVE_BARS).fill(0.08);
    let frame = 0;
    let last = 0;
    let level = 0;
    // Listening, it blinks once when you pause, the way someone does while waiting for the rest.
    let spokeAt = 0;
    let blinked = true;
    const voice = box.current?.closest(".voice");
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (now - last < WAVE_FRAME_MS) return;
      const dt = (now - last) / 1000;
      last = now;
      const heard = voiceLevel();
      level += (heard - level) * (1 - Math.exp(-dt / (heard > level ? 0.025 : 0.11)));
      heights.push(Math.max(0.08, heard));
      heights.shift();
      box.current?.childNodes.forEach((bar, i) => ((bar as HTMLElement).style.scale = `1 ${heights[i]}`));
      const face = voice?.querySelector<HTMLElement>(".face");
      const step = String(level < VOICE_GATE ? 0 : Math.min(steps, Math.round(level * steps)));
      if (face && face.dataset.lv !== step) face.dataset.lv = step;
      if (level >= VOICE_GATE) [spokeAt, blinked] = [now, false];
      else if (listening && face && !blinked && now - spokeAt > PAUSE_BLINK_MS) {
        blinked = true;
        face.dataset.blink = "true";
        setTimeout(() => delete face.dataset.blink, 220);
      }
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      voice?.querySelector(".face")?.setAttribute("data-lv", "0");
    };
  }, [reduced, steps, listening]);
  return (
    <span ref={box} className="voice-wave" aria-hidden="true">
      {Array.from({ length: WAVE_BARS }, (_, i) => <i key={i} style={{ background: tone }} />)}
    </span>
  );
}

export function VoiceView({ reduced }: { reduced: boolean }) {
  const voice = useApp((s) => s.voice);
  if (!voice) return null;
  const hearing = voice.phase === "listening" || voice.phase === "pause";
  return (
    <div className="voice" data-phase={voice.phase}>
      <div className="row voice-head">
        <Mine mood={VOICE_MOODS[voice.phase]} reduced={reduced} />
        {voice.phase === "thinking" ? (
          <span className="voice-dots grow" aria-hidden="true"><i /><i /><i /></span>
        ) : (
          <Wave tone={hearing ? "#5ac8fa" : "#fff"} reduced={reduced} steps={hearing ? VOICE_STEPS.listen : VOICE_STEPS.speak} listening={hearing} />
        )}
        <span className="meta">{VOICE_WORDS[voice.phase]}</span>
        {iconButton("Stop talking", "close", endConversation)}
      </div>
      <p className="voice-words" aria-live="polite">
        {voice.words || (hearing ? <span className="voice-ahead">{voice.woken ? "Yes?" : "Go on, I am listening."}</span> : "")}
        <span className="voice-ahead">{voice.ahead}</span>
        {hearing && voice.words && <i className="voice-caret" />}
      </p>
    </div>
  );
}

/** The volume, brightness or battery, for a moment after it changes. */
export function LevelView({ hovered, reduced }: { hovered: boolean; reduced: boolean }) {
  const level = useApp((s) => s.level);
  const before = useApp((s) => s.levelBefore);
  if (!level) return null;
  const told = story(level, before);
  const open = hovered && level.kind === "battery";
  return (
    <div className="level" data-shake={Boolean(told.shake) && !reduced}>
      {told.glow && <span className="level-glow" style={{ "--tone": told.tone } as React.CSSProperties} aria-hidden="true" />}
      <div className="level-row">
        <Mine mood={told.mood} reduced={reduced} />
        <LevelIcon level={level} story={told} reduced={reduced} />
        {told.title ? (
          <span className="stacked grow">
            <span className="label truncate">{told.title}</span>
            <span className="meta truncate">{told.detail}</span>
          </span>
        ) : (
          <span className="level-track"><i style={{ width: `${told.percent}%`, background: told.tone }} /></span>
        )}
        <span className="level-number tabular" style={{ color: level.kind === "battery" ? told.tone : undefined }}>{told.number}</span>
      </div>
      {open && (
        <div className="level-more">
          <span className="level-track"><i style={{ width: `${told.percent}%`, background: told.tone }} /></span>
          <div className="row">
            <span className="meta grow">{told.left}</span>
            <span className="meta">{told.right}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Steps({ count, at, tone }: { count: number; at: number; tone: string }) {
  return (
    <div className="steps" style={{ "--tone": `var(${tone})` } as React.CSSProperties}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="step" data-done={i <= at} data-now={i === at} data-last={i === count - 1}>
          <i /><b data-done={i < at} />
        </span>
      ))}
    </div>
  );
}

function Route({ from, to, progress, tone }: { from: string; to: string; progress: number; tone: string }) {
  return (
    <div className="route" style={{ "--tone": `var(${tone})`, "--at": `${progress * 100}%` } as React.CSSProperties}>
      <span className="route-end">{from}</span>
      <span className="route-line">
        <i className="route-fill" />
        <span className="route-plane" data-flying={progress > 0 && progress < 1}><Icon name="plane" size={16} /></span>
      </span>
      <span className="route-end">{to}</span>
    </div>
  );
}

export function LiveView({ hovered }: { hovered: boolean }) {
  const live = useApp((s) => s.live[0]);
  const focus = useApp((s) => s.focus);
  const [now, setNow] = useState(() => Date.now());

  // Only a running timer needs the second hand.
  useEffect(() => {
    if (live?.kind !== "timer") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live?.kind]);

  if (!live) return null;
  const a = live.kind === "timer" && focus ? focusActivity(focus.endsAt, focus.minutes, now) : live;
  const tone = { "--tone": `var(${a.tone})` } as React.CSSProperties;
  const open = () => openPanel(a.kind === "timer" ? "home" : "day");

  if (!hovered) {
    return (
      <button className="live-closed" style={tone} onClick={open}>
        <span className="live-left truncate">{a.kind === "flight" && <Icon name="plane" size={14} />}{a.left}</span>
        <span className="live-right tabular">{a.right}</span>
      </button>
    );
  }
  return (
    <div className="live-open" style={tone}>
      <div className="row live-head">
        <button className="grow text-button stacked" onClick={open}>
          <span className="live-status">{a.status}</span>
          <span className="live-big tabular truncate">{a.big}</span>
        </button>
        <span className="stacked live-side">
          <span className="meta">{a.who}</span>
          <span className="live-detail truncate">{a.detail}</span>
        </span>
      </div>
      {a.route && <Route {...a.route} tone={a.tone} />}
      {a.steps && <Steps {...a.steps} tone={a.tone} />}
      <div className="row">
        <span className="grow meta truncate">{a.foot}</span>
        {a.action && <button className="live-action" title={a.action.url} onClick={() => openLink(a.action!.url)}>{a.action.label} on {hostOf(a.action.url)}</button>}
      </div>
    </div>
  );
}

/** A second thing going on, in a small bubble beside the island. */
export function Bubble() {
  const live = useApp((s) => s.live);
  const panelOpen = useApp((s) => s.panelOpen);
  const view = useApp((s) => s.islandView);
  const second = view === "live" ? live[1] : live[0];
  if (!second || panelOpen) return null;
  return (
    <span className="bubble" title={second.status} style={{ "--tone": `var(${second.tone})` } as React.CSSProperties}>
      <span className="bubble-ring"><b>{second.short}</b></span>
    </span>
  );
}

export function ErrorView({ reduced }: { reduced: boolean }) {
  const error = useApp((s) => s.errors[0]);
  const stopped = useApp((s) => s.sessions.find((session) => session.id === s.errors[0]?.sessionId));
  if (!error) return null;
  if (stopped) return <StoppedCard errorId={error.id} body={error.body} session={stopped} />;
  if (error.note) {
    const id = error.note;
    return (
      <div className="row pad-pill note-bar">
        <Mine mood="error" reduced={reduced} />
        <span className="grow note-ready truncate" title={error.body}>{error.title}</span>
        <button className="text-button note-open" onClick={() => openFailedNote(error.id, id)}>Open</button>
      </div>
    );
  }
  return (
    <div className="row pad-pill">
      <Mine mood="error" reduced={reduced} />
      <div className="grow stacked">
        <span className="label truncate">{error.title}</span>
        <span className="meta truncate" title={error.body}>{error.body}</span>
      </div>
      <PinButton id={error.id} />
      {error.retry && iconButton("Retry", "retry", () => { const retry = error.retry; dismissError(error.id); retry?.(); })}
      {iconButton("Dismiss", "close", () => dismissError(error.id))}
    </div>
  );
}
