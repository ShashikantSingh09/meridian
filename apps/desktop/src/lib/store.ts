// App state and the actions that change it. One store, read with useApp(selector).

import { useSyncExternalStore } from "react";
import { focusActivity, liveFrom, pickLive, type LiveActivity } from "../island/live";
import type { IslandError, IslandView, Notice, SessionSummary, Suggestion } from "../island/machine";
import { bridge, native, type StartSession, type UpdateStatus } from "./bridge";
import { chime } from "./sound";
import type {
  AgentEnvelope,
  AgentId,
  AgentInfo,
  Approval,
  AuthStatus,
  Capture,
  ChatMessage,
  ModelInfo,
  Category,
  ConnectedAccount,
  ContextEvent,
  Digest,
  EventTime,
  Integration,
  MediaAction,
  MediaSnapshot,
  ProviderInfo,
  Reminder,
  ReminderLogEntry,
  ScreenSuggestion,
  Settings,
  Track,
  Level,
  WakeStatus,
  LimitWindow,
  NotesState,
  Charge,
  IslandPlace,
} from "./types";
import type { Mood } from "../island/faces";
import type { VoiceState } from "./voice";
import { lastMessage, limitName, mergeTodo, resetLabel } from "./sessions";
import { applyTheme } from "./theme";
import { defaultSettings } from "./types";
import { whatsNew, type NewThing } from "./whats-new";

export type Tab = "home" | "chat" | "agents" | "media" | "day" | "notes" | "inbox" | "settings";
export type SettingsSection = "general" | "themes" | "island" | "assistant" | "voice" | "wake" | "screen" | "updates" | "models" | "providers" | "agents" | "privacy" | "about";

export interface LogEntry {
  kind: "user" | "text" | "activity" | "system" | "diff" | "output";
  text: string;
  /** When it happened. History saved before this was kept has none. */
  at?: number;
  /** For a diff: the lines taken out and put in, which are cut short, and how many there really were. */
  removed?: string[];
  added?: string[];
  linesRemoved?: number;
  linesAdded?: number;
  /** For a command: the end of what it printed. */
  lines?: string[];
  failed?: boolean;
}

export interface SessionDetail extends SessionSummary {
  agentId: AgentId;
  /** Where it lives in the interface: a conversation, or a task in Agents. */
  surface: "chat" | "agents";
  title: string;
  mode: AgentMode;
  cwd: string;
  prompt: string;
  model: string | null;
  endedAt: number | null;
  usage: { input: number; output: number; costUsd: number | null } | null;
  /** How full the conversation is, in tokens. */
  context?: { used: number | null; size: number | null };
  log: LogEntry[];
  /** When the latest turn began, once there has been more than one. */
  turnAt?: number;
  /** Approvals behind the one on screen. */
  queued: Approval[];
  /** Runs in the user's own terminal: it can be followed and answered, not steered. */
  watched?: boolean;
  /** The Claude Code process of a session in a terminal, to find its window. */
  pid?: number | null;
  /** From an earlier run of the app, so there is no process left to talk to. */
  restored?: boolean;
  /** The agent's own id for this conversation, which is what lets it carry on after a restart. */
  nativeId?: string | null;
}

export interface ChatState {
  messages: ChatMessage[];
  requestId: string | null;
  providerId: string | null;
  model: string | null;
  models: ModelInfo[];
  usage: { input: number; output: number } | null;
  /** A few words of what is being asked, for the island. */
  task: string;
}

export type AgentMode = "general" | "project";

/** A coding agent selected as the chat engine. Separate from API conversations. */
export interface AgentChat {
  agent: AgentId | null;
  mode: AgentMode;
  cwd: string | null;
  sessionId: string | null;
}

export interface ScreenState {
  capture: Capture | null;
  capturing: boolean;
  includeImage: boolean;
  /** Why the last capture did not happen, shown where it was asked for. */
  refused: string | null;
}

export interface MediaState extends MediaSnapshot {
  /** When the position was reported, to run the clock on from. */
  reportedAt: number;
  recent: Track[];
}

export interface ActivityState {
  category: Category;
  events: ContextEvent[];
  accounts: ConnectedAccount[];
  log: ReminderLogEntry[];
  /** The next meeting, for the island. */
  next: ContextEvent | null;
  /** Everything current, which is what live activities come from. */
  all: ContextEvent[];
  /** Gmail read through the Claude account, for a PC with no Google sign-in. */
  claudeMail: { reading: boolean; said: string; failed: boolean; at: number };
}

export interface AppState {
  panelOpen: boolean;
  activity: ActivityState;
  screen: ScreenState;
  media: MediaState;
  tab: Tab;
  settingsSection: SettingsSection;
  listening: boolean;
  hovered: boolean;
  /** Cards that close by themselves, by id, and when they close. Set for the last 5 s, when a line shows it. */
  closing: Record<string, number>;
  chatPending: boolean;
  sessions: SessionDetail[];
  /** What each agent last said about the user's plan, kept across restarts. */
  limits: Partial<Record<AgentId, { windows: LimitWindow[]; at: number }>>;
  notices: Notice[];
  /** Finished cards that have left the island, newest first, for Notifications. In memory only. */
  pastNotices: Notice[];
  /** The stage card was clicked open. */
  stagesOpen: boolean;
  /** The session and view to land on when Agents next opens. */
  agentFocus: { id: string; view: "activity" | "changes" } | null;
  suggestions: Suggestion[];
  errors: IslandError[];
  settings: Settings;
  providers: ProviderInfo[];
  /** Local providers whose server answered the last probe. */
  localOnline: string[];
  agents: AgentInfo[];
  auth: Partial<Record<AgentId, AuthStatus>>;
  chat: ChatState;
  agentChat: AgentChat;
  monitors: string[];
  preview: string | null;
  integrations: Integration[];
  notes: NotesState;
  /** The note open in Notes, until another is picked. */
  selectedNote: string | null;
  /** Google and Microsoft sign-in work with no registration of the user's own. */
  builtInClients: [boolean, boolean];
  digests: Record<string, Digest>;
  fetching: string[];
  fetchErrors: Record<string, string>;
  /** Things under way, most pressing first. */
  live: LiveActivity[];
  focus: { endsAt: number; minutes: number } | null;
  /** The compact player was clicked open. */
  mediaOpen: boolean;
  /** Says hello for a moment after the app starts. */
  greeting: boolean;
  /** How the face feels about something that just happened. It passes. */
  feeling: Mood | null;
  /** A spoken conversation, while there is one. */
  voice: VoiceState | null;
  wake: WakeStatus;
  wakeTest: { phase: "idle" | "waiting" | "heard" | "missed"; word: string };
  /** The volume, brightness or battery, for a moment after it changes. */
  level: Level | null;
  /** The last one of the same kind, so a key press can be told up from down. */
  levelBefore: Level | null;
  /** A laptop's charge, kept current for the island at rest. Nothing on a PC with no battery. */
  charge: Charge | null;
  /** The notch, or floating where it was dragged. */
  islandPlace: IslandPlace;
  /** The colour of the album, to light the island with. */
  artTint: string | null;
  islandView: IslandView;
  /** Claude Code hooks are installed, so its sessions appear here. */
  watching: boolean;
  version: string;
  update: UpdateStatus;
  /** What the update is doing. Here, because the panel can close while it runs. */
  updating: "checking" | "installing" | null;
  /** How this copy was installed. A portable copy is sent to the release page instead of updating. */
  updateKind: "setup" | "msi" | "portable";
  /** What changed in this version, shown once after an update. */
  whatsNew: NewThing[];
  /** Sign-ins under way. Each opens a browser, which closes the panel. */
  signingIn: string[];
  /** The message being written, kept while the panel is closed or on another page. */
  draft: string;
  draftFiles: string[];
}

const LOG_LIMIT = 500;
const NOTICE_MS = 6000;
const FINISHED_MS = 12_000;
const ERROR_MS = 15_000;
const SUGGESTION_MS = 20_000;
/** Something urgent stays longest, and is still in My day after it goes. */
const URGENT_MS = 60_000;
/** A pointer can rest on the island with nobody reading, so holding something open has a limit. */
const LONGEST_HOLD_MS = 20_000;
const PAST_NOTICES = 40;
const GREETING_MS = 2600;
/** A little longer than the core listens, so a late match still lands. */
const HOVER_IN_MS = 180;
const HOVER_OUT_MS = 240;
const WAKE_TEST_MS = 11_000;
const ANSWER_GAP_MS = 400;
const SIGN_IN_POLLS = 60;
const SIGN_IN_POLL_MS = 2000;
/** A click on the tray icon blurs the panel on the way down, then toggles it on the way up. */
const TOGGLE_AFTER_BLUR_MS = 300;
/** Sample data shows for this long, then the real state comes back by itself. */
const PREVIEW_MS = 8000;

let state: AppState = {
  panelOpen: false,
  activity: { category: "today", events: [], accounts: [], log: [], next: null, all: [], claudeMail: { reading: false, said: "", failed: false, at: 0 } },
  media: { current: null, sessions: [], reportedAt: 0, recent: [] },
  screen: { capture: null, capturing: false, includeImage: true, refused: null },
  tab: "home",
  settingsSection: "general",
  listening: false,
  hovered: false,
  closing: {},
  chatPending: false,
  sessions: [],
  limits: {},
  notices: [],
  pastNotices: [],
  stagesOpen: false,
  agentFocus: null,
  suggestions: [],
  errors: [],
  settings: defaultSettings,
  providers: [],
  localOnline: [],
  agents: [],
  auth: {},
  chat: { messages: [], requestId: null, providerId: null, model: null, models: [], usage: null, task: "" },
  agentChat: { agent: null, mode: "general", cwd: null, sessionId: null },
  monitors: [],
  preview: null,
  integrations: [],
  notes: { notes: [], recording: null, working: [] },
  selectedNote: null,
  builtInClients: [false, false],
  digests: {},
  fetching: [],
  fetchErrors: {},
  live: [],
  focus: null,
  mediaOpen: false,
  greeting: false,
  feeling: null,
  voice: null,
  wake: { state: "off", why: "" },
  wakeTest: { phase: "idle", word: "" },
  level: null,
  levelBefore: null,
  charge: null,
  islandPlace: "top",
  artTint: null,
  islandView: "idle",
  watching: false,
  version: "",
  update: { current: "", latest: null, available: false, notes: "", published: null, message: "" },
  updating: null,
  updateKind: "setup",
  whatsNew: [],
  signingIn: [],
  draft: "",
  draftFiles: [],
};

const listeners = new Set<() => void>();

