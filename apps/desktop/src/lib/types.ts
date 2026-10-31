// Wire types shared with the Rust core. Keep in step with crates/ai-core and
// crates/agent-adapters: field names there are serialised in camelCase.

export interface Capabilities {
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  modelDiscovery: boolean;
  usage: boolean;
}

export type ProviderKind = "cloud" | "local" | "custom";

export interface ProviderInfo {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  needsKey: boolean;
  hasKey: boolean;
  capabilities: Capabilities;
}

export interface ModelInfo {
  id: string;
  label: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  /** Data URLs the user approved for sharing. */
  images?: string[];
}

export interface ScreenSignal {
  kind: string;
  title: string;
  evidence: string;
}

export interface Capture {
  image: string;
  text: string;
  window: { title: string; process: string } | null;
  signals: ScreenSignal[];
  width: number;
  height: number;
}

export interface ScreenSuggestion {
  key: string;
  title: string;
  evidence: string;
  app: string;
  seen: number;
}

export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "usage"; input: number; output: number }
  | { type: "done" }
  | { type: "error"; kind: ErrorKind; message: string };

export type ErrorKind =
  | "auth"
  | "rateLimit"
  | "unavailable"
  | "badRequest"
  | "network"
  | "cancelled"
  | "other";

export interface LocalServer {
  providerId: string;
  baseUrl: string;
  models: string[];
}

export type AgentId = "claude-code" | "codex";

export interface AgentInfo {
  id: AgentId;
  name: string;
  installed: boolean;
  path: string | null;
  version: string | null;
  capabilities: {
    approvals: boolean;
    resume: boolean;
    usage: boolean;
    progress: boolean;
  };
}

export type SessionStatus =
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface Question {
  text: string;
  options: string[];
  /** What each option means, in the same order. Empty where the agent gave nothing. */
  details?: string[];
  multi: boolean;
}

/** One line of an agent's own to-do list. */
export interface Todo {
  id: string;
  text: string;
  /** "pending", "in_progress" or "completed", as the agent says it. */
  status: string;
}

export interface Approval {
  id: string;
  tool: string;
  summary: string;
  /** Something to choose, when Claude Code asks a question. */
  questions?: Question[];
  /** The plan to approve. */
  plan?: string;
}

/** What a change to a settings file would do, shown before it is made. */
export interface SettingsChange {
  path: string;
  backup: string;
  lines: { kind: "added" | "removed" | "plain" | "gap"; text: string }[];
}

export interface LimitWindow {
  window: string;
  usedPercent: number;
  /** Seconds since 1970. */
  resetsAt: number | null;
}

export type AgentEvent =
  | { type: "watched"; agent: string; cwd: string; title: string | null }
  | { type: "started"; nativeId: string | null; model: string | null }
  | { type: "status"; status: SessionStatus; message?: string | null }
  | { type: "text"; text: string }
  | { type: "activity"; label: string }
  | { type: "approval"; approval: Approval }
  | { type: "approvalResolved"; id: string }
  | { type: "usage"; input: number; output: number; costUsd: number | null }
  | { type: "limits"; windows: LimitWindow[] }
  | { type: "context"; used: number | null; size: number | null }
  | { type: "diff"; path: string; removed: string[]; added: string[]; linesRemoved: number; linesAdded: number }
  | { type: "output"; command: string; lines: string[]; failed: boolean }
  | { type: "todos"; items: Todo[] }
  | { type: "todoChanged"; id: string; text?: string | null; status?: string | null };

export interface AgentEnvelope {
  sessionId: string;
  event: AgentEvent;
}

export interface CustomTheme {
  id: string;
  name: string;
  light: boolean;
  accent: string;
  window: string;
}

export interface WakeWord {
  text: string;
  on: boolean;
}

/** Whether the microphone is open for wake words, and if not, why. */
/** How the Windows default microphone did during a wake word test. */
export interface WakeTested {
  name: string;
  percent: number;
  muted: boolean;
  level: number;
}

export interface WakeStatus {
  state: "off" | "listening" | "paused" | "failed";
  why: string;
}

export interface Settings {
  motion: "system" | "full" | "reduced";
  ambient: boolean;
  autostart: boolean;
  defaultProvider: string | null;
  defaultModel: string | null;
  providerBaseUrls: Record<string, string>;
  systemPrompt: string;
  localOnly: boolean;
  islandMonitor: string;
  islandAlign: "left" | "center" | "right";
  islandAutoHide: boolean;
  showClock: boolean;
  animationSpeed: number;
  agentDefaultDir: string | null;
  voiceProvider: string;
  voiceId: string | null;
  voiceHearing: string;
  voiceInterrupt: boolean;
  assistantName: string;
  assistantPersonality: string;
  /** The microphone and output chosen for conversations, or null to follow Windows. */
  voiceMicrophone: string | null;
  voiceOutput: string | null;
  theme: string;
  themeUse: "theme" | "windows" | "time";
  themeDark: string;
  themeLight: string;
  /** From clear to tinted, 0 to 100. */
  glass: number;
  customThemes: CustomTheme[];
  /** What the assistant calls the user. Empty uses no name. */
  assistantCallsYou: string;
  assistantStyle: string;
  wakeEnabled: boolean;
  wakeWords: WakeWord[];
  wakeSensitivity: "sure" | "balanced" | "easily";
  wakeAfter: "turn" | "conversation";
  wakeListen: "always" | "charger";
  wakePauseCalls: boolean;
  wakePauseLocked: boolean;
  screenMode: "off" | "ondemand" | "contextual";
  screenIntervalSecs: number;
  screenExclusions: string[];
  monitoringPaused: boolean;
  mediaEnabled: boolean;
  activity: ActivityPreferences;
  googleClientId: string;
  microsoftClientId: string;
  showNextMeeting: boolean;
  sounds: boolean;
  onboarded: boolean;
  /** Which face lives on the island. */
  face: string;
}

