// The island: one shape that morphs, hanging from the top edge of the screen like
// a notch, or floating wherever it was dragged. Width, height and radius are spring-driven motion values, so an
// interrupted transition keeps its velocity instead of restarting, and nothing
// inside re-renders per frame.

import { CLOSE_REST, closing, contentEnter, contentEnterReduced, instant, scaled, spring, type SpringName } from "@meridian/design-system/motion";
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import { lastMessage, stepLog } from "../lib/sessions";
import { blurOn, watchFrames } from "../lib/frames";
import { feel, openPanel, planUse, reportView, togglePanel, useApp } from "../lib/store";
import { Capsule, Panel } from "../panel/Panel";
import { Face, useReduced } from "./faces";
import { activeSessions, deriveView, geometryFor, stateToken, waitingApproval, type IslandView, type Snapshot } from "./machine";
import { notchPath, pillPath, pillRadius } from "./notch";
import {
  Bubble,
  ClosingLine,
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
import { AskView, HereView } from "./here";
import { FinishView } from "./finish";
import { answerLines, type AskState } from "../lib/ask";
import type { HereState } from "../lib/here";
import { finishGeometry, type FinishState } from "../lib/finish";
import { listRows } from "../lib/form";
import "./stages.css";

/** A press that moves this far, in CSS pixels, is a drag and not a click. */
const DRAG_PX = 6;
/** What the shape grows out of when the app starts: a dot at the screen's edge. */
const BIRTH = { w: 18, h: 4 };
/** About what fits on one line of the voice view. */
const VOICE_LINE = 52;
/** Views with a light running round the edge, because something is under way. */
const LIT: ReadonlySet<IslandView> = new Set(["listening", "thinking", "working", "multitask", "error", "notification"]);
/** The light runs one lap as something starts, then one this often while it lasts. The rim stays lit. */
const LAP_EVERY: Partial<Record<IslandView, number>> = { listening: 8000, thinking: 8000, working: 15_000, multitask: 15_000 };
/** A request waiting for an answer taps a little more often. */
const LAP_WAITING = 12_000;
const LAP_MS: Partial<Record<IslandView, number>> = { thinking: 1800, notification: 1600, error: 1600 };
/** Where the face sits in the panel's head: the head's left padding, and its height (styles.css, .panel-head). */
const HEAD_PAD = 18;
const HEAD_H = 52;
/** Held, the face stays lifted for as long as the drag lasts. Let go, it squashes and settles. */
const DRAG_HOLD_MS = 10 * 60_000;
const DROP_MS = 550;

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
  const here = useApp((s) => s.here !== null);
  const asking = useApp((s) => s.ask !== null);
  const finish = useApp((s) => s.finish !== null);
  return useMemo(
    () => ({ panelOpen, listening, capturing, mediaPlaying, chatPending, sessions, notices, suggestions, errors, live, level, voice, recording, writingNote, here, asking, finish }),
    [panelOpen, listening, capturing, mediaPlaying, chatPending, sessions, notices, suggestions, errors, live, level, voice, recording, writingNote, here, asking, finish],
  );
}

