// One lap of light round an Ask box when it takes focus (D79): React Bits' Star Border, in the 'once' mode our copy adds.
// Hidden at rest, and the same idea as the comet that runs round the island, so it reads as Meridian.

import StarBorder from "@/components/StarBorder/StarBorder";

export function AskLap({ radius, className, children }: { radius: number; className?: string; children: React.ReactNode }) {
  return (
    <StarBorder
      as="div"
      className={className ? `ask-lap ${className}` : "ask-lap"}
      hover="once"
      radius={radius}
      thickness={1.5}
      color="#e6f2ff"
      trailColor="#4aa3ff"
      stars={1}
      glow={0.5}
      sparkle={false}
      clickPulse={false}
      backgroundColor="transparent"
      borderColor="transparent"
      textColor="inherit"
    >
      {children}
    </StarBorder>
  );
}
