// Stands in for the Rust core when the UI runs in a plain browser, which is how
// the Playwright suite exercises the interface. Never loaded inside Tauri paths.

import type {
  AgentEnvelope,
  AgentEvent,
  AgentId,
  AgentInfo,
  AuthStatus,
  Capture,
  Category,
  ChatEvent,
  ConnectedAccount,
  ContextEvent,
  Digest,
  EventTime,
  Integration,
  LocalServer,
  MediaAction,
  MediaSnapshot,
  ModelInfo,
  ProviderInfo,
  Reminder,
  Settings,
  SettingsChange,
  Level,
} from "./types";
import { defaultSettings } from "./types";

const caps = { streaming: true, tools: true, vision: false, modelDiscovery: true, usage: true };

const providers: ProviderInfo[] = [
  { id: "anthropic", name: "Anthropic", kind: "cloud", baseUrl: "https://api.anthropic.com", needsKey: true, hasKey: true, capabilities: { ...caps, vision: true } },
  { id: "openai", name: "OpenAI", kind: "cloud", baseUrl: "https://api.openai.com/v1", needsKey: true, hasKey: false, capabilities: caps },
  { id: "ollama", name: "Ollama", kind: "local", baseUrl: "http://localhost:11434/v1", needsKey: false, hasKey: false, capabilities: { ...caps, usage: false } },
];

let settings: Settings = { ...defaultSettings, onboarded: true };
let emit: (e: AgentEnvelope) => void = () => {};
let authed = true;
let pushReminders: (r: Reminder[]) => void = () => {};
let accounts: ConnectedAccount[] = [];
const known = new Set<string>();
const voicePacks = new Set<string>();
const voiceKeys = new Set<string>();
let heardWords = "";
const spokenWords: string[] = [];
let updateStatus = { current: "0.3.0", latest: "v0.3.0", available: false, notes: "", published: null as string | null, message: "You are on the latest version." };
let updateInstalled = false;
let failInstalling: (why: Error) => void = () => {};
let signInGate: Promise<void> | null = null;
let failSigningIn: (why: Error) => void = () => {};
let pushLevel: (level: Level) => void = () => {};
let watching = false;
let lastAnswers: Record<string, string | string[]> | null = null;
let integrations: Integration[] = [
  { id: "linear", name: "Linear", group: "Work", blurb: "Issues assigned to you.", access: "open", connected: false, account: null, ready: true },
  { id: "slack", name: "Slack", group: "Work", blurb: "Channels you belong to.", access: "registeredApp", connected: false, account: null, ready: false },
  { id: "github", name: "GitHub", group: "Development", blurb: "Your notifications and issues.", access: "tokenOrApp", connected: false, account: null, ready: false },
];
const sampleEvent = (id: string, title: string, kind: string, over: Partial<ContextEvent> = {}): ContextEvent => ({
  id,
  kind,
  source: "email",
  occurredAt: "2026-10-30T09:00:00Z",
  startsAt: { kind: "zoned", value: "2026-10-31T10:30:00+05:30" },
  endsAt: null,
  title,
  body: null,
  metadata: {},
  confidence: 0.95,
  priority: "important",
  status: "active",
  suggestedActions: [],
  expiresAt: null,
  dedupeKey: id,
  sourceRef: { account: "me@example.com", messageId: "m1", subject: `Confirmation: ${title}`, receivedAt: "2026-10-30T09:00:00Z", link: null },
  userEdited: false,
  revision: 1,
  changedFields: [],
  snoozedUntil: null,
  ...over,
});
let events: ContextEvent[] = [
  sampleEvent("e1", "Flight 6E 2341 to Delhi", "flight"),
  sampleEvent("e2", "Package from Sample Store", "delivery", { confidence: 0.55, priority: "informational", startsAt: { kind: "date", value: "2026-10-31" } }),
];
const inCategory = (e: ContextEvent, category: Category | null) => {
  if (!category || category === "today" || category === "upcoming") return true;
  return (category === "travel" && e.kind === "flight") || (category === "deliveries" && e.kind === "delivery");
};
let pushMedia: (s: MediaSnapshot) => void = () => {};
const sampleTrack = {
  session: "Spotify.exe",
  app: "Spotify",
  title: "Northern Lights",
  artist: "Sample Artist",
  album: "Sample Album",
  playing: true,
  positionMs: 42_000,
  durationMs: 210_000,
  canToggle: true,
  canNext: true,
  canPrevious: true,
  canSeek: true,
  artwork: null,
};
let track = { ...sampleTrack };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pendingSecond = (sessionId: string) =>
  (window as never as { __meridian: { getState(): { sessions: { id: string; approval: { id: string } | null }[] } } })
    .__meridian.getState()
    .sessions.find((s) => s.id === sessionId)?.approval?.id === "a2";

