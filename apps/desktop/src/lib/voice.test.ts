import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bridge } from "./bridge";
import { answerApproval, openPanel, pickEngine, pushError, sendAgentChat, sendChat, wakeTestHeard } from "./store";
import { endConversation, wireVoice } from "./voice";

// The real conversation logic, with no microphone and no sound: the browser's audio, the bridge and
// the store are stand-ins, so the order things happen in is under the test's control.

type Session = { id: string; agent: string; status: string; log: { kind: string; text: string }[]; approval: { id: string; summary: string } | null };

const h = vi.hoisted(() => ({
  app: {
    voice: null as { phase: string; mode: string } | null,
    settings: { voiceInterrupt: true, wakeAfter: "turn", wakeWords: [{ text: "Hey Meridian", on: true }], voiceMicrophone: null as string | null, voiceOutput: null },
    wake: { state: "off" },
    chat: { messages: [] as { role: string; content: string }[] },
    chatPending: false,
    agentChat: { agent: null as string | null, sessionId: null as string | null },
    sessions: [] as Session[],
  },
  key: (_down: boolean): Promise<void> => Promise.resolve(),
  wake: (_heard: { word: string; test: boolean; spokenMs: number }) => {},
}));

vi.mock("./bridge", () => ({
  bridge: {
    onVoiceKey: (handler: (down: boolean) => Promise<void>) => void (h.key = handler),
    onWakeState: vi.fn(async () => {}),
    onWakeHeard: (handler: (heard: { word: string; test: boolean; spokenMs: number }) => void) => void (h.wake = handler),
    onAssistantOpen: vi.fn(async () => {}),
    onAssistantAgent: vi.fn(async () => {}),
    voiceHear: vi.fn(async () => ""),
    wakeStatus: vi.fn(async () => ({ state: "off", why: "" })),
    wakeTalking: vi.fn(async () => {}),
    voiceHearStart: vi.fn(async () => {}),
    voiceHearEnd: vi.fn(async () => ""),
    voiceSpeak: vi.fn(async () => {}),
    voiceStop: vi.fn(async () => {}),
  },
}));

vi.mock("./store", () => ({
  answerApproval: vi.fn(),
  feel: vi.fn(),
  getState: () => h.app,
  openPanel: vi.fn(),
  openSettings: vi.fn(),
  pickEngine: vi.fn(),
  pushError: vi.fn(),
  sendAgentChat: vi.fn(async () => {}),
  sendChat: vi.fn(async () => {}),
  setVoice: (voice: typeof h.app.voice) => void (h.app.voice = voice),
  setWake: vi.fn(),
  startSession: vi.fn(),
  wakeTestHeard: vi.fn(),
}));

const track = { stop: vi.fn() };
let micOpens = () => {};
const getUserMedia = vi.fn(() => new Promise((resolve) => (micOpens = () => resolve({ getTracks: () => [track] }))));
const addModule = vi.fn(async () => {});
let clock = 0;

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Holds the key for a second, as if saying `words`. */
async function holdAndSay(words: string) {
  vi.mocked(bridge.voiceHearEnd).mockResolvedValue(words);
  void h.key(true);
  micOpens();
  await settled();
  clock += 1000;
  void h.key(false);
  await settled();
}

beforeAll(() => wireVoice());

beforeEach(() => {
  vi.clearAllMocks();
  // Far from the last test, so no tap here looks like the second of a double tap.
  clock += 60_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("AudioContext", class {
    audioWorklet = { addModule };
    createMediaStreamSource = () => ({ connect() {} });
    close = async () => {};
  });
  vi.stubGlobal("AudioWorkletNode", class { port = {}; });
  Object.assign(h.app, { voice: null, chat: { messages: [] }, chatPending: false, agentChat: { agent: null, sessionId: null }, sessions: [] });
});

