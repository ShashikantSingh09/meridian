// What the island says about the volume, brightness and battery, as plain functions of what changed.

import type { Mood } from "../island/faces";
import type { Level } from "./types";

export interface LevelStory {
  mood: Mood;
  /** Colour of the bar or the words. */
  tone: string;
  /** Bar position, 0 to 100. */
  percent: number;
  number: string;
  /** Battery only. A bar shows for the rest. */
  title?: string;
  detail?: string;
  /** Green or red rising from the bottom edge. */
  glow?: boolean;
  /** The charging bolt, in place of the battery. */
  bolt?: boolean;
  /** A quick jolt when the charger goes in. */
  zap?: boolean;
  shake?: boolean;
  /** Under the bar on hover. */
  left?: string;
  right?: string;
}

const GREEN = "#30d158";
const AMBER = "#ff9f0a";
const RED = "#ff453a";
const YELLOW = "#ffd60a";
const WHITE = "#f5f5f7";

/** "1 h 12 min", or just the minutes under an hour. */
export function span(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

function battery(level: Extract<Level, { kind: "battery" }>, wasPlugged: boolean | null, now: number): LevelStory {
  const { percent, plugged, saver, secondsLeft, secondsToFull, watts, health } = level;
  const base = { percent, number: `${percent}%` };
  const left = secondsLeft ? `About ${span(secondsLeft)} left` : "";
  const healthy = health ? `Battery health ${health}%` : undefined;

  if (plugged) {
    const until = secondsToFull ? `${span(secondsToFull)} until full` : "Plugged in";
    const fullAt = secondsToFull ? `Full at ${new Date(now + secondsToFull * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Plugged in";
    if (percent >= 100) return { ...base, mood: "done", tone: GREEN, title: "Fully charged", detail: "You can unplug", bolt: true, glow: true, left: "Fully charged", right: healthy };
    return { ...base, mood: "done", tone: GREEN, title: "Charging", detail: until, bolt: true, glow: true, zap: wasPlugged === false, left: fullAt, right: watts ? `${watts} W` : healthy };
  }
  if (percent <= 10) return { ...base, mood: "error", tone: RED, title: "Plug in soon", detail: left, shake: true, glow: true, left, right: healthy };
  if (percent <= 20) return { ...base, mood: "sleepy", tone: AMBER, title: "Battery low", detail: left, glow: true, left, right: healthy };
  if (saver) return { ...base, mood: "sleepy", tone: YELLOW, title: "Battery saver on", detail: "Animations are calmer", left, right: healthy };
  return { ...base, mood: "working", tone: WHITE, title: "On battery", detail: left, left, right: healthy };
}

/** `before` is the last level of the same kind, so a key press can be told up from down. */
export function story(level: Level, before: Level | null, now = Date.now()): LevelStory {
  if (level.kind === "battery") return battery(level, before?.kind === "battery" ? before.plugged : null, now);

  const rising = before?.kind === level.kind && level.percent >= before.percent;
  if (level.kind === "brightness") {
    const mood: Mood = level.percent <= 5 ? "asleep" : rising ? "needs" : "sleepy";
    return { mood, tone: YELLOW, percent: level.percent, number: String(level.percent) };
  }
  if (level.muted) return { mood: "asleep", tone: WHITE, percent: 0, number: "" };
  if (level.percent >= 100) return { mood: "needs", tone: WHITE, percent: 100, number: "100", shake: true };
  return { mood: rising ? "done" : "working", tone: WHITE, percent: level.percent, number: String(level.percent) };
}
