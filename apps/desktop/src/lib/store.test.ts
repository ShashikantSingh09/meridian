// The store's timing, against the browser stand-in for the core. Each of these is something a
// spoken turn or a click depends on happening at once, before anything has been waited for.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridge } from "./bridge";
import { applyAgentEvent, nextEngine, clearAgentFocus, clearChat, closeOnBlur, closePanel, dismissError, dismissNotice, getState, onThisPc, openPanel, openSession, pushError, pushNotice, refreshProviders, selectProvider, sendChat, serverAddress, sendToSession, setHovered, startSession, toggleFromCore } from "./store";
import type { AgentEvent } from "./types";

vi.mock("./sound", () => ({ chime: () => {} }));

describe("a chat turn", () => {
  it("counts as under way before the model list has answered", async () => {
    await refreshProviders();
    const sent = sendChat("hello");
    expect(getState().chatPending).toBe(true);
    await sent;
    expect(getState().chatPending).toBe(false);
  });

  it("lets go again when no model turns up", async () => {
    await refreshProviders();
    const listModels = vi.spyOn(bridge, "listModels").mockResolvedValue([]);
    await selectProvider("anthropic");
    await sendChat("hello");
    listModels.mockRestore();
    expect(getState().chatPending).toBe(false);
    expect(getState().errors.at(-1)?.title).toBe("No model available");
  });

  it("drops what is still arriving after New chat, and stays cleared", async () => {
    await refreshProviders();
    const sent = sendChat("hello");
    await vi.waitFor(() => expect(getState().chat.requestId).not.toBeNull());
    clearChat();
    await sent;
    expect(getState().chat.messages).toEqual([]);
    expect(getState().chatPending).toBe(false);
  });

  it("gives a new question the chat, whatever the one it replaced still sends", async () => {
    await refreshProviders();
    clearChat();
    const first = sendChat("first");
    await vi.waitFor(() => expect(getState().chat.requestId).not.toBeNull());
    const second = sendChat("second");
    await Promise.all([first, second]);
    // The words of both requests would show here, twice over, if the old one still wrote.
    expect(getState().chat.messages.at(-1)?.content).toBe("This is the browser stand-in for a real provider. ");
    expect(getState().chatPending).toBe(false);
  });
});

describe("a follow-up to an agent", () => {
  const ended = async () => {
    const id = await startSession({ agent: "claude-code", cwd: "C:\\Projects", prompt: "work", model: null });
    applyAgentEvent({ sessionId: id!, event: { type: "status", status: "cancelled" } });
    return id!;
  };
  const status = (id: string) => getState().sessions.find((s) => s.id === id)?.status;

  it("is running from the moment it is sent", async () => {
    const id = await ended();
    const sent = sendToSession(id, "and again");
    expect(status(id)).toBe("running");
    await sent;
  });

  it("goes back to how it was when the message does not arrive", async () => {
    const id = await ended();
    vi.spyOn(bridge, "sendToSession").mockRejectedValueOnce(new Error("gone"));
    await sendToSession(id, "and again");
    expect(status(id)).toBe("cancelled");
  });
});

