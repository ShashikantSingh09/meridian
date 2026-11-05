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
// spring, then they grow in with it from a little smaller. Old content leaves in 90 ms, before
// new content arrives, so two lines of text never overlap. Everything follows the Animation
// speed setting. No filters here: a blur re-rasters the text on every frame of a morph.
export const contentEnter = (shape: SpringName, speed: number, up = false) => {
  const delay = (0.3 * springDuration[shape]) / speed;
  const settle = { ...scaled(spring.snap, speed), delay };
  return {
    initial: { opacity: 0, scale: 0.96, y: up ? 4 : -4 },
    animate: { opacity: 1, scale: 1, y: 0, transition: { opacity: { duration: 0.24 / speed, delay, ease: [0.16, 1, 0.3, 1] }, scale: settle, y: settle } },
    exit: { opacity: 0, scale: 0.97, transition: { duration: 0.09 / speed, ease: [0.4, 0, 1, 1] } },
  } as const;
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