function set(patch: Partial<AppState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
  reportContext();
  // Sample sessions must never replace the saved ones.
  if ((patch.sessions || patch.chat) && !state.preview) saveHistory();
}

// ── History ─────────────────────────────────────────────────────────────────

const HISTORY_KEY = "meridian.history";
const HISTORY_SESSIONS = 30;
const HISTORY_LOG = 120;
const HISTORY_MESSAGES = 200;
const ENDED = ["completed", "failed", "cancelled"];

let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Finished work and the chat survive a restart, on this PC only. Images are left
 *  out: a screen capture should not outlive the conversation it was shared in. */
function saveHistory() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const sessions = state.sessions
      // A terminal session's labels can quote a command, which stays out of any file.
      .filter((s) => ENDED.includes(s.status) && !s.watched)
      .slice(0, HISTORY_SESSIONS)
      .map((s) => ({ ...s, log: s.log.slice(-HISTORY_LOG), approval: null, queued: [], todos: undefined }));
    const messages = state.chat.messages.slice(-HISTORY_MESSAGES).map(({ role, content }) => ({ role, content }));
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify({ sessions, messages }));
    } catch {
      // Storage is full or unavailable. History is a convenience, never a reason to fail.
    }
  }, 1000);
}

function forgetHistory() {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    // Storage is unavailable, so there is nothing to forget.
  }
}

function restoreHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "{}");
    const sessions: SessionDetail[] = (saved.sessions ?? []).map((s: SessionDetail) => ({ ...s, restored: true }));
    set({ sessions, limits: loadLimits(), chat: { ...state.chat, messages: saved.messages ?? [] } });
  } catch {
    forgetHistory();
  }
}

export function clearHistory() {
  clearTimeout(saveTimer);
  forgetHistory();
  clearChat();
  set({ sessions: state.sessions.filter((s) => !s.restored && !ENDED.includes(s.status)) });
}

/** Tells the core what the user is in the middle of, for interruption decisions. */
let reported = "";
function reportContext() {
  const agent = state.sessions.some((s) => ["starting", "running", "waiting"].includes(s.status));
  const media = state.media.current?.playing ?? false;
  const screen = state.screen.capture !== null || state.screen.capturing;
  const key = `${agent}${media}${screen}`;
  if (key === reported) return;
  reported = key;
  void bridge.activityContext(agent, media, screen);
}


export const getState = () => state;

const sameFolder = (a: string, b: string) => a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();

/** Folders the user has worked in: the default one and every project session. The assistant can
 *  only start an agent in one of these; anywhere else the user starts it from Agents themselves. */
export function knownFolder(folder: string | null | undefined, s: AppState = state): boolean {
  if (!folder) return false;
  const known = [s.settings.agentDefaultDir, ...s.sessions.filter((x) => x.mode === "project").map((x) => x.cwd)];
  return known.some((k) => !!k && sameFolder(k, folder));
}

export function useApp<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => selector(state),
  );
}

const newId = () => crypto.randomUUID();

// ── Panel ───────────────────────────────────────────────────────────────────

export function openPanel(tab?: Tab) {
  showPreview(null);
  if (!state.panelOpen && state.settings.sounds) chime("open");
  // A reminder that needs an answer is still waiting when the panel closes.
  set({ panelOpen: true, tab: tab ?? state.tab, notices: state.notices.filter((n) => n.sticky), pastNotices: keptNotices(state.notices.filter((n) => !n.sticky)), mediaOpen: false });
  void bridge.setInteractive(true);
  void refreshLocal();
}

export function closePanel() {
  showPreview(null);
  if (state.panelOpen && state.settings.sounds) chime("close");
  set({ panelOpen: false });
  void bridge.setInteractive(false);
}

export const togglePanel = () => (state.panelOpen ? closePanel() : openPanel());

let blurClosedAt = 0;

export function closeOnBlur() {
  if (!state.panelOpen || bridge.dialogOpen()) return;
  blurClosedAt = Date.now();
  closePanel();
}

/** The shortcut and the tray. The tray's click has already closed the panel if it was open. */
export function toggleFromCore() {
  if (Date.now() - blurClosedAt >= TOGGLE_AFTER_BLUR_MS) togglePanel();
}

export const setDraft = (draft: string) => set({ draft });
export const addDraftFile = (file: string) => set({ draftFiles: [...state.draftFiles, file] });
export const clearDraft = () => set({ draft: "", draftFiles: [] });
export const setTab = (tab: Tab) => set({ tab });
export const setNotes = (notes: NotesState) => set({ notes });
export const showNote = (selectedNote: string | null) => set({ selectedNote });
export const setSettingsSection = (settingsSection: SettingsSection) => set({ settingsSection });
export const openSettings = (settingsSection: SettingsSection) => set({ tab: "settings", settingsSection });

let hoverTimer: ReturnType<typeof setTimeout> | undefined;

/** A pointer passing on its way to a browser tab should not move the island, and
 *  one slipping off the edge for a moment should not close it. */
export function setHovered(hovered: boolean) {
  clearTimeout(hoverTimer);
  if (hovered !== state.hovered) {
    hoverTimer = setTimeout(() => set(hovered ? { hovered } : { hovered, mediaOpen: false, stagesOpen: false }), hovered ? HOVER_IN_MS : HOVER_OUT_MS);
  }
}

export const setMediaOpen = (mediaOpen: boolean) => set({ mediaOpen });
export const openStages = () => set({ stagesOpen: true });
export const clearAgentFocus = () => set({ agentFocus: null });

/** Opens one session where it lives, on the view asked for. */
export function openSession(id: string, view: "activity" | "changes" = "activity") {
  const chat = state.sessions.find((s) => s.id === id)?.surface === "chat";
  if (!chat) set({ agentFocus: { id, view } });
  openPanel(chat ? "chat" : "agents");
}

/** Other parts of the island ask what is on show. Only a change is news. */
export function reportView(islandView: IslandView) {
  if (islandView !== state.islandView) set({ islandView });
}

export function setListening(listening: boolean) {
  set({ listening });
  showPreview(null);
}

// ── Notices and errors ──────────────────────────────────────────────────────

/** What is kept when notices leave the island. Sample ones never reach the real list. */
const keptNotices = (gone: Notice[]) => (state.preview ? state.pastNotices : [...gone.filter((n) => n.finished), ...state.pastNotices].slice(0, PAST_NOTICES));

/** Takes something off the island after a while. Someone reading it with the pointer there keeps it for a bit longer. */
/** How long the line runs before a card closes by itself. */
export const CLOSING_LINE_MS = 5000;
/** Cards the user pinned. They stay until closed by hand. */
const pinned = new Set<string>();

function markClosing(id: string, at: number) {
  if (!pinned.has(id)) set({ closing: { ...state.closing, [id]: at } });
}

function endClosing(id: string) {
  if (!(id in state.closing)) return;
  const { [id]: _gone, ...rest } = state.closing;
  set({ closing: rest });
}

/** Closes a card after a while. With an id, the card shows a line in its last 5 s, and Pin keeps it. */
function leaveAfter(ms: number, leave: () => void, id?: string) {
  const latest = Date.now() + ms + LONGEST_HOLD_MS;
  let held = false;
  const expire = () => {
    if (id && pinned.has(id)) return;
    if (getState().hovered && Date.now() < latest) {
      held = true;
      return void setTimeout(expire, 1500);
    }
    // Held past its time, it gets a last 5 s with the line, so it never vanishes as the pointer leaves.
    if (held && id) {
      held = false;
      markClosing(id, Date.now() + CLOSING_LINE_MS);
      return void setTimeout(expire, CLOSING_LINE_MS);
    }
    if (id) endClosing(id);
    leave();
  };
  if (id) setTimeout(() => markClosing(id, Date.now() + Math.min(ms, CLOSING_LINE_MS)), Math.max(0, ms - CLOSING_LINE_MS));
  setTimeout(expire, ms);
}

/** Keeps a card that would close by itself, until it is closed by hand. */
export function pinCard(id: string) {
  pinned.add(id);
  endClosing(id);
}

/** The offer to stop a recording nobody speaks in. It counts down in place, and goes when someone speaks. */
export function setQuietCall(left: number) {
  const others = state.notices.filter((n) => n.id !== QUIET_CALL);
  if (left <= 0) return set({ notices: others });
  const notice: Notice = { id: QUIET_CALL, tone: "info", title: "No one has spoken for 15 minutes", body: "", quiet: left, sticky: true };
  set({ notices: state.notices.some((n) => n.id === QUIET_CALL) ? state.notices.map((n) => (n.id === QUIET_CALL ? notice : n)) : [...state.notices, notice] });
}

export function keepRecording() {
  setQuietCall(0);
  void bridge.keepRecording();
}

const QUIET_CALL = "quiet-call";

export function pushNotice(notice: Omit<Notice, "id"> & { id?: string }, ms = NOTICE_MS) {
  const id = notice.id ?? newId();
  if (state.notices.some((n) => n.id === id)) return;
  set({ notices: [...state.notices, { ...notice, id }] });
  leaveAfter(ms, () => dismissNotice(id), id);
}

export const dismissNotice = (id: string) => set({ notices: state.notices.filter((n) => n.id !== id), pastNotices: keptNotices(state.notices.filter((n) => n.id === id)) });

export function pushError(error: Omit<IslandError, "id">) {
  const id = newId();
  set({ errors: [...state.errors, { ...error, id }] });
  // An agent that failed gets longer, and stays listed under Notifications after it goes.
  leaveAfter(error.sessionId ? URGENT_MS : ERROR_MS, () => {
    if (error.sessionId && state.errors.some((e) => e.id === id)) set({ pastNotices: keptNotices([{ id, tone: "urgent", title: error.title, body: error.body, sessionId: error.sessionId, finished: true }]) });
    dismissError(id);
  }, id);
}

export const dismissError = (id: string) => set({ errors: state.errors.filter((e) => e.id !== id) });
export const dismissSuggestion = (id: string) =>
  set({ suggestions: state.suggestions.filter((s) => s.id !== id) });

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ── Settings ────────────────────────────────────────────────────────────────

function applyAppearance(s: Settings) {
  document.documentElement.dataset.motion = s.motion;
  applyTheme(s);
  document.documentElement.dataset.ambient = String(s.ambient);
  document.documentElement.dataset.align = s.islandAlign;
}

export async function updateSettings(patch: Partial<Settings>) {
  const settings = { ...state.settings, ...patch };
  set({ settings });
  applyAppearance(settings);
  try {
    await bridge.saveSettings(settings);
    if (patch.autostart !== undefined) await bridge.setAutostart(patch.autostart);
    if (patch.providerBaseUrls || patch.localOnly !== undefined) await refreshProviders();
  } catch (err) {
    pushError({ title: "Settings not saved", body: describe(err) });
  }
}

