import { useState } from "react";
import { bridge } from "../lib/bridge";
import { setWatching, useApp } from "../lib/store";
import type { SettingsChange } from "../lib/types";

/**
 * The switch for following Claude Code. It changes a file that belongs to the user, so the
 * exact change is shown first, and nothing is written until it is confirmed.
 */
export function FollowSwitch({ label = "Follow my Claude Code sessions", explain }: { label?: string; explain: string }) {
  const watching = useApp((s) => s.watching);
  const [pending, setPending] = useState<(SettingsChange & { on: boolean }) | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const ask = async (on: boolean) => {
    setStatus(null);
    try {
      setPending({ ...(await bridge.watchPreview(on)), on });
    } catch (err) {
      setStatus(String(err));
    }
  };

  const confirm = async () => {
    const on = pending!.on;
    setPending(null);
    try {
      await setWatching(on);
    } catch (err) {
      setStatus(String(err));
    }
  };

  return (
    <>
      <label className="setting toggle grow">
        <span className="stacked grow">
          <span className="label">{label}</span>
          <span className="meta">{explain}</span>
        </span>
        <input type="checkbox" role="switch" checked={pending?.on ?? watching} onChange={(e) => void ask(e.target.checked)} />
      </label>
      {pending && <HookReview change={pending} on={pending.on} onCancel={() => setPending(null)} onConfirm={() => void confirm()} />}
      {status && <p className="meta bad" role="status">{status}</p>}
    </>
  );
}

/** The exact lines a change to Claude Code's settings adds or removes, shown before anything is written.
 *  Test and repair's Fix shows it too, so putting the hooks back never skips this step. */
export function HookReview({ change, on, onCancel, onConfirm }: { change: SettingsChange; on: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="stack-sm hook-review" role="group" aria-label="Review this change">
      <p className="label">{on ? "This will add these lines" : "This will remove these lines"}</p>
      <p className="meta truncate" title={change.path}>{change.path}</p>
      <div className="code-card hook-diff">
        {change.lines.map((line, i) =>
          line.kind === "gap" ? (
            <div key={i} className="code-line" data-change="gap">···</div>
          ) : (
            <div key={i} className="code-line" data-change={line.kind}>{line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}{line.text}</div>
          ),
        )}
      </div>
      <p className="meta">The first change keeps a copy at {change.backup}.</p>
      <div className="row end">
        <button className="ghost" onClick={onCancel}>Cancel</button>
        <button className="solid" onClick={onConfirm}>{on ? "Add hooks" : "Remove hooks"}</button>
      </div>
    </div>
  );
}
