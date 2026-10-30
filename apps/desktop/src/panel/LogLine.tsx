import { rowEnter } from "@meridian/design-system/motion";
import { motion } from "motion/react";
import type { LogEntry } from "../lib/store";
import { Markdown } from "./Markdown";

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
