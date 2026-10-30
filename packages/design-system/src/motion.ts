// Motion tokens. Growth gets a hint of overshoot, shrinking never does: a panel
// that bounces while closing reads as a mistake.
//
// Numbers come from Apple's two spring terms: response (seconds) and damping
// fraction. stiffness = (2π / response)², damping = 4π · fraction / response.

export const spring = {
  grow: { type: "spring", stiffness: 225, damping: 25, mass: 1 }, // response 0.42, fraction 0.84
  shrink: { type: "spring", stiffness: 340, damping: 37, mass: 1 }, // response 0.34, fraction 1
  hover: { type: "spring", stiffness: 500, damping: 40, mass: 1 }, // response 0.28, fraction 0.9
} as const;

/** The same spring, faster or slower. Keeps the damping ratio, so the character holds. */
export const scaled = (s: (typeof spring)[keyof typeof spring], speed: number) => ({
  ...s,
  stiffness: s.stiffness * speed * speed,
  damping: s.damping * speed,
});

export const instant = { duration: 0 } as const;

// Old content leaves before new content arrives, so two lines of text never
// overlap. No filters here: a blur re-rasters the text on every frame of a morph.
export const contentEnter = {
  initial: { opacity: 0, y: -3 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.2, delay: 0.07, ease: [0.16, 1, 0.3, 1] } },
  exit: { opacity: 0, transition: { duration: 0.07, ease: "linear" } },
} as const;

export const contentEnterReduced = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.1 } },
  exit: { opacity: 0, transition: { duration: 0.05 } },
} as const;

/** Rows arriving from a fetch, one after another. */
export const rowEnter = (index: number) => ({
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { ...spring.hover, delay: Math.min(index, 10) * 0.035 },
});
