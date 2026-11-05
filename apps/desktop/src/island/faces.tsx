// The faces that live on the island. To add one in an update: draw it here, add its
// moods to faces.css, and add a row to FACES. It then appears in Settings, Island.

import { useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useApp } from "../lib/store";
import "./faces.css";

export function useReduced() {
  const system = useReducedMotion() ?? false;
  const setting = useApp((s) => s.settings.motion);
  return setting === "reduced" || (setting === "system" && system);
}

/** The moods every face draws. */
type Drawn = "rest" | "listen" | "think" | "speak" | "heard" | "notice" | "working" | "needs" | "done" | "error" | "drag" | "sleepy" | "asleep";
export type Mood = Drawn | "music" | "curious" | "wink" | "love" | "dizzy";

/** Soft eyes draws every mood. The other faces use the nearest one they have. */
const NEAREST: Partial<Record<Mood, Drawn>> = { music: "rest", curious: "rest", wink: "done", love: "done", dizzy: "error" };

const COLORS: Record<Drawn, string> = {
  rest: "#eef2f8",
  listen: "var(--state-listening)",
  think: "var(--state-thinking)",
  speak: "#eef2f8",
  heard: "#ffffff",
  notice: "#eef2f8",
  working: "var(--state-working)",
  needs: "var(--state-waiting)",
  done: "var(--state-success)",
  error: "var(--state-error)",
  drag: "#eef2f8",
  sleepy: "#a9adb6",
  asleep: "#6d7078",
};

type Range = [number, number];
/** How often a mood blinks, in ms. Listening blinks more, reading less, and the rest keep still. */
const BLINKS: Partial<Record<Mood, Range>> = {
  rest: [2500, 6000],
  notice: [2500, 6000],
  done: [2500, 6000],
  speak: [2500, 6000],
  curious: [2500, 6000],
  music: [2500, 6000],
  listen: [1800, 3500],
  working: [6000, 9000],
};
/** A one-shot that plays again now and then, so a long wait still looks alive without a loop. */
const BEATS: Partial<Record<Mood, Range>> = { needs: [8000, 8000], working: [7000, 11000] };
/** Each z redraws the window for 2.4 s, so asleep it makes two and then nothing moves at all. */
const SNORES_AT = [900, 3300];

// Dot patterns, 17 across and 7 down.
type Grid = number[][];
const grid = (): Grid => Array.from({ length: 7 }, () => Array<number>(17).fill(0));
const box = (g: Grid, x: number, y: number, w: number, h: number) => {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (g[j] && i >= 0 && i < 17) g[j]![i] = 1;
};
const dots = (g: Grid, pts: number[][]) => pts.forEach(([x, y]) => g[y!] && (g[y!]![x!] = 1));
const eyes = (g: Grid, x1: number, x2: number, y: number, w: number, h: number) => (box(g, x1, y, w, h), box(g, x2, y, w, h));

