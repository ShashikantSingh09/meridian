// Finish this for me on the island, as the board draws it: the working card with its step log and
// Stop, the pause, the questions that wait for one click, how it ended, and why it would not start.
// Every button here is the user's own click; nothing answers by itself.

import { useEffect, useState } from "react";
import {
  allowFinish,
  answerFinish,
  clock,
  closeFinish,
  continueFinish,
  finishSettings,
  moreSteps,
  shownSteps,
  stopFinish,
  summary,
  toggleSteps,
  undoFinish,
  type FinishState,
} from "../lib/finish";
import { useApp } from "../lib/store";
import { Face, type Mood } from "./faces";
import "./here.css";
import "./finish.css";

function Eyes({ mood, reduced }: { mood: Mood; reduced: boolean }) {
  const id = useApp((s) => s.settings.face);
  return <Face id={id} mood={mood} reduced={reduced} />;
}

const Button = ({ label, main, stop, onClick }: { label: string; main?: boolean; stop?: boolean; onClick: () => void }) => (
  <button className="here-b" data-main={main || undefined} data-stop={stop || undefined} onClick={(e) => { e.stopPropagation(); onClick(); }}>
    {label}
  </button>
);

/** How long it has worked, ticking while the card is up. */
function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

const Done = () => (
  <svg className="ic" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M4 10l4 4 8-8" />
  </svg>
);

function Log({ finish, ticks }: { finish: FinishState; ticks: boolean }) {
  const steps = shownSteps(finish);
  if (steps.length === 0) return null;
  return (
    <div className="finish-log" role="list" aria-label="Steps">
      {steps.map((step, i) => (
        <div className="finish-step" role="listitem" key={`${step.at}-${i}`}>
          <span className="t">{clock(step.at)}</span>
          {ticks && <Done />}
          <span className="grow truncate" title={step.text}>{step.text}</span>
          {step.from && <span className="finish-from">from {step.from}</span>}
        </div>
      ))}
    </div>
  );
}

function Card({ mood, title, aside, reduced, children }: { mood: Mood; title: string; aside?: string; reduced: boolean; children: React.ReactNode }) {
  return (
    <div className="stack pad-card here-card finish-card" role="alertdialog" aria-label={title}>
      <div className="row">
        <Eyes mood={mood} reduced={reduced} />
        <span className="grow label truncate" title={title}>{title}</span>
        {aside && <span className="finish-mute finish-time">{aside}</span>}
      </div>
      {children}
    </div>
  );
}

function Working({ finish, reduced }: { finish: FinishState; reduced: boolean }) {
  const now = useNow(true);
  return (
    <div className="stack pad-card finish-card" role="status" aria-label={`Finish this · ${finish.app}`}>
      <div className="finish-head">
        <Eyes mood="think" reduced={reduced} />
        <span className="truncate">Finish this · {finish.app}</span>
        <span className="grow" />
        <span className="finish-time">Working · {clock(now - finish.startedAt)}</span>
      </div>
      <div className="finish-now">
        <svg className="finish-spin" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10 3a7 7 0 1 1-7 7" />
        </svg>
        <span className="truncate">{finish.now}</span>
      </div>
      <Log finish={finish} ticks />
      <div className="finish-foot">
        {finish.note && <p className="finish-mute truncate">{finish.note}</p>}
        {moreSteps(finish) && <Button label="Show all steps" onClick={toggleSteps} />}
        <Button label="Stop" stop onClick={stopFinish} />
      </div>
    </div>
  );
}

function Asking({ finish, reduced }: { finish: FinishState; reduced: boolean }) {
  const ask = finish.ask!;
  return (
    <Card mood="needs" reduced={reduced} title={ask.title}>
      {ask.button ? (
        <div className="finish-asked">
          <span className="finish-button" title={ask.button}>{ask.button}</span>
          <p className="finish-mute">{ask.body}</p>
        </div>
      ) : (
        <p className="finish-mute">{ask.body}</p>
      )}
      <div className="finish-foot">
        <Button label={ask.no} onClick={() => answerFinish(false)} />
        <Button label={ask.yes} main onClick={() => answerFinish(true)} />
      </div>
    </Card>
  );
}

