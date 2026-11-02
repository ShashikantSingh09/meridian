// The island: one shape that morphs, hanging from the top edge of the screen like
// a notch, or floating wherever it was dragged. Width, height and radius are spring-driven motion values, so an
// interrupted transition keeps its velocity instead of restarting, and nothing
// inside re-renders per frame.

import { contentEnter, contentEnterReduced, instant, scaled, spring } from "@meridian/design-system/motion";
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import { lastMessage } from "../lib/sessions";
import { openPanel, reportView, togglePanel, useApp } from "../lib/store";
import { Panel } from "../panel/Panel";
import { useReduced } from "./faces";
import { activeSessions, deriveView, geometryFor, stateToken, waitingApproval, type IslandView, type Snapshot } from "./machine";
import { notchPath, pillPath, pillRadius } from "./notch";
import {
  Bubble,
  ContextualView,
  ErrorView,
  IdleView,
  LevelView,
  ListeningView,
  LiveView,
  MediaView,
  MultitaskView,
  NoteView,
  NotificationView,
  ScreenView,
  ThinkingView,
  VoiceView,
  WorkingView,
} from "./views";
import "./stages.css";

/** A press that moves this far, in CSS pixels, is a drag and not a click. */
const DRAG_PX = 6;
/** What the shape grows out of when the app starts: a dot at the screen's edge. */
const BIRTH = { w: 18, h: 4 };
/** About what fits on one line of the voice view. */
const VOICE_LINE = 52;
/** Views with a light running round the edge, because something is under way. */
const LIT: ReadonlySet<IslandView> = new Set(["listening", "thinking", "working", "multitask", "error", "notification"]);

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
  const level = useApp((s) => s.level !== null);
  const voice = useApp((s) => s.voice !== null);
  const recording = useApp((s) => s.notes.recording !== null);
  const writingNote = useApp((s) => s.notes.working.length > 0);
  return useMemo(
    () => ({ panelOpen, listening, capturing, mediaPlaying, chatPending, sessions, notices, suggestions, errors, live, level, voice, recording, writingNote }),
    [panelOpen, listening, capturing, mediaPlaying, chatPending, sessions, notices, suggestions, errors, live, level, voice, recording, writingNote],
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
      return <MultitaskView />;
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
    case "level":
      return <LevelView hovered={hovered} reduced={reduced} />;
    case "voice":
      return <VoiceView reduced={reduced} />;
    case "error":
      return <ErrorView reduced={reduced} />;
    case "note":
      return <NoteView hovered={hovered} reduced={reduced} />;
    default:
      return <IdleView reduced={reduced} hovered={hovered} sliver={sliver} />;
  }
}

