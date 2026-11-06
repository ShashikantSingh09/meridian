// The outlines over a form Meridian filled, from the Fill this form board: green for a box it filled,
// amber with a lock for one that is yours, amber for one that needs you, and a blue glow for the box
// being filled now. The window is see-through to the mouse and never takes the keyboard, so the core
// draws here with draw() and says which box the pointer is on with hover(). Nothing here can reach the
// app, and every word goes in as text, never as markup.

import "@fontsource-variable/inter/opsz.css";
import "./outlines.css";

/** One box, in physical pixels from the window's corner, as the core sends it. */
export interface Outline {
  x: number;
  y: number;
  w: number;
  h: number;
  look: "ok" | "need" | "now";
  /** The mark at the box's end: Written by AI, from mail, Yours to fill, Needs you. */
  tag?: ["ai" | "mail" | "lock" | "need", string];
  /** What pointing at it says. */
  tip?: [string, string];
  /** For a filled box, how long ago in ms. It fades out by FADE_MS, and the core then stops sending it. */
  age?: number;
}

/** A filled box is green for this long, then fades out over the rest of FADE_MS. */
export const FADE_AT_MS = 3400;
export const FADE_MS = 4000;

const root = document.getElementById("outlines")!;
let shown: Outline[] = [];

const LOCK =
  '<svg aria-hidden="true" width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="9" width="11" height="8" rx="2"></rect><path d="M7 9V6.5a3 3 0 0 1 6 0V9"></path></svg>';

function el(tag: string, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function eyes() {
  const node = el("span", "ol-eyes");
  node.setAttribute("aria-hidden", "true");
  node.append(el("i", ""), el("i", ""));
  return node;
}

/** Physical pixels to the page's own, which follow the screen's scale. */
const css = (px: number) => px / (window.devicePixelRatio || 1);

/** `motion` is the app's own setting, which this page cannot read: "system" follows Windows. */
export function draw(outlines: Outline[], motion = "system") {
  shown = outlines;
  document.documentElement.dataset.motion = motion;
  root.replaceChildren();
  outlines.forEach((o, index) => {
    const box = el("div", "ol-box");
    box.dataset.look = o.look;
    box.dataset.index = String(index);
    Object.assign(box.style, { left: `${css(o.x)}px`, top: `${css(o.y)}px`, width: `${css(o.w)}px`, height: `${css(o.h)}px` });
    // Drawn again as the page scrolls, so the fade starts from where it had got to, never over.
    if (o.age !== undefined) {
      box.dataset.fade = "";
      box.style.animationDelay = `${FADE_AT_MS - o.age}ms`;
    }
    if (o.tag) {
      const [kind, text] = o.tag;
      const tag = el("span", "ol-tag");
      tag.dataset.kind = kind;
      // A tall box has its mark at the bottom, as a long answer does on the board.
      if (css(o.h) > 40) tag.dataset.low = "";
      if (kind === "lock") tag.insertAdjacentHTML("afterbegin", LOCK);
      if (kind === "ai") tag.append(eyes());
      tag.append(document.createTextNode(text));
      box.append(tag);
    }
    root.append(box);
  });
}

export function hover(index: number | null) {
  root.querySelector(".ol-tip")?.remove();
  root.querySelectorAll(".ol-box[data-hover]").forEach((box) => box.removeAttribute("data-hover"));
  const o = index === null ? undefined : shown[index];
  if (!o?.tip) return;
  root.querySelector(`.ol-box[data-index="${index}"]`)?.setAttribute("data-hover", "");
  const tip = el("div", "ol-tip");
  const title = el("b", "");
  title.append(eyes(), document.createTextNode(o.tip[0]));
  tip.append(title, document.createTextNode(o.tip[1]));
  // Under the box, or over it when the box is near the bottom.
  const below = css(o.y + o.h) + 8;
  const room = window.innerHeight - below;
  Object.assign(tip.style, { left: `${Math.max(8, Math.min(css(o.x), window.innerWidth - 270))}px` });
  if (room > 90) tip.style.top = `${below}px`;
  else tip.style.bottom = `${window.innerHeight - css(o.y) + 8}px`;
  root.append(tip);
}

Object.assign(window, { draw, hover });
