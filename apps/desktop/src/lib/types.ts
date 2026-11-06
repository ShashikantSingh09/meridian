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
  /** The whole request, when `summary` leaves part of it out. Allow waits until it has been opened. */
  full?: string;
  /** The request's length in characters, when even `full` had to stop short. */
  length?: number;
  /** The folder an agent would start in, for the assistant's Start an agent. */
  folder?: string;
  /** Why this one asks, when it would not usually. */
  why?: string;
}

/** Whether the Claude Code hooks are where following needs them. */
export interface HooksHealth {
  on: boolean;
  inPlace: boolean;
  /** Projects that turn every hook off in their own settings. */
  offIn: string[];
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
  | { type: "watched"; agent: string; cwd: string; title: string | null; pid?: number | null }
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
  /** Where the island was dragged to, by display. Kept by the core, which is the only one that moves it. */
  islandSpots: Record<string, { x: number; y: number; up: boolean }>;
  islandAutoHide: boolean;
  showClock: boolean;
  /** A laptop's charge beside the clock. */
  showBattery: boolean;
  /** A ring by the clock for how much of the Claude plan is used. */
  showUsage: boolean;
  /** Whether to look for new versions by itself. Null until asked. */
  updateChecks: boolean | null;
  /** The version the user last saw What's new for. */
  lastSeenVersion: string | null;
  /** Other apps go quiet while the user talks to the assistant. */
  hushWhileTalking: boolean;
  /** Calls keep their sound while the room goes quiet. */
  hushLeaveCalls: boolean;
  /** A recording nobody speaks in for 15 minutes offers to stop. */
  stopQuietCalls: boolean;
  animationSpeed: number;
  agentDefaultDir: string | null;
  voiceProvider: string;
  voiceId: string | null;
  voiceHearing: string;
  /** Writes the summary as soon as a call's transcript is done. */
  notesSummary: boolean;
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
  /** A few things to ask, under Home's ask box. */
  homeSuggestions: boolean;
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
  /** Write here, Fill this form and Finish this for me. Kept for the fill engine to read. */
  fill: FillSettings;
  /** What Knowledge learns from, and when it updates. Every source is off until turned on. */
  knowledge: KnowledgePreferences;
  /** Which cards My Day shows, and the morning line on the island. */
  myDay: MyDaySettings;
}

/** An app or site, as answered the first time Meridian filled in it. */
export interface FillPlace {
  /** The app's process name or the site's address, like slack.exe or mail.google.com. */
  id: string;
  name: string;
  fill: "allowed" | "ask" | "never";
  /** Finish this for me may work here too. Its own yes, per app. */
  finish: boolean;
  /** A bank, tax or government site, which asks every time. */
  alwaysAsk: boolean;
}

export interface FillSettings {
  on: boolean;
  key: "ctrl-alt-f" | "off";
  buttons: boolean;
  /** The engine that decides what goes where. It never sees Your details. */
  ai: string;
  /** Experimental, off until turned on with its own switch. */
  finish: boolean;
  finishAi: string;
  places: FillPlace[];
  sources: { details: boolean; knowledge: boolean; mail: boolean; notes: boolean; files: boolean; clipboard: boolean; picture: boolean };
}

/** How one Write here ended, as the core says. No message holds what a box held. */
export type HereOutcome =
  | { outcome: "written" }
  | { outcome: "line"; text: string }
  /** Asks first, naming the place. With `every` it asks every time, else this is the first time. */
  | { outcome: "ask"; key: string; id: string | null; name: string; every: string | null }
  | { outcome: "off"; id: string; name: string }
  | { outcome: "local"; ai: string }
  | { outcome: "failed"; why: string }
  | { outcome: "moved"; title: string }
  | { outcome: "stopped" }
  /** Fill this form went through the form. */
  | { outcome: "filled"; form: FormSummary }
  /** Fill this form found one box only, so Write here takes it. */
  | { outcome: "single" };