afterEach(() => {
  endConversation();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the key", () => {
  it("opens one microphone however fast it is tapped, and closes it", async () => {
    void h.key(true);
    void h.key(false);
    void h.key(true);
    void h.key(false);
    micOpens();
    await settled();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(h.app.voice?.mode).toBe("conversation");
    endConversation();
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("counts a tap that ended before the microphone had opened", async () => {
    void h.key(true);
    void h.key(false);
    micOpens();
    await settled();
    expect(h.app.voice?.mode).toBe("turn");
  });

  it("ends the turn when a hold was let go before the microphone had opened", async () => {
    void h.key(true);
    clock += 1000;
    void h.key(false);
    micOpens();
    await settled();
    expect(h.app.voice).toBeNull();
    expect(track.stop).toHaveBeenCalledTimes(1);
  });
});

describe("when something fails", () => {
  it("closes a microphone that could not finish opening", async () => {
    addModule.mockRejectedValueOnce(new Error("no worklet"));
    void h.key(true);
    micOpens();
    await settled();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(h.app.voice).toBeNull();
    expect(pushError).toHaveBeenCalledOnce();
  });

  it("says why and goes to Settings when even the filler cannot be spoken", async () => {
    h.app.chatPending = true;
    const why = "Add your elevenlabs key first, in Settings, Voice.";
    vi.mocked(bridge.voiceSpeak).mockRejectedValueOnce(why);
    await holdAndSay("what time is it");
    clock += 2000;
    await vi.waitFor(() => expect(h.app.voice).toBeNull());
    expect(pushError).toHaveBeenCalledWith({ title: "Could not speak", body: why });
    expect(openPanel).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("ends when hearing cannot start again mid-conversation", async () => {
    await holdAndSay("hello");
    expect(h.app.voice).toBeNull();
    vi.mocked(bridge.voiceHearStart).mockRejectedValueOnce("Speech on this PC needs a small download first. Open Settings, Voice.");
    void h.key(true);
    micOpens();
    await settled();
    expect(h.app.voice).toBeNull();
    expect(openPanel).toHaveBeenCalledOnce();
  });

  it("gives up when the agent never started", async () => {
    h.app.agentChat.agent = "claude-code";
    await holdAndSay("hello");
    await vi.waitFor(() => expect(h.app.voice).toBeNull());
    expect(sendAgentChat).toHaveBeenCalledOnce();
  });
});

describe("a wake word", () => {
  it("starts a conversation as the setting says, and answers to its name", async () => {
    h.app.settings.wakeAfter = "conversation";
    h.wake({ word: "Hey Meridian", test: false, spokenMs: 700 });
    micOpens();
    await settled();
    expect(h.app.voice).toMatchObject({ phase: "listening", mode: "conversation", woken: true });
    h.app.settings.wakeAfter = "turn";
    endConversation();
  });

  it("takes a command said in the same breath, without the name", async () => {
    vi.mocked(bridge.voiceHearEnd).mockResolvedValue("Hey Meridian, open Chrome");
    h.wake({ word: "hey meridian", test: false, spokenMs: 2400 });
    micOpens();
    await vi.waitFor(() => expect(sendChat).toHaveBeenCalledWith("open Chrome", [], true));
    endConversation();
  });

  it("drops talk in the room that only sounded like the name", async () => {
    vi.mocked(bridge.voiceHearEnd).mockResolvedValue("हां वो देखना पड़ेगा तेरे साथ");
    h.wake({ word: "meridian", test: false, spokenMs: 2600 });
    micOpens();
    await vi.waitFor(() => expect(h.app.voice).toBeNull());
    expect(sendChat).not.toHaveBeenCalled();
    expect(sendAgentChat).not.toHaveBeenCalled();
  });

  it("opens the microphone the user chose", async () => {
    h.app.settings.voiceMicrophone = "headset";
    void h.key(true);
    micOpens();
    await settled();
    expect(getUserMedia.mock.lastCall).toEqual([{ audio: expect.objectContaining({ deviceId: { exact: "headset" } }) }]);
    h.app.settings.voiceMicrophone = null;
    endConversation();
  });

  it("starts nothing during a test, and reports what it heard", async () => {
    h.wake({ word: "Hey Meridian", test: true, spokenMs: 700 });
    await settled();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(wakeTestHeard).toHaveBeenCalledWith("Hey Meridian");
  });
});

describe("choosing who to ask", () => {
  it("talks to the AI Chat would open on, even if Chat has never been opened", async () => {
    vi.mocked(pickEngine).mockImplementationOnce(() => void (h.app.agentChat.agent = "claude-code"));
    await holdAndSay("hello");
    await vi.waitFor(() => expect(sendAgentChat).toHaveBeenCalledOnce());
    expect(sendChat).not.toHaveBeenCalled();
  });
});

describe("following a reply", () => {
  it("does not read out an old reply when nothing was sent", async () => {
    h.app.chat.messages = [{ role: "assistant", content: "An old answer." }];
    await holdAndSay("what time is it");
    await vi.waitFor(() => expect(h.app.voice).toBeNull());
    expect(bridge.voiceSpeak).not.toHaveBeenCalled();
  });

  it("reads out the new one, without its markdown", async () => {
    vi.mocked(sendChat).mockImplementationOnce(async () => {
      h.app.chat = { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "A **new** answer. And then **another** one." }] };
    });
    await holdAndSay("hi");
    await vi.waitFor(() => expect(h.app.voice).toBeNull());
    expect(vi.mocked(bridge.voiceSpeak).mock.calls.map((call) => call[0])).toEqual(["A new answer.", "And then another one."]);
  });

  it("asks about a request once, and goes on from where it was", async () => {
    const chat: Session = { id: "s", agent: "Claude", status: "running", log: [{ kind: "user", text: "fix it" }, { kind: "text", text: "On it. Looking now." }], approval: null };
    h.app.sessions = [chat];
    h.app.agentChat = { agent: "claude-code", sessionId: "s" };
    vi.mocked(sendAgentChat).mockImplementationOnce(async () => void (chat.log = [...chat.log]));

    await holdAndSay("fix it");
    await vi.waitFor(() => expect(bridge.voiceSpeak).toHaveBeenCalledOnce());
    Object.assign(chat, { status: "waiting", approval: { id: "a1", summary: "edit a file" } });
    await vi.waitFor(() => expect(h.app.voice?.phase).toBe("listening"));
    await holdAndSay("yes");
    expect(answerApproval).toHaveBeenCalledWith("s", "a1", true);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The agent has not reported the answer yet, so the request is still listed.
    const said = () => vi.mocked(bridge.voiceSpeak).mock.calls.map((call) => call[0]);
    expect(said()).toEqual(["On it.", "Claude wants to edit a file. Should it?"]);

    Object.assign(chat, { approval: null, status: "completed", log: [...chat.log, { kind: "text", text: "All done." }] });
    await vi.waitFor(() => expect(h.app.voice).toBeNull());
    expect(said().slice(2)).toEqual(["Looking now.", "All done."]);
  });

  it("does not let a stopped conversation speak in the next one", async () => {
    h.app.chatPending = true;
    await holdAndSay("first");
    endConversation();
    h.app.chatPending = false;
    h.app.chat.messages = [];
    vi.mocked(sendChat).mockImplementationOnce(async () => {
      h.app.chatPending = true;
      h.app.chat = { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "Once only. " }] };
    });
    await holdAndSay("second");
    clock += 60_000;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(vi.mocked(bridge.voiceSpeak).mock.calls.map((call) => call[0])).toEqual(["One moment."]);
  });
});
