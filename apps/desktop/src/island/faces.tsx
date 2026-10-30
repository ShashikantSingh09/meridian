// The faces that live on the island. To add one in an update: draw it here, add its
// moods to faces.css, and add a row to FACES. It then appears in Settings, Island.

import { useEffect, useRef } from "react";
import "./faces.css";

export type Mood = "rest" | "working" | "needs" | "done" | "error" | "music" | "asleep";

const COLORS: Record<Mood, string> = {
  rest: "#eef2f8",
  working: "var(--state-working)",
  needs: "var(--state-waiting)",
  done: "var(--state-success)",
  error: "var(--state-error)",
  music: "#ff7a9c",
  asleep: "#6d7078",
};

// Dot patterns, 17 across and 7 down.
const PIXELS: Record<Mood, string[]> = {
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
      {PIXELS[mood].join("").split("").map((dot, i) => (
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

export function Face({ id, mood, scale = 1, reduced = false }: { id: string; mood: Mood; scale?: number; reduced?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);

  // Blinks are random on purpose: a steady rhythm reads as a machine, and a timer here
  // costs one short repaint every few seconds instead of a repaint every frame.
  useEffect(() => {
    if (reduced || mood === "asleep") return;
    let timer: ReturnType<typeof setTimeout>;
    const blink = () => {
      const el = ref.current;
      if (el) {
        el.dataset.blink = "true";
        setTimeout(() => delete el.dataset.blink, 170);
      }
      timer = setTimeout(blink, 2500 + Math.random() * 3500);
    };
    timer = setTimeout(blink, 900 + Math.random() * 1800);
    return () => clearTimeout(timer);
  }, [mood, reduced]);

  return (
    <span ref={ref} className="face" data-face={faceById(id).id} data-mood={mood} data-reduced={reduced} style={{ "--c": COLORS[mood], zoom: scale } as React.CSSProperties} aria-hidden="true">
      {faceById(id).draw(mood)}
    </span>
  );
}