function pattern(m: Drawn, lv: number): Grid {
  const g = grid();
  if (m === "rest") (eyes(g, 3, 11, 1, 3, 3), dots(g, [[5, 5], [11, 5]]), box(g, 6, 6, 5, 1));
  else if (m === "listen") (eyes(g, 3, 11, 0, 3, 4), box(g, 7, 6, 3, 1));
  else if (m === "think") (eyes(g, 2, 10, 0, 3, 2), box(g, 10, 5, 2, 1));
  else if (m === "speak") {
    eyes(g, 3, 11, 1, 3, 2);
    if (lv <= 0) box(g, 5, 6, 7, 1);
    else if (lv === 1) box(g, 6, 5, 5, 2);
    else if (lv === 2) (box(g, 6, 4, 5, 1), dots(g, [[5, 5], [11, 5]]), box(g, 6, 6, 5, 1));
    else (box(g, 5, 4, 7, 1), dots(g, [[4, 5], [12, 5]]), box(g, 5, 6, 7, 1));
  } else if (m === "heard") (box(g, 3, 0, 3, 1), box(g, 11, 0, 3, 1), eyes(g, 2, 10, 1, 5, 2), box(g, 3, 3, 3, 1), box(g, 11, 3, 3, 1), dots(g, [[8, 5], [7, 6], [9, 6]]));
  else if (m === "notice") (eyes(g, 4, 12, 1, 3, 3), dots(g, [[6, 5], [12, 5]]), box(g, 7, 6, 5, 1));
  else if (m === "working") (eyes(g, 3, 11, 2, 3, 2), box(g, 6, 6, 5, 1));
  else if (m === "needs") (eyes(g, 3, 11, 0, 3, 4), dots(g, [[8, 5], [7, 6], [9, 6]]));
  else if (m === "done") (box(g, 3, 1, 3, 1), box(g, 11, 1, 3, 1), dots(g, [[2, 2], [6, 2], [10, 2], [14, 2], [4, 4], [12, 4], [5, 5], [11, 5]]), box(g, 6, 6, 5, 1));
  else if (m === "error") {
    const x = (o: number) => [[2 + o, 0], [6 + o, 0], [3 + o, 1], [5 + o, 1], [4 + o, 2], [3 + o, 3], [5 + o, 3], [2 + o, 4], [6 + o, 4]];
    dots(g, [...x(0), ...x(8)]);
    box(g, 6, 5, 5, 1);
    dots(g, [[5, 6], [11, 6]]);
  } else if (m === "drag") (dots(g, [[3, 1], [4, 2], [3, 3], [13, 1], [12, 2], [13, 3]]), box(g, 7, 5, 3, 2));
  else if (m === "sleepy") (eyes(g, 3, 11, 2, 3, 1), box(g, 7, 6, 3, 1));
  else (eyes(g, 3, 11, 3, 3, 1), box(g, 7, 6, 3, 1), dots(g, [[14, 0], [15, 0], [16, 0], [15, 1], [14, 2], [15, 2], [16, 2]]));
  return g;
}

/** Each dot lists the voice steps it is lit at, so speaking can swap the mouth in the styles. */
function Pixel({ mood }: { mood: Mood }) {
  const m = NEAREST[mood] ?? (mood as Drawn);
  const cells = useMemo(() => {
    const steps = m === "speak" ? [0, 1, 2, 3] : [0];
    const grids = steps.map((lv) => pattern(m, lv));
    // Lit at every step, unless the mouth is speaking.
    const lit = (j: number, i: number) => (m === "speak" ? steps.filter((lv) => grids[lv]![j]![i]).join("") : grids[0]![j]![i] ? "0123" : "");
    return grids[0]!.flatMap((row, j) => row.map((_, i) => ({ row: j, on: lit(j, i) })));
  }, [m]);
  return (
    <span className="px">
      {cells.map((c, i) => (
        <i key={i} data-on={c.on} style={{ transitionDelay: `${c.row * 22}ms` }} />
      ))}
    </span>
  );
}

const Eye = ({ children }: { children: React.ReactNode }) => (
  <span className="eye">
    <span className="lid">{children}</span>
  </span>
);

export interface FaceDef {
  id: string;
  name: string;
  note: string;
  draw: (mood: Mood) => React.JSX.Element;
}

export const FACES: FaceDef[] = [
  { id: "soft", name: "Soft eyes", note: "Calm glowing eyes that change shape with mood.", draw: () => <><Eye><i className="shape s-oval" /></Eye><Eye><i className="shape s-oval" /></Eye></> },
  { id: "googly", name: "Googly eyes", note: "Round eyes that follow you. The funniest one.", draw: () => <><Eye><span className="shape g-ball"><i className="g-pupil" /></span></Eye><Eye><span className="shape g-ball"><i className="g-pupil g-right" /></span></Eye></> },
  { id: "visor", name: "Robot visor", note: "One bar of light that moves in steps, like a machine.", draw: () => <span className="v-bar"><i className="v-light" /></span> },
  {
    id: "smile",
    name: "Smiley",
    note: "Eyes and a mouth that moves with speech.",
    draw: () => (
      <span className="sm">
        <span className="sm-eyes"><Eye><i className="shape d-dot" /></Eye><Eye><i className="shape d-dot" /></Eye></span>
        <svg className="sm-mouth" width="24" height="10" viewBox="0 0 24 10"><path className="mouth" d="M4 3 Q12 9 20 3" /></svg>
      </span>
    ),
  },
  { id: "pixel", name: "Pixel face", note: "Retro dots that redraw for each mood.", draw: (mood) => <Pixel mood={mood} /> },
  {
    id: "cat",
    name: "Cat",
    note: "Ears that flick at news, and pupils that widen with interest.",
    draw: () => (
      <span className="cat">
        <span className="ears"><i className="ear l" /><i className="ear r" /></span>
        <span className="c-eyes"><Eye><span className="shape c-eye"><i className="slit" /></span></Eye><Eye><span className="shape c-eye"><i className="slit" /></span></Eye></span>
        <i className="nose" />
      </span>
    ),
  },
  {
    id: "horizon",
    name: "Horizon",
    note: "The Meridian line, with two eyes sitting in it.",
    draw: () => (
      <span className="hz">
        <i className="seg a" /><Eye><i className="shape h-eye" /></Eye><i className="seg b" /><Eye><i className="shape h-eye" /></Eye><i className="seg c" />
      </span>
    ),
  },
  { id: "moons", name: "Moons", note: "Two moons whose lit part shows the mood.", draw: () => <><Eye><span className="shape moon"><i className="lit" /></span></Eye><Eye><span className="shape moon"><i className="lit" /></span></Eye></> },
];

