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
} from "./types";
import type { Mood } from "../island/faces";
import { defaultSettings } from "./types";

export type Tab = "home" | "chat" | "agents" | "media" | "day" | "inbox" | "settings";
export type SettingsSection = "general" | "island" | "screen" | "models" | "providers" | "agents" | "privacy" | "about";

export interface LogEntry {
  kind: "user" | "text" | "activity" | "system" | "diff" | "output";
  text: string;
  /** For a diff: the lines taken out and put in. */
  removed?: string[];
  added?: string[];
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
  log: LogEntry[];
  /** Approvals behind the one on screen. */
  queued: Approval[];
  /** Runs in the user's own terminal: it can be followed and answered, not steered. */
  watched?: boolean;
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
  question: string;
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
  chatPending: boolean;
  sessions: SessionDetail[];
  notices: Notice[];
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
  /** The colour of the album, to light the island with. */
  artTint: string | null;
  islandView: IslandView;
  /** Claude Code hooks are installed, so its sessions appear here. */
  watching: boolean;
  version: string;
  update: UpdateStatus;
}

const LOG_LIMIT = 500;
const NOTICE_MS = 6000;
const GREETING_MS = 2600;
const HOVER_IN_MS = 180;
const HOVER_OUT_MS = 240;
const ANSWER_GAP_MS = 400;
const SIGN_IN_POLLS = 60;
const SIGN_IN_POLL_MS = 2000;

let state: AppState = {
  panelOpen: false,
  activity: { category: "today", events: [], accounts: [], log: [], next: null, all: [] },
  media: { current: null, sessions: [], reportedAt: 0, recent: [] },
  screen: { capture: null, capturing: false, question: "", includeImage: true, refused: null },
  tab: "home",
  settingsSection: "general",
  listening: false,
  hovered: false,
  chatPending: false,
  sessions: [],
  notices: [],
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
  builtInClients: [false, false],
  digests: {},
  fetching: [],
  fetchErrors: {},
  live: [],
  focus: null,
  mediaOpen: false,
  greeting: false,
  feeling: null,
  artTint: null,
  islandView: "idle",
  watching: false,
  version: "",
  update: { available: false, message: "" },
};

const listeners = new Set<() => void>();

function set(patch: Partial<AppState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
  reportContext();
  if (patch.sessions || patch.chat) saveHistory();
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
      .map((s) => ({ ...s, log: s.log.slice(-HISTORY_LOG), approval: null, queued: [] }));
    const messages = state.chat.messages.slice(-HISTORY_MESSAGES).map(({ role, content }) => ({ role, content }));
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify({ sessions, messages }));
    } catch {
      // Storage is full or unavailable. History is a convenience, never a reason to fail.
    }
  }, 1000);
}

function restoreHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "{}");
    const sessions: SessionDetail[] = (saved.sessions ?? []).map((s: SessionDetail) => ({ ...s, restored: true }));
    set({ sessions, chat: { ...state.chat, messages: saved.messages ?? [] } });
  } catch {
    localStorage.removeItem(HISTORY_KEY);
  }
}

export function clearHistory() {
  clearTimeout(saveTimer);
  localStorage.removeItem(HISTORY_KEY);
  set({ sessions: state.sessions.filter((s) => !s.restored && !ENDED.includes(s.status)), chat: { ...state.chat, messages: [], usage: null } });
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
  if (!state.panelOpen && state.settings.sounds) chime("open");
  set({ panelOpen: true, tab: tab ?? state.tab, notices: [], mediaOpen: false });
  void bridge.setInteractive(true);
  void refreshLocal();
}

export function closePanel() {
  if (state.panelOpen && state.settings.sounds) chime("close");
  set({ panelOpen: false });
  void bridge.setInteractive(false);
}

export const togglePanel = () => (state.panelOpen ? closePanel() : openPanel());
export const setTab = (tab: Tab) => set({ tab });
export const setSettingsSection = (settingsSection: SettingsSection) => set({ settingsSection });
export const openSettings = (settingsSection: SettingsSection) => set({ tab: "settings", settingsSection });

let hoverTimer: ReturnType<typeof setTimeout> | undefined;

