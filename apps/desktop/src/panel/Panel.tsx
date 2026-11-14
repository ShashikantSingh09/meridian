import { contentEnterReduced, pageEnter } from "@meridian/design-system/motion";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import BlurText from "@/components/BlurText/BlurText";
import { useEffect, useRef, useState } from "react";
import { useReduced } from "../island/faces";
import { Clock, RecordingClock, greetingWord } from "../island/views";
import { blurOn, watchFrames } from "../lib/frames";
import { Icon, type IconName } from "../lib/icons";
import { closePanel, dismissError, setTab, useApp, type Tab } from "../lib/store";
import { Agents } from "./Agents";
import { Chat } from "./Chat";
import { Home } from "./Home";
import { Inbox } from "./Inbox";
import { Knowledge } from "./Knowledge";
import { Media } from "./Media";
import { MyDay } from "./MyDay";
import { Notes } from "./Notes";
import { SettingsPage } from "./Settings";
import { Welcome } from "./Welcome";
import "./pages.css";

const NAV: { tab: Tab; icon: IconName; label: string }[] = [
  { tab: "home", icon: "home", label: "Home" },
  { tab: "chat", icon: "chat", label: "Chat" },
  { tab: "agents", icon: "agents", label: "Agents" },
  { tab: "media", icon: "music", label: "Media" },
  { tab: "day", icon: "calendar", label: "My day" },
  { tab: "notes", icon: "note", label: "Notes" },
  { tab: "knowledge", icon: "book", label: "Knowledge" },
  { tab: "inbox", icon: "bell", label: "Notifications" },
  { tab: "settings", icon: "settings", label: "Settings" },
];

const PAGES: Record<Tab, () => React.JSX.Element> = {
  home: Home,
  chat: Chat,
  agents: Agents,
  media: Media,
  day: MyDay,
  notes: Notes,
  knowledge: Knowledge,
  inbox: Inbox,
  settings: SettingsPage,
};

/** The open panel covers the island, so what went wrong shows here until it is dismissed. */
function PanelError() {
  const error = useApp((s) => s.errors[0]);
  if (!error) return null;
  return (
    <div className="auth-banner" role="alert">
      <span className="grow meta bad clamp" title={error.body}>{error.title}. {error.body}</span>
      {error.retry && <button className="ghost" onClick={() => { const retry = error.retry; dismissError(error.id); retry?.(); }}>Retry</button>}
      <button className="round" aria-label="Dismiss" title="Dismiss" onClick={() => dismissError(error.id)}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

/** The tabs float in a capsule just outside the panel (D78). The open tab is a pill holding its name; the rest are
 *  icons. Island.tsx places it, so it can sit outside the shape that clips the panel. */
export function Capsule() {
  const tab = useApp((s) => s.tab);
  const running = useApp((s) => s.sessions.filter((x) => x.status === "running" || x.status === "waiting").length);
  const needs = useApp((s) => s.cards.cards.length);
  return (
    <nav className="dock" aria-label="Sections">
      {NAV.map((n) => (
        <button key={n.tab} className="dock-item" aria-label={n.label} title={n.label} aria-current={tab === n.tab ? "page" : undefined} onClick={() => setTab(n.tab)}>
          <Icon name={n.icon} size={18} />
          <span className="dock-label" aria-hidden="true">{n.label}</span>
          {n.tab === "agents" && running > 0 && <span className="badge tabular">{running}</span>}
          {n.tab === "day" && needs > 0 && <span className="badge tabular" aria-hidden="true">{needs}</span>}
        </button>
      ))}
    </nav>
  );
}

type Enter = ReturnType<typeof pageEnter> | typeof contentEnterReduced;

const GREETED = "meridian.greetedOn";

/** True for the first time the panel opens on a given day, so the greeting arrives word by word just once (D79). */
function useFirstToday() {
  const [first] = useState(() => {
    const today = new Date().toDateString();
    try {
      const seen = localStorage.getItem(GREETED);
      localStorage.setItem(GREETED, today);
      return seen !== today;
    } catch {
      return false;
    }
  });
  return first;
}

/** A page and its head. While it fades out under the next one it is out of reach: no focus, no clicks, and nothing
 *  read aloud, so there is only ever one page to use. The ref is AnimatePresence's, for popLayout. */
function PanelBody({ enter, children, ref }: { enter: Enter; children: React.ReactNode; ref?: React.Ref<HTMLDivElement> }) {
  const present = useIsPresent();
  return (
    <motion.div ref={ref} className="panel-body" style={{ transformOrigin: "50% 0" }} initial={enter.initial} animate={enter.animate} exit={enter.exit} aria-hidden={!present || undefined} inert={!present}>
      {children}
    </motion.div>
  );
}

export function Panel() {
  const tab = useApp((s) => s.tab);
  const onboarded = useApp((s) => s.settings.onboarded);
  const wakeOn = useApp((s) => s.wake.state === "listening");
  const recording = useApp((s) => s.notes.notes.find((n) => n.id === s.notes.recording));
  const speed = useApp((s) => s.settings.animationSpeed);
  const reduced = useReduced();
  const Page = onboarded ? PAGES[tab] : Welcome;
  const key = onboarded ? tab : "welcome";
  const title = !onboarded ? "Welcome" : tab === "home" ? greetingWord() : NAV.find((n) => n.tab === tab)?.label;
  const date = new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const blur = !reduced && blurOn();
  const firstToday = useFirstToday();
  const greet = firstToday && onboarded && tab === "home" && !reduced;
  const enter = reduced ? contentEnterReduced : pageEnter(speed, blur);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A blurred page is watched while it arrives, and the blur goes if it costs frames.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    if (blur) watchFrames(400 / speed);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // The old page and its head fade out in 90 ms as the new ones come out of the top edge, still blurred, so the panel
  // is never empty while the island reshapes to them. The face is not here: Island.tsx draws it, so it can ride up
  // from the resting pill.
  return (
    <div className="panel">
      <AnimatePresence mode="popLayout" initial={false}>
        <PanelBody key={key} enter={enter}>
          <header className="panel-head">
            <span className="face-slot" aria-hidden="true" />
            <h1 className="grow truncate">{greet ? <BlurText as="span" text={title} animateBy="words" trigger="load" delay={90} stepDuration={0.3} blur={8} distance={8} /> : title}</h1>
            {recording && <RecordingClock since={recording.startedAt} />}
            {wakeOn && <span className="wake-dot-head" role="img" aria-label="Listening for a wake word" title="Listening for a wake word" />}
            <span className="meta">{date}</span>
            <Clock className="panel-time tabular" />
            <button className="round" aria-label="Close" title="Close (Esc)" onClick={closePanel}>
              <Icon name="close" size={15} />
            </button>
          </header>
          <PanelError />
          <main className="page">
            <Page />
          </main>
        </PanelBody>
      </AnimatePresence>
    </div>
  );
}