// ── Providers and chat ──────────────────────────────────────────────────────

export async function refreshProviders() {
  set({ providers: await bridge.listProviders() });
}

export async function refreshLocal() {
  const servers = await bridge.discoverLocal().catch(() => []);
  set({ localOnline: servers.map((s) => s.providerId) });
  return servers;
}

/** Can this provider answer right now, as far as we can tell without calling it? */
export function isReady(p: ProviderInfo, localOnline: string[]) {
  if (p.kind === "local") return localOnline.includes(p.id);
  if (p.kind === "custom") return p.baseUrl !== "";
  return p.hasKey;
}

function usableProvider(): ProviderInfo | null {
  const { providers, settings, chat, localOnline } = state;
  const ready = (p: ProviderInfo) => isReady(p, localOnline);
  const wanted = chat.providerId ?? settings.defaultProvider;
  return providers.find((p) => p.id === wanted && ready(p)) ?? providers.find(ready) ?? null;
}

export async function selectProvider(providerId: string, model: string | null = null) {
  set({ chat: { ...state.chat, providerId, model, models: [] } });
  try {
    const models = await bridge.listModels(providerId);
    if (state.chat.providerId !== providerId) return;
    const keep = models.find((m) => m.id === model) ?? models[0] ?? null;
    set({ chat: { ...state.chat, models, model: keep?.id ?? model } });
  } catch (err) {
    pushError({ title: "Could not list models", body: describe(err) });
  }
}

function patchLastMessage(fn: (text: string) => string) {
  const messages = state.chat.messages.slice();
  const last = messages[messages.length - 1];
  messages[messages.length - 1] = { ...last, content: fn(last.content) };
  set({ chat: { ...state.chat, messages } });
}

/** Told to the AI on a spoken turn, and kept out of what the user sees. */
const SPOKEN = "\n\n(This is a spoken conversation. Reply in one or two short, plain sentences, with no lists or formatting. After doing something, say only the outcome, such as Done or Chrome is closed. Never mention commands, tools or the steps you took.)";

export async function sendChat(text: string, images: string[] = [], spoken = false) {
  const provider = usableProvider();
  if (!provider) {
    pushError({ title: "No AI provider ready", body: "Add a key or start a local server in Settings, AI models." });
    return;
  }
  // A new question replaces one still being answered, as talking over a reply does.
  cancelChat();
  // Set before anything waits, because a spoken turn takes a quiet chat to mean the reply is over.
  set({ chatPending: true });
  if (state.chat.providerId !== provider.id || !state.chat.model) await selectProvider(provider.id, state.chat.model);
  const model = state.chat.model;
  if (!model) {
    set({ chatPending: false });
    pushError({ title: "No model available", body: `${provider.name} offered no model to use.` });
    return;
  }

  const requestId = newId();
  // A reply that failed before its first token leaves an empty turn behind,
  // and providers reject empty messages.
  const earlier = state.chat.messages.filter((m) => m.content);
  const turn: ChatMessage = images.length > 0 ? { role: "user", content: text, images } : { role: "user", content: text };
  const history: ChatMessage[] = [...earlier, turn];
  const system: ChatMessage[] = state.settings.systemPrompt
    ? [{ role: "system", content: state.settings.systemPrompt }]
    : [];
  if (spoken) system.push({ role: "system", content: SPOKEN.trim() });
  set({
    chatPending: true,
    chat: {
      ...state.chat,
      requestId,
      usage: null,
      task: text.slice(0, 48),
      messages: [...history, { role: "assistant", content: "" }],
    },
  });

  // Only the current request touches the chat. Anything else has been replaced or cleared.
  const current = () => state.chat.requestId === requestId;
  const finish = () => {
    if (current()) set({ chatPending: false, chat: { ...state.chat, requestId: null } });
  };
  try {
    await bridge.streamChat(requestId, provider.id, model, [...system, ...history], (event) => {
      if (!current()) return;
      if (event.type === "delta") patchLastMessage((t) => t + event.text);
      else if (event.type === "usage")
        set({ chat: { ...state.chat, usage: { input: event.input, output: event.output } } });
      else if (event.type === "error" && event.kind !== "cancelled")
        pushError({ title: `${provider.name} failed`, body: event.message, retry: () => retryLast() });
      else if (event.type === "done" && !state.panelOpen)
        pushNotice({ tone: "success", title: "Answer ready", body: `${provider.name} · ${model}` });
    });
  } catch (err) {
    pushError({ title: `${provider.name} failed`, body: describe(err), retry: () => retryLast() });
  } finally {
    finish();
  }
}

export function retryLast() {
  const messages = state.chat.messages.slice();
  if (messages[messages.length - 1]?.role === "assistant") messages.pop();
  const user = messages.pop();
  set({ chat: { ...state.chat, messages } });
  if (user) void sendChat(user.content, user.images);
}

export function cancelChat() {
  const id = state.chat.requestId;
  if (id) void bridge.cancelChat(id);
}

export function clearChat() {
  cancelChat();
  set({ chatPending: false, chat: { ...state.chat, requestId: null, messages: [], usage: null } });
}

// ── Engines ─────────────────────────────────────────────────────────────────

export async function refreshAuth(agent: AgentId) {
  const status = await bridge.agentAuth(agent).catch(() => null);
  if (status) set({ auth: { ...state.auth, [agent]: status } });
  return status;
}

export function selectEngine(id: string) {
  if (id === "claude-code" || id === "codex") {
    const latest = state.sessions.find((s) => s.surface === "chat" && s.agentId === id);
    set({ agentChat: { ...state.agentChat, agent: id, sessionId: latest?.id ?? null, mode: latest?.mode ?? state.agentChat.mode } });
    void refreshAuth(id);
    return;
  }
  set({ agentChat: { ...state.agentChat, agent: null } });
  void selectProvider(id);
}

/** What to move to, if anything. A provider that has gone, such as a closed local server, is no choice at all. */
export function nextEngine(chosen: string | null, usable: string | undefined, agent: string | undefined) {
  return usable ? (usable === chosen ? null : usable) : (agent ?? null);
}

/** What Chat would answer with, for work done away from Chat. */
export async function chatEngine(): Promise<{ agent: string } | { provider: string; model: string } | null> {
  pickEngine();
  if (state.agentChat.agent) return { agent: state.agentChat.agent };
  const provider = usableProvider();
  if (!provider) return null;
  if (state.chat.providerId !== provider.id || !state.chat.model) await selectProvider(provider.id, state.chat.model);
  return state.chat.model ? { provider: provider.id, model: state.chat.model } : null;
}

/** Chat opens on an AI, so nobody meets an empty choice. Asking from anywhere else gets the same one. */
export function pickEngine() {
  // Agents send what they are given to their makers, so local-only mode never picks one, and drops one picked before.
  if (state.agentChat.agent && state.settings.localOnly) set({ agentChat: { ...state.agentChat, agent: null, sessionId: null } });
  if (state.agentChat.agent) return;
  const agent = state.settings.localOnly ? undefined : state.agents.find((a) => a.installed)?.id;
  const next = nextEngine(state.chat.providerId, usableProvider()?.id, agent);
  if (next) selectEngine(next);
}

/** Asks whichever AI Chat is on. */
export function sendToEngine(text: string, images: string[] = []) {
  pickEngine();
  return state.agentChat.agent ? sendAgentChat(text, images) : sendChat(text, images);
}

const LIMITS_KEY = "meridian.limits";
const WARNED_KEY = "meridian.limits.warned";
const LIMIT_WARNING = 80;

function loadLimits() {
  try {
    return JSON.parse(localStorage.getItem(LIMITS_KEY) ?? "{}") as AppState["limits"];
  } catch {
    return {};
  }
}

/** Once at 80% and once at the limit, for each time the window resets. */
function warnedOnce(key: string) {
  try {
    const seen: string[] = JSON.parse(localStorage.getItem(WARNED_KEY) ?? "[]");
    if (seen.includes(key)) return true;
    localStorage.setItem(WARNED_KEY, JSON.stringify([...seen, key].slice(-20)));
  } catch {
    // Without storage it may warn again after a restart, which is better than not at all.
  }
  return false;
}

function noteLimits(agent: AgentId, name: string, windows: LimitWindow[]) {
  // Each report can carry only the window that changed.
  const kept = (state.limits[agent]?.windows ?? []).filter((old) => !windows.some((w) => w.window === old.window));
  const merged = [...kept, ...windows].sort((a, b) => a.window.localeCompare(b.window));
  set({ limits: { ...state.limits, [agent]: { windows: merged, at: Date.now() } } });
  try {
    localStorage.setItem(LIMITS_KEY, JSON.stringify(state.limits));
  } catch {
    // Shown for this run all the same.
  }
  for (const { window, usedPercent, resetsAt } of windows) {
    const level = usedPercent >= 100 ? 100 : usedPercent >= LIMIT_WARNING ? LIMIT_WARNING : 0;
    if (!level || warnedOnce(`${agent}:${window}:${resetsAt}:${level}`)) continue;
    const short = name.replace(/ (Code|CLI)$/, "");
    pushNotice({ tone: level === 100 ? "urgent" : "info", title: level === 100 ? `${short} limit reached` : `${short} at ${Math.round(usedPercent)}%`, body: resetLabel(resetsAt, Date.now()) });
  }
}

/** Takes finished sessions out of the list. What they did stays in their own folders. */
export function clearFinished() {
  set({ sessions: state.sessions.filter((s) => s.surface === "chat" || !["completed", "failed", "cancelled"].includes(s.status)) });
}

export const setAgentMode = (mode: AgentMode) =>
  set({ agentChat: { ...state.agentChat, mode, sessionId: null } });
export const setAgentCwd = (cwd: string) => set({ agentChat: { ...state.agentChat, cwd, sessionId: null } });
export const newAgentConversation = () => set({ agentChat: { ...state.agentChat, sessionId: null } });
export const selectAgentConversation = (sessionId: string) =>
  set({ agentChat: { ...state.agentChat, sessionId } });