/** Where a provider's data comes from and how it signs in. "account" is the direct
 *  Google or Microsoft connector; the rest are MCP servers. */
export type IntegrationAccess = "open" | "registeredApp" | "tokenOrApp" | "account";

export interface Integration {
  id: string;
  name: string;
  group: string;
  blurb: string;
  access: IntegrationAccess;
  connected: boolean;
  account: string | null;
  /** One click works. False until the publisher has registered this service once. */
  ready: boolean;
}

export interface FetchedItem {
  key: string;
  title: string;
  detail: string | null;
  url: string | null;
  when: string | null;
}

export interface Digest {
  server: string | null;
  tool: string | null;
  /** Other read-only tools the server offers. */
  tools: string[];
  items: FetchedItem[];
  text: string | null;
}

export interface Track {
  session: string;
  app: string;
  title: string;
  artist: string;
  album: string;
  playing: boolean;
  positionMs: number | null;
  durationMs: number | null;
  canToggle: boolean;
  canNext: boolean;
  canPrevious: boolean;
  canSeek: boolean;
  artwork: string | null;
}

export interface MediaSnapshot {
  current: Track | null;
  sessions: Track[];
}

export interface VoiceInfo {
  id: string;
  name: string;
  note: string;
}

export type Level =
  | { kind: "volume"; percent: number; muted: boolean }
  | { kind: "brightness"; percent: number }
  | { kind: "battery"; percent: number; plugged: boolean; saver: boolean; secondsLeft: number | null; secondsToFull: number | null; watts: number | null; health: number | null };

export type MediaAction =
  | { action: "toggle" | "next" | "previous" | "refresh" }
  | { action: "seek"; positionMs: number }
  | { action: "select"; session: string };

export type Priority = "low" | "informational" | "important" | "critical";
export type EventStatus = "active" | "updated" | "cancelled" | "completed" | "dismissed";
export type Category = "today" | "upcoming" | "travel" | "deliveries" | "meetings" | "orders" | "importantDates" | "completed";

/** A time at the precision its source stated. Date and naive values have no zone. */
export type EventTime =
  | { kind: "date"; value: string }
  | { kind: "naive"; value: string }
  | { kind: "zoned"; value: string };

export interface SuggestedAction {
  label: string;
  actionId: string;
  url: string | null;
}

export interface SourceRef {
  account: string;
  messageId: string;
  subject: string;
  receivedAt: string;
  link: string | null;
}

export interface ContextEvent {
  id: string;
  kind: string;
  source: string;
  occurredAt: string;
  startsAt: EventTime | null;
  endsAt: EventTime | null;
  title: string;
  body: string | null;
  metadata: Record<string, unknown>;
  confidence: number;
  priority: Priority;
  status: EventStatus;
  suggestedActions: SuggestedAction[];
  expiresAt: string | null;
  dedupeKey: string;
  sourceRef: SourceRef | null;
  userEdited: boolean;
  revision: number;
  changedFields: string[];
  snoozedUntil: string | null;
}

export interface Reminder {
  key: string;
  eventId: string;
  stage: { type: "lead"; minutes: number } | { type: "changed" | "rescheduled" | "cancelled" };
  priority: Priority;
  title: string;
  startsAt: EventTime | null;
  approximateTime: boolean;
  actions: SuggestedAction[];
}

export interface ReminderLogEntry {
  key: string;
  eventId: string;
  stage: Reminder["stage"];
  startsAt: EventTime | null;
  disposition: "surfaced" | "centre" | "held";
  at: string;
}

export interface ConnectedAccount {
  id: string;
  provider: "google" | "microsoft";
  email: string | null;
  scopes: string[];
  connectedAt: string;
  lastSyncAt: string | null;
}

export interface ActivityPreferences {
  categories: Partial<Record<Category, { enabled: boolean; leadMinutes: number[] }>>;
  quietHours: { start: string; end: string } | null;
  maxPerHour: number | null;
}

/** What a CLI reports about its own sign-in. */
export interface AuthStatus {
  signedIn: boolean | null;
  method: string | null;
  plan: string | null;
}

export const defaultSettings: Settings = {
  motion: "system",
  ambient: true,
  autostart: false,
  defaultProvider: null,
  defaultModel: null,
  providerBaseUrls: {},
  systemPrompt: "",
  localOnly: false,
  islandMonitor: "primary",
  islandAlign: "center",
  islandAutoHide: false,
  showClock: true,
  animationSpeed: 1,
  agentDefaultDir: null,
  voiceProvider: "windows",
  voiceId: null,
  voiceHearing: "local",
  voiceInterrupt: true,
  assistantName: "Meridian",
  assistantPersonality: "",
  voiceMicrophone: null,
  voiceOutput: null,
  theme: "midnight",
  themeUse: "theme",
  themeDark: "midnight",
  themeLight: "daylight",
  glass: 58,
  customThemes: [],
  assistantCallsYou: "",
  assistantStyle: "calm",
  wakeEnabled: false,
  wakeWords: [{ text: "Hey Meridian", on: true }, { text: "Okay Meridian", on: false }],
  wakeSensitivity: "balanced",
  wakeAfter: "turn",
  wakeListen: "always",
  wakePauseCalls: true,
  wakePauseLocked: true,
  screenMode: "ondemand",
  screenIntervalSecs: 20,
  screenExclusions: [],
  monitoringPaused: false,
  mediaEnabled: true,
  activity: { categories: {}, quietHours: null, maxPerHour: null },
  googleClientId: "",
  microsoftClientId: "",
  showNextMeeting: true,
  sounds: true,
  onboarded: false,
  face: "soft",
};
