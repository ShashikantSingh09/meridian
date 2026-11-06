// Stands in for the Rust core when the UI runs in a plain browser, which is how
// the Playwright suite exercises the interface. Never loaded inside Tauri paths.

import type {
  Charge,
  IslandPlace,
  KnowledgeHit,
  KnowledgeKind,
  KnowledgeLine,
  KnowledgePage,
  KnowledgeSourceStatus,
  KnowledgeState,
  KnowledgeStatus,
  AgentEnvelope,
  AgentEvent,
  AgentId,
  AgentInfo,
  AuthStatus,
  Capture,
  Card,
  CardsState,
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
  Note,
  NoteLevels,
  NotesState,
  Track,
  WakeStatus,
  FillPlace,
  HereOutcome,
  HereRequest,
} from "./types";
import { defaultSettings } from "./types";
import { emptyProfile, idProblem, problem, tidyId, type IdKind, type IdNumbers, type Profile } from "./details";

// Write here: how the next runs end, what the page asked, and a run held open so a test can look at it.
const hereOutcomes: HereOutcome[] = [];
const hereCalls: string[] = [];
let hereOffered = false;
let hereHeld: Promise<void> | null = null;
let releaseHere = () => {};
let undoRefused = "";
let hereKey: (() => void) | null = null;
let hereAsked: ((start: { instruction: string }) => void) | null = null;
let hereEnded: (() => void) | null = null;
/** The next answer the stand-in agent gives, or why it fails. */
let nextAnswer: { text?: string; fail?: string } | null = null;
const nextHere = async () => {
  if (hereHeld) await hereHeld;
  return hereOutcomes.shift() ?? ({ outcome: "written" } as HereOutcome);
};
const answerWith = async (send: (event: AgentEvent) => void) => {
  const answer = nextAnswer!;
  nextAnswer = null;
  await new Promise((r) => setTimeout(r, 150));
  if (answer.fail) return send({ type: "status", status: "failed", message: answer.fail });
  send({ type: "text", text: answer.text ?? "" });
  send({ type: "status", status: "completed" });
};

let details: Profile = emptyProfile;
/** Whole numbers, as Credential Manager would hold them. */
let idNumbers: Partial<Record<IdKind, string>> = {};
const maskId = (kind: IdKind, n: string) => {
  const shown = kind === "pan" ? 5 : 4;
  return kind === "aadhaar" ? `•••• •••• ${n.slice(-4)}` : `${"•".repeat(n.length - shown)}${n.slice(-shown)}`;
};
import type { StyleLine, StyleProfile } from "./style";

const caps = { streaming: true, tools: true, vision: false, modelDiscovery: true, usage: true };

// ── Knowledge ───────────────────────────────────────────────────────────────
// The pages as files, read by a small stand-in for the core's reader. The rules about what an
// update may change are tested in crates/knowledge, not here.

const KINDS: Record<string, KnowledgeKind> = { People: "person", Projects: "project", Promises: "promise", Places: "place" };
const DEF = /^\[([^\]]+)\]: (\S+)$/;
const SAMPLE_PAGES: Record<string, string> = {
  "People/Asha Rao.md": "# Asha Rao\nDesign lead at Northwind. Works with you on the shop relaunch.\n\n## Now\n- The launch moves to 18 Nov. Checkout testing needs another week. (call on 4 Nov)\n- Wants the hero photos in 4:5, not square. (mail from Asha, 3 Nov)\n\n## Good to know\n- Would rather have a quick call than a long email. (mail from Asha, 28 Oct)\n- Works from Bengaluru. (meeting on 2 Nov)\n\n## Linked\n- Shop relaunch\n- Northwind\n- Pune office\n\n[call on 4 Nov]: meridian:note/call-4-nov\n[mail from Asha, 3 Nov]: https://mail.google.com/mail/u/0/#all/18c2\n[mail from Asha, 28 Oct]: https://mail.google.com/mail/u/0/#all/17a9\n[meeting on 2 Nov]: https://calendar.google.com/calendar/r\n",
  "People/Carl Mendes.md": "# Carl Mendes\nAccounts at Brightline.\n\n## Now\n- Asked whether the October invoice went out. (mail from Carl, 3 Nov)\n\n[mail from Carl, 3 Nov]: https://mail.google.com/mail/u/0/#all/19d4\n",
  "People/Dr. Mehta.md": "# Dr. Mehta\nDentist. Next visit on 21 Nov.\n",
  "Projects/Shop relaunch.md": "# Shop relaunch\nLaunch on 18 Nov.\n\n## Now\n- Checkout testing needs another week. (call on 4 Nov)\n\n[call on 4 Nov]: meridian:note/call-4-nov\n",
  "Projects/October invoices.md": "# October invoices\n3 open, 1 paid.\n",
  "Promises/Send Carl the October invoice.md": "# Send Carl the October invoice\n- [ ] You: send Carl the October invoice, by Fri 6 Nov (mail from Carl, 3 Nov)\n\n## Linked\n- Carl Mendes\n- October invoices\n\n[mail from Carl, 3 Nov]: https://mail.google.com/mail/u/0/#all/19d4\n",
  "Promises/Share the new deck.md": "# Share the new deck\n- [ ] Asha: share the new deck, by Mon 9 Nov (call on 4 Nov)\n\n## Linked\n- Asha Rao\n\n[call on 4 Nov]: meridian:note/call-4-nov\n",
  "Promises/Send the hero photos.md": "# Send the hero photos\n- [ ] You: send the hero photos, by Fri 6 Nov (mail from Asha, 3 Nov)\n\n## Linked\n- Asha Rao\n\n[mail from Asha, 3 Nov]: https://mail.google.com/mail/u/0/#all/18c2\n",
  "Promises/Book the review room.md": "# Book the review room\n- [x] You: book the review room (chat, 2 Nov)\n\n## Linked\n- Asha Rao\n\n[chat, 2 Nov]: meridian:chat\n",
  "Places/Pune office.md": "# Pune office\nBaner. 2 visits.\n",
};
let pageTexts: Record<string, string> = {};
let knowledgeStatus: KnowledgeStatus = { running: false, done: 0, total: 0, now: "", sources: [], failed: null };
let knowledgeUpdatedAt: number | null = null;
let knowledgeChanged = () => {};
let knowledgeIdle = () => {};
let knowledgeHeld: (() => void) | null = null;
const knowledgeRuns: { chats: number; idle: boolean }[] = [];
const knowledgeOpened: string[] = [];
const openedUrls: string[] = [];

