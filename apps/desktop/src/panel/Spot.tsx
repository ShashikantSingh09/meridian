// A soft light that follows the pointer over a card and catches its edge (D79): React Bits' Spotlight Card, with the
// card's own colours. Nothing happens until the pointer comes near.

import SpotlightCard from "@/components/SpotlightCard/SpotlightCard";

type Props = React.HTMLAttributes<HTMLDivElement> & { [data: `data-${string}`]: unknown };

export function Spot({ className, style, children, ...rest }: Props) {
  return (
    <SpotlightCard
      className={className}
      spotlightColor="rgba(255, 255, 255, 0.9)"
      intensity={0.12}
      borderGlow={0.7}
      spotlightSize={260}
      ambient={false}
      flare={false}
      style={{ "--spotlight-card-surface": "var(--well)", "--spotlight-card-border": "var(--hairline)", "--spotlight-card-shadow": "none", ...style } as React.CSSProperties}
      {...rest}
    >
      {children}
    </SpotlightCard>
  );
}
