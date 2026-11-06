import { spring } from "@meridian/design-system/motion";
import { motion } from "motion/react";
import { useEffect } from "react";
import { Face } from "../island/faces";
import { Clock, RecordingClock, greetingWord } from "../island/views";
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

export function Panel() {
  const tab = useApp((s) => s.tab);
  const face = useApp((s) => s.settings.face);
  const feeling = useApp((s) => s.feeling);
  const running = useApp((s) => s.sessions.filter((x) => x.status === "running" || x.status === "waiting").length);
  const onboarded = useApp((s) => s.settings.onboarded);
  const wakeOn = useApp((s) => s.wake.state === "listening");
  const recording = useApp((s) => s.notes.notes.find((n) => n.id === s.notes.recording));
  const needs = useApp((s) => s.cards.cards.length);
  const Page = onboarded ? PAGES[tab] : Welcome;
  const title = !onboarded ? "Welcome" : tab === "home" ? greetingWord() : NAV.find((n) => n.tab === tab)?.label;
  const date = new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="panel">
      <header className="panel-head">
        <Face id={face} mood={feeling ?? "rest"} />
        <h1 className="grow truncate">{title}</h1>
        {recording && <RecordingClock since={recording.startedAt} />}
        {wakeOn && <span className="wake-dot-head" role="img" aria-label="Listening for a wake word" title="Listening for a wake word" />}
        <span className="meta">{date}</span>
        <Clock className="panel-time tabular" />
        <button className="round" aria-label="Close" title="Close (Esc)" onClick={closePanel}>
          <Icon name="close" size={15} />
        </button>
      </header>
      <PanelError />
      <motion.main key={onboarded ? tab : "welcome"} className="page" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}>
        <Page />
      </motion.main>
      {onboarded && (
        <nav className="dock" aria-label="Sections">
          {NAV.map((n) => (
            <button key={n.tab} className="dock-item" aria-label={n.label} title={n.label} aria-current={tab === n.tab ? "page" : undefined} onClick={() => setTab(n.tab)}>
              {tab === n.tab && <motion.span layoutId="dock-pill" className="dock-pill" transition={spring.snap} />}
              <Icon name={n.icon} size={19} />
              {n.tab === "agents" && running > 0 && <span className="badge tabular">{running}</span>}
              {n.tab === "day" && needs > 0 && <span className="badge tabular" aria-hidden="true">{needs}</span>}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