export function Island() {
  const snapshot = useSnapshot();
  const pointerOver = useApp((s) => s.hovered);
  const place = useApp((s) => s.islandPlace);
  const floating = place !== "top";
  const [dragging, setDragging] = useState(false);
  // Being moved, it keeps the size it was picked up at.
  const hovered = pointerOver && !dragging;
  const reduced = useReduced();
  const speed = useApp((s) => s.settings.animationSpeed);
  const clock = useApp((s) => s.settings.showClock);
  const sliver = useApp((s) => s.settings.islandAutoHide);
  const align = useApp((s) => s.settings.islandAlign);
  const tab = useApp((s) => s.tab);
  const mediaOpen = useApp((s) => s.mediaOpen);
  const greeting = useApp((s) => s.greeting);
  const artTint = useApp((s) => s.artTint);
  const wakeOn = useApp((s) => s.wake.state === "listening");
  const battery = useApp((s) => s.level?.kind === "battery");
  const charged = useApp((s) => s.settings.showBattery && s.charge !== null);
  const voiceLong = useApp((s) => ((s.voice?.words.length ?? 0) + (s.voice?.ahead.length ?? 0)) > VOICE_LINE);
  const stagesOpen = useApp((s) => s.stagesOpen);
  const finished = useApp((s) => {
    const notice = s.notices[0];
    const session = notice?.finished ? s.sessions.find((x) => x.id === notice.sessionId) : undefined;
    return session ? (lastMessage(session) ? "message" : "brief") : undefined;
  });
  const view = deriveView(snapshot);
  const waiting = waitingApproval(snapshot.sessions);
  const active = activeSessions(snapshot.sessions);
  const opened = hovered || (view === "working" && stagesOpen);
  const playerOpen = mediaOpen || hovered;

  useEffect(() => reportView(view), [view]);

  const target = geometryFor(view, {
    hovered: opened,
    rows: active.length,
    todos: active[0]?.todos?.length,
    finished,
    stopped: snapshot.sessions.some((s) => s.id === snapshot.errors[0]?.sessionId),
    approval: waiting !== null,
    asking: waiting?.approval,
    clock,
    charge: charged,
    sliver,
    actions: (snapshot.notices[0]?.actions?.length ?? 0) > 0 || snapshot.notices[0]?.eventId !== undefined,
    tab,
    mediaOpen: playerOpen,
    battery,
    voiceLong,
    greeting,
    liveRich: Boolean(snapshot.live[0]?.route || snapshot.live[0]?.steps),
    noteWriting: !snapshot.recording,
    noteReady: snapshot.notices[0]?.note !== undefined,
    noteFailed: snapshot.errors[0]?.note !== undefined,
  });

  const width = useMotionValue(reduced ? target.w : BIRTH.w);
  const height = useMotionValue(reduced ? target.h : BIRTH.h);
  const radius = useMotionValue(target.r);
  const afloat = useMotionValue(floating ? 1 : 0);
  useEffect(() => afloat.set(floating ? 1 : 0), [afloat, floating]);
  const outline = useTransform([width, height, radius, afloat], ([w, h, r, f]: number[]) => (f ? pillPath(w!, h!, r!) : notchPath(w!, h!, r!)));
  // Its contents are clipped to the same corners, all four of them when it floats.
  const corner = useTransform([width, height, radius, afloat], ([w, h, r, f]: number[]) => (f ? pillRadius(w!, h!, r!) : r!));
  const topCorner = useTransform([corner, afloat], ([c, f]: number[]) => (f ? c! : 0));
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);
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

  // Press and move to drag it anywhere. Less than a few pixels is still a click.
  const down = (e: React.PointerEvent) => {
    if (expanded || e.button !== 0) return;
    press.current = { x: e.screenX, y: e.screenY, moved: false };
  };
  const move = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p || p.moved || Math.hypot(e.screenX - p.x, e.screenY - p.y) < DRAG_PX) return;
    p.moved = true;
    // Only now: capturing on every press would take the click from a button inside the island.
    el.current?.setPointerCapture(e.pointerId);
    setDragging(true);
    void bridge.islandDrag(true);
  };
  const up = () => {
    const p = press.current;
    press.current = null;
    if (!p?.moved) return;
    justDragged.current = true;
    // A click normally follows at once. If none does, the next real one must not be lost.
    setTimeout(() => (justDragged.current = false), 400);
    setDragging(false);
    void bridge.islandDrag(false);
  };
  const lit = LIT.has(view) && !reduced;
  const glow = view === "media" ? artTint ?? "#ff7a9c" : `var(${stateToken(view, snapshot)})`;
  // A waiting request looks the same either way, and swapping it would lose the answers so far.
  const opensOnHover = view === "idle" || view === "live" || view === "note" || (view === "working" && waiting === null);
  const contentKey = expanded ? "panel" : view + (opened && opensOnHover ? "-hover" : "") + (view === "media" && playerOpen ? "-open" : "");

  return (
    <motion.div
      ref={el}
      className="island"
      data-view={view}
      data-align={align}
      data-place={place}
      data-dragging={dragging || undefined}
      data-small={target.h < 12}
      style={{ width, height, "--glow": glow } as never}
      onClick={view === "idle" ? togglePanel : view === "note" ? () => openPanel("notes") : undefined}
      onClickCapture={(e) => {
        // The release of a drag is not a click on whatever it ended over.
        if (!justDragged.current) return;
        justDragged.current = false;
        e.stopPropagation();
        e.preventDefault();
      }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
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
      <motion.div className="island-shape" style={{ borderBottomLeftRadius: corner, borderBottomRightRadius: corner, borderTopLeftRadius: topCorner, borderTopRightRadius: topCorner }}>
        <span className="island-tint" aria-hidden="true" />
        <AnimatePresence initial={false}>
          <motion.div key={contentKey} className="island-content" style={{ width: target.w, height: target.h }} initial={enter.initial} animate={enter.animate} exit={enter.exit}>
            {expanded ? <Panel /> : <CompactContent view={view} reduced={reduced} hovered={opened} sliver={sliver} mediaOpen={playerOpen} />}
          </motion.div>
        </AnimatePresence>
        {wakeOn && !expanded && <span className="wake-dot" role="img" aria-label="Listening for a wake word" title="Listening for a wake word" />}
        {snapshot.recording && !expanded && view !== "note" && <span className="note-dot" role="img" aria-label="Recording" title="Recording" />}
      </motion.div>
    </motion.div>
  );
}
