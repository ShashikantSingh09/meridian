// A spoken conversation: the microphone, whose turn it is, and the voice. The microphone opens
// only for a conversation the user started, the island shows it for as long as it is open, and
// audio goes no further than the hearing the user chose. Nothing is ever recorded to disk.

import { bridge } from "./bridge";
import { answerApproval, feel, getState, openSettings, pushError, sendAgentChat, sendChat, setVoice } from "./store";
import { filler, isGoodbye, sentences, silenceFor, speakable, yesOrNo } from "./turns";

export type VoiceMode = "hold" | "turn" | "conversation";
export type VoicePhase = "listening" | "pause" | "thinking" | "speaking";

export interface VoiceState {
  phase: VoicePhase;
  mode: VoiceMode;
  /** What was heard, or what is being said. */
  words: string;
  /** What will be said next. */
  ahead: string;
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
  /** A request waiting for a spoken yes or no. */
  deciding: { sessionId: string; approvalId: string } | null;
} | null = null;

// Speech out.
let output: AudioContext | null = null;
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

function play(pcm: Int16Array, rate: number) {
  if (!output) {
    output = new AudioContext();
    meter = output.createAnalyser();
    meter.fftSize = 512;
    meter.connect(output.destination);
  }
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

async function openMicrophone(mode: VoiceMode) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const context = new AudioContext({ sampleRate: 16000 });
  await context.audioWorklet.addModule("/pcm-worklet.js");
  const node = new AudioWorkletNode(context, "pcm-chunks");
  node.port.onmessage = (event: MessageEvent<Int16Array>) => onAudio(event.data);
  context.createMediaStreamSource(stream).connect(node);
  session = { mode, stream, context, sent: Promise.resolve(), floor: 0.01, heardSpeech: false, quietMs: 0, waitedMs: 0, loudMs: 0, turn: 0, deciding: null };
}

export function endConversation() {
  silence();
  session?.stream.getTracks().forEach((track) => track.stop());
  void session?.context.close();
  session = null;
  micLevel = 0;
  setVoice(null);
}

async function listen(mode: VoiceMode) {
  if (!session) return;
  Object.assign(session, { mode, heardSpeech: false, quietMs: 0, waitedMs: 0, loudMs: 0 });
  await bridge.voiceHearStart();
  setVoice({ phase: "listening", mode, words: "", ahead: "" });
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
  });
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
  if (!session) return;
  const said = words || getState().voice?.words || "";
  if (!said.trim() || (now.mode === "conversation" && isGoodbye(said))) return endConversation();

  if (now.deciding) {
    const answer = yesOrNo(said);
    if (answer === null) {
      await say("Please say yes or no, or use the buttons.");
      return void listen(now.mode);
    }
    answerApproval(now.deciding.sessionId, now.deciding.approvalId, answer);
    now.deciding = null;
    return void followReply(++now.turn);
  }
  update({ words: said, ahead: "" });
  void ask(said);
}

/** Everything the AI has written since the last thing the user said. */
function replySoFar(): { text: string; done: boolean; waiting: { sessionId: string; approvalId: string; summary: string; agent: string } | null } {
  const app = getState();
  if (!app.agentChat.agent) {
    const last = app.chat.messages[app.chat.messages.length - 1];
    return { text: last?.role === "assistant" ? last.content : "", done: !app.chatPending, waiting: null };
  }
  const chat = app.sessions.find((s) => s.id === app.agentChat.sessionId);
  if (!chat) return { text: "", done: false, waiting: null };
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
  const app = getState();
  if (app.agentChat.agent) void sendAgentChat(words, [], true);
  else void sendChat(words, [], true);
  void followReply(++session!.turn);
}

/** Speaks a reply sentence by sentence, as it arrives. */
async function followReply(turn: number) {
  const current = () => session?.turn === turn;
  const started = Date.now();
  let spoken = 0;
  let saidAnything = false;

  while (current()) {
    const reply = replySoFar();
    if (reply.waiting) {
      session!.deciding = reply.waiting;
      update({ phase: "speaking", words: `${reply.waiting.agent} wants to: ${reply.waiting.summary}. Should it?`, ahead: "" });
      await say(`${reply.waiting.agent} wants to ${speakable(reply.waiting.summary)}. Should it?`);
      if (current()) await listen(session!.mode);
      return;
    }
    const fresh = speakable(reply.text.slice(spoken));
    const { ready } = sentences(fresh, reply.done);
    if (ready.length > 0) {
      const sentence = ready[0]!;
      const consumed = reply.text.indexOf(sentence.slice(0, 12), spoken);
      spoken = consumed >= 0 ? Math.min(reply.text.length, consumed + sentence.length) : reply.text.length;
      saidAnything = true;
      update({ phase: "speaking", words: sentence, ahead: ready[1] ? ` ${ready[1]}` : "" });
      try {
        await say(sentence);
      } catch (err) {
        pushError({ title: "Could not speak", body: String(err) });
        return endConversation();
      }
      continue;
    }
    if (reply.done) break;
    if (!saidAnything && Date.now() - started > FILLER_AFTER_MS) {
      saidAnything = true;
      const short = filler(turn);
      update({ phase: "speaking", words: short });
      await say(short);
      if (current()) update({ phase: "thinking" });
    }
    await sleep(120);
  }
  if (!current()) return;
  if (session!.mode === "conversation") await listen("conversation");
  else endConversation();
}

/** Starts a conversation by hand, as the hotkey does. */
export async function startVoice(mode: VoiceMode) {
  if (session) {
    if (getState().voice?.phase === "speaking") await interrupted();
    return;
  }
  try {
    await openMicrophone(mode);
    await listen(mode);
  } catch (err) {
    endConversation();
    const text = String(err);
    pushError({ title: /permission|notallowed|notfound/i.test(text) ? "No microphone" : "Voice is not set up yet", body: text.replace(/^Error: /, "") });
    if (/download|key/i.test(text)) openSettings("voice");
  }
}

let keyDownAt = 0;
let lastTapAt = 0;

async function onKey(down: boolean) {
  const now = Date.now();
  if (down) {
    keyDownAt = now;
    await startVoice("hold");
    return;
  }
  const held = now - keyDownAt;
  if (held >= TAP_MS) {
    if (session?.mode === "hold") void finishTurn();
    return;
  }
  // A tap is hands free: one question, or with two taps a whole conversation.
  const double = now - lastTapAt < DOUBLE_TAP_MS;
  lastTapAt = now;
  if (session) session.mode = double ? "conversation" : "turn";
  update({ mode: double ? "conversation" : "turn" });
}

export function wireVoice() {
  void bridge.onVoiceKey(onKey);
}
