// The island: one shape that morphs, hanging from the top edge of the screen like
// a notch. Width, height and radius are spring-driven motion values, so an
// interrupted transition keeps its velocity instead of restarting, and nothing
// inside re-renders per frame.

import { contentEnter, contentEnterReduced, instant, scaled, spring } from "@meridian/design-system/motion";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { useEffect, useMemo, useRef } from "react";
import { bridge } from "../lib/bridge";
import { reportView, togglePanel, useApp } from "../lib/store";
import { Panel } from "../panel/Panel";
import { activeSessions, deriveView, geometryFor, stateToken, waitingApproval, type IslandView, type Snapshot } from "./machine";
import { notchPath } from "./notch";
import {
  Bubble,
  ContextualView,
  ErrorView,
  IdleView,
  ListeningView,
  LiveView,
  MediaView,
  MultitaskView,
  NotificationView,
  ScreenView,
  ThinkingView,
  WorkingView,
} from "./views";

/** What the shape grows out of when the app starts: a dot at the screen's edge. */
const BIRTH = { w: 18, h: 4 };
/** Views with a light running round the edge, because something is under way. */
const LIT: ReadonlySet<IslandView> = new Set(["listening", "thinking", "working", "multitask", "error", "notification"]);

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
  const live = useApp((s) => s.live);
  return useMemo(
    () => ({ panelOpen, listening, capturing, mediaPlaying, chatPending, sessions, notices, suggestions, errors, live }),
    [panelOpen, listening, capturing, mediaPlaying, chatPending, sessions, notices, suggestions, errors, live],
  );
}

function CompactContent({ view, reduced, hovered, sliver, mediaOpen }: { view: IslandView; reduced: boolean; hovered: boolean; sliver: boolean; mediaOpen: boolean }) {
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
      return <MediaView open={mediaOpen} />;
    case "live":
      return <LiveView hovered={hovered} />;
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
  const tab = useApp((s) => s.tab);
  const mediaOpen = useApp((s) => s.mediaOpen);
  const greeting = useApp((s) => s.greeting);
  const artTint = useApp((s) => s.artTint);
  const view = deriveView(snapshot);

  useEffect(() => reportView(view), [view]);

  const target = geometryFor(view, {
    hovered,
    rows: activeSessions(snapshot.sessions).length,
    approval: waitingApproval(snapshot.sessions) !== null,
    asking: waitingApproval(snapshot.sessions)?.approval,
    clock,
    sliver,
    actions: (snapshot.notices[0]?.actions?.length ?? 0) > 0 || snapshot.notices[0]?.eventId !== undefined,
    tab,
    mediaOpen,
    greeting,
    liveRich: Boolean(snapshot.live[0]?.route || snapshot.live[0]?.steps),
  });

  const width = useMotionValue(reduced ? target.w : BIRTH.w);
  const height = useMotionValue(reduced ? target.h : BIRTH.h);
  const radius = useMotionValue(target.r);
  const outline = useTransform([width, height, radius], ([w, h, r]: number[]) => notchPath(w!, h!, r!));
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    const push = () => {
      frame = 0;
      const box = el.current?.getBoundingClientRect();
      if (box) void bridge.setIslandRect({ x: box.x, y: box.y, w: box.width, h: box.height });
    };
    // One message per frame however many values moved.
    const schedule = () => {
      frame ||= requestAnimationFrame(push);
    };
    const offs = [width.on("change", schedule), height.on("change", schedule)];
    schedule();
    return () => {
      offs.forEach((off) => off());
      cancelAnimationFrame(frame);
    };
  }, [width, height]);

  useEffect(() => {
    const grows = target.w * target.h > width.get() * height.get();
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
  const lit = LIT.has(view) && !reduced;
  const glow = view === "media" ? artTint ?? "#ff7a9c" : `var(${stateToken(view, snapshot)})`;
  const contentKey = expanded ? "panel" : view + (hovered && (view === "idle" || view === "working" || view === "live") ? "-hover" : "") + (view === "media" && mediaOpen ? "-open" : "");

  return (
    <motion.div
      ref={el}
      className="island"
      data-view={view}
      data-align={align}
      data-small={target.h < 12}
      style={{ width, height, "--glow": glow } as never}
      onClick={view === "idle" ? togglePanel : undefined}
    >
      <svg className="island-body" aria-hidden="true">
        <motion.path d={outline} />
      </svg>
      {lit && (
        <svg className="island-light" aria-hidden="true">
          <motion.path className="island-rim" d={outline} />
          {/* Measured as 1 long, so the dash in the styles is a share of the outline at any size. */}
          <motion.path className="island-comet" d={outline} ref={(path: SVGPathElement | null) => path?.setAttribute("pathLength", "1")} />
        </svg>
      )}
      <Bubble />
      <motion.div className="island-shape" style={{ borderBottomLeftRadius: radius, borderBottomRightRadius: radius }}>
        <span className="island-tint" aria-hidden="true" />
        <AnimatePresence initial={false}>
          <motion.div key={contentKey} className="island-content" style={{ width: target.w, height: target.h }} initial={enter.initial} animate={enter.animate} exit={enter.exit}>
            {expanded ? <Panel /> : <CompactContent view={view} reduced={reduced} hovered={hovered} sliver={sliver} mediaOpen={mediaOpen} />}
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