/** A face from a newer version, or one since removed, falls back to the default. */
export const faceById = (id: string) => FACES.find((f) => f.id === id) ?? FACES[0]!;

/** Plays the mood's one-shot again: "1" as it arrives, "2" for a heartbeat, which is one round. */
function play(el: HTMLElement, kind: "1" | "2") {
  delete el.dataset.play;
  // The browser has to see it stop before it will start the same animation again.
  void el.offsetWidth;
  el.dataset.play = kind;
}

/** The face, drawn at its real size. `scale` other than 1 zooms it, and so softens it. */
export function Face({ id, mood, scale = 1, reduced: asked }: { id: string; mood: Mood; scale?: number; reduced?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const setting = useReduced();
  const reduced = asked ?? setting;
  const face = faceById(id);
  const shown = face.id === "soft" ? mood : (NEAREST[mood] ?? mood);
  const color = face.id === "soft" ? COLORS[shown === "sleepy" || shown === "asleep" ? shown : "rest"] : COLORS[shown as Drawn];

  // Before the first paint, so a one-shot never flashes its end pose.
  useLayoutEffect(() => {
    if (!reduced && ref.current) play(ref.current, "1");
  }, [shown, face.id, reduced]);

  // Little things happen at random, because a steady rhythm reads as a machine. A timer costs
  // one short repaint every few seconds instead of a repaint every frame.
  useEffect(() => {
    const el = ref.current;
    if (reduced || !el) return;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const after = (ms: number, then: () => void) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        then();
      }, ms);
      timers.add(timer);
    };
    const flag = (name: string, value: string, ms: number) => {
      el.dataset[name] = value;
      after(ms, () => delete el.dataset[name]);
    };
    const every = ([least, most]: Range, act: () => void) =>
      after(least + Math.random() * (most - least), () => {
        act();
        every([least, most], act);
      });

    const blinks = face.id !== "googly" && BLINKS[shown];
    if (blinks) {
      every(blinks, () => {
        if (shown === "rest" && Math.random() < 0.18) return flag("glance", Math.random() < 0.5 ? "l" : "r", 800);
        flag("blink", "true", 220);
        if (Math.random() < 0.2) after(300, () => flag("blink", "true", 220));
      });
    }
    const beat = BEATS[shown];
    if (beat) every(beat, () => play(el, "2"));
    if (shown === "think") every([2500, 4500], () => (el.dataset.side = el.dataset.side === "l" ? "r" : "l"));
    if (shown === "asleep") SNORES_AT.forEach((at) => after(at, () => flag("snore", "true", 2400)));
    return () => {
      timers.forEach(clearTimeout);
      for (const name of ["blink", "glance", "snore", "side"]) delete el.dataset[name];
    };
  }, [shown, face.id, reduced]);

  return (
    <span ref={ref} className="face" data-face={face.id} data-mood={shown} data-lv="0" data-reduced={reduced} style={{ "--c": color, zoom: scale === 1 ? undefined : scale } as React.CSSProperties} aria-hidden="true">
      {face.draw(mood)}
    </span>
  );
}
