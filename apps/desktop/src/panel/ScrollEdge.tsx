// What scrolls under the bottom edge of a list softens into a blur instead of being cut off (D79): React Bits' Gradual
// Blur. It goes last inside the list that scrolls, held to the list's bottom edge, and shows only while there is more
// below, so a chat that follows its newest line shows none.

import GradualBlur from "@/components/GradualBlur/GradualBlur";

const HEIGHT = 56;

export function ScrollEdge() {
  return (
    <GradualBlur
      className="scroll-edge"
      position="bottom"
      target="parent"
      height={`${HEIGHT}px`}
      strength={1.4}
      layers={6}
      autoHide
      zIndex={2}
      style={{ position: "sticky", bottom: 0, left: "auto", right: "auto", flex: "none", marginTop: -HEIGHT, width: "100%" }}
    />
  );
}
