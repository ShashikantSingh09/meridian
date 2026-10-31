// The only module that talks to the Rust core. Components call these functions
// and never see a provider or agent wire format.

import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { mock } from "./mock";
import type {
  AgentEnvelope,
  AgentId,
  AgentInfo,
  AuthStatus,
  Capture,
  Category,
  ChatEvent,
  ChatMessage,
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
  ReminderLogEntry,
  ScreenSuggestion,
  Settings,
  SettingsChange,
  Level,
  VoiceInfo,
  WakeStatus,
} from "./types";

export const native = isTauri();

let dialogOpen = false;

export interface IslandRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VoiceStatus {
  packs: { id: string; name: string; bytes: number; installed: boolean }[];
  keys: string[];
}

export interface UpdateStatus {
  current: string;
  latest: string | null;
  available: boolean;
  notes: string;
  published: string | null;
  message: string;
}

export interface StartSession {
  agent: AgentId;
  cwd: string;
  prompt: string;
  model: string | null;
  restricted?: boolean;
  images?: string[];
}

export const bridge = {
  setIslandRect: (rect: IslandRect) =>
    native ? invoke<void>("island_set_rect", { rect: { ...rect, dpr: window.devicePixelRatio || 1 } }) : Promise.resolve(),
  setInteractive: (on: boolean) => (native ? invoke<void>("island_set_interactive", { on }) : Promise.resolve()),

  getSettings: () => (native ? invoke<Settings>("settings_get") : mock.getSettings()),
  saveSettings: (settings: Settings) =>
    native ? invoke<void>("settings_save", { settings }) : mock.saveSettings(settings),

  listProviders: () => (native ? invoke<ProviderInfo[]>("providers_list") : mock.listProviders()),
  setProviderKey: (id: string, key: string) =>
    native ? invoke<void>("provider_set_key", { id, key }) : mock.setProviderKey(id),
  clearProviderKey: (id: string) => (native ? invoke<void>("provider_clear_key", { id }) : mock.clearProviderKey(id)),
  listModels: (id: string) => (native ? invoke<ModelInfo[]>("provider_models", { id }) : mock.listModels()),
  testProvider: (id: string) => (native ? invoke<string>("provider_test", { id }) : mock.testProvider()),
  discoverLocal: () => (native ? invoke<LocalServer[]>("providers_discover") : mock.discoverLocal()),

  streamChat(requestId: string, provider: string, model: string, messages: ChatMessage[], onEvent: (e: ChatEvent) => void) {
    if (!native) return mock.streamChat(onEvent);
    const channel = new Channel<ChatEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("chat_stream", { requestId, provider, model, messages, channel });
  },
  cancelChat: (requestId: string) => (native ? invoke<void>("chat_cancel", { requestId }) : Promise.resolve()),

  detectAgents: () => (native ? invoke<AgentInfo[]>("agents_detect") : mock.detectAgents()),
  agentAuth: (agent: AgentId) => (native ? invoke<AuthStatus | null>("agent_auth", { agent }) : mock.agentAuth(agent)),
  agentLogin: (agent: AgentId) => (native ? invoke<void>("agent_login", { agent }) : Promise.resolve()),
  assistantDir: () => (native ? invoke<string>("assistant_dir") : Promise.resolve("C:\\Assistant")),
  monitors: () => (native ? invoke<string[]>("monitors_list") : Promise.resolve(["Display 1"])),
  startSession: (request: StartSession) =>
    native ? invoke<string>("session_start", { request }) : mock.startSession(request),
  sendToSession: (id: string, text: string, images: string[] = []) =>
    native ? invoke<void>("session_send", { id, text, images }) : mock.sendToSession(id, text),
  refreshRunning: () => (native ? invoke<void>("running_refresh") : Promise.resolve()),
  adoptSession: (earlier: { id: string; agent: AgentId; cwd: string; model: string | null; restricted: boolean; nativeId: string }) =>
    native ? invoke<void>("session_adopt", { earlier }) : mock.adoptSession(earlier.id),
  cancelSession: (id: string) => (native ? invoke<void>("session_cancel", { id }) : mock.cancelSession(id)),
  answerApproval: (sessionId: string, approvalId: string, allow: boolean, answers?: Record<string, string | string[]>) =>
    native
      ? invoke<void>("session_answer", { sessionId, approvalId, allow, answers: answers ?? null })
      : mock.answerApproval(sessionId, approvalId, allow, answers),
  openProject: (cwd: string) => (native ? invoke<void>("open_project", { cwd }) : Promise.resolve()),

  mediaAction: (action: MediaAction) => (native ? invoke<void>("media_action", { action }) : mock.mediaAction(action)),

  activityList: (category: Category | null) =>
    native ? invoke<ContextEvent[]>("activity_list", { category }) : mock.activityList(category),
  activityDismiss: (id: string) => (native ? invoke<void>("activity_dismiss", { id }) : mock.activityDelete(id)),
  activityDelete: (id: string) => (native ? invoke<void>("activity_delete", { id }) : mock.activityDelete(id)),
  activitySnooze: (id: string, minutes: number) =>
    native ? invoke<void>("activity_snooze", { id, minutes }) : Promise.resolve(),
  activityCorrect: (id: string, title: string) =>
    native ? invoke<void>("activity_correct", { id, title }) : mock.activityCorrect(id, title),
  activityAddReminder: (title: string, startsAt: EventTime) =>
    native ? invoke<void>("activity_add_reminder", { title, startsAt }) : mock.activityAddReminder(title, startsAt),
  activityImport: (subject: string, from: string, body: string) =>
    native ? invoke<number>("activity_import", { subject, from, body }) : mock.activityImport(subject),
  activityContext: (agent: boolean, media: boolean, screen: boolean) =>
    native ? invoke<void>("activity_context", { agent, media, screen }) : Promise.resolve(),
  reminderLog: () => (native ? invoke<ReminderLogEntry[]>("reminder_log") : Promise.resolve([])),
  accountsList: () => (native ? invoke<ConnectedAccount[]>("accounts_list") : mock.accountsList()),
  accountConnect: (provider: ConnectedAccount["provider"], secret: string | null) =>
    native ? invoke<ConnectedAccount>("account_connect", { provider, secret }) : mock.accountConnect(provider),
  accountDisconnect: (id: string) =>
    native ? invoke<void>("account_disconnect", { id }) : mock.accountDisconnect(id),
  accountSync: (id: string) => (native ? invoke<string>("account_sync", { id }) : Promise.resolve("Up to date.")),
  openUrl: (url: string) => (native ? invoke<void>("open_url", { url }) : Promise.resolve()),
  builtInClients: () => (native ? invoke<[boolean, boolean]>("built_in_clients") : Promise.resolve<[boolean, boolean]>([true, true])),
  /** Sends the user to the service's own page, and stores what comes back. */
  aiSignIn: (id: string) => (native ? invoke<void>("ai_sign_in", { id }) : mock.setProviderKey(id)),

  integrationsList: () => (native ? invoke<Integration[]>("integrations_list") : mock.integrationsList()),
  integrationConnect: (id: string) => (native ? invoke<void>("integration_connect", { id }) : mock.integrationConnect(id)),
  integrationDisconnect: (id: string) =>
    native ? invoke<void>("integration_disconnect", { id }) : mock.integrationDisconnect(id),
  integrationFetch: (id: string, tool: string | null) =>
    native ? invoke<Digest>("integration_fetch", { id, tool }) : mock.integrationFetch(id, tool),

  watchStatus: () => (native ? invoke<boolean>("watch_status") : Promise.resolve(mock.watching())),
  watchPreview: (on: boolean) => (native ? invoke<SettingsChange>("watch_preview", { on }) : mock.watchPreview(on)),
  watchSet: (on: boolean) => (native ? invoke<void>("watch_set", { on }) : mock.watchSet(on)),

  appVersion: () => (native ? invoke<string>("app_version") : Promise.resolve("0.0.0")),
  checkUpdate: (): Promise<UpdateStatus> =>
    native
      ? invoke<UpdateStatus>("update_check")
      : mock.checkUpdate(),
  installUpdate: () => (native ? invoke<void>("update_install") : mock.installUpdate()),
  openLogs: () => (native ? invoke<void>("open_logs") : Promise.resolve()),
  openSoundSettings: () => (native ? invoke<void>("open_sound_settings") : Promise.resolve()),

  screenCapture: (target: "window" | "screen") =>
    native ? invoke<Capture>("screen_capture", { target }) : mock.screenCapture(),
  screenCrop: (x: number, y: number, w: number, h: number) =>
    native ? invoke<Capture>("screen_crop", { x, y, w, h }) : mock.screenCapture(),
  screenDiscard: () => (native ? invoke<void>("screen_discard") : Promise.resolve()),
  screenIgnore: (key: string) => (native ? invoke<void>("screen_ignore", { key }) : Promise.resolve()),

  pickFolder: async () => {
    if (!native) return "C:\\Projects\\sample";
    const { open } = await import("@tauri-apps/plugin-dialog");
    dialogOpen = true;
    try {
      const picked = await open({ directory: true, multiple: false });
      return typeof picked === "string" ? picked : null;
    } finally {
      dialogOpen = false;
    }
  },
  pickFile: async () => {
    if (!native) return "C:\\Projects\\sample\\notes.md";
    const { open } = await import("@tauri-apps/plugin-dialog");
    dialogOpen = true;
    try {
      const picked = await open({ multiple: false });
      return typeof picked === "string" ? picked : null;
    } finally {
      dialogOpen = false;
    }
  },
  /** The folder picker takes focus, which is not click-away. */
  dialogOpen: () => dialogOpen,

  setAutostart: async (on: boolean) => {
    if (!native) return;
    const { enable, disable } = await import("@tauri-apps/plugin-autostart");
    await (on ? enable() : disable());
  },

  onAgentEvent(handler: (e: AgentEnvelope) => void) {
    if (!native) return mock.onAgentEvent(handler);
    return listen<AgentEnvelope>("agent-event", (e) => handler(e.payload)).then((un) => un);
  },
  /** Where the pointer is, from -1 to 1 each way, so the face can look at it. */
  onGaze(handler: (x: number, y: number) => void) {
    if (!native) {
      const move = (e: MouseEvent) => handler((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
      addEventListener("mousemove", move);
      return Promise.resolve(() => removeEventListener("mousemove", move));
    }
    return listen<[number, number]>("island-gaze", (e) => handler(e.payload[0], e.payload[1])).then((un) => un);
  },
  onHover(handler: (hovered: boolean) => void) {
    if (!native) return Promise.resolve(() => {});
    return listen<boolean>("island-hover", (e) => handler(e.payload)).then((un) => un);
  },
  onTogglePanel(handler: () => void) {
    if (!native) return Promise.resolve(() => {});
    return listen("island-toggle", handler).then((un) => un);
  },
  onBlur(handler: () => void) {
    if (!native) return Promise.resolve(() => {});
    return listen("island-blur", handler).then((un) => un);
  },
  onSettingsChanged(handler: (s: Settings) => void) {
    if (!native) return Promise.resolve(() => {});
    return listen<Settings>("settings-changed", (e) => handler(e.payload)).then((un) => un);
  },
  onReminders(handler: (r: Reminder[]) => void) {
    if (!native) return mock.onReminders(handler);
    return listen<Reminder[]>("activity-reminders", (e) => handler(e.payload)).then((un) => un);
  },
  onActivityChanged(handler: () => void) {
    if (!native) return Promise.resolve(() => {});
    return listen("activity-changed", handler).then((un) => un);
  },
  voiceStatus: (): Promise<VoiceStatus> => (native ? invoke<VoiceStatus>("voice_status") : mock.voiceStatus()),
  voiceList: (provider: string): Promise<VoiceInfo[]> => (native ? invoke<VoiceInfo[]>("voice_list", { provider }) : mock.voiceList(provider)),
  voiceKeySet: (provider: string, key: string) => (native ? invoke<void>("voice_key_set", { provider, key }) : mock.voiceKeySet(provider)),
  voiceKeyClear: (provider: string) => (native ? invoke<void>("voice_key_clear", { provider }) : mock.voiceKeyClear(provider)),
  voiceDownload(id: string, onBytes: (bytes: number) => void) {
    if (!native) return mock.voiceDownload(id, onBytes);
    const on = new Channel<number>();
    on.onmessage = onBytes;
    return invoke<void>("voice_download", { id, on });
  },
  voiceRemove: (id: string) => (native ? invoke<void>("voice_remove", { id }) : mock.voiceRemove(id)),
  /** The first thing `onAudio` gets is the sample rate. After that, 16-bit audio. */
  voiceSpeak(text: string, provider: string | undefined, voiceId: string | undefined, onAudio: (data: ArrayBuffer) => void) {
    if (!native) return mock.voiceSpeak(text);
    return new Promise<void>((resolve, reject) => {
      const on = new Channel<ArrayBuffer>();
      // Finishes on the empty last message, not the call, so all the audio has arrived.
      on.onmessage = (data) => (data.byteLength ? onAudio(data) : resolve());
      invoke<void>("voice_speak", { text, provider: provider ?? null, voiceId: voiceId ?? null, on }).catch(reject);
    });
  },
  voiceStop: () => (native ? invoke<void>("voice_stop") : Promise.resolve()),
  voiceHearStart: () => (native ? invoke<void>("voice_hear_start") : Promise.resolve()),
  voiceHear: (pcm: Uint8Array) => (native ? invoke<string>("voice_hear", pcm) : mock.voiceHeard()),
  voiceHearEnd: () => (native ? invoke<string>("voice_hear_end") : mock.voiceHeard()),
  onAssistantOpen(handler: (tab: string) => void) {
    if (!native) return Promise.resolve();
    return listen<string>("assistant-open", (e) => handler(e.payload)).then(() => {});
  },
  onAssistantAgent(handler: (start: { task: string; folder: string }) => void) {
    if (!native) return Promise.resolve();
    return listen<{ task: string; folder: string }>("assistant-start-agent", (e) => handler(e.payload)).then(() => {});
  },
  wakeStatus: () => (native ? invoke<WakeStatus>("wake_status") : Promise.resolve<WakeStatus>({ state: "off", why: "" })),
  wakeTalking: (on: boolean) => (native ? invoke<void>("wake_talking", { on }) : Promise.resolve()),
  wakeTest: () => (native ? invoke<void>("wake_test") : Promise.resolve()),
  onWakeState(handler: (status: WakeStatus) => void) {
    if (!native) return Promise.resolve(mock.onWakeState(handler));
    return listen<WakeStatus>("wake-state", (e) => handler(e.payload)).then(() => {});
  },
  onWakeHeard(handler: (heard: { word: string; test: boolean; spokenMs: number }) => void) {
    if (!native) return Promise.resolve(mock.onWakeHeard(handler));
    return listen<{ word: string; test: boolean; spokenMs: number }>("wake-heard", (e) => handler(e.payload)).then(() => {});
  },
  onVoiceKey(handler: (down: boolean) => void) {
    if (!native) return Promise.resolve(() => {});
    return listen<boolean>("voice-key", (e) => handler(e.payload)).then((un) => un);
  },
  onLevel(handler: (level: Level) => void) {
    if (!native) return mock.onLevel(handler);
    return listen<Level>("level-change", (e) => handler(e.payload)).then((un) => un);
  },
  onMedia(handler: (s: MediaSnapshot) => void) {
    if (!native) return mock.onMedia(handler);
    return listen<MediaSnapshot>("media-state", (e) => handler(e.payload)).then((un) => un);
  },
  onScreenSuggestion(handler: (s: ScreenSuggestion) => void) {
    if (!native) return Promise.resolve(() => {});
    return listen<ScreenSuggestion>("screen-suggestion", (e) => handler(e.payload)).then((un) => un);
  },
  onCaptureRequest(handler: () => void) {
    if (!native) return Promise.resolve(() => {});
    return listen("screen-capture-request", handler).then((un) => un);
  },
  onOpenTab(handler: (tab: string) => void) {
    if (!native) return Promise.resolve(() => {});
    return listen<string>("island-open-tab", (e) => handler(e.payload)).then((un) => un);
  },
};
