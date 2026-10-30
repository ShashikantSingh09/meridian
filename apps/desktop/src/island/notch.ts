/** The curve where the shape flows out of the screen's top edge, sized to the shape. */
export const earOf = (w: number, h: number) => Math.max(0, Math.min(10, h / 3, w / 8));

/**
 * The island's outline as one line: out of the top edge on the left, round the bottom, and back
 * into the top edge on the right. Being one path is what stops the curves and the body ever
 * showing as separate pieces. It stays open along the top, so a line drawn on it never shows there.
 */
export function notchPath(w: number, h: number, radius: number) {
  const r = Math.max(0, Math.min(radius, w / 2, h));
  const ear = earOf(w, h);
  return [
    `M${-ear} 0`,
    `Q0 0 0 ${ear}`,
    `V${h - r}`,
    `A${r} ${r} 0 0 0 ${r} ${h}`,
    `H${w - r}`,
    `A${r} ${r} 0 0 0 ${w} ${h - r}`,
    `V${ear}`,
    `Q${w} 0 ${w + ear} 0`,
  ].join("");
}