export async function sendAgentChat(said: string, images: string[] = [], spoken = false) {
  const { agent, mode, cwd, sessionId } = state.agentChat;
  if (!agent) return;
  const text = spoken ? said + SPOKEN : said;
  const earlier = state.sessions.find((s) => s.id === sessionId);
  // History saved before ids were kept cannot be resumed, so that chat starts afresh.
  if (earlier && !(earlier.restored && !earlier.nativeId)) return sendToSession(earlier.id, text, images);
  const dir = mode === "project" ? (cwd ?? state.settings.agentDefaultDir) : await bridge.assistantDir();
  if (!dir) {
    pushError({ title: "Choose a project folder", body: "Project mode needs a folder to work in." });
    // What was said waits in the message box while a folder is chosen.
    set({ draft: said });
    return;
  }
  const id = await startSession({ agent, cwd: dir, prompt: text, model: null, restricted: mode === "general", images }, "chat", mode);
  if (id) set({ agentChat: { ...state.agentChat, sessionId: id, cwd: mode === "project" ? dir : state.agentChat.cwd } });
}

// ── Agent sessions ──────────────────────────────────────────────────────────

const projectName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;

function patchSession(id: string, fn: (s: SessionDetail) => SessionDetail) {
  set({ sessions: state.sessions.map((s) => (s.id === id ? fn(s) : s)) });
}

/** An ended session running again. A list it finished is over, and would otherwise read as where it is now. */
const newTurn = (s: SessionDetail) => ({ turnAt: Date.now(), todos: s.todos?.every((t) => t.status === "completed") ? undefined : s.todos });

function appendLog(s: SessionDetail, kind: LogEntry["kind"], text: string): LogEntry[] {
  const last = s.log[s.log.length - 1];
  const log =
    kind === "text" && last?.kind === "text" && (last.at ?? 0) >= (s.turnAt ?? 0)
      ? [...s.log.slice(0, -1), { ...last, text: last.text + text }]
      : [...s.log, { kind, text, at: Date.now() }];
  return log.slice(-LOG_LIMIT);
}

// Events travel separately from the reply that names a new session, so a fast
// failure can arrive first. They wait here until the session exists.
const earlyEvents = new Map<string, AgentEnvelope[]>();

function hold(envelope: AgentEnvelope) {
  earlyEvents.set(envelope.sessionId, [...(earlyEvents.get(envelope.sessionId) ?? []), envelope]);
}

export function applyAgentEvent(envelope: AgentEnvelope) {
  const { sessionId, event } = envelope;
  // Sample sessions are on show. The real ones catch up when they come back.
  if (state.preview) return hold(envelope);
  if (event.type === "watched") {
    addWatchedSession(sessionId, event.agent, event.cwd, event.title, event.pid ?? null);
    return;
  }
  // Hooks can outrun the page at startup, and the one event naming a session is
  // then gone. A request for permission must still appear.
  if (sessionId.startsWith("watch:") && !state.sessions.some((s) => s.id === sessionId)) {
    addWatchedSession(sessionId, "Claude Code", "", null);
  }
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) return hold(envelope);
  switch (event.type) {
    case "started":
      patchSession(sessionId, (s) => ({ ...s, model: event.model, nativeId: event.nativeId ?? s.nativeId }));
      break;
    case "text":
      patchSession(sessionId, (s) => ({ ...s, log: appendLog(s, "text", event.text) }));
      break;
    case "activity":
      patchSession(sessionId, (s) => ({ ...s, activity: event.label, log: appendLog(s, "activity", event.label) }));
      break;
    case "approval":
      if (state.settings.sounds) chime("attention");
      // Parallel tool calls can ask at once. Each waits its turn on screen.
      patchSession(sessionId, (s) => ({
        ...s,
        status: "waiting",
        approval: s.approval ?? event.approval,
        queued: s.approval ? [...s.queued, event.approval] : s.queued,
        activity: `Waiting for approval: ${(s.approval ?? event.approval).tool}`,
      }));
      break;
    case "approvalResolved":
      patchSession(sessionId, (s) => {
        const queued = s.queued.filter((a) => a.id !== event.id);
        if (s.approval?.id !== event.id) return { ...s, queued };
        const [next, ...rest] = queued;
        // Answered, it goes back to what it was doing, not to saying it is waiting.
        const doing = next ? s.activity : s.log.filter((e) => e.kind === "activity").pop()?.text ?? "Working";
        return { ...s, approval: next ?? null, queued: rest, status: next ? "waiting" : "running", activity: doing };
      });
      break;
    case "usage":
      patchSession(sessionId, (s) => ({
        ...s,
        usage: { input: event.input, output: event.output, costUsd: event.costUsd },
      }));
      break;
    case "limits": {
      const agent = state.sessions.find((s) => s.id === sessionId);
      if (agent) noteLimits(agent.agentId, agent.agent, event.windows);
      break;
    }
    case "context":
      patchSession(sessionId, (s) => ({
        ...s,
        context: { used: event.used ?? s.context?.used ?? null, size: event.size ?? s.context?.size ?? null },
      }));
      break;
    case "diff":
      patchSession(sessionId, (s) => ({ ...s, log: [...s.log, { kind: "diff" as const, text: event.path, at: Date.now(), removed: event.removed, added: event.added, linesRemoved: event.linesRemoved, linesAdded: event.linesAdded }].slice(-LOG_LIMIT) }));
      break;
    case "output":
      patchSession(sessionId, (s) => ({ ...s, log: [...s.log, { kind: "output" as const, text: event.command, at: Date.now(), lines: event.lines, failed: event.failed }].slice(-LOG_LIMIT) }));
      break;
    case "todos":
      patchSession(sessionId, (s) => ({ ...s, todos: event.items }));
      break;
    case "todoChanged":
      patchSession(sessionId, (s) => ({ ...s, todos: mergeTodo(s.todos ?? [], event) }));
      break;
    case "status": {
      const ended = ["completed", "failed", "cancelled"].includes(event.status);
      if (ended) set({ stagesOpen: false });
      patchSession(sessionId, (s) => ({
        ...s,
        status: event.status,
        ...(!ended && ENDED.includes(s.status) ? newTurn(s) : {}),
        endedAt: ended ? Date.now() : s.endedAt,
        approval: ended ? null : s.approval,
        queued: ended ? [] : s.queued,
        activity: event.message ?? (ended ? "" : s.activity),
        log: event.message ? appendLog(s, "system", event.message) : s.log,
      }));
      if (event.status === "completed") feel("done", 2400);
      if (event.status === "failed") feel("error", 3000);
      // A reply in Chat is the assistant answering, which is in front of the reader or being spoken, not work to review.
      if (event.status === "completed" && session.surface !== "chat") {
        // The only ending with a message is a terminal that went silent, which is not news of work done.
        void announceFinish(session, sessionId, event.message ?? null);
      }
      if (event.status === "failed") {
        pushError({ title: `${session.agent} failed`, body: event.message ?? session.project, sessionId });
        // A lapsed sign-in is the usual cause, and it should show where you can fix it.
        void refreshAuth(session.agentId);
      }
      break;
    }
  }
}

function addWatchedSession(id: string, agent: string, cwd: string, title: string | null, pid: number | null = null) {
  // A session that went quiet and came back keeps its row.
  if (state.sessions.some((s) => s.id === id)) {
    patchSession(id, (s) => ({ ...s, ...newTurn(s), status: "running", endedAt: null, restored: false, pid: pid ?? s.pid }));
    return;
  }
  const session: SessionDetail = {
    id,
    agentId: "claude-code",
    agent,
    surface: "agents",
    mode: "project",
    title: title ?? (projectName(cwd) || "Your terminal"),
    project: projectName(cwd) || "Your terminal",
    cwd,
    pid,
    prompt: title ?? "",
    model: null,
    status: "running",
    activity: "Working",
    startedAt: Date.now(),
    endedAt: null,
    approval: null,
    usage: null,
    log: title ? [{ kind: "user", text: title }] : [],
    queued: [],
    watched: true,
  };
  set({ sessions: [session, ...state.sessions] });
  earlyEvents.get(id)?.forEach(applyAgentEvent);
  earlyEvents.delete(id);
}

export async function startSession(
  request: StartSession,
  surface: SessionDetail["surface"] = "agents",
  mode: AgentMode = "project",
) {
  const agent = state.agents.find((a) => a.id === request.agent);
  try {
    const id = await bridge.startSession(request);
    const session: SessionDetail = {
      id,
      agentId: request.agent,
      agent: agent?.name ?? request.agent,
      surface,
      mode,
      title: request.prompt.replace(SPOKEN, "").slice(0, 48),
      project: mode === "general" ? "General" : projectName(request.cwd),
      cwd: request.cwd,
      prompt: request.prompt,
      model: request.model,
      status: "starting",
      activity: "Starting",
      startedAt: Date.now(),
      endedAt: null,
      approval: null,
      usage: null,
      log: [{ kind: "user", text: request.prompt.replace(SPOKEN, "") }],
      queued: [],
    };
    set({ sessions: [session, ...state.sessions] });
    earlyEvents.get(id)?.forEach(applyAgentEvent);
    earlyEvents.delete(id);
    return id;
  } catch (err) {
    pushError({ title: `Could not start ${agent?.name ?? request.agent}`, body: describe(err) });
    return null;
  }
}

export const cancelSession = (id: string) => void bridge.cancelSession(id);
let lastAnswerAt = 0;

/** The next request can appear under the button that was just pressed, so the second
 *  half of a double click must not approve something nobody has read. */
/** The assistant wants to send something out after reading other people's words. It shows as a
 *  request on its chat, answered with the same buttons, and goes when the tool server stops waiting. */
export function askConfirm(confirm: { id: string; tool: string; summary: string }) {
  const chat = state.sessions.find((s) => s.id === state.agentChat.sessionId) ?? state.sessions.find((s) => s.mode === "general" && !ENDED.includes(s.status));
  if (!chat) return;
  const approval = { id: confirm.id, tool: confirm.tool, summary: confirm.summary, why: "This came up after it read your mail or notes." };
  applyAgentEvent({ sessionId: chat.id, event: { type: "approval", approval } });
}

export function confirmGone(id: string) {
  const owner = state.sessions.find((s) => s.approval?.id === id || s.queued.some((a) => a.id === id));
  if (owner) applyAgentEvent({ sessionId: owner.id, event: { type: "approvalResolved", id } });
}

/** A finish says so on the island, with a chime. When the user is already looking at the terminal
 *  it runs in, the session just shows as done, with no sound and nothing popping up. */
async function announceFinish(session: SessionDetail, sessionId: string, message: string | null) {
  if (session.pid && (await bridge.terminalInFront(session.pid).catch(() => false))) return;
  // The only ending with a message is a terminal that went silent, which is not news of work done.
  if (message) pushNotice({ tone: "info", title: `${session.project} went quiet`, body: message, sessionId });
  else pushNotice({ tone: "success", title: `${session.project} is done`, body: lastMessage(session) ?? session.title, sessionId, finished: true }, FINISHED_MS);
  if (state.settings.sounds && !state.panelOpen) chime("done");
}

