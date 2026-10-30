import { spring } from "@meridian/design-system/motion";
import { motion } from "motion/react";
import { useEffect } from "react";
import { Face } from "../island/faces";
import { Clock, greetingWord } from "../island/views";
import { Icon, type IconName } from "../lib/icons";
import { closePanel, setTab, useApp, type Tab } from "../lib/store";
import { Agents } from "./Agents";
import { Chat } from "./Chat";
import { Home } from "./Home";
import { Inbox } from "./Inbox";
import { Media } from "./Media";
import { MyDay } from "./MyDay";
import { SettingsPage } from "./Settings";
import { Welcome } from "./Welcome";

const NAV: { tab: Tab; icon: IconName; label: string }[] = [
  { tab: "home", icon: "home", label: "Home" },
  { tab: "chat", icon: "chat", label: "Chat" },
  { tab: "agents", icon: "agents", label: "Agents" },
  { tab: "media", icon: "music", label: "Media" },
  { tab: "day", icon: "calendar", label: "My day" },
  { tab: "inbox", icon: "bell", label: "Notifications" },
  { tab: "settings", icon: "settings", label: "Settings" },
];

const PAGES: Record<Tab, () => React.JSX.Element> = {
  home: Home,
  chat: Chat,
  agents: Agents,
  media: Media,
  day: MyDay,
  inbox: Inbox,
  settings: SettingsPage,
};

export function Panel() {
  const tab = useApp((s) => s.tab);
  const face = useApp((s) => s.settings.face);
  const feeling = useApp((s) => s.feeling);
  const running = useApp((s) => s.sessions.filter((x) => x.status === "running" || x.status === "waiting").length);
  const onboarded = useApp((s) => s.settings.onboarded);
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
        <Face id={face} mood={feeling ?? "rest"} scale={0.62} />
        <h1 className="grow truncate">{title}</h1>
        <span className="meta">{date}</span>
        <Clock className="panel-time tabular" />
        <button className="round" aria-label="Close" title="Close (Esc)" onClick={closePanel}>
          <Icon name="close" size={15} />
        </button>
      </header>
      <motion.main key={onboarded ? tab : "welcome"} className="page" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}>
        <Page />
      </motion.main>
      {onboarded && (
        <nav className="dock" aria-label="Sections">
          {NAV.map((n) => (
            <button key={n.tab} className="dock-item" aria-label={n.label} title={n.label} aria-current={tab === n.tab ? "page" : undefined} onClick={() => setTab(n.tab)}>
              {tab === n.tab && <motion.span layoutId="dock-pill" className="dock-pill" transition={spring.hover} />}
              <Icon name={n.icon} size={19} />
              {n.tab === "agents" && running > 0 && <span className="badge tabular">{running}</span>}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
