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
import { Providers } from "./Providers";
import { SettingsPage } from "./Settings";

const NAV: { tab: Tab; icon: IconName; label: string }[] = [
  { tab: "home", icon: "home", label: "Command center" },
  { tab: "chat", icon: "chat", label: "Chat" },
  { tab: "agents", icon: "agents", label: "Agents" },
  { tab: "desktop", icon: "eye", label: "Desktop awareness" },
  { tab: "media", icon: "music", label: "Media" },
  { tab: "day", icon: "calendar", label: "My day" },
  { tab: "inbox", icon: "bell", label: "Notifications" },
  { tab: "providers", icon: "providers", label: "Providers" },
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
  providers: Providers,
  settings: SettingsPage,
};

export function Panel() {
  const tab = useApp((s) => s.tab);
  const running = useApp((s) => s.sessions.filter((x) => x.status === "running" || x.status === "waiting").length);
  const Page = PAGES[tab];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="panel">
      <nav className="rail" aria-label="Sections">
        {NAV.map((n) => (
          <button
            key={n.tab}
            className="rail-item"
            aria-label={n.label}
            title={n.label}
            aria-current={tab === n.tab ? "page" : undefined}
            onClick={() => setTab(n.tab)}
          >
            <Icon name={n.icon} size={18} />
            {n.tab === "agents" && running > 0 && <span className="badge tabular">{running}</span>}
          </button>
        ))}
        <span className="grow" />
        <button className="rail-item" aria-label="Close" title="Close (Esc)" onClick={closePanel}>
          <Icon name="close" size={16} />
        </button>
      </nav>
      <main className="page">
        <Page />
      </main>
    </div>
  );
}