/** What the agents are doing and how much of the plan is used, in words for the assistant. */
export function agentsInWords(s: AppState = state): string {
  const now = Date.now();
  const lines = s.sessions
    .filter((x) => x.surface === "agents" && (!ENDED.includes(x.status) || (x.endedAt ?? 0) > now - 60 * 60_000))
    .map((x) => `${x.title || x.project} (${x.project}, ${x.agent}): ${ENDED.includes(x.status) ? x.status : x.approval ? "waiting for the user to answer a request" : x.activity || "working"}`);
  const plan = s.limits["claude-code"]?.windows.map((w) => `${limitName(w.window)} ${Math.round(w.usedPercent)}% used, ${resetLabel(w.resetsAt, now)}`) ?? [];
  return [lines.length ? lines.join("\n") : "No agents are running.", plan.length ? `Claude plan: ${plan.join("; ")}.` : ""].filter(Boolean).join("\n");
}

/** The most used of the Claude plan's limits, for the ring at rest. Null until a run has reported one. */
export function planUse(s: AppState = state): { percent: number } | null {
  const windows = s.limits["claude-code"]?.windows ?? [];
  return windows.length ? { percent: Math.max(...windows.map((w) => w.usedPercent)) } : null;
}

/** Folds a request away to answer later, from the Agents page or when it comes back. The agent
 *  keeps waiting, and the request goes when the agent stops waiting. */
export function foldApproval(sessionId: string) {
  patchSession(sessionId, (s) => ({ ...s, foldedId: s.approval?.id ?? null }));
}

/** Brings the window a terminal session runs in to the front, from a click. */
export async function focusTerminal(session: Pick<SessionDetail, "pid" | "cwd" | "project">) {
  if (!session.pid) return;
  const found = await bridge.terminalFocus(session.pid, session.cwd || null).catch(() => false);
  if (!found) pushError({ title: "Could not find its window", body: `The terminal ${session.project} runs in may have closed.` });
}

export function answerApproval(sessionId: string, approvalId: string, allow: boolean, answers?: Record<string, string | string[]>) {
  if (Date.now() - lastAnswerAt < ANSWER_GAP_MS) return;
  lastAnswerAt = Date.now();
  feel(allow ? "love" : "error", 1300);
  void bridge.answerApproval(sessionId, approvalId, allow, answers).catch((err) => pushError({ title: "That request has gone", body: describe(err) }));
}

export async function sendToSession(id: string, text: string, images: string[] = []) {
  const session = state.sessions.find((s) => s.id === id);
  // Running from this moment, or a spoken follow-up reads the last turn's end as this one's.
  patchSession(id, (s) => {
    const next = ENDED.includes(s.status) ? { ...s, ...newTurn(s), status: "running" as const } : s;
    return { ...next, log: appendLog(next, "user", text.replace(SPOKEN, "")) };
  });
  try {
    // A conversation from before a restart exists only here until the app is told about it.
    if (session?.restored && session.nativeId) {
      const { agentId: agent, cwd, model, mode, nativeId } = session;
      await bridge.adoptSession({ id, agent, cwd, model, restricted: mode === "general", nativeId });
      patchSession(id, (s) => ({ ...s, restored: false }));
    }
    await bridge.sendToSession(id, text, images);
  } catch (err) {
    patchSession(id, (s) => ({ ...s, status: session?.status ?? s.status }));
    pushError({ title: "Message not delivered", body: describe(err) });
  }
}

// ── Personal activity ───────────────────────────────────────────────────────

const setActivity = (patch: Partial<ActivityState>) => set({ activity: { ...state.activity, ...patch } });

export async function refreshActivity(category: Category = state.activity.category) {
  try {
    const [events, accounts, log, meetings, all] = await Promise.all([
      bridge.activityList(category),
      bridge.accountsList(),
      bridge.reminderLog(),
      bridge.activityList("meetings"),
      bridge.activityList(null),
    ]);
    const next = meetings.find((m) => m.status !== "cancelled" && m.status !== "completed") ?? null;
    setActivity({ category, events, accounts, log, next, all });
    refreshLive();
  } catch (err) {
    pushError({ title: "Could not read your activity", body: describe(err) });
  }
}

const activityAction = (action: () => Promise<unknown>) => async () => {
  try {
    await action();
    await refreshActivity();
  } catch (err) {
    pushError({ title: "That did not work", body: describe(err) });
  }
};

export const dismissEvent = (id: string) => activityAction(() => bridge.activityDismiss(id))();
export const deleteEvent = (id: string) => activityAction(() => bridge.activityDelete(id))();
export const renameEvent = (id: string, title: string) => activityAction(() => bridge.activityCorrect(id, title))();
export const addReminder = (title: string, startsAt: EventTime) =>
  activityAction(() => bridge.activityAddReminder(title, startsAt))();

/** Each read is a run on the user's Claude plan that takes about a minute, so My Day asks at most this often. */
const CLAUDE_MAIL_EVERY_MS = 30 * 60_000;

/** My Day reads Gmail through the Claude account when Google has no sign-in of its own and Claude Code is here. */
export const mailThroughClaude = (s: AppState) =>
  !s.settings.localOnly && !s.activity.accounts.some((a) => a.provider === "google") && s.agents.some((a) => a.id === "claude-code" && a.installed);

/** Only from My Day, when it opens or is asked to read again. */
export async function readMailThroughClaude(again = false) {
  const { claudeMail } = state.activity;
  if (!mailThroughClaude(state) || claudeMail.reading) return;
  if (!again && claudeMail.at > 0 && Date.now() - claudeMail.at < CLAUDE_MAIL_EVERY_MS) return;
  setActivity({ claudeMail: { ...claudeMail, reading: true } });
  try {
    const said = await bridge.activityClaudeMail();
    setActivity({ claudeMail: { reading: false, said, failed: false, at: Date.now() } });
    await refreshActivity();
  } catch (err) {
    setActivity({ claudeMail: { reading: false, said: describe(err), failed: true, at: Date.now() } });
  }
}

export async function importEmail(subject: string, from: string, body: string) {
  const found = await bridge.activityImport(subject, from, body);
  await refreshActivity();
  return found;
}

export const disconnectAccount = (id: string) => activityAction(() => bridge.accountDisconnect(id))();

export async function connectAccount(provider: ConnectedAccount["provider"], secret: string | null) {
  const account = await bridge.accountConnect(provider, secret);
  await refreshActivity();
  return account;
}

export const openLink = (url: string) => void bridge.openUrl(url);

export function dismissReminder(notice: Notice) {
  dismissNotice(notice.id);
  if (notice.eventId) void dismissEvent(notice.eventId);
}

export function snoozeReminder(notice: Notice, minutes: number) {
  dismissNotice(notice.id);
  if (notice.eventId) void activityAction(() => bridge.activitySnooze(notice.eventId!, minutes))();
}

function onReminders(reminders: Reminder[]) {
  for (const r of reminders) {
    const urgent = r.priority === "critical" || r.priority === "important";
    const notice: Notice = {
      id: r.key,
      eventId: r.eventId,
      tone: urgent ? "urgent" : "info",
      title: r.title,
      body: r.startsAt ? describeTime(r.startsAt) : "",
      actions: r.actions.filter((a) => a.url).map((a) => ({ label: a.label, url: a.url })),
      sticky: urgent,
    };
    set({ notices: [...state.notices.filter((n) => n.id !== notice.id), notice] });
    leaveAfter(notice.sticky ? URGENT_MS : NOTICE_MS, () => dismissNotice(notice.id), notice.id);
  }
}

/** The time of day alone for something today, which is how a day reads. Anything else, null. */
export function timeToday(time: EventTime) {
  const at = new Date(time.value);
  if (time.kind === "date" || at.toDateString() !== new Date().toDateString()) return null;
  return at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** A time as stated: a date stays a date, and an unzoned time claims no zone. */
export function describeTime(time: EventTime) {
  const stated = time.kind === "date" ? new Date(`${time.value}T00:00:00`) : new Date(time.value);
  return time.kind === "date"
    ? stated.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })
    : stated.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

// ── Live activities ─────────────────────────────────────────────────────────

const LIVE_EVERY_MS = 30_000;
const FOCUS_MINUTES = 25;

function refreshLive() {
  if (state.preview) return;
  const now = Date.now();
  const { focus } = state;
  if (focus && now >= focus.endsAt) {
    set({ focus: null });
    pushNotice({ tone: "success", title: "Focus time is over", body: `${focus.minutes} minutes done` });
    if (state.settings.sounds) chime("done");
  }
  const found = pickLive(state.activity.all, now);
  set({ live: state.focus ? [...found, focusActivity(state.focus.endsAt, state.focus.minutes, now)] : found });
}

export function startFocus(minutes = FOCUS_MINUTES) {
  set({ focus: { endsAt: Date.now() + minutes * 60_000, minutes } });
  refreshLive();
  closePanel();
}

export function endFocus() {
  set({ focus: null });
  refreshLive();
}

// ── Providers ───────────────────────────────────────────────────────────────

/** Gmail, Calendar and Outlook use the direct connectors, which also feed My day. */
const DIRECT: Integration[] = [
  { id: "gmail", name: "Gmail", group: "Mail and calendar", blurb: "Finds flights, deliveries and bookings in your mail.", access: "account", connected: false, account: null, ready: false },
  { id: "calendar", name: "Google Calendar", group: "Mail and calendar", blurb: "Shows meetings as they come up.", access: "account", connected: false, account: null, ready: false },
  { id: "outlook", name: "Outlook", group: "Mail and calendar", blurb: "Mail and calendar from a Microsoft account.", access: "account", connected: false, account: null, ready: false },
];

const directAccount = (id: string, accounts: ConnectedAccount[]) =>
  accounts.find((a) => a.provider === (id === "outlook" ? "microsoft" : "google")) ?? null;

/** With no registered app, these two are read through the user's Claude account, only when asked. */
const VIA_CLAUDE: Record<string, string> = {
  gmail: "Answers questions about your mail.",
  calendar: "Answers questions about your schedule.",
};
let onClaude: Record<string, boolean> = {};

