// Which theme is showing right now, from the user's choice, Windows and the hour.

import type { CustomTheme, Settings } from "./types";

export const THEMES = [
  { id: "midnight", name: "Midnight", note: "Dark glass", top: "#0b0c14", low: "#10111c", accent: "#2a84ea", light: false },
  { id: "daylight", name: "Daylight", note: "Light glass", top: "#e6e9ef", low: "#f1f3f7", accent: "#2a84ea", light: true },
  { id: "graphite", name: "Graphite", note: "Quiet and neutral", top: "#1b1c1f", low: "#26272b", accent: "#c8ccd4", light: false },
  { id: "ocean", name: "Ocean", note: "Deep teal", top: "#05202e", low: "#062a3a", accent: "#17a2b8", light: false },
  { id: "rose", name: "Rose", note: "Warm and soft", top: "#240d19", low: "#2e1020", accent: "#e0527c", light: false },
  { id: "solid", name: "Solid", note: "No glass, easiest to read", top: "#111216", low: "#17181d", accent: "#2a84ea", light: false },
] as const;

const DAY_STARTS = 7;
const NIGHT_STARTS = 19;

/** The id of the theme to show. */
export function activeTheme(s: Pick<Settings, "theme" | "themeUse" | "themeDark" | "themeLight">, windowsDark: boolean, hour: number): string {
  if (s.themeUse === "windows") return windowsDark ? s.themeDark : s.themeLight;
  if (s.themeUse === "time") return hour >= DAY_STARTS && hour < NIGHT_STARTS ? s.themeLight : s.themeDark;
  return s.theme;
}

const shown = (s: Settings) => activeTheme(s, matchMedia("(prefers-color-scheme: dark)").matches, new Date().getHours());

/** A colour with its alpha, for the light behind a custom theme's glass. */
const glow = (hex: string, alpha: number) => `${hex}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;

function paintCustom(root: HTMLElement, theme: CustomTheme | undefined) {
  for (const [name, value] of Object.entries({
    "--accent": theme?.accent,
    "--accent-shine": theme?.accent,
    "--sheet-top": theme?.window,
    "--sheet-low": theme?.window,
    "--glow-a": theme ? glow(theme.accent, 0.26) : undefined,
    "--glow-b": theme ? glow(theme.accent, 0.1) : undefined,
  })) {
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
}

export function applyTheme(s: Settings) {
  const root = document.documentElement;
  const id = shown(s);
  const custom = s.customThemes.find((t) => t.id === id);
  root.dataset.theme = custom ? (custom.light ? "daylight" : "midnight") : id;
  paintCustom(root, custom);
  root.style.setProperty("--glass-strength", String(0.55 + (s.glass / 100) * 0.45));
  root.style.fontSize = "";
}

/** Keeps a theme that follows Windows or the clock correct while the app stays open. */
export function watchTheme(settings: () => Settings) {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(settings()));
  setInterval(() => {
    if (settings().themeUse === "time") applyTheme(settings());
  }, 60_000);
}
