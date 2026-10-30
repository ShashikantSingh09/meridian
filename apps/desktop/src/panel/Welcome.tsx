// First run. Everything here is optional and repeats a setting, so nobody has to
// decide anything before they can use the island.

import { FollowSwitch } from "./Follow";
import { rowEnter } from "@meridian/design-system/motion";
import { motion } from "motion/react";
import { openSettings, updateSettings, useApp } from "../lib/store";

const Step = ({ index, children }: { index: number; children: React.ReactNode }) => (
  <motion.div className="welcome-step" {...rowEnter(index)}>{children}</motion.div>
);

const finish = () => updateSettings({ onboarded: true });

export function Welcome() {
  const claude = useApp((s) => s.agents.find((a) => a.id === "claude-code")?.installed ?? false);
  const autostart = useApp((s) => s.settings.autostart);

  return (
    <div className="page-scroll stack-lg welcome">
      <header className="stack-sm">
        <h1>Meridian lives at the top of your screen</h1>
        <p className="meta">It shows what your agents are doing, asks before they do anything important, and stays out of the way otherwise.</p>
      </header>

      <div className="stack">
        <Step index={0}>
          <span className="stacked grow">
            <span className="label">Open it from anywhere</span>
            <span className="meta">Point at the top of the screen and click, or press Ctrl Alt Space.</span>
          </span>
        </Step>
        {claude && (
          <Step index={1}>
            <div className="stack-sm grow">
              <FollowSwitch explain="Adds hooks to your Claude Code settings, with a backup. Off removes them." />
            </div>
          </Step>
        )}
        <Step index={2}>
          <span className="stacked grow">
            <span className="label">Connect a provider</span>
            <span className="meta">See your issues, mail and calendar on the island. Read-only.</span>
          </span>
          <button className="ghost" onClick={() => { void finish(); openSettings("providers"); }}>Choose</button>
        </Step>
        <Step index={3}>
          <label className="setting toggle grow">
            <span className="stacked grow">
              <span className="label">Start with Windows</span>
              <span className="meta">So it is always there.</span>
            </span>
            <input type="checkbox" role="switch" checked={autostart} onChange={(e) => void updateSettings({ autostart: e.target.checked })} />
          </label>
        </Step>
      </div>

      <div className="row end">
        <button className="solid" onClick={() => void finish()}>Done</button>
      </div>
    </div>
  );
}
