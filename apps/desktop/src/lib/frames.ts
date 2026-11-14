// Content arrives from a short blur (D78), unless the blur costs frames on this PC. Each blurred entrance is
// watched; two in a row with a frame slower than SLOW_MS turn the blur off for the rest of the session, and
// the old fade takes over. No setting: it is only a fallback.

/** About two frames at 60 Hz. */
export const SLOW_MS = 34;
const MISSES_TO_STOP = 2;

let on = typeof matchMedia !== "function" || !matchMedia("(prefers-reduced-transparency: reduce)").matches;
let misses = 0;

export const blurOn = () => on;

/** Judges one entrance from the frame gaps it took. Exported for the test. */
export function judge(gaps: number[]) {
  // The first gap holds React's own render of the new content, which blur does not cost.
  const worst = Math.max(0, ...gaps.slice(1));
  misses = worst > SLOW_MS ? misses + 1 : 0;
  if (misses >= MISSES_TO_STOP) on = false;
}

/** Watches the frames for as long as an entrance plays. */
export function watchFrames(ms: number) {
  if (!on || typeof requestAnimationFrame !== "function") return;
  const gaps: number[] = [];
  let last = performance.now();
  const end = last + ms;
  const tick = (t: number) => {
    gaps.push(t - last);
    last = t;
    if (t < end) requestAnimationFrame(tick);
    else judge(gaps);
  };
  requestAnimationFrame(tick);
}

/** For the test only. */
export function resetFrames() {
  on = true;
  misses = 0;
}