export const mock = {
  getSettings: async () => settings,
  saveSettings: async (next: Settings) => void (settings = next),
  listProviders: async () => providers.map((p) => ({ ...p })),
  setProviderKey: async (id: string) => void providers.filter((p) => p.id === id).forEach((p) => (p.hasKey = true)),
  clearProviderKey: async (id: string) => void providers.filter((p) => p.id === id).forEach((p) => (p.hasKey = false)),
  listModels: async (): Promise<ModelInfo[]> => [
    { id: "model-a", label: "Model A" },
    { id: "model-b", label: "Model B" },
  ],
  testProvider: async () => "Connected. 2 models available.",
  discoverLocal: async (): Promise<LocalServer[]> => [],

  async streamChat(onEvent: (e: ChatEvent) => void) {
    for (const word of "This is the browser stand-in for a real provider.".split(" ")) {
      await sleep(30);
      onEvent({ type: "delta", text: `${word} ` });
    }
    onEvent({ type: "usage", input: 12, output: 9 });
    onEvent({ type: "done" });
  },

  detectAgents: async (): Promise<AgentInfo[]> => [
    { id: "claude-code", name: "Claude Code", installed: true, path: "claude", version: "stand-in", capabilities: { approvals: true, resume: true, usage: true, progress: false } },
    { id: "codex", name: "Codex CLI", installed: false, path: null, version: null, capabilities: { approvals: true, resume: true, usage: true, progress: false } },
  ],

  /** A flight departing soon, for the live activity tests. */
  addFlight: (minutesAway: number) => {
    const at = Date.now() + minutesAway * 60_000;
    events = [...events, sampleEvent("flight-live", "Flight 6E 2341 DEL → BOM", "flight", {
      startsAt: { kind: "zoned", value: new Date(at).toISOString() },
      endsAt: { kind: "zoned", value: new Date(at + 120 * 60_000).toISOString() },
      metadata: { flightNumber: "6E2341", departureAirport: "DEL", arrivalAirport: "BOM" },
    })];
  },

  async mediaAction(action: MediaAction) {
    if (action.action === "refresh") return;
    if (action.action === "toggle") track = { ...track, playing: !track.playing };
    if (action.action === "next") track = { ...track, title: "Next Song" };
    pushMedia({ current: track, sessions: [track] });
  },
  async onLevel(handler: (level: Level) => void) {
    pushLevel = handler;
    return () => {};
  },
  publishLevel: (level: Level) => pushLevel(level),
  async onMedia(handler: (s: MediaSnapshot) => void) {
    pushMedia = handler;
    return () => {};
  },
  publishMedia: (present: boolean) => {
    track = { ...sampleTrack };
    pushMedia(present ? { current: track, sessions: [track] } : { current: null, sessions: [] });
  },

  activityList: async (category: Category | null) => events.filter((e) => inCategory(e, category)),
  activityDelete: async (id: string) => void (events = events.filter((e) => e.id !== id)),
  activityCorrect: async (id: string, title: string) =>
    void (events = events.map((e) => (e.id === id ? { ...e, title, userEdited: true } : e))),
  activityAddReminder: async (title: string, startsAt: EventTime) =>
    void (events = [...events, sampleEvent(crypto.randomUUID(), title, "userReminder", { source: "user", startsAt, sourceRef: null })]),
  activityImport: async (subject: string) => {
    if (/sale|deal/i.test(subject)) return 0;
    events = [...events, sampleEvent(crypto.randomUUID(), subject, "order")];
    return 1;
  },
  accountsList: async () => accounts,
  accountConnect: async (provider: ConnectedAccount["provider"]) => {
    const account = { id: `${provider}:me`, provider, email: "me@example.com", scopes: [], connectedAt: "2026-10-30T09:00:00Z", lastSyncAt: null };
    accounts = [...accounts, account];
    return account;
  },
  accountDisconnect: async (id: string) => void (accounts = accounts.filter((a) => a.id !== id)),

  integrationsList: async () => integrations.map((i) => ({ ...i })),
  /** The next sign-in waits in the browser until `failConnect`. */
  holdConnect: () => void (signInGate = new Promise((_, reject) => (failSigningIn = reject))),
  failConnect: (why: string) => failSigningIn(new Error(why)),
  integrationConnect: async (id: string) => {
    await (signInGate ?? sleep(40));
    integrations =integrations.map((i) => (i.id === id ? { ...i, connected: true, account: "Connected, read-only" } : i));
  },
  integrationDisconnect: async (id: string) =>
    void (integrations = integrations.map((i) => (i.id === id ? { ...i, connected: false, account: null } : i))),
  integrationFetch: async (_id: string, tool: string | null): Promise<Digest> => {
    await sleep(120);
    return {
      server: "Stand-in",
      tool: tool ?? "list_my_issues",
      tools: ["list_my_issues", "search_issues"],
      items: [
        { key: "i1", title: "Fix the island hit area", detail: "In progress", url: "https://linear.example/i1", when: "2026-10-30T09:00:00Z" },
        { key: "i2", title: "Write the release notes", detail: "Todo", url: null, when: null },
      ],
      text: null,
    };
  },
  voiceStatus: async () => ({
    packs: [
      { id: "engine", name: "Speech engine", bytes: 7_900_000, installed: voicePacks.has("engine") },
      { id: "hearing", name: "Hearing", bytes: 57_000_000, installed: voicePacks.has("hearing") },
      { id: "kokoro", name: "Kokoro", bytes: 320_000_000, installed: voicePacks.has("kokoro") },
      { id: "piper-amy", name: "Piper, Amy", bytes: 21_000_000, installed: voicePacks.has("piper-amy") },
      { id: "piper-alan", name: "Piper, Alan", bytes: 21_000_000, installed: voicePacks.has("piper-alan") },
    ],
    keys: [...voiceKeys],
  }),
  voiceList: async (provider: string) => (provider === "kokoro" ? [{ id: "1", name: "Bella", note: "American" }] : [{ id: "w1", name: "Zira", note: "en-US" }]),
  voiceKeySet: async (provider: string) => void voiceKeys.add(provider),
  voiceKeyClear: async (provider: string) => void voiceKeys.delete(provider),
  voiceDownload: async (id: string, onBytes: (bytes: number) => void) => {
    onBytes(1000);
    voicePacks.add("engine");
    voicePacks.add(id);
  },
  voiceRemove: async (id: string) => void voicePacks.delete(id),
  voiceSpeak: async (text: string) => void spokenWords.push(text),
  voiceHeard: async () => heardWords,
  setPacks: (ids: string[]) => {
    voicePacks.clear();
    ids.forEach((id) => voicePacks.add(id));
  },
  setHeard: (words: string) => void (heardWords = words),
  spoken: () => spokenWords,
  checkUpdate: async () => updateStatus,
  installUpdate: () => {
    updateInstalled = true;
    // Succeeding ends the real app, so this only ever answers with a failure.
    return new Promise<void>((_, reject) => (failInstalling = reject));
  },
  failInstall: (why: string) => failInstalling(new Error(why)),
  setUpdate:(status: Partial<typeof updateStatus>) => void (updateStatus = { ...updateStatus, ...status }),
  updateInstalled: () => updateInstalled,
  watching: () => watching,
  watchPreview: async (on: boolean): Promise<SettingsChange> => ({
    path: "C:\\Users\\you\\.claude\\settings.json",
    backup: "C:\\Users\\you\\.claude\\settings.json.meridian-backup",
    lines: [
      { kind: "plain", text: '  "theme": "dark",' },
      { kind: on ? "added" : "removed", text: '  "hooks": { "Stop": [ { "url": "http://127.0.0.1:4823/hook" } ] }' },
    ],
  }),
  watchSet: async (on: boolean) => void (watching = on),
  async onReminders(handler: (r: Reminder[]) => void) {
    pushReminders = handler;
    return () => {};
  },
  publishReminder: (reminder: Reminder) => pushReminders([reminder]),

  screenCapture: async (): Promise<Capture> => ({
    image: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1280' height='720'/%3E",
    text: "terraform plan\nError: Invalid reference\n  on main.tf line 12",
    window: { title: "main.tf - infra", process: "Code.exe" },
    signals: [{ kind: "terraform", title: "Looks like a Terraform configuration issue", evidence: "Error: Invalid reference" }],
    width: 1280,
    height: 720,
  }),

  agentAuth: async (agent: AgentId): Promise<AuthStatus> =>
    agent === "claude-code"
      ? { signedIn: authed, method: "claude.ai", plan: "max" }
      : { signedIn: false, method: null, plan: null },
  setAuthed: (value: boolean) => void (authed = value),

  /** A session started in another terminal, as its hooks would report it. */
  publishWatched: (sessionId: string) => {
    emit({ sessionId, event: { type: "watched", agent: "Claude Code", cwd: "C:\\Projects\\shop", title: "Fix the checkout" } });
    emit({ sessionId, event: { type: "activity", label: "Editing cart.ts" } });
  },
  publishText: (sessionId: string, text: string) => emit({ sessionId, event: { type: "text", text } }),
  publishFailure: (sessionId: string, message: string) => emit({ sessionId, event: { type: "status", status: "failed", message } }),
  publishWatchedApproval: (sessionId: string) =>
    emit({ sessionId, event: { type: "approval", approval: { id: "w1", tool: "Bash", summary: "npm install stripe" } } }),
  publishWatchedQuestion: (sessionId: string, multi = false) =>
    emit({ sessionId, event: { type: "approval", approval: { id: "q1", tool: "AskUserQuestion", summary: "Which one?", questions: [
      { text: "Which one?", options: ["Teal", "Amber"], multi },
      { text: "And then?", options: ["Ship it", "Wait"], multi: false },
    ] } } }),
  publishWatchedPlan: (sessionId: string) =>
    emit({ sessionId, event: { type: "approval", approval: { id: "p1", tool: "ExitPlanMode", summary: "Add a page", plan: "## Add a page\n\n1. Write it\n2. Test it" } } }),
  /** The last answer given to a question, so a test can see what would go back. */
  lastAnswers: () => lastAnswers,

  async startSession(request: { agent: string; cwd: string; prompt: string }) {
    const sessionId = crypto.randomUUID();
    known.add(sessionId);
    const send = (event: AgentEvent) => emit({ sessionId, event });
    void (async () => {
      await sleep(20);
      send({ type: "started", nativeId: "stand-in", model: "stand-in-model" });
      send({ type: "status", status: "running" });
      if (request.prompt.startsWith("chat:")) {
        await sleep(30);
        send({ type: "text", text: "Hello from the stand-in agent." });
        send({ type: "usage", input: 10, output: 5, costUsd: 0.001 });
        send({ type: "status", status: "completed" });
        return;
      }
      send({ type: "activity", label: "Reading src/main.rs" });
      await sleep(60);
      send({ type: "approval", approval: { id: "a1", tool: "Bash", summary: "cargo test --workspace" } });
      // A prompt mentioning "parallel" asks twice at once, as parallel tool calls do.
      if (request.prompt.includes("parallel"))
        send({ type: "approval", approval: { id: "a2", tool: "Bash", summary: "cargo clippy" } });
    })();
    return sessionId;
  },

  async answerApproval(sessionId: string, approvalId: string, allow: boolean, answers?: Record<string, string | string[]>) {
    lastAnswers = answers ?? null;
    emit({ sessionId, event: { type: "approvalResolved", id: approvalId } });
    if (approvalId === "a1" && pendingSecond(sessionId)) return;
    if (!allow) return emit({ sessionId, event: { type: "status", status: "cancelled" } });
    await sleep(40);
    emit({ sessionId, event: { type: "text", text: "All tests pass." } });
    emit({ sessionId, event: { type: "usage", input: 1200, output: 340, costUsd: 0.012 } });
    emit({ sessionId, event: { type: "status", status: "completed" } });
  },

  adoptSession: async (id: string) => void known.add(id),
  async sendToSession(sessionId: string, text: string) {
    // As in the app: a session from before a restart has to be taken back first.
    if (!known.has(sessionId)) throw new Error("No session with that id.");
    emit({ sessionId, event: { type: "status", status: "running" } });
    await sleep(30);
    emit({ sessionId, event: { type: "text", text: `Follow-up received: ${text}` } });
    emit({ sessionId, event: { type: "status", status: "completed" } });
  },

  async cancelSession(id: string) {
    emit({ sessionId: id, event: { type: "status", status: "cancelled" } });
  },

  async onAgentEvent(handler: (e: AgentEnvelope) => void) {
    emit = handler;
    return () => {
      emit = () => {};
    };
  },
};