export async function refreshIntegrations() {
  const accounts = await bridge.accountsList().catch(() => []);
  const [google, microsoft] = await bridge.builtInClients();
  const direct = DIRECT.map((d): Integration => {
    const account = directAccount(d.id, accounts);
    const own = d.id === "outlook" ? state.settings.microsoftClientId : state.settings.googleClientId;
    const ready = (d.id === "outlook" ? microsoft : google) || own !== "";
    const row = { ...d, connected: account !== null, account: account?.email ?? null, ready };
    return ready || !VIA_CLAUDE[d.id] ? row : { ...row, ready: true, blurb: VIA_CLAUDE[d.id], viaClaude: onClaude[d.id] ? "on" : "off" };
  });
  const servers = await bridge.integrationsList().catch(() => []);
  set({ integrations: [...direct, ...servers] });
}

/** Claude Code reports this as it starts, which takes seconds, so it is asked only when Providers opens. */
export async function checkClaudeConnectors() {
  const ids = Object.keys(VIA_CLAUDE);
  if (!state.integrations.some((i) => i.viaClaude) || state.fetching.includes(ids[0])) return;
  set({ fetching: [...state.fetching, ...ids] });
  const [gmail, calendar] = await bridge.claudeConnectors().catch(() => [false, false]);
  onClaude = { gmail, calendar };
  set({ fetching: state.fetching.filter((x) => !ids.includes(x)) });
  await refreshIntegrations();
}

/** What the mail and calendar connectors have found, in the shape of a fetch. */
async function directDigest(integration: Integration): Promise<Digest> {
  const account = directAccount(integration.id, await bridge.accountsList());
  const events = await bridge.activityList(null);
  const items = events
    .filter((e) => integration.id === "outlook" || e.source === (integration.id === "calendar" ? "calendar" : "email"))
    .filter((e) => (e.sourceRef?.account ?? account?.email) === account?.email)
    .map((e) => ({
      key: e.id,
      title: e.title,
      detail: e.sourceRef?.subject ?? e.body,
      url: e.sourceRef?.link ?? null,
      when: e.startsAt && e.startsAt.kind !== "date" ? e.startsAt.value : null,
    }));
  return { server: null, tool: null, tools: [], items, text: null };
}

export async function fetchIntegration(integration: Integration, tool: string | null = null, background = false) {
  const { id, name } = integration;
  if (state.fetching.includes(id)) return;
  set({ fetching: [...state.fetching, id], fetchErrors: { ...state.fetchErrors, [id]: "" } });
  try {
    const digest = integration.access === "account" ? await directDigest(integration) : await bridge.integrationFetch(id, tool);
    const known = new Set(state.digests[id]?.items.map((i) => i.key));
    const fresh = digest.items.filter((i) => !known.has(i.key)).length;
    set({ digests: { ...state.digests, [id]: digest } });
    if (background && known.size > 0 && fresh > 0) pushNotice({ tone: "info", title: name, body: `${fresh} new` });
  } catch (err) {
    set({ fetchErrors: { ...state.fetchErrors, [id]: describe(err) } });
  } finally {
    set({ fetching: state.fetching.filter((x) => x !== id) });
  }
}

/** The browser takes focus, which closes the panel, so a sign-in is followed here and a failure
 *  shows on the island. A second click while one is under way does nothing. */
async function signingIn(id: string, name: string, work: () => Promise<unknown>) {
  if (state.signingIn.includes(id)) return;
  set({ signingIn: [...state.signingIn, id] });
  try {
    await work();
  } catch (err) {
    pushError({ title: `Could not sign in to ${name}`, body: describe(err) });
  } finally {
    set({ signingIn: state.signingIn.filter((x) => x !== id) });
  }
}

/** One click: the service's own page opens in the browser, and this returns once signed in. */
export const connectIntegration = (integration: Integration) =>
  signingIn(integration.id, integration.name, async () => {
    if (integration.access === "account") {
      await connectAccount(integration.id === "outlook" ? "microsoft" : "google", null);
    } else {
      await bridge.integrationConnect(integration.id);
    }
    await refreshIntegrations();
  });

export async function disconnectIntegration(integration: Integration) {
  if (integration.access === "account") {
    const account = directAccount(integration.id, await bridge.accountsList());
    if (account) await disconnectAccount(account.id);
  } else {
    await bridge.integrationDisconnect(integration.id);
  }
  const { [integration.id]: _gone, ...digests } = state.digests;
  set({ digests });
  await refreshIntegrations();
}

const FETCH_EVERY_MS = 15 * 60_000;
/** A PC left on for days still hears about a new version. */
const UPDATE_EVERY_MS = 6 * 60 * 60_000;
const ASK_UPDATES_AFTER_MS = 30_000;
const ASK_FOREVER_MS = 24 * 60 * 60_000;
const WHATS_NEW_MS = 12_000;
/** The charge moves slowly, and the charger coming and going arrives at once as a level. */
const CHARGE_EVERY_MS = 60_000;

export async function refreshCharge() {
  const charge = await bridge.batteryNow().catch(() => null);
  if (charge?.percent !== state.charge?.percent || charge?.plugged !== state.charge?.plugged) set({ charge });
}

/** Back to the middle of the top edge, from wherever it was dragged. */
export async function resetIslandPlace() {
  await bridge.islandReset();
  if (state.settings.islandAlign !== "center") await updateSettings({ islandAlign: "center" });
}

function fetchInBackground() {
  if (state.settings.monitoringPaused) return;
  for (const i of state.integrations) if (i.connected) void fetchIntegration(i, null, true);
}

export function describeWhen(value: string) {
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return value.slice(0, 16);
  return when.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

// ── Claude Code sessions in other terminals ─────────────────────────────────

/** A CLI signs in through its own window, so this waits to see it succeed. */
export const signInAgent = (agent: AgentId, name: string) =>
  signingIn(agent, name, async () => {
    await bridge.agentLogin(agent);
    for (let i = 0; i < SIGN_IN_POLLS; i++) {
      await new Promise((r) => setTimeout(r, SIGN_IN_POLL_MS));
      if ((await refreshAuth(agent))?.signedIn) return;
    }
    throw new Error("Sign-in did not finish. Try again when you are ready.");
  });

export const signInProvider = (id: string, name: string) =>
  signingIn(id, name, async () => {
    await bridge.aiSignIn(id);
    await refreshProviders();
  });

export async function setWatching(on: boolean) {
  await bridge.watchSet(on);
  set({ watching: on });
}

// ── Media ───────────────────────────────────────────────────────────────────

const RECENT_TRACKS = 8;

/** A colour to show on black, from an average that may be nearly black itself. Keeps only the hue. */
export function vivid(r: number, g: number, b: number) {
  const high = Math.max(r, g, b);
  const range = high - Math.min(r, g, b);
  if (range < 12) return "hsl(0 0% 78%)";
  const hue = high === r ? ((g - b) / range + 6) % 6 : high === g ? (b - r) / range + 2 : (r - g) / range + 4;
  return `hsl(${Math.round(hue * 60)} 72% 66%)`;
}

/** The album's colour, taken from a tiny copy of its art. */
function tintOf(src: string, done: (tint: string) => void) {
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 8;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.drawImage(image, 0, 0, 8, 8);
    const pixels = context.getImageData(0, 0, 8, 8).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < pixels.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += pixels[i + c];
    done(vivid(sum[0]! / 64, sum[1]! / 64, sum[2]! / 64));
  };
  image.src = src;
}

export function setVoice(voice: VoiceState | null) {
  // The panel steps aside for a conversation, so its window must not catch clicks meanwhile.
  if (!voice !== !state.voice) {
    if (state.panelOpen) void bridge.setInteractive(!voice);
  }
  set({ voice });
}

export const setWake = (wake: WakeStatus) => set({ wake });

let wakeTestEnds: ReturnType<typeof setTimeout> | undefined;

/** Listens for a few seconds whether or not the switch is on, and starts no conversation. */
export function testWake() {
  clearTimeout(wakeTestEnds);
  set({ wakeTest: { phase: "waiting", word: "" } });
  void bridge.wakeTest();
  wakeTestEnds = setTimeout(() => set({ wakeTest: { phase: "missed", word: "" } }), WAKE_TEST_MS);
}

export function wakeTestHeard(word: string) {
  clearTimeout(wakeTestEnds);
  set({ wakeTest: { phase: "heard", word } });
}

/** How far the eyes travel each way, in CSS pixels. island.rs uses the same numbers. */
const GAZE_REACH = { x: 4, y: 3 };
let gazed = "0,0";

/** Points the eyes, on the faces themselves so only they restyle. A move smaller than one device
 *  pixel is invisible, so it is not worth a repaint of the window. */
function aim(gx: number, gy: number) {
  for (const face of document.querySelectorAll<HTMLElement>(".island .face")) {
    face.style.setProperty("--gx", `${gx}px`);
    face.style.setProperty("--gy", `${gy}px`);
  }
}

/** The eyes follow the pointer wherever it is, as they did in 0.5.1, which looked right: the core
 *  sends where it is up to 15 times a second, and the styles glide the eyes there over 0.14 s, so
 *  they move smoothly rather than in jumps. */
function look(x: number, y: number) {
  if (document.documentElement.hasAttribute("data-reduced")) return;
  const dpr = devicePixelRatio || 1;
  const gx = Math.round(x * GAZE_REACH.x * dpr) / dpr;
  const gy = Math.round(y * GAZE_REACH.y * dpr) / dpr;
  if (`${gx},${gy}` === gazed) return;
  gazed = `${gx},${gy}`;
  aim(gx, gy);
}

let feelingTimer: ReturnType<typeof setTimeout> | undefined;

/** Shows a feeling on the face for a moment. */
export function feel(feeling: Mood, ms = 1800) {
  clearTimeout(feelingTimer);
  set({ feeling });
  feelingTimer = setTimeout(() => set({ feeling: null }), ms);
}

const LEVEL_MS = { volume: 1700, brightness: 1700, battery: 4500 };
let levelTimer: ReturnType<typeof setTimeout> | undefined;
const lastLevels = new Map<Level["kind"], Level>();

function hideLevel() {
  // Hovering the battery opens it, so it stays for as long as the pointer does.
  if (state.hovered && state.level?.kind === "battery") levelTimer = setTimeout(hideLevel, 600);
  else set({ level: null });
}

function onLevel(level: Level) {
  if (level.kind === "battery") set({ charge: { percent: level.percent, plugged: level.plugged } });
  const levelBefore = lastLevels.get(level.kind) ?? null;
  lastLevels.set(level.kind, level);
  clearTimeout(levelTimer);
  set({ level, levelBefore });
  levelTimer = setTimeout(hideLevel, LEVEL_MS[level.kind]);
}

