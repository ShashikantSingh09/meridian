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

export interface Approval {
  id: string;
  tool: string;
  summary: string;
}

export type AgentEvent =
  | { type: "started"; nativeId: string | null; model: string | null }
  | { type: "status"; status: SessionStatus; message?: string | null }
  | { type: "text"; text: string }
  | { type: "activity"; label: string }
  | { type: "approval"; approval: Approval }
  | { type: "approvalResolved"; id: string }
  | { type: "usage"; input: number; output: number; costUsd: number | null };

export interface AgentEnvelope {
  sessionId: string;
  event: AgentEvent;
}

export interface Settings {
  theme: "system" | "dark" | "light";
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
  screenMode: "off" | "ondemand" | "contextual";
  screenIntervalSecs: number;
  screenExclusions: string[];
  monitoringPaused: boolean;
  mediaEnabled: boolean;
  activity: ActivityPreferences;
  googleClientId: string;
  microsoftClientId: string;
  showNextMeeting: boolean;
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

export type MediaAction =
  | { action: "toggle" | "next" | "previous" }
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
  theme: "system",
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
  showClock: false,
  animationSpeed: 1,
  agentDefaultDir: null,
  screenMode: "ondemand",
  screenIntervalSecs: 20,
  screenExclusions: [],
  monitoringPaused: false,
  mediaEnabled: true,
  activity: { categories: {}, quietHours: null, maxPerHour: null },
  googleClientId: "",
  microsoftClientId: "",
  showNextMeeting: true,
};