function CompactContent({ view, reduced, hovered, sliver, mediaOpen, here, ask, finish }: { view: IslandView; reduced: boolean; hovered: boolean; sliver: boolean; mediaOpen: boolean; here: HereState | null; ask: AskState | null; finish: FinishState | null }) {
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
      return <NotificationView reduced={reduced} hovered={hovered} />;
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
    case "here":
      return <HereView here={here} reduced={reduced} hovered={hovered} />;
    case "ask":
      return <AskView ask={ask} reduced={reduced} />;
    case "finish":
      return <FinishView finish={finish} reduced={reduced} />;
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
  const onboarded = useApp((s) => s.settings.onboarded);
  const faceId = useApp((s) => s.settings.face);
  const feeling = useApp((s) => s.feeling);
  const mediaOpen = useApp((s) => s.mediaOpen);
  const greeting = useApp((s) => s.greeting);
  const artTint = useApp((s) => s.artTint);
  const wakeOn = useApp((s) => s.wake.state === "listening");
  const battery = useApp((s) => s.level?.kind === "battery");
  const charged = useApp((s) => s.settings.showBattery && s.charge !== null);
  const usage = useApp((s) => s.settings.showUsage && planUse(s) !== null);
  const voiceLong = useApp((s) => ((s.voice?.words.length ?? 0) + (s.voice?.ahead.length ?? 0)) > VOICE_LINE);
  const stagesOpen = useApp((s) => s.stagesOpen);
  const here = useApp((s) => s.here);
  const ask = useApp((s) => s.ask);
  const hereStep = here?.step;
  const askPhase = ask?.phase;
  const finish = useApp((s) => s.finish);
  const askLines = answerLines(ask?.answer ?? "");
  const finished = useApp((s) => {
    const notice = s.notices[0];
    const session = notice?.finished ? s.sessions.find((x) => x.id === notice.sessionId) : undefined;
    return session ? (lastMessage(session) ? "message" : "brief") : undefined;
  });
  // The steps of the session on show, finished or at work, for the room its step log needs.
  const steps = useApp((s) => {
    const notice = s.notices[0];
    const session = notice?.finished ? s.sessions.find((x) => x.id === notice.sessionId) : waitingApproval(s.sessions) ?? activeSessions(s.sessions)[0];
    return session ? stepLog(session, Date.now()).length : 0;
  });
  const view = deriveView(snapshot);
  const waiting = waitingApproval(snapshot.sessions);
  const active = activeSessions(snapshot.sessions);
  const opened = hovered || (view === "working" && stagesOpen);
  const playerOpen = mediaOpen || hovered;

  useEffect(() => reportView(view), [view]);
  // One switch for reduced motion, from the app's setting and Windows', for every style to follow.
  useEffect(() => void document.documentElement.toggleAttribute("data-reduced", reduced), [reduced]);

  // The core says how far to lean while the island is dragged, from how fast it moves.
  useEffect(() => {
    const un = bridge.onLean((degrees) => el.current?.style.setProperty("--lean", String(reduced ? 0 : degrees)));
    return () => void un.then((stop) => stop());
  }, [reduced]);

  const target = geometryFor(view, {
    hovered: opened,
    rows: active.length,
    todos: active[0]?.todos?.length,
    finished,
    steps,
    stopped: snapshot.sessions.some((s) => s.id === snapshot.errors[0]?.sessionId),
    approval: waiting !== null,
    asking: waiting?.approval,
    clock,
    charge: charged,
    usage,
    sliver,
    actions: (snapshot.notices[0]?.actions?.length ?? 0) > 0 || snapshot.notices[0]?.eventId !== undefined,
    // Before set-up the panel is the welcome, which has its own size and no tabs.
    tab: onboarded ? tab : "welcome",
    mediaOpen: playerOpen,
    battery,
    voiceLong,
    greeting,
    liveRich: Boolean(snapshot.live[0]?.route || snapshot.live[0]?.steps),
    noteWriting: !snapshot.recording,
    noteReady: snapshot.notices[0]?.note !== undefined,
    noteFailed: snapshot.errors[0]?.note !== undefined,
    cards: snapshot.notices[0]?.cards?.length,
    here: hereStep,
    formRows: here?.step === "list" && here.form ? listRows(here.form, here.all ?? false) : undefined,
    ask: askPhase ? { phase: askPhase, lines: askLines } : undefined,
    finish: finish ? finishGeometry(finish) : undefined,
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
  const comet = useRef<SVGPathElement | null>(null);
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    const push = () => {
      frame = 0;
      const box = el.current?.getBoundingClientRect();
      if (!box) return;
      // The tab capsule floats outside the shape, and the pointer has to reach it too.
      const cap = el.current?.querySelector(".capsule")?.getBoundingClientRect();
      const x = Math.min(box.left, cap?.left ?? box.left);
      const y = Math.min(box.top, cap?.top ?? box.top);
      const right = Math.max(box.right, cap?.right ?? box.right);
      const bottom = Math.max(box.bottom, cap?.bottom ?? box.bottom);
      void bridge.setIslandRect({ x, y, w: right - x, h: bottom - y });
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

  // Which spring moves the shape, so the content can wait for it. The resting pill swells under the pointer with a
  // small wobble; everything else grows on the opening spring.
  const settling = view === "idle" && hovered;
  const shapeSpring: SpringName = target.w * target.h > width.get() * height.get() ? (settling ? "wobble" : "grow") : hovered ? "snap" : "shrink";
  // A card or the panel closing goes back up into the resting pill, floating or not, instead of fading where it is.
  const resting = view === "idle" && !opened;
  const pullsBack = resting && target.w * target.h < width.get() * height.get();
  useEffect(() => {
    const grows = target.w * target.h > width.get() * height.get();
    if (!reduced && !grows && resting) {
      const pull = closing(speed);
      const controls = [animate(width, target.w, pull.width), animate(height, target.h, pull.height), animate(radius, target.r, pull.height)];
      return () => controls.forEach((c) => c.stop());
    }
    const transition = reduced ? instant : scaled(grows ? (settling ? spring.wobble : spring.grow) : hovered ? spring.snap : spring.shrink, speed);
    const controls = [
      animate(width, target.w, transition),
      animate(height, target.h, transition),
      animate(radius, target.r, transition),
    ];
    return () => controls.forEach((c) => c.stop());
  }, [target.w, target.h, target.r, reduced, hovered, settling, resting, speed, width, height, radius]);

  const blur = !reduced && blurOn();
  const enter = reduced ? contentEnterReduced : contentEnter(shapeSpring, speed, place === "up", pullsBack ? CLOSE_REST : undefined, blur);
  const expanded = view === "expanded";
  const withTabs = expanded && onboarded;

  // The face rides the shape's left edge from where it was in the island out to the panel's head, so it is carried by
  // the morph and never slides across the title, and back in on the way out. The head keeps an empty slot for it
  // (Panel.tsx); only the small step between the two spots is animated here.
  const rideX = useMotionValue(0);
  const rideY = useMotionValue(0);
  const cameFrom = useRef<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!expanded) return;
    const box = el.current?.getBoundingClientRect();
    const was = el.current?.querySelector(".island-content:not([data-panel]) .face")?.getBoundingClientRect();
    if (!box || !was || reduced) {
      cameFrom.current = null;
      rideX.jump(0);
      rideY.jump(0);
      return;
    }
    const from = { x: was.left - box.left - HEAD_PAD, y: was.top - box.top - (HEAD_H - was.height) / 2 };
    cameFrom.current = from;
    // jump, not set: set would count the step as speed, and the spring would fling the face the wrong way first.
    rideX.jump(from.x);
    rideY.jump(from.y);
    const go = scaled(spring.grow, speed);
    const controls = [animate(rideX, 0, go), animate(rideY, 0, go)];
    return () => controls.forEach((c) => c.stop());
    // Only as the panel opens: on a tab change the slot moves with the shape.
  }, [expanded]); // eslint-disable-line react-hooks/exhaustive-deps
  const back = cameFrom.current;
  const rideOut = closing(speed);

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
    feel("drag", DRAG_HOLD_MS);
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
    el.current?.style.setProperty("--lean", "0");
    feel("drag", 0);
    if (!reduced) {
      const faces = el.current?.querySelectorAll<HTMLElement>(".face") ?? [];
      faces.forEach((face) => (face.dataset.dropped = ""));
      setTimeout(() => faces.forEach((face) => delete face.dataset.dropped), DROP_MS);
    }
  };
  const lit = LIT.has(view);
  const lapMs = (LAP_MS[view] ?? 2400) / speed;
  const lapEvery = view === "working" && waiting !== null ? LAP_WAITING : LAP_EVERY[view];

  // Laps of light, not a loop: one that ran for as long as an approval waited would redraw the
  // whole window for all of that time.
  useEffect(() => {
    const path = comet.current;
    if (!path || !lit || reduced) return;
    const lap = (laps: number) => path.animate([{ strokeDashoffset: 0.22 }, { strokeDashoffset: -1 }], { duration: lapMs, iterations: laps });
    lap(1);
    const timer = lapEvery ? setInterval(() => lap(1), lapEvery) : undefined;
    return () => {
      clearInterval(timer);
      path.getAnimations().forEach((a) => a.cancel());
    };
  }, [lit, reduced, view, lapMs, lapEvery]);
  // The open panel glows in the colour of what is under way: an agent waiting for you, or at work.
  const panelTone = expanded ? (waiting ? "--state-waiting" : active.length > 0 ? "--state-working" : null) : null;
  const glowing = lit || panelTone !== null;
  const glow = view === "media" ? artTint ?? "#ff7a9c" : `var(${panelTone ?? stateToken(view, snapshot)})`;
  // A waiting request looks the same either way, and swapping it would lose the answers so far.
  const opensOnHover =
    view === "idle" ||
    view === "live" ||
    view === "note" ||
    (view === "working" && waiting === null) ||
    (view === "notification" && snapshot.notices[0]?.cards !== undefined) ||
    // A filled form waits as a small pill, and opens to its line with Undo.
    (view === "here" && hereStep === "filled");
  const contentKey = expanded
    ? "panel"
    : view + (opened && opensOnHover ? "-hover" : "") + (view === "media" && playerOpen ? "-open" : "") + (view === "here" ? `-${hereStep}` : view === "ask" ? `-${askPhase}` : view === "finish" ? `-${finish?.phase}-${finish?.ask?.id ?? finish?.end?.kind ?? finish?.card?.kind ?? ""}` : "");

  // A blurred entrance is watched, and the blur goes for the session if it costs frames.
  useEffect(() => {
    if (blur) watchFrames(500 / speed);
  }, [contentKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <motion.div
      ref={el}
      className="island"
      data-view={view}
      data-align={align}
      data-place={place}
      data-dragging={dragging || undefined}
      data-small={target.h < 12}
      data-glowing={glowing || undefined}
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
      <motion.span className="island-glow" aria-hidden="true" style={{ borderBottomLeftRadius: corner, borderBottomRightRadius: corner, borderTopLeftRadius: topCorner, borderTopRightRadius: topCorner }} />
      <svg className="island-body" aria-hidden="true">
        <motion.path d={outline} />
      </svg>
      {lit && (
        <svg className="island-light" aria-hidden="true">
          <motion.path className="island-rim" d={outline} />
          {/* Measured as 1 long, so the dash in the styles is a share of the outline at any size. */}
          {!reduced && (
            <motion.path
              className="island-comet"
              d={outline}
              ref={(path: SVGPathElement | null) => {
                comet.current = path;
                path?.setAttribute("pathLength", "1");
              }}
            />
          )}
        </svg>
      )}
      <Bubble />
      <motion.div className="island-shape" style={{ borderBottomLeftRadius: corner, borderBottomRightRadius: corner, borderTopLeftRadius: topCorner, borderTopRightRadius: topCorner }}>
        <span className="island-tint" aria-hidden="true" />
        <AnimatePresence initial={false}>
          <motion.div key={contentKey} className="island-content" data-panel={expanded || undefined} style={{ width: target.w, height: target.h, transformOrigin: place === "up" ? "50% 100%" : "50% 0" }} initial={enter.initial} animate={enter.animate} exit={enter.exit}>
            {expanded ? <Panel /> : <CompactContent view={view} reduced={reduced} hovered={opened} sliver={sliver} mediaOpen={playerOpen} here={here} ask={ask} finish={finish} />}
          </motion.div>
        </AnimatePresence>
        <AnimatePresence>
          {expanded && (
            <motion.span
              key="riding"
              className="riding-face"
              style={{ left: HEAD_PAD, height: HEAD_H, x: rideX, y: rideY }}
              exit={back && !reduced ? { x: back.x, y: back.y, opacity: [1, 1, 0], transition: { ...rideOut.width, opacity: { duration: 0.32 / speed, times: [0, 0.8, 1] } } } : { opacity: 0, transition: { duration: 0.09 / speed } }}
            >
              <Face id={faceId} mood={feeling ?? "rest"} reduced={reduced} />
            </motion.span>
          )}
        </AnimatePresence>
        {!expanded && <ClosingLine view={view} />}
        {wakeOn && !expanded && <span className="wake-dot" role="img" aria-label="Listening for a wake word" title="Listening for a wake word" />}
        {snapshot.recording && !expanded && view !== "note" && <span className="note-dot" role="img" aria-label="Recording" title="Recording" />}
      </motion.div>
      {/* The tabs float outside the shape so it does not clip them: under the panel, or above it at the bottom of the screen. */}
      <AnimatePresence>
        {withTabs && (
          <motion.div
            key="capsule"
            className="capsule"
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: place === "up" ? 8 : -8, ...(blur ? { filter: "blur(6px)" } : {}) }}
            animate={{ opacity: 1, scale: 1, y: 0, ...(blur ? { filter: "blur(0px)" } : {}), transition: { duration: 0.26 / speed, delay: reduced ? 0 : 0.12 / speed, ease: [0.16, 1, 0.3, 1] } }}
            exit={{ opacity: 0, transition: { duration: 0.09 / speed, ease: [0.4, 0, 1, 1] } }}
          >
            <Capsule />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