function promiseWords(line: KnowledgeLine | undefined) {
  if (!line) return "";
  if (line.done) return "Done";
  const who = line.text.split(": ")[0];
  const by = line.text.split(", by ")[1];
  return [who, by && `by ${by}`].filter(Boolean).join(" · ");
}

function parsePage(path: string, text: string): KnowledgePage {
  const lines = text.split("\n");
  const sources = lines.map((l) => DEF.exec(l.trim())).filter((m) => m !== null).map((m) => ({ label: m[1]!, target: m[2]! }));
  let title = path.split("/")[1]!.replace(/\.md$/, "");
  let titled = false;
  const about: string[] = [];
  const sections: KnowledgePage["sections"] = [{ heading: "", lines: [] }];
  const linked: string[] = [];
  lines.forEach((line, at) => {
    if (!line.trim() || DEF.test(line.trim())) return;
    if (!titled && line.startsWith("# ")) return void ((title = line.slice(2).trim()), (titled = true));
    if (line.startsWith("## ")) return void sections.push({ heading: line.slice(3).trim(), lines: [] });
    const current = sections[sections.length - 1]!;
    if (current.heading === "Linked") return void linked.push(line.replace(/^[-*]\s*/, "").trim());
    const bullet = /^[-*] (\[( |x)\] )?(.*?)(?: \(([^()]+)\))?$/.exec(line);
    if (bullet) {
      const label = bullet[4];
      const source = sources.find((s) => s.label === label) ?? null;
      const yours = label === "you";
      const text = yours || source ? bullet[3]! : `${bullet[3]}${label ? ` (${label})` : ""}`;
      current.lines.push({ at, text, source, yours, done: bullet[1] ? bullet[2] === "x" : null, bullet: true });
    } else if (sections.length === 1 && current.lines.length === 0) about.push(line.trim());
    else current.lines.push({ at, text: line.trim(), source: null, yours: false, done: null, bullet: false });
  });
  const kind = KINDS[path.split("/")[0]!]!;
  const kept = sections.filter((s) => s.lines.length > 0);
  const firstSentence = about.join(" ").split(". ")[0]!.replace(/\.$/, "");
  const subtitle = kind === "promise" ? promiseWords(kept.flatMap((s) => s.lines).find((l) => l.done !== null)) : firstSentence;
  return { path, kind, title, about: about.join(" "), subtitle, sections: kept, linked, sources, updated: Date.now() };
}

const knowledgePages = () => Object.entries(pageTexts).map(([path, text]) => parsePage(path, text)).sort((a, b) => "person project promise place".indexOf(a.kind) - "person project promise place".indexOf(b.kind) || a.title.localeCompare(b.title));

function seedKnowledge() {
  pageTexts = { ...SAMPLE_PAGES };
  knowledgeUpdatedAt = new Date(2026, 10, 6, 7, 12).getTime();
  if (!noteList.notes.some((n) => n.id === "call-4-nov")) {
    const note: Note = { id: "call-4-nov", title: "Launch date and checkout", titleEdited: true, startedAt: new Date(2026, 10, 4, 15, 0).getTime(), endedAt: new Date(2026, 10, 4, 15, 20).getTime(), status: "ready", ...WRITTEN, summary: "The launch moves to 18 Nov.", keyPoints: [], todos: [], error: null };
    noteList = { ...noteList, notes: [note, ...noteList.notes] };
    notesChanged();
  }
  knowledgeChanged();
}

/** As the core would while it reads: some sources done, Gmail signed out, 14 of 52 written. */
function updatingNow(): KnowledgeStatus {
  const on = (["notes", "gmail", "calendar", "chats"] as const).filter((id) => settings.knowledge[id]);
  const sources = on.map((id): KnowledgeSourceStatus => {
    if (id === "gmail") return { id, state: "skipped", found: 0, why: "Claude Code is signed out, so Gmail could not be read.", signIn: true };
    if (id === "calendar") return { id, state: "done", found: 6, why: "", signIn: false };
    return { id, state: "read", found: id === "notes" ? 2 : 3, why: "", signIn: false };
  });
  return { running: true, done: 14, total: 52, now: "the call with Asha, 4 Nov", sources, failed: null };
}

const providers: ProviderInfo[] = [
  { id: "anthropic", name: "Anthropic", kind: "cloud", baseUrl: "https://api.anthropic.com", needsKey: true, hasKey: true, capabilities: { ...caps, vision: true } },
  { id: "openai", name: "OpenAI", kind: "cloud", baseUrl: "https://api.openai.com/v1", needsKey: true, hasKey: false, capabilities: caps },
  { id: "ollama", name: "Ollama", kind: "local", baseUrl: "http://localhost:11434/v1", needsKey: false, hasKey: false, capabilities: { ...caps, usage: false } },
];

