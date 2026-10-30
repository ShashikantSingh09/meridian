// Stands in for the Rust core when the UI runs in a plain browser, which is how
// the Playwright suite exercises the interface. Never loaded inside Tauri paths.

import type {
  AgentEnvelope,
  AgentEvent,
  AgentId,
  AgentInfo,
  AuthStatus,
  ChatEvent,
  LocalServer,
  ModelInfo,
  ProviderInfo,
  Settings,
} from "./types";
import { defaultSettings } from "./types";

const caps = { streaming: true, tools: true, vision: false, modelDiscovery: true, usage: true };

const providers: ProviderInfo[] = [
  { id: "anthropic", name: "Anthropic", kind: "cloud", baseUrl: "https://api.anthropic.com", needsKey: true, hasKey: true, capabilities: { ...caps, vision: true } },
  { id: "openai", name: "OpenAI", kind: "cloud", baseUrl: "https://api.openai.com/v1", needsKey: true, hasKey: false, capabilities: caps },
  { id: "ollama", name: "Ollama", kind: "local", baseUrl: "http://localhost:11434/v1", needsKey: false, hasKey: false, capabilities: { ...caps, usage: false } },
];

let settings: Settings = { ...defaultSettings };
let emit: (e: AgentEnvelope) => void = () => {};
let authed = true;
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

  agentAuth: async (agent: AgentId): Promise<AuthStatus> =>
    agent === "claude-code"
      ? { signedIn: authed, method: "claude.ai", plan: "max" }
      : { signedIn: false, method: null, plan: null },
  setAuthed: (value: boolean) => void (authed = value),

  async startSession(request: { agent: string; cwd: string; prompt: string }) {
    const sessionId = crypto.randomUUID();
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

  async answerApproval(sessionId: string, approvalId: string, allow: boolean) {
    emit({ sessionId, event: { type: "approvalResolved", id: approvalId } });
    if (approvalId === "a1" && pendingSecond(sessionId)) return;
    if (!allow) return emit({ sessionId, event: { type: "status", status: "cancelled" } });
    await sleep(40);
    emit({ sessionId, event: { type: "text", text: "All tests pass." } });
    emit({ sessionId, event: { type: "usage", input: 1200, output: 340, costUsd: 0.012 } });
    emit({ sessionId, event: { type: "status", status: "completed" } });
  },

  async sendToSession(sessionId: string, text: string) {
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
