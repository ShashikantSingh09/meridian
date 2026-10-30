import { spring } from "@meridian/design-system/motion";
import { motion } from "motion/react";
import { useEffect } from "react";
import { Icon, type IconName } from "../lib/icons";
import { closePanel, setTab, useApp, type Tab } from "../lib/store";
import { Agents } from "./Agents";
import { Chat } from "./Chat";
import { Desktop } from "./Desktop";
import { Home } from "./Home";
import { Inbox } from "./Inbox";
import { Media } from "./Media";
import { MyDay } from "./MyDay";
import { SettingsPage } from "./Settings";
import { Welcome } from "./Welcome";

const NAV: { tab: Tab; icon: IconName; label: string }[] = [
  { tab: "home", icon: "home", label: "Command center" },
  { tab: "chat", icon: "chat", label: "Chat" },
  { tab: "agents", icon: "agents", label: "Agents" },
  { tab: "desktop", icon: "eye", label: "Desktop awareness" },
  { tab: "media", icon: "music", label: "Media" },
  { tab: "day", icon: "calendar", label: "My day" },
  { tab: "inbox", icon: "bell", label: "Notifications" },
  { tab: "settings", icon: "settings", label: "Settings" },
];

const PAGES: Record<Tab, () => React.JSX.Element> = {
  home: Home,
  chat: Chat,
  agents: Agents,
  desktop: Desktop,
  media: Media,
  day: MyDay,
  inbox: Inbox,
  settings: SettingsPage,
};

export function Panel() {
  const tab = useApp((s) => s.tab);
  const running = useApp((s) => s.sessions.filter((x) => x.status === "running" || x.status === "waiting").length);
  const onboarded = useApp((s) => s.settings.onboarded);
  const Page = onboarded ? PAGES[tab] : Welcome;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="panel">
      <nav className="topnav" aria-label="Sections">
        {onboarded && NAV.map((n) => (
          <button
            key={n.tab}
            className="topnav-item"
            aria-label={n.label}
            title={n.label}
            aria-current={tab === n.tab ? "page" : undefined}
            onClick={() => setTab(n.tab)}
          >
            {tab === n.tab && <motion.span layoutId="topnav-pill" className="topnav-pill" transition={spring.hover} />}
            <Icon name={n.icon} size={18} />
            {n.tab === "agents" && running > 0 && <span className="badge tabular">{running}</span>}
          </button>
        ))}
        <button className="round topnav-close" aria-label="Close" title="Close (Esc)" onClick={closePanel}>
          <Icon name="close" size={15} />
        </button>
      </nav>
      <motion.main key={onboarded ? tab : "welcome"} className="page" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.14 }}>
        <Page />
      </motion.main>
    </div>
  );
}
