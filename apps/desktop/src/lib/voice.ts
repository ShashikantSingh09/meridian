// A spoken conversation: the microphone, whose turn it is, and the voice. The microphone opens
// only for a conversation the user started, by key, by button or by a wake word they turned on.
// The island shows it for as long as it is open, audio goes no further than the hearing the user
// chose, and nothing is ever recorded to disk.

import { bridge } from "./bridge";
import { answerApproval, feel, getState, openPanel, openSettings, pickEngine, pushError, sendAgentChat, sendChat, setVoice, setWake, startSession, wakeTestHeard, type Tab } from "./store";
import { calledByName, filler, isGoodbye, sentences, silenceFor, speakable, withoutWakeWord, yesOrNo } from "./turns";

export type VoiceMode = "hold" | "turn" | "conversation";
export type VoicePhase = "listening" | "pause" | "thinking" | "speaking";

export interface VoiceState {
  phase: VoicePhase;
  mode: VoiceMode;
  /** What was heard, or what is being said. */
  words: string;
  /** What will be said next. */
  ahead: string;
  /** Started by its name, so it answers to that. */
  woken?: boolean;
}

const CHUNK_MS = 100;
const QUIET_NOTICE_MS = 600;
/** Silence before giving up on a turn that never started. */
const NOTHING_SAID_MS = { hold: Infinity, turn: 7000, conversation: 15000 };
const INTERRUPT_MS = 200;
const FILLER_AFTER_MS = 1600;
/** A key held less than this was tapped. */
const TAP_MS = 280;
const DOUBLE_TAP_MS = 380;

interface Capture {
  stream: MediaStream;
  context: AudioContext;
  node: AudioWorkletNode;
}

/** How much is kept while listening for a name. */
const EAR_MS = 12_000;
/** Taken from before the utterance as well, so its first word is not clipped. */
const EAR_MARGIN_MS = 500;
/** Longer than this after a name means there was more than the name. */
const NAME_MS = 1400;

let ear: Capture | null = null;
let earOpening = false;
let heardSoFar: Int16Array[] = [];

let session: {
  mode: VoiceMode;
  stream: MediaStream;
  context: AudioContext;
  sent: Promise<unknown>;
  floor: number;
  heardSpeech: boolean;
  quietMs: number;
  waitedMs: number;
  loudMs: number;
  turn: number;
  /** A request waiting for a spoken yes or no, and how many sentences came before it. */
  deciding: { sessionId: string; approvalId: string; spoken: number } | null;
  /** What the chat held when the user last spoke, so an earlier reply is not taken for this one. */
  before: unknown;
  /** Woken by words inside longer speech, so what was heard has to prove it was meant. */
  provingName?: boolean;
} | null = null;
/** The microphone is on its way. There is no `session` until it arrives. */
let opening = false;

// Speech out.
let output: AudioContext | null = null;
let outputDevice: string | null = null;
let meter: AnalyserNode | null = null;
let playing: AudioBufferSourceNode[] = [];
let playUntil = 0;
/** Changes whenever speech is cut off, which silences anything still on its way. */
let speaking = 0;
let micLevel = 0;
const samples = new Uint8Array(256);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const update = (patch: Partial<VoiceState>) => {
  const now = getState().voice;
  if (now) setVoice({ ...now, ...patch });
};

/** How loud things are right now, from 0 to 1, for the eyes and the wave. */
export function voiceLevel(): number {
  if (getState().voice?.phase !== "speaking" || !meter) return micLevel;
  meter.getByteTimeDomainData(samples);
  let sum = 0;
  for (const value of samples) sum += ((value - 128) / 128) ** 2;
  return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}