describe("what an agent is doing", () => {
  const session = (id: string) => getState().sessions.find((s) => s.id === id)!;
  const send = (sessionId: string, event: AgentEvent) => applyAgentEvent({ sessionId, event });
  const started = async (surface: "agents" | "chat" = "agents") =>
    (await startSession({ agent: "claude-code", cwd: "C:\\Projects\\shop", prompt: "work", model: null }, surface))!;

  beforeEach(() => {
    closePanel();
    getState().notices.forEach((n) => dismissNotice(n.id));
    getState().errors.forEach((e) => dismissError(e.id));
  });

  it("notes when each step happened", async () => {
    const id = await started();
    send(id, { type: "activity", label: "Reading a.ts" });
    send(id, { type: "diff", path: "a.ts", removed: [], added: ["x"], linesRemoved: 0, linesAdded: 40 });
    const [step, diff] = session(id).log.slice(-2);
    expect(step!.at).toBeGreaterThan(0);
    expect(diff).toMatchObject({ linesAdded: 40, added: ["x"] });
  });

  it("keeps the agent's list, whole or a line at a time", async () => {
    const id = await started();
    send(id, { type: "todos", items: [{ id: "0", text: "One", status: "in_progress" }] });
    send(id, { type: "todoChanged", id: "0", status: "completed" });
    send(id, { type: "todoChanged", id: "7", text: "Two" });
    expect(session(id).todos).toEqual([{ id: "0", text: "One", status: "completed" }, { id: "7", text: "Two", status: "pending" }]);
  });

  it("goes back to what it was doing once a request is answered", async () => {
    const id = await started();
    send(id, { type: "activity", label: "$ npm test" });
    send(id, { type: "approval", approval: { id: "r", tool: "Bash", summary: "npm test" } });
    expect(session(id).activity).toBe("Waiting for approval: Bash");
    send(id, { type: "approvalResolved", id: "r" });
    expect(session(id).activity).toBe("$ npm test");
  });

  it("starts a new turn when an ended session runs again, and keeps its replies apart", async () => {
    const id = await started();
    send(id, { type: "text", text: "First." });
    send(id, { type: "status", status: "completed" });
    expect(session(id).turnAt).toBeUndefined();
    await new Promise((r) => setTimeout(r, 5));
    send(id, { type: "status", status: "running" });
    const { turnAt } = session(id);
    expect(turnAt).toBeGreaterThan(0);
    send(id, { type: "text", text: "Second." });
    expect(session(id).log.filter((e) => e.kind === "text").map((e) => e.text)).toEqual(["First.", "Second."]);
    send(id, { type: "status", status: "running" });
    expect(session(id).turnAt, "only an ended session starts a turn").toBe(turnAt);
  });

  it("lets go of a finished list at the next turn, and keeps one still under way", async () => {
    const id = await started();
    send(id, { type: "todos", items: [{ id: "0", text: "One", status: "completed" }] });
    send(id, { type: "status", status: "completed" });
    send(id, { type: "status", status: "running" });
    expect(session(id).todos).toBeUndefined();
    send(id, { type: "todos", items: [{ id: "0", text: "One", status: "in_progress" }] });
    send(id, { type: "status", status: "completed" });
    send(id, { type: "status", status: "running" });
    expect(session(id).todos).toHaveLength(1);
  });

  it("finishes on a card that stays 12 seconds, then moves to Notifications", async () => {
    const id = await started();
    vi.useFakeTimers();
    send(id, { type: "status", status: "completed" });
    expect(getState().notices).toHaveLength(1);
    expect(getState().notices[0]).toMatchObject({ title: "shop is done", finished: true, sessionId: id });
    vi.advanceTimersByTime(11_000);
    expect(getState().notices).toHaveLength(1);
    vi.advanceTimersByTime(1_500);
    vi.useRealTimers();
    expect(getState().notices).toHaveLength(0);
    expect(getState().pastNotices[0]).toMatchObject({ title: "shop is done", sessionId: id });
  });

  it("stays while the pointer is on the card", async () => {
    const id = await started();
    vi.useFakeTimers();
    send(id, { type: "status", status: "completed" });
    setHovered(true);
    vi.advanceTimersByTime(200);
    vi.advanceTimersByTime(30_000);
    expect(getState().notices).toHaveLength(1);
    setHovered(false);
    // Once the pointer leaves it gets a last 5 s with the closing line, rather than vanishing.
    vi.advanceTimersByTime(2_000);
    expect(getState().notices).toHaveLength(1);
    expect(Object.keys(getState().closing)).toHaveLength(1);
    vi.advanceTimersByTime(5_000);
    vi.useRealTimers();
    expect(getState().notices).toHaveLength(0);
    expect(getState().closing).toEqual({});
  });

  it("keeps a finished card when opening the panel takes it off the island", async () => {
    const id = await started();
    send(id, { type: "status", status: "completed" });
    openPanel("home");
    expect(getState().notices).toHaveLength(0);
    expect(getState().pastNotices[0]?.sessionId).toBe(id);
  });

  it("does not say so twice for a reply already showing in Chat", async () => {
    const id = await started("chat");
    openPanel("chat");
    const before = getState().pastNotices.length;
    send(id, { type: "status", status: "completed" });
    closePanel();
    expect(getState().notices).toHaveLength(0);
    expect(getState().pastNotices).toHaveLength(before);
  });

  it("gives the assistant no finished card, with the panel open or closed", async () => {
    const id = await started("chat");
    send(id, { type: "status", status: "completed" });
    expect(getState().notices).toHaveLength(0);
  });

  it("does not call a terminal that went silent done", async () => {
    const id = await started();
    send(id, { type: "status", status: "completed", message: "No word from this session" });
    expect(getState().notices[0]).toMatchObject({ title: "shop went quiet", body: "No word from this session" });
    expect(getState().notices[0]?.finished).toBeUndefined();
  });

  it("keeps a failed agent up for a minute, then moves it to Notifications", async () => {
    const id = await started();
    vi.useFakeTimers();
    send(id, { type: "status", status: "failed", message: "2 tests failed in machine.test.ts" });
    vi.advanceTimersByTime(30_000);
    expect(getState().errors.at(-1)).toMatchObject({ body: "2 tests failed in machine.test.ts", sessionId: id });
    vi.advanceTimersByTime(31_000);
    vi.useRealTimers();
    expect(getState().errors.some((e) => e.sessionId === id)).toBe(false);
    expect(getState().pastNotices[0]).toMatchObject({ body: "2 tests failed in machine.test.ts", sessionId: id });
  });

  it("does not raise anything when the user stopped it", async () => {
    const id = await started();
    send(id, { type: "status", status: "cancelled" });
    expect(getState().notices).toHaveLength(0);
    expect(getState().errors).toHaveLength(0);
  });

  it("opens a session on the view asked for, or in Chat if it lives there", async () => {
    const task = await started();
    openSession(task, "changes");
    expect(getState()).toMatchObject({ panelOpen: true, tab: "agents", agentFocus: { id: task, view: "changes" } });
    clearAgentFocus();
    closePanel();
    const chat = await started("chat");
    openSession(chat, "changes");
    expect(getState()).toMatchObject({ tab: "chat", agentFocus: null });
  });
});

