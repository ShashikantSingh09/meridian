import { rowEnter } from "@meridian/design-system/motion";
import { motion } from "motion/react";
import { useEffect, useRef } from "react";
import { clock, type Step } from "../lib/sessions";
import type { LogEntry } from "../lib/store";
import { Markdown } from "./Markdown";

/** How near the end still counts as being there. */
const FOLLOW_WITHIN = 40;

/** Keeps a log on its newest line, unless the reader has scrolled up. Spread the result on the log.
 *  `also` is anything else that moves that line, such as a card opening under it. */
export function useFollow(lines: unknown, conversation: unknown, also?: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    following.current = true;
  }, [conversation]);
  useEffect(() => {
    if (following.current) ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines, conversation, also]);
  const onScroll = () => {
    const el = ref.current;
    if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_WITHIN;
  };
  return { ref, onScroll };
}

/** A tool action: the verb, what it acted on, and when, counted from `start`. */
export function StepRow({ step, start }: { step: Step; start: number }) {
  const lines = step.lines ? `, ${step.lines} ${step.lines === 1 ? "line" : "lines"}` : "";
  return (
    <div className="step-row" data-kind={step.kind} data-failed={step.failed}>
      <span className="step-verb">{step.verb}</span>
      <span className="step-what truncate">{step.what}{lines}</span>
      {step.at !== undefined && <span className="step-time tabular">{clock(step.at - start)}</span>}
    </div>
  );
}

/** One step of a session. Code changes and commands show what really happened. */
export function LogLine({ entry }: { entry: LogEntry }) {
  if (entry.kind === "diff") {
    return (
      <motion.div className="code-card" {...rowEnter(0)}>
        <div className="code-title truncate">{entry.text}</div>
        {entry.removed?.map((line, i) => <div key={`r${i}`} className="code-line" data-change="removed">- {line}</div>)}
        {entry.added?.map((line, i) => <div key={`a${i}`} className="code-line" data-change="added">+ {line}</div>)}
      </motion.div>
    );
  }
  if (entry.kind === "output") {
    return (
      <motion.div className="code-card" {...rowEnter(0)}>
        <div className="code-line" data-change="command">$ {entry.text}</div>
        {entry.lines?.map((line, i) => <div key={i} className="code-line" data-change={entry.failed ? "removed" : "plain"}>{line}</div>)}
      </motion.div>
    );
  }
  if (entry.kind === "text") return <Markdown text={entry.text} />;
  return <p className={`log-${entry.kind}`}>{entry.text}</p>;
}
