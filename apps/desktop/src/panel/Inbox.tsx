import { useEffect } from "react";
import { Icon } from "../lib/icons";
import { describeTime, refreshActivity, updateSettings, useApp } from "../lib/store";
import type { ActivityPreferences, Category, ReminderLogEntry } from "../lib/types";
import { toneOf } from "./MyDay";

const KINDS: { value: Category; label: string }[] = [
  { value: "travel", label: "Travel" },
  { value: "meetings", label: "Meetings" },
  { value: "deliveries", label: "Deliveries" },
  { value: "orders", label: "Orders" },
  { value: "importantDates", label: "Important dates" },
];

const QUIET = { start: "22:00:00", end: "07:00:00" };

const stageText = (entry: ReminderLogEntry) => {
  const { stage } = entry;
  if (stage.type === "lead") return stage.minutes >= 60 ? `${Math.round(stage.minutes / 60)} h before` : `${stage.minutes} min before`;
  return stage.type === "changed" ? "Changed" : stage.type === "rescheduled" ? "Rescheduled" : "Cancelled";
};

const placeText = { surfaced: "On the island", centre: "Kept here", held: "Held back" };

export function Inbox() {
  const { log, all } = useApp((s) => s.activity);
  const preferences = useApp((s) => s.settings.activity);
  const sessions = useApp((s) => s.sessions);
  const past = useApp((s) => s.pastNotices);
  // Every reply in Chat is not news. The list is for work that went off and finished.
  const finished = past.filter((notice) => sessions.find((s) => s.id === notice.sessionId)?.surface !== "chat");

  useEffect(() => {
    void refreshActivity();
    // Each visit reads the current log.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = (patch: Partial<ActivityPreferences>) => void updateSettings({ activity: { ...preferences, ...patch } });
  const recent = log.slice().reverse().slice(0, 40);

  return (
    <div className="inbox-page board">
      <section className="plate inbox-rules">
        <h2>What reaches the island</h2>
        {KINDS.map((k) => {
          const current = preferences.categories[k.value];
          return (
            <label key={k.value} className="setting toggle">
              <span className="label grow">{k.label}</span>
              <input
                type="checkbox"
                role="switch"
                aria-label={k.label}
                checked={current?.enabled ?? true}
                onChange={(e) =>
                  save({ categories: { ...preferences.categories, [k.value]: { leadMinutes: current?.leadMinutes ?? [], enabled: e.target.checked } } })
                }
              />
            </label>
          );
        })}
        <label className="setting toggle inbox-quiet">
          <span className="stacked grow">
            <span className="label">Quiet hours</span>
            <span className="meta">10 pm to 7 am. Only critical reminders get through.</span>
          </span>
          <input type="checkbox" role="switch" aria-label="Quiet hours" checked={preferences.quietHours !== null} onChange={(e) => save({ quietHours: e.target.checked ? QUIET : null })} />
        </label>
      </section>

      <section className="plate inbox-history">
        <h2>History</h2>
        {recent.length === 0 && finished.length === 0 ? (
          <div className="page-rest">
            <Icon name="bell" size={34} />
            <p className="meta">Reminders appear here once they have been decided on.</p>
          </div>
        ) : (
          <ul className="list">
            {finished.map((notice) => (
              <li key={notice.id} className="inbox-entry" style={{ "--tone": notice.tone === "urgent" ? "var(--state-error)" : "var(--state-success)" } as React.CSSProperties}>
                <span className="grow stacked">
                  <span className="label truncate">{notice.title}</span>
                  <span className="meta truncate" title={notice.body}>{notice.body}</span>
                </span>
                <span className="flag">{notice.tone === "urgent" ? "Stopped" : "Finished"}</span>
              </li>
            ))}
            {recent.map((entry) => {
              const event = all.find((e) => e.id === entry.eventId);
              const held = entry.disposition === "held";
              return (
                <li key={entry.key} className="inbox-entry" style={{ "--tone": held || !event ? "var(--ink-3)" : toneOf(event.kind) } as React.CSSProperties}>
                  <span className="grow stacked">
                    <span className="label truncate">{event?.title ?? "Item no longer listed"}</span>
                    <span className="meta truncate">{stageText(entry)}{entry.startsAt ? `, ${describeTime(entry.startsAt)}` : ""}</span>
                  </span>
                  <span className="flag">{placeText[entry.disposition]}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
