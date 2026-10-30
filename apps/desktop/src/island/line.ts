// The Meridian Line: one line of light that carries every state. These are the
// pure shape functions; MeridianLine.tsx draws them.

export type LineMode = "rest" | "listen" | "think" | "work" | "flare" | "fracture";

export interface LineSegment {
  color: string;
  mode: LineMode;
}

/** Tapers the line to nothing at both ends, u in [0, 1]. */
export const envelope = (u: number) => Math.sin(Math.PI * Math.min(1, Math.max(0, u)));

/** Vertical offset at position u and time t (seconds), as a fraction of half the height. */
export function displacement(mode: LineMode, u: number, t: number, level: number): number {
  const env = envelope(u);
  switch (mode) {
    case "listen": {
      const a = 0.12 + 0.88 * Math.min(1, Math.max(0, level));
      const wave =
        0.6 * Math.sin(u * 13 + t * 7) + 0.3 * Math.sin(u * 23 - t * 11) + 0.1 * Math.sin(u * 41 + t * 17);
      return a * env * wave;
    }
    case "think":
      return 0.34 * env * Math.sin(u * Math.PI * 4) * Math.cos(t * 2.6);
    case "fracture": {
      const tremor = Math.sin(t * 31) * Math.exp(-(t % 3) * 3);
      return 0.16 * env * tremor * Math.sin(u * 37);
    }
    default:
      return 0;
  }
}

/** Where the travelling pulse sits, u in [0, 1]. */
export const pulseAt = (t: number, speed = 0.42) => {
  const p = (t * speed) % 1.3;
  return p - 0.15;
};

/** Brightness at u: 0 to 1, drawn as the opacity of a short sub-segment. */
export function brightness(mode: LineMode, u: number, t: number): number {
  const env = envelope(u);
  switch (mode) {
    case "rest":
      return 0.62 * env;
    case "work": {
      const d = (u - pulseAt(t)) / 0.17;
      return env * (0.3 + 0.7 * Math.exp(-d * d));
    }
    case "flare":
      return env * (0.72 + 0.28 * Math.exp(-t * 2.2));
    case "fracture":
      return Math.abs(u - 0.5) < 0.045 ? 0 : 0.86 * env;
    default:
      return 0.92 * env;
  }
}

/** Whether a mode needs frames at all. A resting line is drawn once. */
export const animates = (mode: LineMode) => mode !== "rest";
