// The only module that talks to the Rust core. Components call these functions
// and never see a provider or agent wire format.

import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { mock } from "./mock";
import type {
  AgentEnvelope,
  AgentId,
  AgentInfo,
  ChatEvent,
  ChatMessage,
  LocalServer,
  ModelInfo,
  ProviderInfo,
  Settings,
} from "./types";

export const native = isTauri();

let dialogOpen = false;

export interface IslandRect {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

export interface StartSession {
  agent: AgentId;
  cwd: string;
  prompt: string;
  model: string | null;
}

export const bridge = {
  setIslandRect: (rect: IslandRect) =>
    native ? invoke<void>("island_set_rect", { rect: { ...rect, dpr: window.devicePixelRatio || 1 } }) : Promise.resolve(),
  setInteractive: (on: boolean) => (native ? invoke<void>("island_set_interactive", { on }) : Promise.resolve()),
  glassStatus: () => (native ? invoke<boolean>("glass_active") : Promise.resolve(false)),

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
  startSession: (request: StartSession) =>
    native ? invoke<string>("session_start", { request }) : mock.startSession(request),
  sendToSession: (id: string, text: string) =>
    native ? invoke<void>("session_send", { id, text }) : Promise.resolve(),
  cancelSession: (id: string) => (native ? invoke<void>("session_cancel", { id }) : mock.cancelSession(id)),
  answerApproval: (sessionId: string, approvalId: string, allow: boolean) =>
    native
      ? invoke<void>("session_answer", { sessionId, approvalId, allow })
      : mock.answerApproval(sessionId, approvalId, allow),
  openProject: (cwd: string) => (native ? invoke<void>("open_project", { cwd }) : Promise.resolve()),

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
  onOpenTab(handler: (tab: string) => void) {
    if (!native) return Promise.resolve(() => {});
    return listen<string>("island-open-tab", (e) => handler(e.payload)).then((un) => un);
  },
};
