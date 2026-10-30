// Motion tokens. Growth gets a touch of overshoot, shrinking never does:
// a panel that bounces while closing reads as a mistake.
// Damping ratio is damping / (2 * sqrt(stiffness * mass)).

export const spring = {
  grow: { type: "spring", stiffness: 420, damping: 33, mass: 1 },
  shrink: { type: "spring", stiffness: 460, damping: 42, mass: 1 },
  hover: { type: "spring", stiffness: 620, damping: 40, mass: 1 },
} as const;

export const fade = {
  out: { duration: 0.09, ease: [0.4, 0, 1, 1] },
  in: { duration: 0.2, ease: [0.16, 1, 0.3, 1] },
} as const;

export const instant = { duration: 0 } as const;

export const contentEnter = {
  initial: { opacity: 0, y: 4, filter: "blur(4px)" },
  animate: { opacity: 1, y: 0, filter: "blur(0px)" },
  exit: { opacity: 0, filter: "blur(2px)" },
} as const;

export const contentEnterReduced = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
} as const;
