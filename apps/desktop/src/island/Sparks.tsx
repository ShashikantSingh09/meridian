// Sparks when work is done (D79): React Bits' Click Spark, on a layer over the whole window that the pointer passes
// through, so ordinary clicks never set it off. It fires from code: round the face when an agent finishes, and from any
// Allow button when it is pressed.

import ClickSpark, { type ClickSparkHandle } from "@/components/ClickSpark/ClickSpark";
import { useEffect, useRef } from "react";
import { useReduced } from "./faces";

const EVENT = "meridian:spark";

/** Sparks round the middle of an element on screen. */
export function sparkFrom(el: Element | null | undefined) {
  const box = el?.getBoundingClientRect();
  if (box && box.width > 0) window.dispatchEvent(new CustomEvent(EVENT, { detail: { x: box.left + box.width / 2, y: box.top + box.height / 2 } }));
}

export function Sparks() {
  const ref = useRef<ClickSparkHandle>(null);
  const reduced = useReduced();

  useEffect(() => {
    if (reduced) return;
    const fire = (e: Event) => {
      const { x, y } = (e as CustomEvent<{ x: number; y: number }>).detail;
      ref.current?.spark(x, y);
    };
    // Every Allow, wherever it is: on the island, in Agents, in Chat.
    const allowed = (e: MouseEvent) => {
      const button = (e.target as Element | null)?.closest?.("button.allow");
      if (button && !(button as HTMLButtonElement).disabled) sparkFrom(button);
    };
    window.addEventListener(EVENT, fire);
    document.addEventListener("click", allowed, true);
    return () => {
      window.removeEventListener(EVENT, fire);
      document.removeEventListener("click", allowed, true);
    };
  }, [reduced]);

  // The success colour, short and small: a burst, not fireworks.
  return (
    <ClickSpark
      ref={ref}
      className="spark-layer"
      style={{ position: "fixed", inset: 0, width: "auto", height: "auto", zIndex: 50, pointerEvents: "none" }}
      sparkColor="#30d158"
      sparkCount={10}
      sparkSize={9}
      sparkRadius={26}
      duration={520}
      glow={0.6}
    />
  );
}