// Tests start as someone who has already said yes to update checks. The question itself has its own test.
let settings: Settings = { ...defaultSettings, onboarded: true, updateChecks: true };
let noteList: NotesState = { notes: [], recording: null, working: [] };
let notesChanged = () => {};
let noteWritten: (id: string) => void = () => {};
let noteFailed: (failed: { id: string; title: string; why: string }) => void = () => {};
let noteLevels: ((levels: NoteLevels) => void) | null = null;
let exportedTo = "";

const WRITTEN: Pick<Note, "speakers" | "lines"> = {
  speakers: [
    { id: "me", name: "You", color: 0, you: true },
    { id: "p2", name: "Person 2", color: 1, you: false },
    { id: "p3", name: "Person 3", color: 2, you: false },
  ],
  lines: [
    { id: "a", speaker: "me", start: 4, end: 9, text: "Let's start with the launch date. Is Friday still okay?" },
    { id: "b", speaker: "p2", start: 11, end: 16, text: "चेकआउट टेस्ट अभी बाकी है, Thursday तक हो जाएगा।" },
    { id: "c", speaker: "p3", start: 19, end: 23, text: "Then Friday works, as long as the payment fix goes in first." },
    { id: "d", speaker: "me", start: 27, end: 30, text: "ठीक है। I will tell the client today." },
  ],
};