/** Follows the setting as it changes. An unplugged device says so, and the reply still reaches the user. */
function useChosenOutput(context: AudioContext) {
  const chosen = getState().settings.voiceOutput;
  if (chosen === outputDevice) return;
  outputDevice = chosen;
  (context as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(chosen ?? "").catch(() => {
    pushError({ title: "Your headphones are not connected", body: "Using the Windows default until they are back." });
  });
}

function play(pcm: Int16Array, rate: number) {
  if (!output) {
    output = new AudioContext();
    meter = output.createAnalyser();
    meter.fftSize = 512;
    meter.connect(output.destination);
  }
  useChosenOutput(output);
  const buffer = output.createBuffer(1, pcm.length, rate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i]! / 32768;
  const source = output.createBufferSource();
  source.buffer = buffer;
  source.connect(meter!);
  const at = Math.max(output.currentTime + 0.02, playUntil);
  source.start(at);
  playUntil = at + buffer.duration;
  playing.push(source);
  source.onended = () => (playing = playing.filter((s) => s !== source));
}

/** Says one thing, and returns when the last of it has been heard. */
export async function say(text: string, provider?: string, voiceId?: string) {
  const mine = speaking;
  let rate = 0;
  await bridge.voiceSpeak(text, provider, voiceId, (data) => {
    if (mine !== speaking) return;
    if (!rate) rate = new Uint32Array(data.slice(0, 4))[0]!;
    else play(new Int16Array(data), rate);
  });
  while (mine === speaking && output && output.currentTime < playUntil) await sleep(40);
}

function silence() {
  speaking++;
  void bridge.voiceStop();
  for (const source of playing) source.stop();
  playing = [];
  playUntil = 0;
}

function closeMicrophone(stream: MediaStream, context?: AudioContext) {
  stream.getTracks().forEach((track) => track.stop());
  void context?.close();
}

/** The microphone the user chose, or the Windows default. */
function microphoneSettings(): MediaTrackConstraints {
  const chosen = getState().settings.voiceMicrophone;
  return { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(chosen ? { deviceId: { exact: chosen } } : {}) };
}

async function captureMicrophone(handle: (chunk: Int16Array) => void): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneSettings() });
  let context: AudioContext | undefined;
  try {
    context = new AudioContext({ sampleRate: 16000 });
    await context.audioWorklet.addModule("/pcm-worklet.js");
    const node = new AudioWorkletNode(context, "pcm-chunks");
    node.port.onmessage = (event: MessageEvent<Int16Array>) => handle(event.data);
    context.createMediaStreamSource(stream).connect(node);
    return { stream, context, node };
  } catch (err) {
    // Nothing holds these yet, so nothing else would ever close the microphone.
    closeMicrophone(stream, context);
    throw err;
  }
}

async function openMicrophone(mode: VoiceMode) {
  // Already open for wake words, so nothing said after the name is lost to reopening it.
  const capture = ear ?? (await captureMicrophone(onAudio));
  capture.node.port.onmessage = (event: MessageEvent<Int16Array>) => onAudio(event.data);
  ear = null;
  session = { mode, stream: capture.stream, context: capture.context, sent: Promise.resolve(), floor: 0.01, heardSpeech: false, quietMs: 0, waitedMs: 0, loudMs: 0, turn: 0, deciding: null, before: null };
}

/** Keeps the last few seconds in memory while listening for a name. It is never saved. */
async function openEar() {
  if (ear || earOpening || session) return;
  earOpening = true;
  try {
    const capture = await captureMicrophone(remember);
    // It may have been turned off while the microphone opened.
    if (getState().wake.state === "listening" && !session) ear = capture;
    else closeMicrophone(capture.stream, capture.context);
  } catch {
    // Listening for the name carries on without it, and only a command said in one breath is lost.
  } finally {
    earOpening = false;
  }
}

function closeEar() {
  if (ear) closeMicrophone(ear.stream, ear.context);
  ear = null;
  heardSoFar = [];
}

function remember(chunk: Int16Array) {
  heardSoFar.push(chunk);
  if (heardSoFar.length * CHUNK_MS > EAR_MS) heardSoFar.shift();
}

