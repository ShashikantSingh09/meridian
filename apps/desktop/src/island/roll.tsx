// Numbers that roll to their next value instead of jumping, with React Bits' Counter (D79). A clock, a count or a
// time like 4:05 PM is split into its numbers, and each one rolls on its own. What a screen reader and a test read is
// the plain text, said once: the Counter's columns hold every numeral, so they are for the eye only.

import Counter from "@/components/Counter/Counter";
import { useReduced } from "./faces";

const NUMBER = /^\d+$/;

/** `still` names the trailing number that changes every second, like the seconds of a running time. It changes without
 *  rolling: rolling it would redraw the window most of every second for as long as an agent works. */
export function Roll({ text, className, still = false }: { text: string; className?: string; still?: boolean }) {
  const reduced = useReduced();
  const parts = text.split(/(\d+)/).filter(Boolean);
  const last = parts.map((p) => NUMBER.test(p)).lastIndexOf(true);
  return (
    <span className={className ? `roll ${className}` : "roll"}>
      <span className="sr-only">{text}</span>
      <span className="roll-digits" aria-hidden="true">
        {parts.map((part, i) =>
          still && i === last ? (
            // Plain text: a Counter does work on every change even when it does not roll.
            <span key={i}>{part}</span>
          ) : NUMBER.test(part) ? (
            // Our snap spring (motion.ts): 0.28 s with a little bounce. Nothing rolls in on first show.
            <Counter key={i} value={Number(part)} minDigits={part.length} fontSize="1em" intro={false} duration={reduced ? 0 : 0.45} bounce={0.11} stagger={0.03} motionBlur={!reduced} />
          ) : (
            <span key={i}>{part}</span>
          ),
        )}
      </span>
    </span>
  );
}