describe("the tray icon", () => {
  it("closes an open panel, even though its click also toggles", () => {
    openPanel();
    closeOnBlur();
    toggleFromCore();
    expect(getState().panelOpen).toBe(false);
  });

  it("still toggles once the click is over", () => {
    vi.useFakeTimers();
    openPanel();
    closeOnBlur();
    vi.advanceTimersByTime(301);
    toggleFromCore();
    vi.useRealTimers();
    expect(getState().panelOpen).toBe(true);
  });
});

describe("leaving the island", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("an error goes by itself", () => {
    const before = getState().errors.length;
    pushError({ title: "Could not hear that", body: "x" });
    expect(getState().errors).toHaveLength(before + 1);
    vi.advanceTimersByTime(16_000);
    expect(getState().errors).toHaveLength(before);
  });

  it("a pointer holds a notice for a while, and not for ever", () => {
    vi.spyOn(Date, "now").mockImplementation(() => vi.getMockedSystemTime()?.valueOf() ?? 0);
    setHovered(true);
    vi.advanceTimersByTime(500);
    expect(getState().hovered).toBe(true);
    pushNotice({ tone: "info", title: "Held", body: "" });
    vi.advanceTimersByTime(10_000);
    expect(getState().notices.some((n) => n.title === "Held")).toBe(true);
    vi.advanceTimersByTime(30_000);
    expect(getState().notices.some((n) => n.title === "Held")).toBe(false);
    setHovered(false);
    vi.advanceTimersByTime(500);
  });
});

describe("choosing an AI", () => {
  it("keeps a provider that still answers", () => {
    expect(nextEngine("anthropic", "anthropic", "claude-code")).toBeNull();
  });

  it("moves to an installed agent when the chosen provider has gone away", () => {
    expect(nextEngine("lmstudio", undefined, "claude-code")).toBe("claude-code");
  });

  it("takes a working provider when nothing was chosen", () => {
    expect(nextEngine(null, "anthropic", "claude-code")).toBe("anthropic");
  });
});

describe("a model server on another machine", () => {
  const ollama = "http://localhost:11434/v1";

  it("takes a bare address and fills in the usual port and path", () => {
    expect(serverAddress("192.168.1.20", ollama)).toBe("http://192.168.1.20:11434/v1");
    expect(serverAddress(" studio-pc.local:1234 ", ollama)).toBe("http://studio-pc.local:1234/v1");
    expect(serverAddress("[fe80::1]", ollama)).toBe("http://[fe80::1]:11434/v1");
  });

  it("keeps a full address as it was typed", () => {
    expect(serverAddress("https://ai.example.test/api/v1/", ollama)).toBe("https://ai.example.test/api/v1");
    expect(serverAddress("http://10.0.0.5:8000/v1?x=1#y", ollama)).toBe("http://10.0.0.5:8000/v1");
  });

  it("refuses what is not a web address", () => {
    expect(serverAddress("", ollama)).toBeNull();
    expect(serverAddress("file:///C:/models", ollama)).toBeNull();
    expect(serverAddress("http://", ollama)).toBeNull();
  });

  it("counts only this PC as this PC", () => {
    expect(onThisPc("http://localhost:11434/v1")).toBe(true);
    expect(onThisPc("http://127.0.0.1:1234/v1")).toBe(true);
    expect(onThisPc("http://[::1]:8080/v1")).toBe(true);
    expect(onThisPc("http://192.168.1.20:11434/v1")).toBe(false);
    expect(onThisPc("http://localhost.example.test/v1")).toBe(false);
  });
});
