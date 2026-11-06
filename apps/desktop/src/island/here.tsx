// Write here and asking from the island, as the boards draw them: a short line while the words go in,
// one line with Undo, Shorter and Warmer once they are in, a line or a card when they cannot go in, and a
// question typed into the island with its answer.

import { useEffect, useRef } from "react";
import { closeAsk, openAsk, openInChat, askAgain, sendAsk, signInAgain, SHOWN_CHARS, typeAsk, type AskState } from "../lib/ask";
import { allowAlways, allowOnce, allowPlace, closeHere, copyReply, lookForBox, neverHere, notNow, openFillSettings, rewrite, startFillForm, startWriteHere, tryAgain, undoHere, type HereState } from "../lib/here";
import { Icon } from "../lib/icons";
import { useApp } from "../lib/store";
import { Face, type Mood } from "./faces";
import { FORM_STEPS, FormView } from "./form";
import "./here.css";

export function Eyes({ mood, reduced }: { mood: Mood; reduced: boolean }) {
  const id = useApp((s) => s.settings.face);
  const feeling = useApp((s) => s.feeling);
  return <Face id={id} mood={feeling ?? mood} reduced={reduced} />;
}

/** Something under way, without a time it will take. */
export const Working = () => (
  <span className="here-progress" aria-hidden="true">
    <i />
  </span>
);

export const Button = ({ label, main, onClick }: { label: string; main?: boolean; onClick: () => void }) => (
  <button className="here-b" data-main={main || undefined} onClick={(e) => { e.stopPropagation(); onClick(); }}>
    {label}
  </button>
);