/** Hands over what was said with the name, so a command in the same breath is heard whole. */
function hearOneBreath(spokenMs: number) {
  const now = session;
  const chunks = heardSoFar.slice(-Math.ceil((spokenMs + EAR_MARGIN_MS) / CHUNK_MS));
  heardSoFar = [];
  if (!now) return;
  for (const chunk of chunks) {
    const bytes = new Uint8Array(chunk.buffer.slice(0));
    now.sent = now.sent.then(() => bridge.voiceHear(bytes)).then(() => {}, () => {});
  }
}

export function endConversation() {
  silence();
  if (session) closeMicrophone(session.stream, session.context);
  session = null;
  micLevel = 0;
  setVoice(null);
}

/** Ends the conversation and says why, and goes to the page that fixes it if there is one. */
function failed(title: string, err: unknown) {
  endConversation();
  const text = String(err).replace(/^Error: /, "");
  pushError({ title, body: text });
  if (/download|key/i.test(text)) {
    openSettings("voice");
    openPanel();
  }
}

/** Says something in a conversation. If it cannot be said the conversation is over, and says why. */
async function speak(text: string) {
  const mine = speaking;
  try {
    await say(text);
  } catch (err) {
    // Speech that was cut off has nothing left to report.
    if (mine === speaking) failed("Could not speak", err);
  }
}

async function listen(mode: VoiceMode, woken = false) {
  if (!session) return;
  Object.assign(session, { mode, heardSpeech: false, quietMs: 0, waitedMs: 0, loudMs: 0 });
  try {
    await bridge.voiceHearStart();
  } catch (err) {
    return failed("Voice is not set up yet", err);
  }
  // It may have been stopped in the meantime, and then nothing is listening.
  if (session) setVoice({ phase: "listening", mode, words: "", ahead: "", woken });
}

function onAudio(chunk: Int16Array) {
  const now = session;
  if (!now) return;
  let sum = 0;
  for (const sample of chunk) sum += (sample / 32768) ** 2;
  const loudness = Math.sqrt(sum / chunk.length);
  micLevel = micLevel * 0.5 + Math.min(1, loudness * 8) * 0.5;
  // The room's own noise sets the bar for what counts as speech.
  now.floor = loudness < now.floor ? loudness : now.floor * 1.01;
  const speech = loudness > Math.max(0.012, now.floor * 3);

  const voice = getState().voice;
  if (!voice) return;
  if (voice.phase === "speaking") {
    now.loudMs = speech ? now.loudMs + CHUNK_MS : 0;
    if (now.loudMs >= INTERRUPT_MS && getState().settings.voiceInterrupt) void interrupted();
    return;
  }
  if (voice.phase !== "listening" && voice.phase !== "pause") return;

  const bytes = new Uint8Array(chunk.buffer.slice(0));
  now.sent = now.sent.then(() => bridge.voiceHear(bytes)).then((words) => {
    if (!words) return;
    // Words are better proof of speech than loudness: a quiet voice still counts.
    if (words !== getState().voice?.words) now.quietMs = 0;
    now.heardSpeech = true;
    update({ words });
    // One lost chunk must not stop the rest, and the end of the turn reports a real fault.
  }).catch(() => {});
  if (speech) {
    now.heardSpeech = true;
    now.quietMs = 0;
    if (voice.phase === "pause") update({ phase: "listening" });
    return;
  }
  now.quietMs += CHUNK_MS;
  now.waitedMs += CHUNK_MS;
  if (now.mode === "hold") return;
  if (!now.heardSpeech) {
    if (now.waitedMs >= NOTHING_SAID_MS[now.mode]) endConversation();
    return;
  }
  if (now.quietMs >= QUIET_NOTICE_MS && voice.phase === "listening") update({ phase: "pause" });
  if (now.quietMs >= silenceFor(voice.words)) void finishTurn();
}

/** Talking over it stops it at once, and what it had not said yet is dropped. */
async function interrupted() {
  silence();
  if (!session) return;
  session.turn++;
  feel("needs", 500);
  await listen(session.mode);
  if (session) session.heardSpeech = true;
}

