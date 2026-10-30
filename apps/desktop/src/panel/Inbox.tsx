import { useEffect } from "react";
import { describeTime, refreshActivity, updateSettings, useApp } from "../lib/store";
import type { ActivityPreferences, Category, ReminderLogEntry } from "../lib/types";

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

const placeText = { surfaced: "Shown on the island", centre: "Kept here", held: "Held back" };

export function Inbox() {
  const { log, events } = useApp((s) => s.activity);
  const preferences = useApp((s) => s.settings.activity);

  useEffect(() => {
    void refreshActivity();
    // Each visit reads the current log.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = (patch: Partial<ActivityPreferences>) => void updateSettings({ activity: { ...preferences, ...patch } });
  const titleOf = (id: string) => events.find((e) => e.id === id)?.title ?? "Item no longer listed";
  const recent = log.slice().reverse().slice(0, 40);

  return (
    <div className="page-scroll stack-lg">
      <h1>Notifications</h1>

      <section className="stack">
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
        <label className="setting toggle">
          <span className="stacked grow">
            <span className="label">Quiet hours</span>
            <span className="meta">10 pm to 7 am. Only critical reminders get through.</span>
          </span>
          <input type="checkbox" role="switch" aria-label="Quiet hours" checked={preferences.quietHours !== null} onChange={(e) => save({ quietHours: e.target.checked ? QUIET : null })} />
        </label>
      </section>

      <section className="stack-sm">
        <h2>History</h2>
        {recent.length === 0 ? (
          <p className="meta">Reminders appear here once they have been decided on.</p>
        ) : (
          <ul className="list">
            {recent.map((entry) => (
              <li key={entry.key} className="list-row">
                <span className="label truncate">{titleOf(entry.eventId)}</span>
                <span className="meta grow truncate">{stageText(entry)}{entry.startsAt ? ` · ${describeTime(entry.startsAt)}` : ""}</span>
                <span className="meta">{placeText[entry.disposition]}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
