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

/**
 * Floating, the island is a shape of its own: the outline closed all the way round. A bar that is
 * no taller than the island at rest gets fully round ends.
 */
export function pillPath(w: number, h: number, radius: number) {
  const r = pillRadius(w, h, radius);
  return [
    `M${r} 0`,
    `H${w - r}`,
    `A${r} ${r} 0 0 1 ${w} ${r}`,
    `V${h - r}`,
    `A${r} ${r} 0 0 1 ${w - r} ${h}`,
    `H${r}`,
    `A${r} ${r} 0 0 1 0 ${h - r}`,
    `V${r}`,
    `A${r} ${r} 0 0 1 ${r} 0`,
    "Z",
  ].join("");
}

/** The corner of a floating island, which the clip of its contents follows too. */
export const pillRadius = (w: number, h: number, radius: number) => Math.max(0, Math.min(h <= 44 ? h / 2 : radius, w / 2, h / 2));