export function Card({ mood, title, body, reduced, children }: { mood: Mood; title: string; body: string; reduced: boolean; children: React.ReactNode }) {
  return (
    <div className="stack pad-card here-card" role="alertdialog" aria-label={title}>
      <div className="row">
        <Eyes mood={mood} reduced={reduced} />
        <span className="grow label truncate" title={title}>{title}</span>
      </div>
      <p className="here-body">{body}</p>
      <div className="row end">{children}</div>
    </div>
  );
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Banks, tax and government sites, which ask every time whatever the list says. */
const CAREFUL = ["a bank", "a tax site", "a government site"];

function HereCard({ here, reduced }: { here: HereState; reduced: boolean }) {
  const place = here.place;
  const form = here.kind === "form";
  const what = form ? "Fill this form" : "Write here";
  // On a site, in an app.
  const on = place && (place.id === null || (place.id.includes(".") && !/\.exe$/i.test(place.id))) ? "on" : "in";
  switch (here.step) {
    case "ask": {
      if (!place) return null;
      if (!place.every) {
        return (
          <Card mood="needs" reduced={reduced} title={`${what} ${on} ${place.name}?`} body={`${place.name} is not on your list of apps and sites yet. Nothing in it is read until you say.`}>
            <Button label="Never" onClick={() => void neverHere()} />
            <Button label="Once" onClick={() => void allowOnce()} />
            <Button label="Always" main onClick={() => void allowAlways()} />
          </Card>
        );
      }
      const why = place.every.startsWith("set to") ? `${place.name} is ${place.every}.` : `${sentence(place.every)} asks every time.`;
      // The bank card on the Fill this form board.
      const body = form && CAREFUL.includes(place.every) ? "Banks and government sites ask every time. Passwords and one-time codes stay yours." : `${why} Nothing is read until you say.`;
      return (
        <Card mood="needs" reduced={reduced} title={`${what} ${on} ${place.name}?`} body={body}>
          <Button label="Not now" onClick={notNow} />
          <Button label={form ? "Fill this time" : "Write here"} main onClick={() => void allowOnce()} />
        </Card>
      );
    }
    case "off":
      return place ? (
        <Card mood="rest" reduced={reduced} title={`${what} is off ${on} ${place.name}`} body={`You set ${place.name} to Never, so nothing in it is read.`}>
          <Button label="Not now" onClick={notNow} />
          <Button label={`Allow ${place.name}`} main onClick={() => void allowPlace()} />
        </Card>
      ) : null;
    case "local":
      return (
        <Card mood="rest" reduced={reduced} title="Local-only mode is on" body={`${what} is set to use ${here.ai ?? "an AI"}, which is online. Pick an AI on this PC, or turn local-only mode off.`}>
          <Button label="Settings" onClick={openFillSettings} />
        </Card>
      );
    case "failed":
      return (
        <Card mood="error" reduced={reduced} title={form ? "Could not fill this form" : "Could not write here"} body={here.text ?? ""}>
          <Button label="Close" onClick={closeHere} />
          <Button label="Try again" main onClick={() => void tryAgain()} />
        </Card>
      );
    case "moved":
      return (
        <Card mood="needs" reduced={reduced} title={here.text ?? "You moved to another box"} body="So nothing was put in. The reply is kept for a minute.">
          <Button label="Close" onClick={closeHere} />
          <Button label="Copy the reply" main onClick={() => void copyReply()} />
        </Card>
      );
    default:
      return null;
  }
}

/** Given what to show rather than reading it, so the content on its way out keeps showing what it was. */
export function HereView({ here, reduced, hovered = false }: { here: HereState | null; reduced: boolean; hovered?: boolean }) {
  if (!here) return null;
  if (FORM_STEPS.has(here.step)) return <FormView here={here} reduced={reduced} hovered={hovered} />;
  if (here.step === "writing") {
    return (
      <div className="row pad-pill here-pill" role="status">
        <Eyes mood="think" reduced={reduced} />
        <span className="grow label">Writing here…</span>
        <Working />
      </div>
    );
  }
  if (here.step === "written") {
    return (
      <div className="row pad-pill here-pill" role="status">
        <Eyes mood="done" reduced={reduced} />
        <span className="grow label truncate">Written here · not sent</span>
        <Button label="Undo" onClick={() => void undoHere()} />
        <Button label="Shorter" onClick={() => void rewrite("shorter")} />
        <Button label="Warmer" onClick={() => void rewrite("warmer")} />
      </div>
    );
  }
  if (here.step === "line") {
    return (
      <div className="row pad-pill here-pill" role="status">
        <Eyes mood="needs" reduced={reduced} />
        <span className="grow label truncate" title={here.text}>{here.text}</span>
      </div>
    );
  }
  return <HereCard here={here} reduced={reduced} />;
}

/** Under the greeting when the pointer is on the island: a field to ask from, and Write here when a
 *  box Meridian may write in has the cursor, or Fill this form when that box is in a form. */
export function AskRow() {
  const offer = useApp((s) => s.hereOffer !== null && s.settings.fill.on && s.settings.fill.buttons);
  const form = useApp((s) => s.formOffer);
  useEffect(() => void lookForBox(), []);
  return (
    <div className="row peek-ask">
      <button className="peek-field grow" onClick={(e) => { e.stopPropagation(); openAsk(); }}>
        <span className="grow">Ask anything</span>
        <Icon name="mic" size={14} />
      </button>
      {offer && (form ? <Button label="Fill this form" onClick={() => void startFillForm()} /> : <Button label="Write here" onClick={() => void startWriteHere()} />)}
    </div>
  );
}

/** Typing goes straight into the island. Enter sends, and Esc or a click elsewhere closes it. */
function Typing({ question, reduced }: { question: string; reduced: boolean }) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => box.current?.focus(), []);
  return (
    <div className="stack pad-card ask-typing">
      <div className="row">
        <Eyes mood="listen" reduced={reduced} />
        <form className="answer-box" onSubmit={(e) => { e.preventDefault(); sendAsk(); }}>
          <input
            ref={box}
            aria-label="Ask anything"
            placeholder="Ask anything"
            value={question}
            maxLength={2000}
            onChange={(e) => typeAsk(e.target.value)}
            // Pressing in the box is typing, not the start of a drag.
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.key === "Escape" && closeAsk()}
            onBlur={closeAsk}
          />
          {/* Keeps the keyboard in the box, so a click here is not a click elsewhere. */}
          <button type="submit" className="answer-send" aria-label="Send" disabled={!question.trim()} onMouseDown={(e) => e.preventDefault()}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16V4M5 9l5-5 5 5" /></svg>
          </button>
        </form>
      </div>
      <span className="ask-hint">Enter sends · Esc closes · Hold Ctrl Alt V to talk instead</span>
    </div>
  );
}

export function AskView({ ask, reduced }: { ask: AskState | null; reduced: boolean }) {
  if (!ask) return null;
  if (ask.phase === "typing") return <Typing question={ask.question} reduced={reduced} />;
  if (ask.phase === "thinking") {
    return (
      <div className="row pad-pill here-pill" role="status">
        <Eyes mood="think" reduced={reduced} />
        <span className="grow truncate ask-question">{ask.question}</span>
        <Working />
      </div>
    );
  }
  if (ask.phase === "answer") {
    const long = ask.answer.length > SHOWN_CHARS;
    return (
      <div className="stack pad-card ask-card">
        <div className="row ask-answer-row">
          <Eyes mood="rest" reduced={reduced} />
          <p className="ask-answer" data-long={long || undefined}>{ask.answer}</p>
        </div>
        <div className="row end">
          <Button label={long ? "Open in Chat for the rest" : "Open in Chat"} onClick={openInChat} />
        </div>
      </div>
    );
  }
  return (
    <Card mood="error" reduced={reduced} title="Could not answer" body={ask.why}>
      <Button label="Close" onClick={closeAsk} />
      {ask.signIn ? <Button label="Sign in again" main onClick={() => void signInAgain()} /> : <Button label="Try again" main onClick={() => void askAgain()} />}
    </Card>
  );
}