function Ended({ finish, reduced }: { finish: FinishState; reduced: boolean }) {
  const end = finish.end!;
  if (end.kind === "done") {
    return (
      <div className="stack pad-card finish-card" role="status" aria-label={end.title}>
        <div className="finish-head">
          <Eyes mood="done" reduced={reduced} />
          <span className="truncate">Finish this · {finish.app}</span>
          <span className="grow" />
          <span>Done</span>
        </div>
        <span className="finish-title truncate" title={end.title}>{end.title}</span>
        <p className="finish-mute finish-time">{summary(end)}</p>
        <Log finish={finish} ticks={false} />
        {end.sent && <p className="finish-mute">What it sent can't be undone from here. Change it in {finish.app}.</p>}
        <div className="finish-foot">
          {moreSteps(finish) && <Button label="Show all steps" onClick={toggleSteps} />}
          <Button label="Close" onClick={closeFinish} />
        </div>
      </div>
    );
  }
  if (end.kind === "payment") {
    return (
      <Card mood="needs" reduced={reduced} title={end.title} aside={end.site ?? undefined}>
        <p className="finish-mute">{end.body}</p>
        <div className="finish-foot">
          <Button label="Done" main onClick={closeFinish} />
        </div>
      </Card>
    );
  }
  if (end.kind === "failed") {
    return (
      <Card mood="error" reduced={reduced} title={end.title}>
        {finish.all ? <Log finish={finish} ticks={false} /> : <p className="finish-mute">{end.body}</p>}
        <div className="finish-foot">
          <Button label={finish.all ? "Hide steps" : "Show steps"} onClick={toggleSteps} />
          <Button label="Close" main onClick={closeFinish} />
        </div>
      </Card>
    );
  }
  const undo = end.filled > 0 && !finish.undone;
  return (
    <Card mood="rest" reduced={reduced} title={end.title}>
      <p className="finish-mute">{finish.undone ?? end.body}</p>
      <div className="finish-foot">
        <Button label="Close" main={!undo} onClick={closeFinish} />
        {undo && <Button label={`Undo the ${end.filled === 1 ? "box" : `${end.filled} boxes`}`} main onClick={() => void undoFinish()} />}
      </div>
    </Card>
  );
}

function NotStarted({ finish, reduced }: { finish: FinishState; reduced: boolean }) {
  const card = finish.card!;
  return (
    <Card mood="rest" reduced={reduced} title={card.title}>
      <p className="finish-mute">{card.body}</p>
      <div className="finish-foot">
        {card.kind === "off" && (
          <>
            <Button label="Not now" onClick={closeFinish} />
            <Button label="Settings" main onClick={finishSettings} />
          </>
        )}
        {card.kind === "not-listed" && (
          <>
            <Button label="Not now" onClick={closeFinish} />
            <Button label={`Allow ${card.name ?? "it"}`} main onClick={() => void allowFinish()} />
          </>
        )}
        {(card.kind === "never" || card.kind === "local") && <Button label="Close" onClick={closeFinish} />}
      </div>
    </Card>
  );
}

/** Given what to show rather than reading it, so the content on its way out keeps showing what it was. */
export function FinishView({ finish, reduced }: { finish: FinishState | null; reduced: boolean }) {
  if (!finish) return null;
  switch (finish.phase) {
    case "working":
      return <Working finish={finish} reduced={reduced} />;
    case "paused":
      return (
        <Card mood="needs" reduced={reduced} title={finish.paused ?? "Paused"} aside={clock(Date.now() - finish.startedAt)}>
          <div className="finish-foot">
            <Button label="Stop" onClick={stopFinish} />
            <Button label="Continue" main onClick={continueFinish} />
          </div>
        </Card>
      );
    case "ask":
      return finish.ask ? <Asking finish={finish} reduced={reduced} /> : null;
    case "ended":
      return finish.end ? <Ended finish={finish} reduced={reduced} /> : null;
    case "card":
      return finish.card ? <NotStarted finish={finish} reduced={reduced} /> : null;
  }
}
