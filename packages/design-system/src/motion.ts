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
  wobble: { type: "spring", stiffness: 438.6, damping: 29.3, mass: 1 }, // 0.30 s, bounce 0.30: the resting pill under the pointer
} as const;

export type SpringName = keyof typeof spring;

/** Each spring's duration in Apple's terms, which is what content waits a share of. */
export const springDuration: Record<SpringName, number> = { snap: 0.28, grow: 0.42, shrink: 0.34, face: 0.3, pop: 0.35, drift: 0.9, wobble: 0.3 };

/** The same spring, faster or slower. Keeps the damping ratio, so the character holds. */
export const scaled = (s: (typeof spring)[SpringName], speed: number) => ({
  ...s,
  stiffness: s.stiffness * speed * speed,
  damping: s.damping * speed,
});

export const instant = { duration: 0 } as const;

// The shape moves first, and the words follow it out of the edge it grows from (D78): from a short
// blur, 96 % size and a few pixels back towards the edge. The blur hides the part of the morph that is
// not finished yet, so the words start at 0.15 of the shape's spring instead of 0.3. Old content leaves
// in 90 ms, before new content arrives, so two lines of text never overlap. Everything follows the
// Animation speed setting. `blur` false is the old way, a fade from very slightly smaller, kept for
// when the blur costs frames (lib/frames.ts).
export const contentEnter = (shape: SpringName, speed: number, up = false, after?: number, blur = false) => {
  const delay = (after ?? (blur ? 0.15 : 0.3) * springDuration[shape]) / speed;
  const settle = { ...scaled(spring.snap, speed), delay };
  const ease = [0.16, 1, 0.3, 1] as const;
  const back = (blur ? 6 : 2) * (up ? 1 : -1);
  return {
    initial: blur ? { opacity: 0, scale: 0.96, y: back, filter: "blur(8px)" } : { opacity: 0, scale: 0.985, y: back },
    animate: {
      opacity: 1,
      scale: 1,
      y: 0,
      ...(blur ? { filter: "blur(0px)" } : {}),
      transition: { opacity: { duration: 0.22 / speed, delay, ease }, filter: { duration: 0.22 / speed, delay, ease }, scale: settle, y: settle },
    },
    exit: { opacity: 0, scale: 0.97, transition: { duration: 0.09 / speed, ease: [0.4, 0, 1, 1] } },
  } as const;
};

/** A page arriving the moment the old one has gone, while the island is still reshaping to it, so there is no gap. */
export const pageEnter = (speed: number, blur = false) => contentEnter("grow", speed, false, 0, blur);

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