function changeNote(id: string, change: Partial<Note>) {
  noteList = { ...noteList, notes: noteList.notes.map((note) => (note.id === id ? { ...note, ...change } : note)) };
  notesChanged();
}
let emit: (e: AgentEnvelope) => void = () => {};
let authed = true;
let pushReminders: (r: Reminder[]) => void = () => {};
let registered = true;
let accounts: ConnectedAccount[] = [];
let claudeMailReads = 0;
let claudeMailFails = "";
const known = new Set<string>();
const voicePacks = new Set<string>();
const voiceKeys = new Set<string>();
let heardWords = "";
const spokenWords: string[] = [];
let wakeState: ((status: WakeStatus) => void) | null = null;
const taughtWords = new Set<string>();
let notesAsked: (() => void) | null = null;
let wakeHeard: ((heard: { word: string; test: boolean; afterMs: number }) => void) | null = null;
let updateStatus = { current: "0.3.0", latest: "v0.3.0", available: false, notes: "", published: null as string | null, message: "You are on the latest version." };
let updateInstalled = false;
let failInstalling: (why: Error) => void = () => {};
let installKind: "setup" | "msi" | "portable" = "setup";
const hushes: string[] = [];
const focused: number[] = [];
let inFront: number[] = [];
let terminalFound = true;
let noteQuiet: (left: number) => void = () => {};
let noteStoppedQuiet: (id: string) => void = () => {};
let keptRecording = 0;
let signInGate: Promise<void> | null = null;
let failSigningIn: (why: Error) => void = () => {};
let pushLevel: (level: Level) => void = () => {};
/** A desktop unless a test says otherwise, so the island keeps its usual size. */
let charge: Charge | null = null;
let islandPlaced: (place: IslandPlace) => void = () => {};
const islandDrags: boolean[] = [];
const keyboard: boolean[] = [];
let leaning: ((degrees: number) => void) | null = null;
let islandResets = 0;
let watching = false;
/** Following was turned on, whether or not its hooks are still in Claude Code's settings. */
let hooksWanted = false;
let hooksOff: string[] = [];
let gmailOnClaude = true;
let connectorsGate: Promise<void> | null = null;
let releaseConnectors = () => {};
let lastAnswers: Record<string, string | string[]> | null = null;
let updateLooks = 0;
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
const sampleTrack: Track = {
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
let styleProfile: StyleProfile | null = null;
/** A learning run the test drives page by page. */
let styleRun: { onRead: (read: number) => void; resolve: (profile: StyleProfile) => void; reject: (why: string) => void } | null = null;
const STYLE_LINES: StyleLine[] = [
  { key: "greeting", text: "\"Hi\" and their first name. Never \"Dear\".", mine: false },
  { key: "signoff", text: "\"Thanks,\" then \"Ravi\". Sometimes \"R\". Never \"Regards\".", mine: false },
  { key: "length", text: "Short. Two to four sentences.", mine: false },
  { key: "tone", text: "Friendly and direct. Often says sorry. Few exclamation marks.", mine: false },
  { key: "uses", text: "\"quick one\", \"sounds good\", \"will share by EOD\", \"cheers\"", mine: false },
  { key: "avoids", text: "\"Kindly\", \"Please find attached\", \"Hope this finds you well\"", mine: false },
  { key: "languages", text: "English. Mixes in Hindi with family, like \"haan, done\".", mine: false },
];
/** Learning again keeps every line the user wrote, as the core does. */
const learnedStyle = (emails: number): StyleProfile => ({
  learnedAt: "2026-11-06T09:20:00",
  emails,
  lines: STYLE_LINES.map((line) => styleProfile?.lines.find((own) => own.key === line.key && own.mine) ?? line),
});
const sleep =(ms: number) => new Promise((r) => setTimeout(r, ms));
const pendingSecond = (sessionId: string) =>
  (window as never as { __meridian: { getState(): { sessions: { id: string; approval: { id: string } | null }[] } } })
    .__meridian.getState()
    .sessions.find((s) => s.id === sessionId)?.approval?.id === "a2";

export const mock = {
  detailsGet: async () => details,
  /** Refuses what the core refuses, and turning ID numbers off removes them, as it does. */
  async detailsSave(next: Profile) {
    const wrong = problem("birth", next.birth) ?? problem("email", next.email) ?? problem("phone", next.phone) ?? problem("phone", next.otherPhone) ?? problem("pin", next.address.pin) ?? problem("email", next.work.email);
    if (wrong) throw wrong;
    if (details.ids && !next.ids) idNumbers = {};
    details = structuredClone(next);
    return details;
  },
  detailsDelete: async () => {
    details = emptyProfile;
    idNumbers = {};
  },
  detailsIds: async (): Promise<IdNumbers> => {
    const masked = (kind: IdKind) => (details.ids && idNumbers[kind] ? maskId(kind, idNumbers[kind]) : null);
    return { pan: masked("pan"), aadhaar: masked("aadhaar"), passport: masked("passport") };
  },
  detailsIdShow: async (kind: IdKind) => idNumbers[kind] ?? Promise.reject("That number is not kept."),
  async detailsIdSet(kind: IdKind, number: string) {
    const n = tidyId(number);
    if (!n) return void delete idNumbers[kind];
    if (!details.ids) throw "Turn on ID numbers first.";
    const wrong = idProblem(kind, n);
    if (wrong) throw wrong;
    idNumbers[kind] = n;
  },
  /** Starts a test with details already added. */
  seedDetails: (profile: Profile, ids: Partial<Record<IdKind, string>> = {}) => {
    details = structuredClone(profile);
    idNumbers = { ...ids };
  },
  idNumbersKept: () => ({ ...idNumbers }),

  getSettings: async () => settings,
  /** The apps and sites belong to the core, as in the app: a page's copy never replaces them. */
  saveSettings: async (next: Settings) => void (settings = { ...next, fill: { ...next.fill, places: settings.fill.places } }),

  async hereStart(request: HereRequest) {
    hereCalls.push(`start ${JSON.stringify(request)}`);
    return nextHere();
  },
  async hereRetry() {
    hereCalls.push("retry");
    return nextHere();
  },
  async hereRewrite(how: string) {
    hereCalls.push(`rewrite ${how}`);
    return nextHere();
  },
  async hereUndo() {
    hereCalls.push("undo");
    if (undoRefused) throw undoRefused;
  },
  hereCopy: async () => void hereCalls.push("copy"),
  hereStop: async () => {
    hereCalls.push("stop");
    hereOutcomes.unshift({ outcome: "stopped" });
    releaseHere();
  },
  hereDone: async () => void hereCalls.push("done"),
  /** The window in front, when a box has the cursor. */
  hereOffer: async () => (hereOffered ? 4242 : null),
  async fillPlaceSet(place: FillPlace) {
    const known = settings.fill.places.some((p) => p.id === place.id);
    const places = known ? settings.fill.places.map((p) => (p.id === place.id ? { ...place, alwaysAsk: p.alwaysAsk || place.alwaysAsk } : p)) : [...settings.fill.places, place];
    settings = { ...settings, fill: { ...settings.fill, places } };
    return settings;
  },
  async fillPlaceForget(id: string) {
    settings = { ...settings, fill: { ...settings.fill, places: settings.fill.places.filter((p) => p.id !== id) } };
    return settings;
  },
  onHereKey: (handler: () => void) => void (hereKey = handler),
  onHereStart: (handler: (start: { instruction: string }) => void) => void (hereAsked = handler),
  onHereEnded: (handler: () => void) => void (hereEnded = handler),
  /** As the core does when Ctrl Alt F is pressed. */
  pressHereKey: () => hereKey?.(),
  /** As the core does when the assistant calls write_here. */
  askToWriteHere: (instruction: string) => hereAsked?.({ instruction }),
  /** The user types in the box after the reply went in. */
  typeInTheBox: () => hereEnded?.(),
  hereNext: (...outcomes: HereOutcome[]) => void hereOutcomes.push(...outcomes),
  hereCalls: () => [...hereCalls],
  offerHere: (on: boolean) => void (hereOffered = on),
  /** Keeps the next runs writing until `releaseHere`. */
  holdHere: () => void (hereHeld = new Promise((done) => (releaseHere = () => {
    hereHeld = null;
    done();
  }))),
  releaseHere: () => releaseHere(),
  refuseUndo: (why: string) => void (undoRefused = why),
  seedPlaces: (places: FillPlace[]) => void (settings = { ...settings, fill: { ...settings.fill, places } }),
  /** The stand-in agent's next answer, or the reason it fails. */
  answerNext: (answer: { text?: string; fail?: string }) => void (nextAnswer = answer),
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
    const answer = nextAnswer;
    nextAnswer = null;
    if (answer?.fail) return onEvent({ type: "error", kind: "auth", message: answer.fail });
    for (const word of (answer?.text ?? "This is the browser stand-in for a real provider.").split(" ")) {
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

  /** Any item in My Day, as a connected account or Claude would leave it. */
  addEvent: (id: string, title: string, kind: string, over: Partial<ContextEvent> = {}) => void (events = [...events, sampleEvent(id, title, kind, over)]),
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
  batteryNow: async () => charge,
  /** Sets the laptop's charge, which the island reads on its next look. */
  setCharge: (next: Charge | null) => void (charge = next),
  setInteractive: async (on: boolean) => void keyboard.push(on),
  /** Each time the window asked for the keyboard, or gave it back. */
  keyboard: () => [...keyboard],
  islandDrag: async (start: boolean) => void islandDrags.push(start),
  islandDrags: () => [...islandDrags],
  onLean: (handler: (degrees: number) => void) => {
    leaning = handler;
    return () => (leaning = null);
  },
  /** As the core does while the island is dragged. */
  lean: (degrees: number) => leaning?.(degrees),
  islandReset: async () => {
    islandResets += 1;
    islandPlaced("top");
  },
  islandResets: () => islandResets,
  islandPlacement: async (): Promise<IslandPlace> => "top",
  onIslandPlaced: (handler: (place: IslandPlace) => void) => void (islandPlaced = handler),
  /** As the core does after a drag. */
  placeIsland: (place: IslandPlace) => islandPlaced(place),
  async onMedia(handler: (s: MediaSnapshot) => void) {
    pushMedia = handler;
    return () => {};
  },
  publishMedia: (present: boolean, over: Partial<Track> = {}, others: Partial<Track>[] = []) => {
    track = { ...sampleTrack, ...over };
    pushMedia(present ? { current: track, sessions: [track, ...others.map((o) => ({ ...sampleTrack, ...o }))] } : { current: null, sessions: [] });
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
  /** Gmail through the Claude account finds one order. Set `claudeMailFails` to see it fail. */
  activityClaudeMail: async () => {
    claudeMailReads += 1;
    if (claudeMailFails) throw new Error(claudeMailFails);
    if (!events.some((e) => e.id === "claude-order")) {
      const sourceRef = { account: "Gmail, through Claude", messageId: "claude-gmail:18c2", subject: "Your order has shipped", receivedAt: "2026-11-01T09:00:00Z", link: null };
      events = [...events, sampleEvent("claude-order", "Order 112-4455", "order", { sourceRef })];
    }
    return "Read 2 messages through Claude, and found 1 plan.";
  },
  claudeMailReads: () => claudeMailReads,
  failClaudeMail: (why: string) => void (claudeMailFails = why),
  /** A build with no registered app, so Google is reached through the Claude account. */
  noRegisteredApps: () => void (registered = false),
  builtInClients: async (): Promise<[boolean, boolean]> => [registered, registered],
  claudeConnectors: async (): Promise<[boolean, boolean]> => {
    await connectorsGate;
    return [gmailOnClaude, false];
  },
  setGmailOnClaude: (on: boolean) => void (gmailOnClaude = on),
  /** Asking Claude Code waits, as a slow start does, until `releaseConnectors`. */
  holdConnectors: () => void (connectorsGate = new Promise((done) => (releaseConnectors = done))),
  releaseConnectors: () => {
    connectorsGate = null;
    releaseConnectors();
  },
  setClaudeGmail: (on: boolean) => void (gmailOnClaude = on),
  styleGet: async () => styleProfile,
  styleLearn: (onRead: (read: number) => void) => new Promise<StyleProfile>((resolve, reject) => void (styleRun = { onRead, resolve, reject })),
  styleStop: async () => {
    styleRun?.reject("Stopped. Nothing was kept.");
    styleRun = null;
  },
  styleSetLine: async (key: string, text: string) => {
    if (!styleProfile) throw "There is no profile to change.";
    styleProfile = { ...styleProfile, lines: styleProfile.lines.map((line) => (line.key === key && line.text !== text.trim() ? { key, text: text.trim(), mine: true } : line)) };
    return styleProfile;
  },
  styleForget: async () => void (styleProfile = null),
  /** What Gmail would do while it learns: a page read, the end of the sent mail, or a failure. */
  styleRead: (read: number) => styleRun?.onRead(read),
  styleFinish: (emails = 100) => {
    styleProfile = learnedStyle(emails);
    styleRun?.resolve(styleProfile);
    styleRun = null;
  },
  styleFail: (why: string) => {
    styleRun?.reject(why);
    styleRun = null;
  },
  /** Starts a test with a profile already learned. */
  styleLearned: (emails = 100) => void (styleProfile = learnedStyle(emails)),
  styleSaved: () => styleProfile,
  notesState: async () => ({ ...noteList }),
  onNotesChanged: (handler: () => void) => void (notesChanged = handler),
  onNoteWritten: (handler: (id: string) => void) => void (noteWritten = handler),
  onNoteFailed: (handler: (failed: { id: string; title: string; why: string }) => void) => void (noteFailed = handler),
  onNoteLevels: (handler: (levels: NoteLevels) => void) => {
    noteLevels = handler;
    return () => void (noteLevels = null);
  },
  noteStart: async () => {
    if (settings.voiceHearing === "local") throw "Notes need ElevenLabs or Deepgram. Change it in Settings, Voice.";
    const id = crypto.randomUUID();
    const note: Note = { id, title: "Call · 2 Nov, 4:23 pm", titleEdited: false, startedAt: Date.now(), endedAt: null, status: "recording", speakers: [], lines: [], summary: null, keyPoints: [], todos: [], error: null };
    noteList = { ...noteList, notes: [note, ...noteList.notes], recording: id };
    notesChanged();
    return id;
  },
  noteStop: async () => {
    const id = noteList.recording;
    if (!id) return;
    noteList = { ...noteList, recording: null, working: [...noteList.working, id] };
    changeNote(id, { status: "writing", endedAt: Date.now() });
  },
  /** What the hearing service would do when a recording stops. */
  finishNote: (lines = true) => {
    const id = noteList.working[0]!;
    noteList = { ...noteList, working: noteList.working.filter((other) => other !== id) };
    changeNote(id, { status: "ready", ...(lines ? WRITTEN : { speakers: [WRITTEN.speakers[0]!], lines: [] }) });
    noteWritten(id);
  },
  failNote: (why: string) => {
    const id = noteList.working[0]!;
    noteList = { ...noteList, working: noteList.working.filter((other) => other !== id) };
    changeNote(id, { status: "failed", error: why });
    noteFailed({ id, title: noteList.notes.find((note) => note.id === id)!.title, why });
  },
  setNoteLevels: (levels: NoteLevels) => noteLevels?.(levels),
  noteRename: async (id: string, title: string) => changeNote(id, { title, titleEdited: true }),
  noteRenameSpeaker: async (id: string, speaker: string, name: string) => {
    const note = noteList.notes.find((n) => n.id === id)!;
    changeNote(id, { speakers: note.speakers.map((s) => (s.id === speaker ? { ...s, name } : s)) });
  },
  noteToggleTodo: async (id: string, todo: string) => {
    const note = noteList.notes.find((n) => n.id === id)!;
    changeNote(id, { todos: note.todos.map((t) => (t.id === todo ? { ...t, done: !t.done } : t)) });
  },
  noteDelete: async (id: string) => {
    noteList = { ...noteList, notes: noteList.notes.filter((note) => note.id !== id) };
    notesChanged();
  },
  noteRetry: async (id: string) => {
    noteList = { ...noteList, working: [...noteList.working, id] };
    changeNote(id, { status: "writing", error: null });
  },
  noteSummarize: async (id: string) => {
    const note = noteList.notes.find((n) => n.id === id)!;
    changeNote(id, {
      title: note.titleEdited ? note.title : "Launch date and checkout",
      summary: "The launch moves to Friday 6 November, so the payment fix ships first. Priya finishes the checkout test by Thursday, and you tell the client today.",
      keyPoints: ["The checkout test is the only thing holding the launch", "The payment fix goes in before anything else"],
      todos: [
        { id: "t1", text: "Tell the client the new date", owner: "You", due: "today", done: false },
        { id: "t2", text: "Finish the checkout test", owner: "Priya", due: "Thursday", done: false },
        { id: "t3", text: "Check the invoice template", owner: null, due: null, done: false },
      ],
    });
  },
  knowledgeState: async (): Promise<KnowledgeState> => ({ pages: knowledgePages(), status: knowledgeStatus, updatedAt: knowledgeUpdatedAt, folder: "C:\\Users\\sample\\Documents\\Meridian\\Knowledge", calls: noteList.notes.filter((n) => n.status === "ready").length }),
  onKnowledgeChanged: (handler: () => void) => void (knowledgeChanged = handler),
  onKnowledgeIdle: (handler: () => void) => void (knowledgeIdle = handler),
  /** As the core does after 10 minutes with no typing or mouse, on the charger. */
  idleKnowledge: () => knowledgeIdle(),
  /** Puts the sample pages in place, as a finished update would. */
  seedKnowledge,
  /** The next update stops part way, as in the board, until `finishKnowledge`. */
  holdKnowledge: () => void (knowledgeHeld = () => {}),
  finishKnowledge: () => knowledgeHeld?.(),
  knowledgeRuns: () => knowledgeRuns,
  knowledgeOpened: () => knowledgeOpened,
  knowledgeUpdate: async (chats: { text: string; at: number | null }[], idle: boolean) => {
    if (knowledgeStatus.running) throw new Error("Knowledge is already updating.");
    knowledgeRuns.push({ chats: chats.length, idle });
    if (knowledgeHeld) {
      knowledgeStatus = updatingNow();
      knowledgeChanged();
      await new Promise<void>((resolve) => (knowledgeHeld = resolve));
      knowledgeHeld = null;
      if (!knowledgeStatus.running) return;
    }
    seedKnowledge();
    knowledgeStatus = { ...updatingNow(), running: false, done: 52, now: "", sources: updatingNow().sources.map((s) => (s.state === "read" ? { ...s, state: "done" } : s)) };
    knowledgeChanged();
  },
  knowledgeStop: async () => {
    knowledgeStatus = { ...knowledgeStatus, running: false, now: "", failed: "Stopped. It carries on next time." };
    knowledgeChanged();
    knowledgeHeld?.();
  },
  knowledgeSearch: async (query: string): Promise<KnowledgeHit[]> => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const textsOf = (p: KnowledgePage) => [p.title, p.about, ...p.sections.flatMap((s) => s.lines.map((l) => l.text)), ...p.linked];
    return knowledgePages()
      .filter((p) => words.every((w) => textsOf(p).join("\n").toLowerCase().includes(w)))
      .map((p) => {
        const named = words.every((w) => p.title.toLowerCase().includes(w));
        const from = p.kind === "promise" ? p.sections.flatMap((s) => s.lines).find((l) => l.source)?.source?.label : undefined;
        const text = textsOf(p).slice(1).find((t) => t.toLowerCase().includes(words[0]!)) ?? "";
        return { path: p.path, kind: p.kind, title: p.title, snippet: named ? [p.subtitle, from].filter(Boolean).join(" · ") : text, quote: !named, named };
      })
      .sort((a, b) => Number(b.named) - Number(a.named))
      .map(({ named: _, ...hit }) => hit);
  },
  knowledgeRead: async (path: string) => pageTexts[path] ?? Promise.reject(new Error("That page is gone.")),
  /** Marks the lines that are new as the user's, as the core does. */
  knowledgeSave: async (path: string, text: string, base: string) => {
    if (pageTexts[path] !== base) throw new Error("This page changed while you were editing it, so nothing was saved.");
    const before = new Set(base.split("\n"));
    pageTexts[path] = text.split("\n").map((line) => (/^[-*] /.test(line) && !before.has(line) && !line.endsWith("(you)") ? `${line.replace(/ \([^()]+\)$/, "")} (you)` : line)).join("\n");
    knowledgeChanged();
  },
  knowledgeTick: async (path: string, line: number, done: boolean) => {
    const lines = pageTexts[path]!.split("\n");
    lines[line] = lines[line]!.replace(done ? "[ ]" : "[x]", done ? "[x]" : "[ ]");
    pageTexts[path] = lines.join("\n");
    knowledgeChanged();
  },
  knowledgeOpen: async (path: string) => void knowledgeOpened.push(path),
  /** Links the app opened in the browser, newest last. */
  openUrl: async (url: string) => void openedUrls.push(url),
  openedUrls: () => openedUrls,
  noteMarkdown: async (id: string) => `# ${noteList.notes.find((n) => n.id === id)!.title}\n`,
  noteExport: async (path: string) => ((exportedTo = path), true),
  exportedTo: () => exportedTo,
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
  onWakeState: (handler: (status: WakeStatus) => void) => void (wakeState = handler),
  onWakeHeard: (handler: (heard: { word: string; test: boolean; afterMs: number }) => void) => void (wakeHeard = handler),
  setWakeState: (status: WakeStatus) => wakeState?.(status),
  wakeTaught: async (words: string[]) => words.filter((word) => taughtWords.has(word)),
  wakeTeachEnd: async (word: string | null) => void (word && taughtWords.add(word)),
  wakeForget: async (word: string) => void taughtWords.delete(word),
  hearWake: (word: string, test = false, afterMs = 0) => wakeHeard?.({ word, test, afterMs }),
  onAssistantStartNotes: (handler: () => void) => void (notesAsked = handler),
  /** As the core does when the user asks the assistant to take notes. */
  askForNotes: () => notesAsked?.(),
  setPacks: (ids: string[]) => {
    voicePacks.clear();
    ids.forEach((id) => voicePacks.add(id));
  },
  setHeard: (words: string) => void (heardWords = words),
  spoken: () => spokenWords,
  checkUpdate: async () => {
    updateLooks++;
    return updateStatus;
  },
  installUpdate: () => {
    updateInstalled = true;
    // Succeeding ends the real app, so this only ever answers with a failure.
    return new Promise<void>((_, reject) => (failInstalling = reject));
  },
  failInstall: (why: string) => failInstalling(new Error(why)),
  updateKind: async () => installKind,
  onNoteQuiet: (handler: (left: number) => void) => void (noteQuiet = handler),
  onNoteStoppedQuiet: (handler: (id: string) => void) => void (noteStoppedQuiet = handler),
  quietCall: (left: number) => noteQuiet(left),
  stoppedQuiet: (id: string) => noteStoppedQuiet(id),
  keepRecording: async () => void (keptRecording += 1),
  keptRecording: () => keptRecording,
  setInstallKind: (kind: "setup" | "msi" | "portable") => void (installKind = kind),
  hushOn: async (leaveCalls: boolean) => void hushes.push(leaveCalls ? "on, calls left alone" : "on"),
  hushOff: async () => void hushes.push("off"),
  hushes: () => hushes,
  terminalFocus: async (pid: number) => (focused.push(pid), terminalFound),
  terminalInFront: async (pid: number) => inFront.includes(pid),
  focused: () => focused,
  setInFront: (pids: number[]) => void (inFront = pids),
  setTerminalFound: (found: boolean) => void (terminalFound = found),
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
  watchSet: async (on: boolean) => void (watching = hooksWanted = on),
  hooksHealth: async (projects: string[]) => ({ on: watching || hooksWanted, inPlace: watching, offIn: projects.filter((p) => hooksOff.includes(p)) }),
  /** Following is on, and something has taken its hooks out of Claude Code's settings. */
  loseHooks: () => void ((hooksWanted = true), (watching = false)),
  setHooksOff: (projects: string[]) => void (hooksOff = projects),
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
    emit({ sessionId, event: { type: "watched", agent: "Claude Code", cwd: "C:\\Projects\\shop", title: "Fix the checkout", pid: 4242 } });
    emit({ sessionId, event: { type: "activity", label: "Editing cart.ts" } });
  },
  publishEvent: (sessionId: string, event: AgentEvent) => emit({ sessionId, event }),
  publishText: (sessionId: string, text: string) => emit({ sessionId, event: { type: "text", text } }),
  publishFailure: (sessionId: string, message: string) => emit({ sessionId, event: { type: "status", status: "failed", message } }),
  publishWatchedApproval: (sessionId: string) =>
    emit({ sessionId, event: { type: "approval", approval: { id: "w1", tool: "Bash", summary: "npm install stripe" } } }),
  publishWatchedQuestion: (sessionId: string, multi = false) =>
    emit({ sessionId, event: { type: "approval", approval: { id: "q1", tool: "AskUserQuestion", summary: "Which one?", questions: [
      { text: "Which one?", options: ["Teal", "Amber"], multi },
      { text: "And then?", options: ["Ship it", "Wait"], multi: false },
    ] } } }),
  /** The question answered in the terminal itself, before anyone answers it here. */
  answerInTerminal: (sessionId: string, approvalId = "q1") => emit({ sessionId, event: { type: "approvalResolved", id: approvalId } }),
  publishWatchedPlan: (sessionId: string) =>
    emit({ sessionId, event: { type: "approval", approval: { id: "p1", tool: "ExitPlanMode", summary: "Add a page", plan: "## Add a page\n\n1. Write it\n2. Test it" } } }),
  /** The last answer given to a question, so a test can see what would go back. */
  lastAnswers: () => lastAnswers,
  /** How many times the app asked GitHub for the latest release. */
  updateLooks: () => updateLooks,

  async startSession(request: { agent: string; cwd: string; prompt: string }) {
    const sessionId = crypto.randomUUID();
    known.add(sessionId);
    const send = (event: AgentEvent) => emit({ sessionId, event });
    void (async () => {
      await sleep(20);
      send({ type: "started", nativeId: "stand-in", model: "stand-in-model" });
      send({ type: "status", status: "running" });
      if (nextAnswer) return answerWith(send);
      if (request.prompt.startsWith("chat:")) {
        await sleep(30);
        send({ type: "text", text: "Hello from the stand-in agent." });
        send({ type: "usage", input: 10, output: 5, costUsd: 0.001 });
        send({ type: "status", status: "completed" });
        return;
      }
      send({ type: "activity", label: "Reading src/main.rs" });
      // A prompt saying "quietly" keeps working without asking, so a test can lead it step by step.
      if (request.prompt.includes("quietly")) return;
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
    // A terminal carries on by itself, and says what it does next through its hooks.
    if (sessionId.startsWith("watch:")) return;
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
    if (nextAnswer) return answerWith((event) => emit({ sessionId, event }));
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

  // ── Cards you can act on ──
  // What counts as a card is the core's, tested in cards.rs. This keeps the board's three, and Not now,
  // Dismiss and the drafts, as the core would.
  cardsState: async (): Promise<CardsState> => ({ cards: shownCards(), failures: cardFailures, checking: cardsHeld !== null, checkedAt: cardsCheckedAt }),
  async cardsCheck(morning: boolean) {
    cardChecks += 1;
    if (cardsHeld) await new Promise<void>((done) => (cardsHeld = done));
    cardsHeld = null;
    cardList = nextCards.map((card) => cardList.find((was) => was.id === card.id) ?? card);
    cardFailures = nextFailures;
    cardsCheckedAt = Date.now();
    cardsChanged();
    const today = new Date().toDateString();
    const due = morning && settings.myDay.summary && shownCards().length > 0 && summaryOn !== today;
    if (due) summaryOn = today;
    return due;
  },
  cardsHide: async (id: string, until: number) => {
    cardList = cardList.map((card) => (card.id === id ? { ...card, hiddenUntil: until } : card));
    cardsChanged();
  },
  cardsDismiss: async (id: string, gone: boolean) => {
    if (gone) dismissedCards.add(id);
    else dismissedCards.delete(id);
    cardsChanged();
  },
  async cardsDraft(id: string) {
    await sleep(30);
    cardList = cardList.map((card) => (card.id === id && card.kind === "reply" ? { ...card, draft: CARL_DRAFT } : card));
    cardsChanged();
    return CARL_DRAFT;
  },
  cardsSetDraft: async (id: string, text: string) => {
    cardList = cardList.map((card) => (card.id === id && card.kind === "reply" ? { ...card, draft: text } : card));
    cardsChanged();
  },
  onCardsChanged: (handler: () => void) => void (cardsChanged = handler),
  onCardsDue: (handler: () => void) => void (cardsDue = handler),
  /** The board's three cards, as a check left them. */
  seedCards: (kinds: Card["kind"][] = ["reply", "renewal", "trip"]) => {
    cardList = BOARD_CARDS.filter((card) => kinds.includes(card.kind)).map((card) => structuredClone(card));
    cardsCheckedAt = Date.now();
    cardsChanged();
  },
  /** What the next check finds. */
  nextCheck: (kinds: Card["kind"][], failures: CardsState["failures"] = []) => {
    nextCards = BOARD_CARDS.filter((card) => kinds.includes(card.kind));
    nextFailures = failures;
  },
  /** As the core does the first time the PC is in use after 6 am. */
  cardsDue: () => cardsDue(),
  /** As the core does when a card put off with Not now is back. */
  tellCards: () => cardsChanged(),
  cardChecks: () => cardChecks,
  /** Holds the next check open until `releaseCards`. */
  holdCards: () => void (cardsHeld = () => {}),
  releaseCards: () => cardsHeld?.(),
};

const CARL_DRAFT = "Hi Carl,\nSorry for the slow reply. I'll send the October invoice today, so you have it well before Friday's close.\nThanks,\nRavi";
/** The board's three, in India's time, as on Friday 6 November 2026. */
const BOARD_CARDS: Card[] = [
  { kind: "reply", id: "reply:19d4", seen: "2026-11-03T10:12:00+05:30", link: "https://mail.google.com/mail/#all/19d4", hiddenUntil: null, who: "Carl Mendes", address: "carl@brightline.example", subject: "October invoice", asked: "the October invoice", draft: CARL_DRAFT },
  { kind: "renewal", id: "renewal:netflix:2026-11-07", seen: "2026-10-07T08:00:00+05:30", link: "https://mail.google.com/mail/#all/18a1", hiddenUntil: null, service: "Netflix", amount: "₹649", on: "2026-11-07", period: "month", trial: false, receipt: true },
  {
    kind: "trip", id: "trip:e7:2026-11-10", seen: "2026-11-10T14:00:00+05:30", link: "https://calendar.google.com/calendar/event?eid=e7", hiddenUntil: null,
    event: "Pune office visit", starts: "2026-11-10T14:00:00+05:30", location: "Pune office, Baner, Pune", place: "the Pune office", title: "Book a train to Pune?",
    step: "Take a morning train from Mumbai that gets in before noon, which leaves time before your 2 pm.", site: { name: "IRCTC", url: "https://www.irctc.co.in/" }, planned: true,
  },
];
let cardList: Card[] = [];
let nextCards: Card[] = BOARD_CARDS;
let nextFailures: CardsState["failures"] = [];
let cardFailures: CardsState["failures"] = [];
let cardsCheckedAt: number | null = null;
let cardChecks = 0;
let cardsHeld: (() => void) | null = null;
let summaryOn = "";
const dismissedCards = new Set<string>();
let cardsChanged = () => {};
let cardsDue = () => {};
/** As the core shows them: not dismissed, not put off, of a kind that is on. */
const shownCards = () => {
  const on = settings.myDay;
  const wanted = { reply: on.replies, renewal: on.renewals, trip: on.trips };
  return cardList.filter((card) => !dismissedCards.has(card.id) && (card.hiddenUntil === null || card.hiddenUntil <= Date.now()) && wanted[card.kind]);
};