/** Where one box of a form is up to. `by-you`: it needed the user, and they have been in it on the page. */
export type FormRowState = "waiting" | "filled" | "yours" | "needs-you" | "kept" | "ask-first" | "put-back" | "by-you";
/** Where a value came from. Your details are put in by Meridian and never go to the AI. `typed`: on the island. */
export type FormOrigin = "details" | "knowledge" | "mail" | "notes" | "file" | "clipboard" | "page" | "said" | "written-by-ai" | "typed";

/** One choice of a question, by its box. */
export interface FormChoice {
  field: number;
  label: string;
}

/** One box of a form, or one question of choices, for the Show list. */
export interface FormRow {
  field: number;
  label: string;
  kind: string;
  state: FormRowState;
  origin?: FormOrigin;
  /** The Knowledge page, mail or file it came from. For a choice Your details answered, the detail, such as "company". */
  from: string;
  /** What went in. An ID number is masked. */
  value: string;
  /** Why it was left. */
  why: string;
  /** A question's choices, a button each. Its `field` is the one picked. */
  choices?: FormChoice[];
  /** The Your details key what the user types here can be kept under, when Your details has nothing for it. */
  key?: string;
}

/** A form as Fill this form left it. */
export interface FormSummary {
  site: string;
  filled: number;
  total: number;
  need: number;
  rows: FormRow[];
  /** ID numbers waiting for a yes, by name, such as PAN. */
  ids: string[];
  /** Offers to start Your details, naming what the form asked for. */
  details: string[] | null;
  canUndo: boolean;
  /** Why the run ended before every box. */
  stopped: string | null;
  /** Something asked for that could not be read, such as Gmail. */
  note: string | null;
}

/** How an Undo of a form went. */
export interface FormUndone {
  putBack: number;
  /** Boxes the user changed since, which keep what they typed. */
  kept: string[];
  form: FormSummary;
}

/** The box being filled, or a source being read first. */
export interface FormProgress {
  done: number;
  total: number;
  reading: "mail" | null;
}

/** What the island offers: Fill this form when the cursor is in a box of a form, else Write here. */
export interface HereOffer {
  window: number;
  form: boolean;
}

/** What to write: words the user asked for, or words already written. A yes for one place, once. */
export interface HereRequest {
  instruction: string | null;
  text: string | null;
  allow: string | null;
  /** The window whose box had the cursor when a question was asked on the island. The answer goes only there. */
  window: number | null;
}

export interface KnowledgePreferences {
  notes: boolean;
  gmail: boolean;
  calendar: boolean;
  chats: boolean;
  when: "idle" | "manual";
}

/** Which cards My Day shows, and the morning line on the island. */
export interface MyDaySettings {
  replies: boolean;
  renewals: boolean;
  trips: boolean;
  summary: boolean;
}

export type CardKind = "reply" | "renewal" | "trip";

interface CardBase {
  /** The thing it is about, so the same card is found again however often it is read. */
  id: string;
  /** When what it was built from happened: the mail's arrival, or the event's start, in RFC 3339. */
  seen: string;
  /** The mail in Gmail, or the event in Google Calendar. */
  link: string | null;
  /** Not now: hidden until then, in ms. */
  hiddenUntil: number | null;
}

/** A card at the top of My Day. The core decides what counts as one. */
export type Card = CardBase &
  (
    | { kind: "reply"; who: string; address: string; subject: string; asked: string; draft: string | null }
    | { kind: "renewal"; service: string; amount: string | null; on: string; period: "week" | "month" | "year" | null; trial: boolean; receipt: boolean }
    | { kind: "trip"; event: string; starts: string; location: string; place: string; title: string; step: string; site: { name: string; url: string }; planned: boolean }
  );

/** A source that could not be read. `why` follows "because", and is empty when it is not known. */
export interface CardFailure {
  source: "gmail" | "calendar";
  why: string;
}

export interface CardsState {
  cards: Card[];
  failures: CardFailure[];
  checking: boolean;
  checkedAt: number | null;
}

export type KnowledgeKind = "person" | "project" | "promise" | "place";
export type KnowledgeSource = "notes" | "gmail" | "calendar" | "chats";

export interface KnowledgeRef {
  label: string;
  /** meridian:note/<id>, meridian:chat, or a Gmail or Google Calendar address. */
  target: string;
}

