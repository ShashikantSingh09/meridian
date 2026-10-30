// The island: one shape that morphs. Width, height and radius are spring-driven
// motion values, so an interrupted transition keeps its velocity instead of
// restarting, and nothing inside re-renders per frame.

import { contentEnter, contentEnterReduced, fade, instant, scaled, spring } from "@meridian/design-system/motion";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef } from "react";
import { bridge } from "../lib/bridge";
import { togglePanel, useApp } from "../lib/store";
import { Panel } from "../panel/Panel";
import { activeSessions, deriveView, geometryFor, stateToken, waitingApproval, type IslandView, type Snapshot } from "./machine";
import {
  ContextualView,
  ErrorView,
  IdleView,
  ListeningView,
  MediaView,
  MultitaskView,
  NotificationView,
  ScreenView,
  ThinkingView,
  WorkingView,
} from "./views";

const TOP_GAP = 10;

function useReduced() {
  const system = useReducedMotion() ?? false;
  const setting = useApp((s) => s.settings.motion);
  return setting === "reduced" || (setting === "system" && system);
}

function useSnapshot(): Snapshot {
  const panelOpen = useApp((s) => s.panelOpen);
  const listening = useApp((s) => s.listening);
  const capturing = useApp((s) => s.screen.capturing);
  const mediaPlaying = useApp((s) => s.settings.mediaEnabled && (s.media.current?.playing ?? false));
  const chatPending = useApp((s) => s.chatPending);
  const sessions = useApp((s) => s.sessions);
  const notices = useApp((s) => s.notices);
  const suggestions = useApp((s) => s.suggestions);
  const errors = useApp((s) => s.errors);
  return useMemo(
    () => ({ panelOpen, listening, capturing, mediaPlaying, chatPending, sessions, notices, suggestions, errors }),
    [panelOpen, listening, capturing, mediaPlaying, chatPending, sessions, notices, suggestions, errors],
  );
}

function CompactContent({ view, reduced, hovered, sliver }: { view: IslandView; reduced: boolean; hovered: boolean; sliver: boolean }) {
  switch (view) {
    case "listening":
      return <ListeningView reduced={reduced} />;
    case "thinking":
      return <ThinkingView reduced={reduced} />;
    case "working":
      return <WorkingView reduced={reduced} hovered={hovered} />;
    case "multitask":
      return <MultitaskView reduced={reduced} />;
    case "notification":
      return <NotificationView reduced={reduced} />;
    case "contextual":
      return <ContextualView reduced={reduced} />;
    case "screen":
      return <ScreenView reduced={reduced} />;
    case "media":
      return <MediaView reduced={reduced} hovered={hovered} />;
    case "error":
      return <ErrorView reduced={reduced} />;
    default:
      return <IdleView reduced={reduced} hovered={hovered} sliver={sliver} />;
  }
}

export function Island() {
  const snapshot = useSnapshot();
  const hovered = useApp((s) => s.hovered);
  const reduced = useReduced();
  const speed = useApp((s) => s.settings.animationSpeed);
  const clock = useApp((s) => s.settings.showClock);
  const sliver = useApp((s) => s.settings.islandAutoHide);
  const align = useApp((s) => s.settings.islandAlign);
  const view = deriveView(snapshot);

  const target = geometryFor(view, {
    hovered,
    rows: activeSessions(snapshot.sessions).length,
    approval: waitingApproval(snapshot.sessions) !== null,
    clock,
    sliver,
  });

  const width = useMotionValue(target.w);
  const height = useMotionValue(target.h);
  const radius = useMotionValue(target.r);
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    const push = () => {
      frame = 0;
      const box = el.current?.getBoundingClientRect();
      if (box) void bridge.setIslandRect({ x: box.x, y: box.y, w: box.width, h: box.height, r: radius.get() });
    };
    // One message per frame however many values moved.
    const schedule = () => {
      frame ||= requestAnimationFrame(push);
    };
    const offs = [width.on("change", schedule), height.on("change", schedule), radius.on("change", schedule)];
    schedule();
    return () => {
      offs.forEach((off) => off());
      cancelAnimationFrame(frame);
    };
  }, [width, height, radius]);

  useEffect(() => {
    const grows = target.w >= width.get() && target.h >= height.get();
    const transition = reduced ? instant : scaled(grows ? spring.grow : hovered ? spring.hover : spring.shrink, speed);
    const controls = [
      animate(width, target.w, transition),
      animate(height, target.h, transition),
      animate(radius, target.r, transition),
    ];
    return () => controls.forEach((c) => c.stop());
  }, [target.w, target.h, target.r, reduced, hovered, speed, width, height, radius]);

  const enter = reduced ? contentEnterReduced : contentEnter;
  const expanded = view === "expanded";
  const glow = stateToken(view, snapshot);

  return (
    <motion.div
      ref={el}
      className="island"
      data-view={view}
      data-align={align}
      style={{ width, height, borderRadius: radius, top: TOP_GAP, "--glow": `var(${glow})` } as never}
      onClick={view === "idle" ? togglePanel : undefined}
    >
      <span className="sheen" aria-hidden="true" />
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={expanded ? "panel" : view + (hovered && (view === "idle" || view === "working" || view === "media") ? "-hover" : "")}
          className="island-content"
          style={{ width: target.w, height: target.h }}
          initial={enter.initial}
          animate={enter.animate}
          exit={enter.exit}
          transition={fade.in}
        >
          {expanded ? <Panel /> : <CompactContent view={view} reduced={reduced} hovered={hovered} sliver={sliver} />}
        </motion.div>
      </AnimatePresence>
    </motion.div>
  );
}
