// The store's timing, against the browser stand-in for the core. Each of these is something a
// spoken turn or a click depends on happening at once, before anything has been waited for.

import { describe, expect, it, vi } from "vitest";
import { bridge } from "./bridge";
import { applyAgentEvent, clearChat, closeOnBlur, getState, openPanel, refreshProviders, selectProvider, sendChat, sendToSession, startSession, toggleFromCore } from "./store";

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
