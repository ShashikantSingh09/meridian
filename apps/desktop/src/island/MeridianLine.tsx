import { useEffect, useRef } from "react";
import { animates, brightness, displacement, type LineSegment } from "./line";

interface Props {
  segments: LineSegment[];
  width: number;
  height: number;
  reduced: boolean;
  /** Read each frame, so a microphone level never re-renders React. */
  level?: () => number;
}

const STEP = 3;
const GAP = 8;

function resolve(color: string, el: HTMLElement) {
  return color.startsWith("--") ? getComputedStyle(el).getPropertyValue(color).trim() : color;
}

function drawSegment(
  ctx: CanvasRenderingContext2D,
  seg: LineSegment,
  color: string,
  x0: number,
  x1: number,
  h: number,
  t: number,
  level: number,
) {
  const mid = h / 2;
  const amp = mid - 2;
  const span = Math.max(1, x1 - x0);
  // Sub-segments carry their own alpha, which is how a gradient that travels
  // along a curved line is drawn without a shadow blur per frame.
  for (const [lineWidth, gain] of [
    [5, 0.14],
    [1.6, 1],
  ] as const) {
    ctx.lineWidth = lineWidth;
    let prevX = x0;
    let prevY = mid + displacement(seg.mode, 0, t, level) * amp;
    for (let x = x0 + STEP; x <= x1 + 0.5; x += STEP) {
      const u = (x - x0) / span;
      const y = mid + displacement(seg.mode, u, t, level) * amp;
      const b = brightness(seg.mode, u, t) * gain;
      if (b > 0.004) {
        ctx.globalAlpha = b;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(prevX, prevY);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
      prevX = x;
      prevY = y;
    }
  }
}

export function MeridianLine({ segments, width, height, reduced, level }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = "round";

    const colors = segments.map((s) => resolve(s.color, canvas));
    const start = performance.now();
    let frame = 0;

    const paint = (now: number) => {
      const t = reduced ? 0.8 : (now - start) / 1000;
      const lvl = level?.() ?? 0;
      ctx.clearRect(0, 0, width, height);
      const n = segments.length;
      const each = (width - GAP * (n - 1)) / n;
      segments.forEach((seg, i) => {
        const x0 = i * (each + GAP);
        drawSegment(ctx, seg, colors[i], x0, x0 + each, height, t, lvl);
      });
      if (!reduced && segments.some((s) => animates(s.mode))) frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [segments, width, height, reduced, level]);

  return <canvas ref={ref} style={{ width, height, display: "block" }} aria-hidden="true" />;
}