/** A pointer passing on its way to a browser tab should not move the island, and
 *  one slipping off the edge for a moment should not close it. */
export function setHovered(hovered: boolean) {
  clearTimeout(hoverTimer);
  if (hovered !== state.hovered) {
    hoverTimer = setTimeout(() => set(hovered ? { hovered } : { hovered, mediaOpen: false }), hovered ? HOVER_IN_MS : HOVER_OUT_MS);
  }
}

export const setMediaOpen = (mediaOpen: boolean) => set({ mediaOpen });

/** Other parts of the island ask what is on show. Only a change is news. */
export function reportView(islandView: IslandView) {
  if (islandView !== state.islandView) set({ islandView });
}

export const setListening = (listening: boolean) => set({ listening, preview: null });

// ── Notices and errors ──────────────────────────────────────────────────────

export function pushNotice(notice: Omit<Notice, "id">) {
  const id = newId();
  set({ notices: [...state.notices, { ...notice, id }] });
  const expire = () => {
    // Someone reading it with the pointer on the island keeps it open.
    if (getState().hovered) setTimeout(expire, 1500);
    else dismissNotice(id);
  };
  setTimeout(expire, NOTICE_MS);
}

export const dismissNotice = (id: string) => set({ notices: state.notices.filter((n) => n.id !== id) });

export function pushError(error: Omit<IslandError, "id">) {
  set({ errors: [...state.errors, { ...error, id: newId() }] });
}

export const dismissError = (id: string) => set({ errors: state.errors.filter((e) => e.id !== id) });
export const dismissSuggestion = (id: string) =>
  set({ suggestions: state.suggestions.filter((s) => s.id !== id) });

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ── Settings ────────────────────────────────────────────────────────────────

