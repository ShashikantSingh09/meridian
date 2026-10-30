// App state and the actions that change it. One store, read with useApp(selector).

import { useSyncExternalStore } from "react";
import type { IslandError, Notice, SessionSummary, Suggestion } from "../island/machine";
import { bridge, type StartSession } from "./bridge";
import type {
  AgentEnvelope,
  AgentId,
  AgentInfo,
  Approval,
  AuthStatus,
  Capture,
  ChatMessage,
  ModelInfo,
  MediaAction,
  MediaSnapshot,
  ProviderInfo,
  ScreenSuggestion,
  Settings,
  Track,
} from "./types";
import { defaultSettings } from "./types";

export type Tab = "home" | "chat" | "agents" | "desktop" | "media" | "providers" | "settings";

export interface LogEntry {
  kind: "user" | "text" | "activity" | "system";
  text: string;
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

export interface AppState {
  panelOpen: boolean;
  screen: ScreenState;
  media: MediaState;
  tab: Tab;
  listening: boolean;
  hovered: boolean;
  glass: boolean;
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
}

const LOG_LIMIT = 500;
const NOTICE_MS = 6000;

let state: AppState = {
  panelOpen: false,
  media: { current: null, sessions: [], reportedAt: 0, recent: [] },
  screen: { capture: null, capturing: false, question: "", includeImage: true, refused: null },
  tab: "home",
  listening: false,
  hovered: false,
  glass: false,
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
};

const listeners = new Set<() => void>();

function set(patch: Partial<AppState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
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
  set({ panelOpen: true, tab: tab ?? state.tab, notices: [] });
  void bridge.setInteractive(true);
  void refreshLocal();
}

export function closePanel() {
  set({ panelOpen: false });
  void bridge.setInteractive(false);
}

export const togglePanel = () => (state.panelOpen ? closePanel() : openPanel());
export const setTab = (tab: Tab) => set({ tab });
export const setHovered = (hovered: boolean) => set({ hovered });
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
  document.documentElement.dataset.theme = s.theme;
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
    pushError({ title: "No AI provider ready", body: "Add a key or start a local server in Providers." });
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
  if (sessionId) return sendToSession(sessionId, text, images);
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
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) {
    earlyEvents.set(sessionId, [...(earlyEvents.get(sessionId) ?? []), envelope]);
    return;
  }
  switch (event.type) {
    case "started":
      patchSession(sessionId, (s) => ({ ...s, model: event.model }));
      break;
    case "text":
      patchSession(sessionId, (s) => ({ ...s, log: appendLog(s, "text", event.text) }));
      break;
    case "activity":
      patchSession(sessionId, (s) => ({ ...s, activity: event.label, log: appendLog(s, "activity", event.label) }));
      break;
    case "approval":
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
      if (event.status === "completed" && !state.panelOpen)
        pushNotice({ tone: "success", title: `${session.agent} finished`, body: session.title, sessionId });
      if (event.status === "failed") {
        pushError({ title: `${session.agent} failed`, body: event.message ?? session.project });
        // A lapsed sign-in is the usual cause, and it should show where you can fix it.
        void refreshAuth(session.agentId);
      }
      break;
    }
  }
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
export const answerApproval = (sessionId: string, approvalId: string, allow: boolean) =>
  void bridge.answerApproval(sessionId, approvalId, allow);

export async function sendToSession(id: string, text: string, images: string[] = []) {
  patchSession(id, (s) => ({ ...s, log: appendLog(s, "user", text) }));
  try {
    await bridge.sendToSession(id, text, images);
  } catch (err) {
    pushError({ title: "Message not delivered", body: describe(err) });
  }
}

// ── Media ───────────────────────────────────────────────────────────────────

const RECENT_TRACKS = 8;

function onMedia(snapshot: MediaSnapshot) {
  const before = state.media;
  const changed = before.current && before.current.title !== snapshot.current?.title;
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
  openPanel("desktop");
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

const clear: Partial<AppState> = {
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
    };
    set({ ...preview.apply(), preview: preview.name });
  } else {
    set({ ...beforePreview, preview: null });
    beforePreview = null;
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────

export async function boot() {
  const [settings, providers, agents, glass] = await Promise.all([
    bridge.getSettings(),
    bridge.listProviders(),
    bridge.detectAgents(),
    bridge.glassStatus(),
  ]);
  applyAppearance(settings);
  document.documentElement.dataset.glass = glass ? "native" : "fallback";
  set({ settings, providers, agents, glass });
  void refreshLocal();
  void bridge.monitors().then((monitors) => set({ monitors }));
  for (const a of agents) if (a.installed) void refreshAuth(a.id);
  await Promise.all([
    bridge.onAgentEvent(applyAgentEvent),
    bridge.onHover(setHovered),
    bridge.onTogglePanel(togglePanel),
    bridge.onBlur(() => {
      if (state.panelOpen && !bridge.dialogOpen()) closePanel();
    }),
    bridge.onOpenTab((tab) => openPanel(tab as Tab)),
    bridge.onMedia(onMedia),
    bridge.onScreenSuggestion(onScreenSuggestion),
    bridge.onCaptureRequest(() => {
      openPanel("desktop");
      void captureScreen("window");
    }),
  ]);
}

export const newSessionDefaults = (): Pick<StartSession, "agent"> | null => {
  const agent = state.agents.find((a) => a.installed);
  return agent ? { agent: agent.id } : null;
};