function onMedia(snapshot: MediaSnapshot) {
  const before = beforePreview?.media ?? state.media;
  const art = snapshot.current?.artwork ?? null;
  if (art !== before.current?.artwork) {
    if (art) tintOf(art, (artTint) => set({ artTint }));
    else set({ artTint: null });
  }
  const changed = before.current?.title && before.current.title !== snapshot.current?.title;
  const recent = changed
    ? [before.current!, ...before.recent.filter((t) => t.title !== before.current!.title)].slice(0, RECENT_TRACKS)
    : before.recent;
  const media = { ...snapshot, reportedAt: Date.now(), recent };
  // Sample music may be on show, so the real track waits with the rest.
  if (beforePreview) beforePreview = { ...beforePreview, media };
  else set({ media });
}

export const mediaAction = (action: MediaAction) => void bridge.mediaAction(action);

// ── Screen awareness ────────────────────────────────────────────────────────

const setScreen = (patch: Partial<ScreenState>) => set({ screen: { ...state.screen, ...patch } });

export const setIncludeImage = (includeImage: boolean) => setScreen({ includeImage });

export async function captureScreen(target: "window" | "screen") {
  setScreen({ capturing: true, refused: null });
  try {
    const capture = await bridge.screenCapture(target);
    setScreen({ capture, capturing: false });
  } catch (err) {
    setScreen({ capturing: false, refused: describe(err) });
  }
}

export async function cropCapture(x: number, y: number, w: number, h: number) {
  try {
    setScreen({ capture: await bridge.screenCrop(x, y, w, h), refused: null });
  } catch (err) {
    setScreen({ refused: describe(err) });
  }
}

export function discardCapture() {
  setScreen({ capture: null, refused: null });
  void bridge.screenDiscard();
}

/** What the selected engine can take from a capture. */
export function shareTarget() {
  const { agentChat, chat, providers, agents } = state;
  if (agentChat.agent) {
    const name = agents.find((a) => a.id === agentChat.agent)?.name ?? agentChat.agent;
    return { name, vision: agentChat.agent === "claude-code", local: false };
  }
  const provider = providers.find((p) => p.id === chat.providerId);
  return {
    name: provider?.name ?? "No engine selected",
    vision: provider?.capabilities.vision ?? false,
    local: provider?.kind === "local",
  };
}

/** The only path by which screen content leaves this machine. */
export function shareCapture(question: string) {
  const { capture, includeImage } = state.screen;
  if (!capture) return;
  pickEngine();
  const target = shareTarget();
  const from = capture.window ? ` (${capture.window.process}: ${capture.window.title})` : "";
  const text = capture.text
    ? `${question}\n\nText read from my screen${from}:\n"""\n${capture.text}\n"""`
    : `${question}${from ? `\n\nFrom my screen${from}.` : ""}`;
  const images = includeImage && target.vision ? [capture.image] : [];
  discardCapture();
  setTab("chat");
  void sendToEngine(text, images);
}

const suggestionFrom = (s: ScreenSuggestion): Suggestion => ({
  id: s.key,
  key: s.key,
  title: s.title,
  body: s.seen > 1 ? `${s.evidence} (seen ${s.seen} times)` : s.evidence,
});

function onScreenSuggestion(s: ScreenSuggestion) {
  if (state.suggestions.some((x) => x.key === s.key)) return;
  const suggestion = suggestionFrom(s);
  set({ suggestions: [...state.suggestions, suggestion] });
  leaveAfter(SUGGESTION_MS, () => dismissSuggestion(suggestion.id), suggestion.id);
}

export function ignoreSuggestion(suggestion: Suggestion) {
  dismissSuggestion(suggestion.id);
  if (suggestion.key) void bridge.screenIgnore(suggestion.key);
}

/** A suggestion never sends anything. It opens the preview with the question written, ready to approve. */
export function assist(suggestion: Suggestion, question: string) {
  dismissSuggestion(suggestion.id);
  set({ draft: question });
  openPanel("chat");
  void captureScreen("window");
}

// ── Preview tour: real components with sample data, flagged as such ─────────

const previewSession = (id: string, agent: string, project: string, activity: string, over: Partial<SessionDetail> = {}): SessionDetail => ({
  id,
  agentId: "claude-code",
  agent,
  surface: "agents",
  mode: "project",
  title: activity,
  project,
  cwd: "",
  prompt: "",
  model: null,
  status: "running",
  activity,
  startedAt: Date.now() - 134_000,
  endedAt: null,
  approval: null,
  usage: null,
  log: [],
  queued: [],
  ...over,
});

/** A session a few steps in, for the previews of what an agent is doing. */
function sampleWork(over: Partial<SessionDetail> = {}): SessionDetail {
  const start = Date.now() - 42_000;
  const step = (text: string, seconds: number): LogEntry => ({ kind: "activity", text, at: start + seconds * 1000 });
  return previewSession("p1", "Claude Code", "dock-agent", "Editing src/island/views.tsx", {
    title: "Fix the island flicker",
    startedAt: start,
    log: [
      step("Reading src/island/machine.ts", 4), step("Reading src/lib/store.ts", 9), step("Reading src/lib/types.ts", 15), step("Reading src/island/Island.tsx", 31),
      step("Editing src/island/machine.ts", 38), { kind: "diff", text: "machine.ts", linesAdded: 6, linesRemoved: 3 },
      step("Editing src/island/views.tsx", 42), { kind: "diff", text: "views.tsx", linesAdded: 2, linesRemoved: 0 },
    ],
    ...over,
  });
}

type Preview = { name: string; apply: () => Partial<AppState> };

/** A sample event seen a set number of minutes after it starts. */
function previewLive(kind: string, minutes: number, over: Partial<ContextEvent> = {}): LiveActivity[] {
  const now = Date.now();
  const starts = now - minutes * 60_000;
  const event: ContextEvent = {
    id: `preview-${kind}`, kind, source: "email", occurredAt: new Date(now).toISOString(),
    startsAt: { kind: "zoned", value: new Date(starts).toISOString() },
    endsAt: { kind: "zoned", value: new Date(starts + 135 * 60_000).toISOString() },
    title: "Design review", body: null, metadata: { flightNumber: "6E2341", departureAirport: "DEL", arrivalAirport: "BOM" },
    confidence: 1, priority: "important", status: "active", suggestedActions: [], expiresAt: null, dedupeKey: kind,
    sourceRef: null, userEdited: false, revision: 1, changedFields: [], snoozedUntil: null, ...over,
  };
  const activity = liveFrom(event, now);
  return activity ? [activity] : [];
}

const clear: Partial<AppState> = {
  live: [],
  panelOpen: false,
  listening: false,
  chatPending: false,
  sessions: [],
  notices: [],
  suggestions: [],
  errors: [],
  level: null,
  levelBefore: null,
  voice: null,
  media: { current: null, sessions: [], reportedAt: 0, recent: [] },
};

/** A check nobody asked for says so on the island, once for each new version. */
let announced: string | null = null;

export async function checkForUpdates(announce = false) {
  if (state.updating) return;
  if (state.settings.localOnly) {
    set({ update: { ...state.update, available: false, message: "Update checks are off in local-only mode." } });
    return;
  }
  set({ updating: "checking" });
  try {
    const update = await bridge.checkUpdate();
    set({ update });
    if (announce && update.available && update.latest && update.latest !== announced) {
      announced = update.latest;
      pushNotice({ tone: "info", title: "Update ready", body: `Meridian ${update.latest.replace(/^v/, "")} is ready to install.`, update: true });
    }
  } catch {
    set({ update: { ...state.update, available: false, message: "Could not check for updates." } });
  } finally {
    set({ updating: null });
  }
}

export const RELEASES_URL = "https://github.com/ShashikantSingh09/meridian/releases/latest";

/** Succeeding ends the app, so only a failure comes back here. A copy that was not installed cannot
 *  update itself, so it gets the release page instead of half-updating. */
export async function installUpdate() {
  if (state.updating) return;
  const tag = state.update.latest;
  if (state.updateKind === "portable") return openLink(RELEASES_URL);
  if (!tag) return;
  set({ updating: "installing" });
  try {
    await bridge.installUpdate(tag);
  } catch (err) {
    set({ updating: null });
    if (describe(err) === "portable") return openLink(RELEASES_URL);
    pushError({ title: "Could not update", body: describe(err), retry: () => void installUpdate() });
  }
}

/** Whether to look for new versions by itself. Asked once, a while after the first start. */
export function setUpdateChecks(on: boolean) {
  void updateSettings({ updateChecks: on });
  dismissNotice("ask-updates");
  if (on) void checkForUpdates(true);
}

/** A check nobody asked for, made only once the user has said yes to them. */
const autoCheck = () => {
  if (state.settings.updateChecks === true) void checkForUpdates(true);
};

/** Shows What's new once, then remembers this version as seen. */
function noteVersion(version: string) {
  const fresh = whatsNew(version, state.settings.lastSeenVersion);
  if (fresh.length) {
    set({ whatsNew: fresh });
    pushNotice({ tone: "info", title: `New in ${version.replace(/^v/, "")}`, body: fresh.map((thing) => thing.title).join(" · "), update: true }, WHATS_NEW_MS);
  }
  if (state.settings.lastSeenVersion !== version) void updateSettings({ lastSeenVersion: version });
}

