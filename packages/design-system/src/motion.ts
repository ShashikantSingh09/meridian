// Motion tokens: six named springs, and nothing else moves without one. Growth gets a hint
// of overshoot, shrinking never does: a panel that bounces while closing reads as a mistake.
//
// Numbers come from Apple's two spring terms, duration (seconds) and bounce, at mass 1:
// stiffness = (2π / duration)², damping = 4π · (1 − bounce) / duration. Motion's own
// `visualDuration` is not Apple's duration, so the stiffness and damping are given outright.
// faces.css uses the same curves, written as cubic-beziers.

export const spring = {
  snap: { type: "spring", stiffness: 500, damping: 40, mass: 1 }, // 0.28 s, bounce 0.11: hover, presses
  grow: { type: "spring", stiffness: 225, damping: 25, mass: 1 }, // 0.42 s, bounce 0.17: the island opening
  shrink: { type: "spring", stiffness: 340, damping: 37, mass: 1 }, // 0.34 s, no bounce: the island closing
  face: { type: "spring", stiffness: 438.6, damping: 31.4, mass: 1 }, // 0.30 s, bounce 0.25: eyes changing shape
  pop: { type: "spring", stiffness: 322.3, damping: 23.3, mass: 1 }, // 0.35 s, bounce 0.35: heard its name, a drop
  drift: { type: "spring", stiffness: 48.7, damping: 14, mass: 1 }, // 0.90 s, no bounce: slow moods
} as const;

export type SpringName = keyof typeof spring;

/** Each spring's duration in Apple's terms, which is what content waits a share of. */
export const springDuration: Record<SpringName, number> = { snap: 0.28, grow: 0.42, shrink: 0.34, face: 0.3, pop: 0.35, drift: 0.9 };

/** The same spring, faster or slower. Keeps the damping ratio, so the character holds. */
export const scaled = (s: (typeof spring)[SpringName], speed: number) => ({
  ...s,
  stiffness: s.stiffness * speed * speed,
  damping: s.damping * speed,
});

export const instant = { duration: 0 } as const;

// The shape moves first, and the words wait until there is room for them: 0.3 of the shape's
// spring, then they settle in from very slightly smaller, so the eye reads the words and not the
// motion. Old content leaves in 90 ms, before
// new content arrives, so two lines of text never overlap. Everything follows the Animation
// speed setting. No filters here: a blur re-rasters the text on every frame of a morph.
export const contentEnter = (shape: SpringName, speed: number, up = false, after = 0.3 * springDuration[shape]) => {
  const delay = after / speed;
  const settle = { ...scaled(spring.snap, speed), delay };
  return {
    initial: { opacity: 0, scale: 0.985, y: up ? 2 : -2 },
    animate: { opacity: 1, scale: 1, y: 0, transition: { opacity: { duration: 0.24 / speed, delay, ease: [0.16, 1, 0.3, 1] }, scale: settle, y: settle } },
    exit: { opacity: 0, scale: 0.97, transition: { duration: 0.09 / speed, ease: [0.4, 0, 1, 1] } },
  } as const;
};

/** Closing goes back the way it came. The words leave in the first 90 ms while the shape holds still,
 *  then it pulls up into its resting pill, height first so it reads as rising, and is there by 300 ms,
 *  when the clock comes back. The shrink spring, only quicker, so it still never bounces. Being critically
 *  damped, it settles about 1.35 of its duration after it starts: height by 250 ms, width by 300. */
export const CLOSE_REST = 0.3;
export const closing = (speed: number) => {
  const pull = (seconds: number, delay: number) => ({ ...scaled(spring.shrink, (springDuration.shrink / seconds) * speed), delay: delay / speed });
  return { height: pull(0.12, 0.09), width: pull(0.14, 0.11) };
};

export const contentEnterReduced = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.1 } },
  exit: { opacity: 0, transition: { duration: 0.05 } },
} as const;

/** Rows arriving from a fetch, one after another. */
export const rowEnter = (index: number) => ({
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { ...spring.snap, delay: Math.min(index, 10) * 0.035 },
});
