// The faces that live on the island. To add one in an update: draw it here, add its
// moods to faces.css, and add a row to FACES. It then appears in Settings, Island.

import { useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { useApp } from "../lib/store";
import "./faces.css";

export function useReduced() {
  const system = useReducedMotion() ?? false;
  const setting = useApp((s) => s.settings.motion);
  return setting === "reduced" || (setting === "system" && system);
}

type Base = "rest" | "working" | "needs" | "done" | "error" | "music" | "asleep";
export type Mood = Base | "sleepy" | "curious" | "wink" | "love" | "dizzy";

/** Soft eyes draws every mood. The other faces use the nearest one they have. */
const NEAREST: Partial<Record<Mood, Base>> = { sleepy: "asleep", curious: "rest", wink: "done", love: "done", dizzy: "error" };

const COLORS: Record<Base, string> = {
  rest: "#eef2f8",
  working: "var(--state-working)",
  needs: "var(--state-waiting)",
  done: "var(--state-success)",
  error: "var(--state-error)",
  music: "#ff7a9c",
  asleep: "#6d7078",
};

// Dot patterns, 17 across and 7 down.
const PIXELS: Record<Base, string[]> = {
  rest: [".................", "...###.....###...", "...###.....###...", "...###.....###...", ".................", ".....#.....#.....", "......#####......"],
  working: [".................", ".................", "...###.....###...", "...###.....###...", ".................", ".................", "......#####......"],
  needs: ["...###.....###...", "...###.....###...", "...###.....###...", "...###.....###...", ".................", "........#........", ".......#.#......."],
  done: [".................", "...###.....###...", "..#...#...#...#..", ".................", "....#.......#....", ".....#.....#.....", "......#####......"],
  error: ["..#...#...#...#..", "...#.#.....#.#...", "....#.......#....", "...#.#.....#.#...", "..#...#...#...#..", "......#####......", ".....#.....#....."],
  music: [".................", "...###.....###...", "..#...#...#...#..", ".................", ".....#######.....", ".....#.....#.....", "......#####......"],
  asleep: [".............###.", "...............#.", "..###.......###..", ".............###.", ".................", ".................", ".......###......."],
};

function Pixel({ mood }: { mood: Mood }) {
  return (
    <span className="pixels">
      {PIXELS[(NEAREST[mood] ?? mood) as Base].join("").split("").map((dot, i) => (
        <i key={i} data-on={dot === "#"} />
      ))}
    </span>
  );
}

export interface FaceDef {
  id: string;
  name: string;
  note: string;
  draw: (mood: Mood) => React.JSX.Element;
}

export const FACES: FaceDef[] = [
  { id: "soft", name: "Soft eyes", note: "Calm glowing eyes that change shape with mood.", draw: () => <><span className="oval" /><span className="oval" /></> },
  { id: "googly", name: "Googly eyes", note: "Round eyes that follow you. The funniest one.", draw: () => <><span className="googly"><i className="pupil" /></span><span className="googly"><i className="pupil" /></span></> },
  { id: "visor", name: "Robot visor", note: "One bar of light that scans.", draw: () => <span className="visor"><i className="scan" /></span> },
  { id: "smile", name: "Smiley", note: "Eyes and a mouth. Reads its mood instantly.", draw: () => <span className="smile"><span className="smile-eyes"><i className="dot" /><i className="dot" /></span><i className="mouth" /></span> },
  { id: "pixel", name: "Pixel face", note: "Retro dots that redraw for each mood.", draw: (mood) => <Pixel mood={mood} /> },
  { id: "cat", name: "Cat", note: "Slit pupils that widen when it needs you.", draw: () => <span className="kitty"><span className="smile-eyes"><span className="cat"><i className="slit" /></span><span className="cat"><i className="slit" /></span></span><i className="nose" /></span> },
];

/** A face from a newer version, or one since removed, falls back to the default. */
export const faceById = (id: string) => FACES.find((f) => f.id === id) ?? FACES[0];

export function Face({ id, mood, scale = 1, reduced: asked }: { id: string; mood: Mood; scale?: number; reduced?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const setting = useReduced();
  const reduced = asked ?? setting;

  // Little things happen at random, because a steady rhythm reads as a machine. A timer costs
  // one short repaint every few seconds instead of a repaint every frame. Asleep, it snores.
  useEffect(() => {
    if (reduced) return;
    const sleeping = mood === "asleep";
    let timer: ReturnType<typeof setTimeout>;
    const flag = (name: string, ms: number) => {
      const el = ref.current;
      if (!el) return;
      el.dataset[name] = "true";
      setTimeout(() => delete el.dataset[name], ms);
    };
    const act = () => {
      const roll = Math.random();
      if (sleeping) flag("snore", 2400);
      else if (mood === "rest" && roll < 0.18) flag("glance", 900);
      else if (roll < 0.34) {
        flag("blink", 170);
        setTimeout(() => flag("blink", 170), 260);
      } else flag("blink", 170);
      timer = setTimeout(act, sleeping ? 5200 + Math.random() * 3000 : 2500 + Math.random() * 3500);
    };
    timer = setTimeout(act, 900 + Math.random() * 1800);
    return () => clearTimeout(timer);
  }, [mood, reduced]);

  const soft = faceById(id).id === "soft";
  const shown = soft ? mood : (NEAREST[mood] ?? mood);

  return (
    <span ref={ref} className="face" data-face={faceById(id).id} data-mood={shown} data-reduced={reduced} style={{ "--c": COLORS[soft ? "rest" : (shown as Base)], zoom: scale } as React.CSSProperties} aria-hidden="true">
      {faceById(id).draw(mood)}
    </span>
  );
}