function applyAppearance(s: Settings) {
  document.documentElement.dataset.motion = s.motion;
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

export async function sendChat(text: string, images: string[] = []) {
  const provider = usableProvider();
  if (!provider) {
    pushError({ title: "No AI provider ready", body: "Add a key or start a local server in Settings, AI models." });
    return;
  }
  if (state.chat.providerId !== provider.id || !state.chat.model) await selectProvider(provider.id, state.chat.model);
  const model = state.chat.model;
  if (!model) {
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

  const finish = () => set({ chatPending: false, chat: { ...state.chat, requestId: null } });
  try {
    await bridge.streamChat(requestId, provider.id, model, [...system, ...history], (event) => {
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

function retryLast() {
  const messages = state.chat.messages.slice();
  if (messages[messages.length - 1]?.role === "assistant") messages.pop();
  const user = messages.pop();
  set({ chat: { ...state.chat, messages } });
  if (user) void sendChat(user.content);
}

export function cancelChat() {
  const id = state.chat.requestId;
  if (id) void bridge.cancelChat(id);
}

export const clearChat = () => set({ chat: { ...state.chat, messages: [], usage: null } });

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

export const setAgentMode = (mode: AgentMode) =>
  set({ agentChat: { ...state.agentChat, mode, sessionId: null } });
export const setAgentCwd = (cwd: string) => set({ agentChat: { ...state.agentChat, cwd, sessionId: null } });
export const newAgentConversation = () => set({ agentChat: { ...state.agentChat, sessionId: null } });
export const selectAgentConversation = (sessionId: string) =>
  set({ agentChat: { ...state.agentChat, sessionId } });

export async function sendAgentChat(text: string, images: string[] = []) {
  const { agent, mode, cwd, sessionId } = state.agentChat;
  if (!agent) return;
  const earlier = state.sessions.find((s) => s.id === sessionId);
  // History saved before ids were kept cannot be resumed, so that chat starts afresh.
  if (sessionId && !(earlier?.restored && !earlier.nativeId)) return sendToSession(sessionId, text, images);
  const dir = mode === "project" ? (cwd ?? state.settings.agentDefaultDir) : await bridge.assistantDir();
  if (!dir) {
    pushError({ title: "Choose a project folder", body: "Project mode needs a folder to work in." });
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

function appendLog(s: SessionDetail, kind: LogEntry["kind"], text: string): LogEntry[] {
  const last = s.log[s.log.length - 1];
  const log =
    kind === "text" && last?.kind === "text"
      ? [...s.log.slice(0, -1), { kind, text: last.text + text }]
      : [...s.log, { kind, text }];
  return log.slice(-LOG_LIMIT);
}

// Events travel separately from the reply that names a new session, so a fast
// failure can arrive first. They wait here until the session exists.
const earlyEvents = new Map<string, AgentEnvelope[]>();

export function applyAgentEvent(envelope: AgentEnvelope) {
  const { sessionId, event } = envelope;
  if (event.type === "watched") {
    addWatchedSession(sessionId, event.agent, event.cwd, event.title);
    return;
  }
  // Hooks can outrun the page at startup, and the one event naming a session is
  // then gone. A request for permission must still appear.
  if (sessionId.startsWith("watch:") && !state.sessions.some((s) => s.id === sessionId)) {
    addWatchedSession(sessionId, "Claude Code", "", null);
  }
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) {
    earlyEvents.set(sessionId, [...(earlyEvents.get(sessionId) ?? []), envelope]);
    return;
  }
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
        return { ...s, approval: next ?? null, queued: rest, status: next ? "waiting" : "running" };
      });
      break;
    case "usage":
      patchSession(sessionId, (s) => ({
        ...s,
        usage: { input: event.input, output: event.output, costUsd: event.costUsd },
      }));
      break;
    case "diff":
      patchSession(sessionId, (s) => ({ ...s, log: [...s.log, { kind: "diff" as const, text: event.path, removed: event.removed, added: event.added }].slice(-LOG_LIMIT) }));
      break;
    case "output":
      patchSession(sessionId, (s) => ({ ...s, log: [...s.log, { kind: "output" as const, text: event.command, lines: event.lines, failed: event.failed }].slice(-LOG_LIMIT) }));
      break;
    case "status": {
      const ended = ["completed", "failed", "cancelled"].includes(event.status);
      patchSession(sessionId, (s) => ({
        ...s,
        status: event.status,
        endedAt: ended ? Date.now() : s.endedAt,
        approval: ended ? null : s.approval,
        queued: ended ? [] : s.queued,
        activity: event.message ?? (ended ? "" : s.activity),
        log: event.message ? appendLog(s, "system", event.message) : s.log,
      }));
      if (event.status === "completed") feel("done", 2400);
      if (event.status === "failed") feel("error", 3000);
      if (event.status === "completed" && !state.panelOpen) {
        pushNotice({ tone: "success", title: `${session.agent} finished`, body: session.title, sessionId });
        if (state.settings.sounds) chime("done");
      }
      if (event.status === "failed") {
        pushError({ title: `${session.agent} failed`, body: event.message ?? session.project });
        // A lapsed sign-in is the usual cause, and it should show where you can fix it.
        void refreshAuth(session.agentId);
      }
      break;
    }
  }
}

function addWatchedSession(id: string, agent: string, cwd: string, title: string | null) {
  // A session that went quiet and came back keeps its row.
  if (state.sessions.some((s) => s.id === id)) {
    patchSession(id, (s) => ({ ...s, status: "running", endedAt: null, restored: false }));
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
      title: request.prompt.slice(0, 48),
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
      log: [{ kind: "user", text: request.prompt }],
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
export function answerApproval(sessionId: string, approvalId: string, allow: boolean, answers?: Record<string, string | string[]>) {
  if (Date.now() - lastAnswerAt < ANSWER_GAP_MS) return;
  lastAnswerAt = Date.now();
  feel(allow ? "love" : "error", 1300);
  void bridge.answerApproval(sessionId, approvalId, allow, answers).catch((err) => pushError({ title: "That request has gone", body: describe(err) }));
}

export async function sendToSession(id: string, text: string, images: string[] = []) {
  const session = state.sessions.find((s) => s.id === id);
  patchSession(id, (s) => ({ ...s, log: appendLog(s, "user", text) }));
  try {
    // A conversation from before a restart exists only here until the app is told about it.
    if (session?.restored && session.nativeId) {
      const { agentId: agent, cwd, model, mode, nativeId } = session;
      await bridge.adoptSession({ id, agent, cwd, model, restricted: mode === "general", nativeId });
      patchSession(id, (s) => ({ ...s, restored: false }));
    }
    await bridge.sendToSession(id, text, images);
  } catch (err) {
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
    if (!notice.sticky) setTimeout(() => dismissNotice(notice.id), NOTICE_MS);
  }
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

export async function refreshIntegrations() {
  const accounts = await bridge.accountsList().catch(() => []);
  const [google, microsoft] = await bridge.builtInClients();
  const direct = DIRECT.map((d) => {
    const account = directAccount(d.id, accounts);
    const own = d.id === "outlook" ? state.settings.microsoftClientId : state.settings.googleClientId;
    return { ...d, connected: account !== null, account: account?.email ?? null, ready: (d.id === "outlook" ? microsoft : google) || own !== "" };
  });
  const servers = await bridge.integrationsList().catch(() => []);
  set({ integrations: [...direct, ...servers] });
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

/** One click: the service's own page opens in the browser, and this returns once signed in. */
export async function connectIntegration(integration: Integration) {
  if (integration.access === "account") {
    await connectAccount(integration.id === "outlook" ? "microsoft" : "google", null);
  } else {
    await bridge.integrationConnect(integration.id);
  }
  await refreshIntegrations();
}

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
export async function signInAgent(agent: AgentId) {
  await bridge.agentLogin(agent);
  for (let i = 0; i < SIGN_IN_POLLS; i++) {
    await new Promise((r) => setTimeout(r, SIGN_IN_POLL_MS));
    if ((await refreshAuth(agent))?.signedIn) return true;
  }
  return false;
}

export async function signInProvider(id: string) {
  await bridge.aiSignIn(id);
  await refreshProviders();
}

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

let feelingTimer: ReturnType<typeof setTimeout> | undefined;

/** Shows a feeling on the face for a moment. */
export function feel(feeling: Mood, ms = 1800) {
  clearTimeout(feelingTimer);
  set({ feeling });
  feelingTimer = setTimeout(() => set({ feeling: null }), ms);
}

function onMedia(snapshot: MediaSnapshot) {
  const before = state.media;
  const art = snapshot.current?.artwork ?? null;
  if (art !== before.current?.artwork) {
    if (art) tintOf(art, (artTint) => set({ artTint }));
    else set({ artTint: null });
  }
  const changed = before.current?.title && before.current.title !== snapshot.current?.title;
  const recent = changed
    ? [before.current!, ...before.recent.filter((t) => t.title !== before.current!.title)].slice(0, RECENT_TRACKS)
    : before.recent;
  set({ media: { ...snapshot, reportedAt: Date.now(), recent } });
}

export const mediaAction = (action: MediaAction) => void bridge.mediaAction(action);

// ── Screen awareness ────────────────────────────────────────────────────────

const setScreen = (patch: Partial<ScreenState>) => set({ screen: { ...state.screen, ...patch } });

export const setScreenQuestion = (question: string) => setScreen({ question });
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
  setScreen({ capture: null, question: "", refused: null });
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
  const target = shareTarget();
  const from = capture.window ? ` (${capture.window.process}: ${capture.window.title})` : "";
  const text = capture.text
    ? `${question}\n\nText read from my screen${from}:\n"""\n${capture.text}\n"""`
    : `${question}${from ? `\n\nFrom my screen${from}.` : ""}`;
  const images = includeImage && target.vision ? [capture.image] : [];
  discardCapture();
  setTab("chat");
  void (state.agentChat.agent ? sendAgentChat(text, images) : sendChat(text, images));
}

const suggestionFrom = (s: ScreenSuggestion): Suggestion => ({
  id: s.key,
  key: s.key,
  title: s.title,
  body: s.seen > 1 ? `${s.evidence} (seen ${s.seen} times)` : s.evidence,
});

function onScreenSuggestion(s: ScreenSuggestion) {
  if (state.suggestions.some((x) => x.key === s.key)) return;
  set({ suggestions: [...state.suggestions, suggestionFrom(s)] });
}

export function ignoreSuggestion(suggestion: Suggestion) {
  dismissSuggestion(suggestion.id);
  if (suggestion.key) void bridge.screenIgnore(suggestion.key);
}

/** A suggestion never sends anything. It opens the preview, ready to approve. */
export function assist(suggestion: Suggestion, question: string) {
  dismissSuggestion(suggestion.id);
  setScreen({ question });
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
};

export const PREVIEWS: Preview[] = [
  { name: "idle", apply: () => clear },
  { name: "listening", apply: () => ({ ...clear, listening: true }) },
  { name: "thinking", apply: () => ({ ...clear, chatPending: true }) },
  { name: "question", apply: () => ({ ...clear, sessions: [{ ...previewSession("p1", "Claude Code", "dock-agent", "Waiting"), approval: { id: "pq", tool: "AskUserQuestion", summary: "Which database should this use?", questions: [{ text: "Which database should this use?", options: ["SQLite", "Postgres", "Keep it in memory"], multi: false }] } }] }) },
  { name: "plan", apply: () => ({ ...clear, sessions: [{ ...previewSession("p1", "Claude Code", "dock-agent", "Waiting"), approval: { id: "pp", tool: "ExitPlanMode", summary: "Add a settings page", plan: "## Add a settings page\n\n1. Create `Settings.tsx`\n2. Save choices with **updateSettings**\n3. Add it to the dock\n\nThis touches three files and needs no new packages." } }] }) },
  { name: "working", apply: () => ({ ...clear, sessions: [previewSession("p1", "Claude Code", "dock-agent", "Editing island/machine.ts")] }) },
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
        previewSession("p1", "Claude Code", "backend", "Running migrations"),
        previewSession("p2", "Codex", "frontend", "Reviewing Island.tsx"),
        previewSession("p3", "Ollama", "docs", "Summarising architecture", { status: "waiting" }),
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

export function showPreview(name: string | null) {
  const preview = PREVIEWS.find((p) => p.name === name);
  if (preview) {
    beforePreview ??= {
      panelOpen: state.panelOpen,
      listening: state.listening,
      chatPending: state.chatPending,
      sessions: state.sessions,
      notices: state.notices,
      suggestions: state.suggestions,
      errors: state.errors,
      media: state.media,
      live: state.live,
    };
    set({ ...preview.apply(), preview: preview.name });
  } else {
    set({ ...beforePreview, preview: null });
    beforePreview = null;
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
  if (!settings.onboarded) set({ notices: [{ id: "welcome", tone: "info", title: "Welcome to Meridian", body: "Click here to set up", sticky: true }] });
  else if (native) {
    set({ greeting: true });
    setTimeout(() => set({ greeting: false }), GREETING_MS);
  }
  setInterval(refreshLive, LIVE_EVERY_MS);
  void refreshIntegrations();
  void bridge.builtInClients().then((builtInClients) => set({ builtInClients }));
  void bridge.watchStatus().then((watching) => set({ watching }));
  void bridge.appVersion().then((version) => set({ version }));
  if (settings.localOnly) set({ update: { available: false, message: "Update checks are off in local-only mode." } });
  else
    void bridge.checkUpdate().then(
      (update) => set({ update }),
      () => set({ update: { available: false, message: "Could not check for updates." } }),
    );
  setInterval(fetchInBackground, FETCH_EVERY_MS);
  for (const a of agents) if (a.installed) void refreshAuth(a.id);
  await Promise.all([
    bridge.onAgentEvent(applyAgentEvent),
    bridge.onHover(setHovered),
    bridge.onGaze((x, y) => {
      const island = document.querySelector<HTMLElement>(".island");
      island?.style.setProperty("--gx", `${(x * 4).toFixed(1)}px`);
      island?.style.setProperty("--gy", `${(y * 3).toFixed(1)}px`);
    }),
    bridge.onTogglePanel(togglePanel),
    bridge.onBlur(() => {
      if (state.panelOpen && !bridge.dialogOpen()) closePanel();
    }),
    bridge.onOpenTab((tab) => openPanel(tab as Tab)),
    bridge.onMedia(onMedia),
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