async function finishTurn() {
  const now = session;
  if (!now || !["listening", "pause"].includes(getState().voice?.phase ?? "")) return;
  update({ phase: "thinking" });
  await now.sent;
  let words = "";
  try {
    words = await bridge.voiceHearEnd();
  } catch (err) {
    pushError({ title: "Could not hear that", body: String(err) });
  }
  if (session !== now) return;
  const wakeWords = getState().settings.wakeWords.filter((w) => w.on).map((w) => w.text);
  const heard = words || getState().voice?.words || "";
  // People talking near the microphone can sound like the name. Nothing goes further unless it was said.
  if (now.provingName) {
    now.provingName = false;
    if (!calledByName(heard, wakeWords)) return endConversation();
  }
  const said = withoutWakeWord(heard, wakeWords);
  if (!said.trim() || (now.mode === "conversation" && isGoodbye(said))) return endConversation();

  if (now.deciding) {
    const answer = yesOrNo(said);
    if (answer === null) {
      await speak("Please say yes or no, or use the buttons.");
      return void listen(now.mode);
    }
    const { sessionId, approvalId, spoken } = now.deciding;
    answerApproval(sessionId, approvalId, answer);
    now.deciding = null;
    return void followReply(++now.turn, spoken, approvalId);
  }
  update({ words: said, ahead: "" });
  void ask(said);
}

/** What holds the current chat. Asking something replaces it, so it tells a new reply from an old one. */
function chatNow() {
  const app = getState();
  return app.agentChat.agent ? app.sessions.find((s) => s.id === app.agentChat.sessionId)?.log : app.chat.messages;
}

/** Everything the AI has written since the last thing the user said. */
function replySoFar(): { text: string; done: boolean; waiting: { sessionId: string; approvalId: string; summary: string; agent: string } | null } {
  const app = getState();
  const unchanged = chatNow() === session?.before;
  if (!app.agentChat.agent) {
    const last = app.chat.messages[app.chat.messages.length - 1];
    return { text: !unchanged && last?.role === "assistant" ? last.content : "", done: !app.chatPending, waiting: null };
  }
  const chat = app.sessions.find((s) => s.id === app.agentChat.sessionId);
  if (!chat || unchanged) return { text: "", done: false, waiting: null };
  const start = chat.log.map((entry) => entry.kind).lastIndexOf("user");
  const text = chat.log.slice(start + 1).filter((entry) => entry.kind === "text").map((entry) => entry.text).join("\n");
  const asking = chat.approval;
  return {
    text,
    done: ["completed", "failed", "cancelled"].includes(chat.status),
    waiting: asking ? { sessionId: chat.id, approvalId: asking.id, summary: asking.summary, agent: chat.agent } : null,
  };
}

function ask(words: string) {
  pickEngine();
  const app = getState();
  const now = session!;
  const turn = ++now.turn;
  now.before = chatNow();
  if (!app.agentChat.agent) void sendChat(words, [], true);
  else {
    void sendAgentChat(words, [], true)
      .catch((err) => pushError({ title: "Could not reach the agent", body: String(err) }))
      .then(() => {
        // Nothing started, so nothing will arrive. The reason is already on screen.
        if (session === now && now.turn === turn && chatNow() === now.before) endConversation();
      });
  }
  void followReply(turn);
}

/**
 * Speaks a reply sentence by sentence, as it arrives. `spoken` counts sentences, not characters,
 * because what is said is the reply with its markdown taken out. `answered` is a request that
 * stays on the session until the agent reports it has moved on.
 */