export const PREVIEWS: Preview[] = [
  { name: "idle", apply: () => clear },
  { name: "listening", apply: () => ({ ...clear, listening: true }) },
  { name: "thinking", apply: () => ({ ...clear, chatPending: true }) },
  { name: "volume up", apply: () => ({ ...clear, level: { kind: "volume", percent: 62, muted: false }, levelBefore: { kind: "volume", percent: 50, muted: false } }) },
  { name: "volume down", apply: () => ({ ...clear, level: { kind: "volume", percent: 38, muted: false }, levelBefore: { kind: "volume", percent: 50, muted: false } }) },
  { name: "muted", apply: () => ({ ...clear, level: { kind: "volume", percent: 62, muted: true }, levelBefore: null }) },
  { name: "brightness", apply: () => ({ ...clear, level: { kind: "brightness", percent: 40 }, levelBefore: { kind: "brightness", percent: 60 } }) },
  { name: "charging", apply: () => ({ ...clear, level: { kind: "battery", percent: 64, plugged: true, saver: false, secondsLeft: null, secondsToFull: 4320, watts: 65, health: 92 }, levelBefore: { kind: "battery", percent: 64, plugged: false, saver: false, secondsLeft: null, secondsToFull: null, watts: null, health: null } }) },
  { name: "battery low", apply: () => ({ ...clear, level: { kind: "battery", percent: 20, plugged: false, saver: false, secondsLeft: 2100, secondsToFull: null, watts: null, health: 92 }, levelBefore: null }) },
  { name: "voice listening", apply: () => ({ ...clear, voice: { phase: "listening", mode: "hold", words: "Can you check if my flight on Monday", ahead: "" } }) },
  { name: "voice pause", apply: () => ({ ...clear, voice: { phase: "pause", mode: "hold", words: "Can you check if my flight on Monday, the one to Mumbai,", ahead: "" } }) },
  { name: "voice thinking", apply: () => ({ ...clear, voice: { phase: "thinking", mode: "turn", words: "Let me look.", ahead: "" } }) },
  { name: "voice speaking", apply: () => ({ ...clear, voice: { phase: "speaking", mode: "turn", words: "Your flight to Mumbai leaves Monday at 7:40 from gate 22.", ahead: " It is on time, and you should leave by 5." } }) },
  { name: "question", apply: () => ({ ...clear, sessions: [{ ...previewSession("p1", "Claude Code", "dock-agent", "Waiting"), approval: { id: "pq", tool: "AskUserQuestion", summary: "Which database should this use?", questions: [{ text: "Which database should this use?", options: ["SQLite", "Postgres", "Keep it in memory"], multi: false }] } }] }) },
  { name: "plan", apply: () => ({ ...clear, sessions: [{ ...previewSession("p1", "Claude Code", "dock-agent", "Waiting"), approval: { id: "pp", tool: "ExitPlanMode", summary: "Add a settings page", plan: "## Add a settings page\n\n1. Create `Settings.tsx`\n2. Save choices with **updateSettings**\n3. Add it to the dock\n\nThis touches three files and needs no new packages." } }] }) },
  { name: "working", apply: () => ({ ...clear, sessions: [sampleWork()] }) },
  {
    name: "to-do list",
    apply: () => ({
      ...clear,
      sessions: [sampleWork({
        todos: [
          { id: "1", text: "Find what causes the flicker", status: "completed" },
          { id: "2", text: "Fix the resize", status: "completed" },
          { id: "3", text: "Add a test", status: "in_progress" },
          { id: "4", text: "Run the tests", status: "pending" },
          { id: "5", text: "Update the docs", status: "pending" },
        ],
      })],
    }),
  },
  {
    name: "finished",
    apply: () => {
      const session = sampleWork({
        status: "completed",
        activity: "",
        endedAt: Date.now(),
        startedAt: Date.now() - 252_000,
        usage: { input: 118_000, output: 2_400, costUsd: 0.18 },
      });
      const log: LogEntry[] = [
        ...session.log,
        { kind: "diff", text: "Island.tsx", linesAdded: 4, linesRemoved: 1 },
        { kind: "output", text: "npm test", lines: ["Tests  148 passed (148)", "Duration  1.20s"], failed: false },
        { kind: "text", text: "The flicker came from the panel resizing twice. It now resizes once, and the test covers it." },
      ];
      return { ...clear, sessions: [{ ...session, log }], notices: [{ id: "pf", tone: "success" as const, title: "dock-agent is done", body: session.title, sessionId: session.id, finished: true }] };
    },
  },
  {
    name: "stopped",
    apply: () => {
      const session = sampleWork({ status: "failed", activity: "", endedAt: Date.now(), startedAt: Date.now() - 123_000 });
      return { ...clear, sessions: [session], errors: [{ id: "px", title: "Claude Code failed", body: "2 tests failed in machine.test.ts", sessionId: session.id }] };
    },
  },
  {
    name: "approval",
    apply: () => ({
      ...clear,
      sessions: [
        previewSession("p1", "Claude Code", "dock-agent", "Waiting for approval: Bash", {
          status: "waiting",
          approval: { id: "pa", tool: "Bash", summary: "npm publish --access public" },
        }),
      ],
    }),
  },
  { name: "notification", apply: () => ({ ...clear, notices: [{ id: "pn", tone: "success", title: "Claude Code finished", body: "dock-agent · 14 files changed" }] }) },
  { name: "contextual", apply: () => ({ ...clear, suggestions: [{ id: "ps", title: "Looks like a Terraform configuration issue", body: "Error: Invalid reference on main.tf line 12" }] }) },
  {
    name: "multitask",
    apply: () => ({
      ...clear,
      sessions: [
        previewSession("p1", "Claude Code", "billing-api", "$ npm test"),
        previewSession("p2", "Codex", "website", "Editing index.html"),
        previewSession("p3", "Claude Code", "dock-agent", "Waiting", { status: "waiting" }),
      ],
    }),
  },
  {
    name: "media",
    apply: () => ({
      ...clear,
      media: {
        current: { session: "preview", app: "Spotify", title: "Northern Lights", artist: "Sample Artist", album: "", playing: true, positionMs: 42_000, durationMs: 210_000, canToggle: true, canNext: true, canPrevious: true, canSeek: false, artwork: null },
        sessions: [],
        reportedAt: Date.now(),
        recent: [],
      },
    }),
  },
  { name: "error", apply: () => ({ ...clear, errors: [{ id: "pe", title: "Anthropic unreachable", body: "Network connection lost." }] }) },
  { name: "flight, boarding", apply: () => ({ ...clear, live: previewLive("flight", -30) }) },
  { name: "flight, in the air", apply: () => ({ ...clear, live: previewLive("flight", 57) }) },
  { name: "flight, landed", apply: () => ({ ...clear, live: previewLive("flight", 140) }) },
  { name: "parcel", apply: () => ({ ...clear, live: previewLive("delivery", 0, { endsAt: null, metadata: { deliveryStatus: "Out for delivery", carrier: "Delhivery" } }) }) },
  { name: "meeting", apply: () => ({ ...clear, live: previewLive("meeting", -4, { suggestedActions: [{ label: "Join", actionId: "join", url: "https://meet.google.com/abc" }] }) }) },
  { name: "expanded", apply: () => ({ ...clear, panelOpen: true, tab: "home" as Tab }) },
];

/** The real state, held aside while sample data is on show. */
let beforePreview: Partial<AppState> | null = null;
let previewTimer: ReturnType<typeof setTimeout> | undefined;

export function showPreview(name: string | null) {
  clearTimeout(previewTimer);
  const preview = PREVIEWS.find((p) => p.name === name);
  if (preview) {
    beforePreview ??= {
      // Reopening the panel afterwards would take focus from whatever is in use by then.
      panelOpen: false,
      listening: state.listening,
      sessions: state.sessions,
      notices: state.notices,
      suggestions: state.suggestions,
      errors: state.errors,
      media: state.media,
      live: state.live,
      // A level lasts a moment, and its timer can run out while sample data shows.
      level: null,
      levelBefore: null,
      voice: state.voice,
    };
    const sample = preview.apply();
    if (state.panelOpen && !sample.panelOpen) void bridge.setInteractive(false);
    set({ ...sample, preview: preview.name });
    previewTimer = setTimeout(() => showPreview(null), PREVIEW_MS);
  } else if (beforePreview) {
    if (state.panelOpen) void bridge.setInteractive(false);
    // A reply can finish while sample data shows, and nothing would then clear the flag.
    set({ ...beforePreview, chatPending: state.chat.requestId !== null, preview: null });
    beforePreview = null;
    const held = [...earlyEvents.values()].flat();
    earlyEvents.clear();
    held.forEach(applyAgentEvent);
    refreshLive();
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────

export async function boot() {
  const [settings, providers, agents] = await Promise.all([bridge.getSettings(), bridge.listProviders(), bridge.detectAgents()]);
  applyAppearance(settings);
  set({ settings, providers, agents });
  restoreHistory();
  void refreshLocal();
  void refreshActivity();
  void bridge.monitors().then((monitors) => set({ monitors }));
  if (!settings.onboarded) set({ notices: [{ id: "welcome", tone: "info", title: "Welcome to Meridian", body: "Click here to set up" }] });
  else if (native) {
    set({ greeting: true });
    setTimeout(() => set({ greeting: false }), GREETING_MS);
  }
  setInterval(refreshLive, LIVE_EVERY_MS);
  void refreshIntegrations();
  void bridge.builtInClients().then((builtInClients) => set({ builtInClients }));
  void bridge.watchStatus().then((watching) => set({ watching }));
  void bridge.appVersion().then((version) => {
    set({ version });
    noteVersion(version);
  });
  void bridge.updateKind().then((updateKind) => set({ updateKind })).catch(() => undefined);
  // Looking on GitHub is asked about once, a while after the first start, and never over a question.
  setTimeout(() => {
    if (state.settings.updateChecks === null && !state.settings.localOnly) {
      pushNotice({ id: "ask-updates", tone: "info", title: "Check for new versions by itself?", body: "Meridian can look on GitHub when it starts and every few hours. Click to choose.", update: true, sticky: true }, ASK_FOREVER_MS);
    }
  }, ASK_UPDATES_AFTER_MS);
  autoCheck();
  setInterval(autoCheck, UPDATE_EVERY_MS);
  // The assistant's agents_status reads what the agents are doing from here, kept current.
  let told = "";
  setInterval(() => {
    const now = agentsInWords();
    if (now !== told) void bridge.assistantContext((told = now)).catch(() => undefined);
  }, 3000);
  void bridge.islandPlacement().then((islandPlace) => set({ islandPlace }));
  void refreshCharge();
  setInterval(() => void refreshCharge(), CHARGE_EVERY_MS);
  setInterval(fetchInBackground, FETCH_EVERY_MS);
  for (const a of agents) if (a.installed) void refreshAuth(a.id);
  await Promise.all([
    bridge.onAgentEvent(applyAgentEvent),
    bridge.onAssistantConfirm(askConfirm, confirmGone),
    bridge.onHover(setHovered),
    bridge.onGaze(look),
    bridge.onTogglePanel(toggleFromCore),
    bridge.onBlur(closeOnBlur),
    bridge.onOpenTab((tab) => openPanel(tab as Tab)),
    bridge.onMedia(onMedia),
    bridge.onLevel(onLevel),
    bridge.onIslandPlaced((islandPlace) => set({ islandPlace })),
    bridge.onReminders(onReminders),
    bridge.onActivityChanged(() => void refreshActivity()),
    bridge.onSettingsChanged((changed) => {
      applyAppearance(changed);
      set({ settings: changed });
    }),
    bridge.onScreenSuggestion(onScreenSuggestion),
    bridge.onCaptureRequest(() => {
      openPanel("chat");
      void captureScreen("window");
    }),
  ]);
  // The first state was sent before anything here was listening.
  void bridge.mediaAction({ action: "refresh" });
  void bridge.refreshRunning();
}

export const newSessionDefaults = (): Pick<StartSession, "agent"> | null => {
  const agent = state.agents.find((a) => a.installed);
  return agent ? { agent: agent.id } : null;
};