export interface KnowledgeLine {
  /** Its line in the file, for ticking it. */
  at: number;
  text: string;
  source: KnowledgeRef | null;
  /** The user wrote or changed it, so no update touches it. */
  yours: boolean;
  /** A promise's tick box. */
  done: boolean | null;
  bullet: boolean;
}

export interface KnowledgePage {
  /** Inside the Knowledge folder, as "People/Asha Rao.md". */
  path: string;
  kind: KnowledgeKind;
  title: string;
  about: string;
  subtitle: string;
  sections: { heading: string; lines: KnowledgeLine[] }[];
  linked: string[];
  sources: KnowledgeRef[];
  /** When the file last changed, in ms. */
  updated: number;
}

export interface KnowledgeSourceStatus {
  id: KnowledgeSource;
  state: "waiting" | "reading" | "read" | "done" | "skipped";
  found: number;
  why: string;
  signIn: boolean;
}

export interface KnowledgeStatus {
  running: boolean;
  done: number;
  total: number;
  now: string;
  sources: KnowledgeSourceStatus[];
  failed: string | null;
}

export interface KnowledgeState {
  pages: KnowledgePage[];
  status: KnowledgeStatus;
  updatedAt: number | null;
  folder: string;
  /** Finished call notes on this PC. */
  calls: number;
}

export interface KnowledgeHit {
  path: string;
  kind: KnowledgeKind;
  title: string;
  snippet: string;
  /** The snippet is quoted from the page. */
  quote: boolean;
}

/** Where a provider's data comes from and how it signs in. "account" is the direct
 *  Google or Microsoft connector; the rest are MCP servers. */
export type IntegrationAccess = "open" | "registeredApp" | "tokenOrApp" | "account";

export type NoteStatus = "recording" | "writing" | "ready" | "failed";

export interface NoteSpeaker {
  id: string;
  name: string;
  color: number;
  you: boolean;
}

export interface NoteLine {
  id: string;
  speaker: string;
  start: number;
  end: number;
  text: string;
}

export interface NoteTodo {
  id: string;
  text: string;
  owner: string | null;
  due: string | null;
  done: boolean;
}

export interface Note {
  id: string;
  title: string;
  titleEdited: boolean;
  startedAt: number;
  endedAt: number | null;
  status: NoteStatus;
  speakers: NoteSpeaker[];
  lines: NoteLine[];
  summary: string | null;
  keyPoints: string[];
  todos: NoteTodo[];
  error: string | null;
}

export interface NotesState {
  notes: Note[];
  /** The note being recorded. */
  recording: string | null;
  /** Notes whose transcript or summary is being written. */
  working: string[];
}

export interface NoteLevels {
  you: number;
  others: number;
}

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
  /** Reached through the user's Claude account, which holds the sign-in, and whether it is connected there. */
  viaClaude?: "on" | "off";
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

/** A laptop's charge, and whether the charger is in. */
export interface Charge {
  percent: number;
  plugged: boolean;
}

/** The notch on the top edge, or floating and growing down or up. */
export type IslandPlace = "top" | "down" | "up";

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
  islandSpots: {},
  islandAutoHide: false,
  showClock: true,
  showBattery: true,
  showUsage: false,
  updateChecks: null,
  lastSeenVersion: null,
  hushWhileTalking: true,
  hushLeaveCalls: true,
  stopQuietCalls: true,
  animationSpeed: 1,
  agentDefaultDir: null,
  voiceProvider: "windows",
  voiceId: null,
  voiceHearing: "local",
  notesSummary: true,
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
  homeSuggestions: true,
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
  fill: {
    on: false,
    key: "ctrl-alt-f",
    buttons: true,
    ai: "claude-code",
    finish: false,
    finishAi: "claude-code",
    places: [],
    sources: { details: true, knowledge: true, mail: true, notes: true, files: true, clipboard: true, picture: false },
  },
  knowledge: { notes: false, gmail: false, calendar: false, chats: false, when: "idle" },
  myDay: { replies: true, renewals: true, trips: true, summary: true },
};