async function followReply(turn: number, spoken = 0, answered: string | null = null) {
  // Turn numbers start again with each conversation, so the number alone could wake an old one.
  const mine = session;
  const current = () => session === mine && session?.turn === turn;
  const started = Date.now();
  let saidAnything = false;

  while (current()) {
    const reply = replySoFar();
    if (reply.waiting && reply.waiting.approvalId !== answered) {
      session!.deciding = { ...reply.waiting, spoken };
      update({ phase: "speaking", words: `${reply.waiting.agent} wants to: ${reply.waiting.summary}. Should it?`, ahead: "" });
      await speak(`${reply.waiting.agent} wants to ${speakable(reply.waiting.summary)}. Should it?`);
      if (current()) await listen(session!.mode);
      return;
    }
    const { ready } = sentences(speakable(reply.text), reply.done);
    const sentence = ready[spoken];
    if (sentence) {
      spoken++;
      saidAnything = true;
      update({ phase: "speaking", words: sentence, ahead: ready[spoken] ? ` ${ready[spoken]}` : "" });
      await speak(sentence);
      continue;
    }
    if (reply.done) break;
    if (!saidAnything && Date.now() - started > FILLER_AFTER_MS) {
      saidAnything = true;
      const short = filler(turn);
      update({ phase: "speaking", words: short });
      await speak(short);
      if (current()) update({ phase: "thinking" });
    }
    await sleep(120);
  }
  if (!current()) return;
  if (session!.mode === "conversation") await listen("conversation");
  else endConversation();
}

const currentSession = () => session;

/** Starts a conversation, as the hotkey does. `spokenMs` is set when it was called by name, and says for how long. */
export async function startVoice(mode: VoiceMode, spokenMs?: number) {
  if (opening) return;
  if (session) {
    if (getState().voice?.phase === "speaking") await interrupted();
    return;
  }
  opening = true;
  try {
    await openMicrophone(mode);
    await listen(mode, spokenMs !== undefined);
    if (spokenMs !== undefined) {
      hearOneBreath(spokenMs);
      // A command came with the name, and it has already been said.
      if (spokenMs > NAME_MS) {
        const now = currentSession();
        if (now) now.provingName = true;
        void finishTurn();
      }
    }
  } catch (err) {
    failed(/permission|notallowed|notfound|overconstrained/i.test(String(err)) ? "No microphone" : "Voice is not set up yet", /overconstrained/i.test(String(err)) ? "The microphone you chose is not connected. Plug it in, or choose another under Settings, Voice." : err);
  } finally {
    opening = false;
  }
}

let keyDownAt = 0;
let lastTapAt = 0;
/** What the last release of the key asked for, until the conversation is ready to take it. */
let released: VoiceMode | null = null;

/** The microphone takes longer to open than a tap lasts, so this runs when it has opened too. */
function applyRelease() {
  const voice = getState().voice;
  if (!released || !session || !voice || voice.phase === "speaking") return;
  const mode = released;
  released = null;
  if (mode !== "hold") {
    session.mode = mode;
    update({ mode });
  } else if (session.mode === "hold") void finishTurn();
}

async function onKey(down: boolean) {
  const now = Date.now();
  if (down) {
    keyDownAt = now;
    released = null;
    await startVoice("hold");
  } else {
    // A tap is hands free: one question, or with two taps a whole conversation.
    const tap = now - keyDownAt < TAP_MS;
    released = !tap ? "hold" : now - lastTapAt < DOUBLE_TAP_MS ? "conversation" : "turn";
    if (tap) lastTapAt = now;
  }
  applyRelease();
}

export function wireVoice() {
  void bridge.onVoiceKey(onKey);
  // A reload can end a conversation without saying so.
  void bridge.wakeTalking(false);
  void bridge.onWakeState((status) => {
    setWake(status);
    if (status.state === "listening") void openEar();
    else closeEar();
  });
  void bridge.onAssistantOpen((tab) => openPanel(tab as Tab));
  void bridge.onAssistantAgent(({ task, folder }) => {
    const cwd = folder || getState().settings.agentDefaultDir;
    if (!cwd) return pushError({ title: "Choose a project folder", body: "Tell it which folder to work in." });
    void startSession({ agent: "claude-code", cwd, prompt: task, model: null, restricted: false, images: [] }, "agents", "project");
  });
  void bridge.wakeStatus().then((status) => {
    setWake(status);
    if (status.state === "listening") void openEar();
  });
  void bridge.onWakeHeard(({ word, test, spokenMs }) => (test ? wakeTestHeard(word) : void startVoice(getState().settings.wakeAfter, spokenMs)));
}
