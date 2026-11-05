// A pill that opens a list, in place of the system's dropdown, which cannot be styled and
// opens as a white box outside the island.

import { spring } from "@meridian/design-system/motion";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../lib/icons";

export interface MenuItem {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

/** Past this many rows a list gets a search box. OpenRouter alone has hundreds. */
const SEARCH_FROM = 10;
/** Kept clear at the foot of the panel, where the page fades out under the dock. */
const DOCK_ROOM = 110;

export function Menu({ label, value, items, empty, onPick }: { label: string; value: string; items: MenuItem[]; empty: string; onPick: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [up, setUp] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const shown = items.filter((i) => i.label.toLowerCase().includes(query.trim().toLowerCase()));
  const current = items.find((i) => i.value === value);

  // Measured before it paints, so a list that has no room below never shows there first.
  useLayoutEffect(() => {
    if (!open) return;
    const floor = root.current!.closest(".panel")?.getBoundingClientRect().bottom ?? innerHeight;
    setUp(button.current!.getBoundingClientRect().bottom + list.current!.offsetHeight + DOCK_ROOM > floor);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[aria-checked="true"], [role="menuitemradio"]')?.focus();
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery("");
    button.current?.focus();
  };

  const keys = (e: React.KeyboardEvent) => {
    // Shut, it leaves the keys alone, so Escape still closes the panel from the pill.
    if (!open) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    rows[(at + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length]?.focus();
  };

  return (
    <div className="menu-root" ref={root} onKeyDown={keys}>
      <button ref={button} type="button" className="pill-button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {current?.icon}
        <span className="truncate">{current?.label ?? empty}</span>
        <span className="pill-chevron"><Icon name="chevron" size={11} /></span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            ref={list}
            className="menu"
            data-up={up}
            role="menu"
            aria-label={label}
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={spring.snap}
          >
            {items.length > SEARCH_FROM && (
              <input aria-label={`Search ${label.toLowerCase()}`} placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
            )}
            {shown.map((item) => (
              <button
                key={item.value}
                type="button"
                role="menuitemradio"
                aria-checked={item.value === value}
                className="menu-row"
                onClick={() => {
                  close();
                  onPick(item.value);
                }}
              >
                {item.icon}
                <span className="truncate grow">{item.label}</span>
                {item.value === value && <Icon name="check" size={13} />}
              </button>
            ))}
            {shown.length === 0 && <p className="meta menu-none">{empty}</p>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
