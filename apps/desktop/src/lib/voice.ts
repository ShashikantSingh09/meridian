// A spoken conversation: the microphone, whose turn it is, and the voice. The microphone opens
// only for a conversation the user started, by key, by button or by a wake word they turned on.
// The island shows it for as long as it is open, audio goes no further than the hearing the user
// chose, and nothing is ever recorded to disk.

import { bridge } from "./bridge";
import { answerApproval, feel, getState, knownFolder, openPanel, openSettings, pickEngine, pushError, sendAgentChat, sendChat, setVoice, setWake, startSession, wakeTestHeard, type Tab } from "./store";
import { filler, isGoodbye, pickAllowWord, sentences, silenceFor, speakable, spokenAnswer, withoutWakeWord } from "./turns";

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
/** A noisy room can pass for speech for ever, so a turn ends here even if it never goes quiet. */
const LONGEST_TURN_MS = 45_000;
/** The most of any one reply it reads out. The whole of it is in Chat. */
const MOST_SENTENCES = 3;
const INTERRUPT_MS = 200;
const FILLER_AFTER_MS = 1600;
/** How long the face shows it heard its name: a squash, a pop and a blink. */
const HEARD_MS = 700;
/** A key held less than this was tapped. */
const TAP_MS = 280;
const DOUBLE_TAP_MS = 380;

interface Capture {
  stream: MediaStream;
  context: AudioContext;
  node: AudioWorkletNode;
}

/** Recordings that make a wake word, all of them really the same word. */
const RECORDINGS = 4;
/** How long it waits for each one before giving up. */
const TEACH_WAIT_MS = 15_000;
/** Silence that ends a recording, and the longest a word can run. */
const WORD_END_MS = 500;
const LONGEST_WORD_MS = 3000;
/** Taken from just before the voice started, so its first sound is not clipped. */
const BEFORE_WORD_CHUNKS = 2;

/** Open while listening for a name, and handed to the conversation when it hears one. */
let ear: Capture | null = null;
let earOpening = false;
let teaching = false;
/** The last few seconds the ear heard, in memory only, so a command said in the same breath as the name is heard whole. */
const RECENT_MS = 3000;
let recent: Int16Array[] = [];

function remember(chunk: Int16Array) {
  recent.push(chunk);
  if (recent.length * CHUNK_MS > RECENT_MS) recent.shift();
}

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
  listenedMs: number;
  turn: number;
  /** A request waiting for a spoken answer, the word that allows it, and how many sentences came before it. */
  deciding: { sessionId: string; approvalId: string; spoken: number; word: string } | null;
  /** What the chat held when the user last spoke, so an earlier reply is not taken for this one. */
  before: unknown;
  /** The assistant heard them say they were finished, so this reply is the last. */
  closing?: boolean;
  /** Called by name: what the microphone sends before the conversation is ready, kept to be heard first. */
  early?: Int16Array[];
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

async function captureMicrophone(handle: (chunk: Int16Array) => void, settings = microphoneSettings()): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: settings });
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

async function openMicrophone(mode: VoiceMode, woken: boolean) {
  // Already open for wake words, so nothing said after the name is lost to reopening it.
  const capture = ear ?? (await captureMicrophone(onAudio));
  capture.node.port.onmessage = (event: MessageEvent<Int16Array>) => onAudio(event.data);
  ear = null;
  session = { mode, stream: capture.stream, context: capture.context, sent: Promise.resolve(), floor: 0.01, heardSpeech: false, quietMs: 0, waitedMs: 0, loudMs: 0, listenedMs: 0, turn: 0, deciding: null, before: null, early: woken ? [] : undefined };
}

/** Passes sound on for the name to be found in. Only the last few seconds are held, in memory. */
async function openEar() {
  if (ear || earOpening || session || teaching) return;
  earOpening = true;
  try {
    const capture = await captureMicrophone((chunk) => {
      remember(chunk);
      void bridge.wakeAudio(new Uint8Array(chunk.buffer.slice(0)));
    });
    // It may have been turned off while the microphone opened.
    if (getState().wake.state === "listening" && !session && !teaching) ear = capture;
    else closeMicrophone(capture.stream, capture.context);
  } catch {
    // It tries again the next time wake words start.
  } finally {
    earOpening = false;
  }
}

let noteMicrophone: Capture | null = null;

/** Sends the microphone to the note being recorded. The core drops anything before it starts.
 *  A chosen microphone that is gone costs nobody a call, so the Windows default stands in. */
export async function openNoteMicrophone(onStopped: () => void, onDefault: () => void) {
  if (noteMicrophone) return;
  const send = (chunk: Int16Array) => void bridge.noteAudio(new Uint8Array(chunk.buffer.slice(0)));
  noteMicrophone = await captureMicrophone(send).catch((err: Error) => {
    if (err.name !== "OverconstrainedError") throw err;
    onDefault();
    const { deviceId: _unplugged, ...anyMicrophone } = microphoneSettings();
    return captureMicrophone(send, anyMicrophone);
  });
  // A headset unplugged in the middle of a call.
  noteMicrophone.stream.getAudioTracks()[0]?.addEventListener("ended", onStopped);
}

export function closeNoteMicrophone() {
  if (noteMicrophone) closeMicrophone(noteMicrophone.stream, noteMicrophone.context);
  noteMicrophone = null;
}

function closeEar() {
  if (ear) closeMicrophone(ear.stream, ear.context);
  ear = null;
  recent = [];
}

const loudnessOf = (chunk: Int16Array) => {
  let sum = 0;
  for (const sample of chunk) sum += (sample / 32768) ** 2;
  return Math.sqrt(sum / chunk.length);
};

/** Waits for someone to say something once, and returns it. */
function recordWord(listenWith: (hear: (chunk: Int16Array) => void) => void) {
  return new Promise<Uint8Array>((resolve, reject) => {
    const giveUp = setTimeout(() => reject(new Error("Did not hear anything. Check the microphone and try again.")), TEACH_WAIT_MS);
    const before: Int16Array[] = [];
    const said: Int16Array[] = [];
    let floor = 0.01;
    let quietMs = 0;
    listenWith((chunk) => {
      const loudness = loudnessOf(chunk);
      floor = loudness < floor ? loudness : floor * 1.01;
      const speech = loudness > Math.max(0.012, floor * 3);
      if (said.length === 0) {
        before.push(chunk);
        if (before.length > BEFORE_WORD_CHUNKS) before.shift();
        if (speech) said.push(...before);
        return;
      }
      said.push(chunk);
      quietMs = speech ? 0 : quietMs + CHUNK_MS;
      if (quietMs < WORD_END_MS && said.length * CHUNK_MS < LONGEST_WORD_MS) return;
      clearTimeout(giveUp);
      listenWith(() => {});
      // Only the word itself, because silence in a lesson is something a live voice can never match.
      const word = said.slice(0, said.length - quietMs / CHUNK_MS);
      const samples = word.reduce((all, part) => all + part.length, 0);
      const joined = new Int16Array(samples);
      let at = 0;
      for (const part of word) {
        joined.set(part, at);
        at += part.length;
      }
      resolve(new Uint8Array(joined.buffer));
    });
  });
}

/** Learns a wake word from the user saying it a few times. `onStep` hears which time this is. */
export async function teachWakeWord(word: string, onStep: (recording: number, of: number) => void) {
  teaching = true;
  closeEar();
  let capture: Capture | undefined;
  try {
    let hear = (_chunk: Int16Array) => {};
    capture = await captureMicrophone((chunk) => hear(chunk));
    // Stays on the same number until it has one that is really the word.
    for (let good = 0, more = true; good < RECORDINGS && more; ) {
      onStep(good + 1, RECORDINGS);
      [good, more] = await bridge.wakeTeachSample(await recordWord((handler) => (hear = handler)));
    }
    await bridge.wakeTeachEnd(word);
  } catch (err) {
    await bridge.wakeTeachEnd(null);
    throw err;
  } finally {
    if (capture) closeMicrophone(capture.stream, capture.context);
    teaching = false;
    if (getState().wake.state === "listening") void openEar();
  }
}

/** Whether other apps were made quiet for this conversation, so they get their sound back once. */
let hushed = false;

/** Other apps go quiet while the user talks, unless they turned it off or a call is being recorded,
 *  which would empty the PC side of the recording. */
function hushRoom() {
  const { settings, notes } = getState();
  if (hushed || !settings.hushWhileTalking || notes?.recording) return;
  hushed = true;
  void bridge.hushOn(settings.hushLeaveCalls).catch(() => undefined);
}

function unhushRoom() {
  if (!hushed) return;
  hushed = false;
  void bridge.hushOff().catch(() => undefined);
}

export function endConversation() {
  silence();
  unhushRoom();
  if (session) closeMicrophone(session.stream, session.context);
  session = null;
  micLevel = 0;
  setVoice(null);
  // The conversation took this microphone, and the next one-breath command needs it back.
  if (getState().wake.state === "listening") void openEar();
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
  Object.assign(session, { mode, heardSpeech: false, quietMs: 0, waitedMs: 0, loudMs: 0, listenedMs: 0 });
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
  if (now.early && !getState().voice) {
    if (now.early.length * CHUNK_MS < RECENT_MS) now.early.push(chunk);
    return;
  }
  const loudness = loudnessOf(chunk);
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
  now.listenedMs += CHUNK_MS;
  if (now.mode !== "hold" && now.listenedMs >= LONGEST_TURN_MS) return void finishTurn();

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
  const said = withoutWakeWord(heard, wakeWords);
  if (!heard.trim()) return endConversation();
  // Only its name, and then a pause. They have not asked yet, so this is no reason to go.
  if (!said.trim()) return now.mode === "hold" ? endConversation() : void listen(now.mode, true);
  const goodbye = isGoodbye(said, [...wakeWords, getState().settings.assistantName ?? ""]);

  if (now.deciding) {
    const answer = spokenAnswer(said, now.deciding.word);
    if (answer === null) {
      // A request stays on the island for its buttons. Leaving never answers it.
      if (goodbye) return endConversation();
      await speak(`To allow it, say allow ${now.deciding.word}. Or say no, or use the buttons.`);
      return void listen(now.mode);
    }
    const { sessionId, approvalId, spoken } = now.deciding;
    answerApproval(sessionId, approvalId, answer);
    now.deciding = null;
    return void followReply(++now.turn, spoken, approvalId);
  }
  if (goodbye) return endConversation();
  update({ words: said, ahead: "" });
  void ask(said);
}

/** What holds the current chat. Asking something replaces it, so it tells a new reply from an old one. */
function chatNow() {
  const app = getState();
  return app.agentChat.agent ? app.sessions.find((s) => s.id === app.agentChat.sessionId)?.log : app.chat.messages;
}

/** Everything the AI has written since the last thing the user said. */
function replySoFar(): { text: string; done: boolean; waiting: { sessionId: string; approvalId: string; summary: string; agent: string; tool: string; whole: boolean } | null } {
  const app = getState();
  const unchanged = chatNow() === session?.before;
  if (!app.agentChat.agent) {
    const last = app.chat.messages[app.chat.messages.length - 1];
    return { text: !unchanged && last?.role === "assistant" ? last.content : "", done: !app.chatPending, waiting: null };
  }
  const chat = app.sessions.find((s) => s.id === app.agentChat.sessionId);
  if (!chat || unchanged) return { text: "", done: false, waiting: null };
  const start = chat.log.map((entry) => entry.kind).lastIndexOf("user");
  const turn = chat.log.slice(start + 1);
  const done = ["completed", "failed", "cancelled"].includes(chat.status);
  // What it writes between steps is working out loud. Only what follows the last step is the answer,
  // and that is not known until it has finished.
  const answer = turn.slice(turn.map((entry) => entry.kind === "text").lastIndexOf(false) + 1).map((entry) => entry.text).join("\n");
  const asking = chat.approval;
  return {
    text: done ? answer || (turn.length > 0 && chat.status === "completed" ? "Done." : "") : "",
    done,
    waiting: asking ? { sessionId: chat.id, approvalId: asking.id, summary: asking.summary, agent: chat.agent, tool: asking.tool, whole: !asking.full } : null,
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
      // Allowing needs a word picked for this request, so a "yes" from a video or another person
      // cannot do it. A command is not read out, because reading it aloud drops what matters.
      const word = pickAllowWord();
      const { agent, summary, tool, whole } = reply.waiting;
      const shell = ["Bash", "PowerShell", "Shell"].includes(tool) || !whole;
      session!.deciding = { sessionId: reply.waiting.sessionId, approvalId: reply.waiting.approvalId, spoken, word };
      update({ phase: "speaking", words: `${agent} wants to: ${summary}. To allow it, say "allow ${word}", or click.`, ahead: "" });
      await speak(`${agent} wants to ${shell ? "run something. It is on the island" : speakable(summary)}. To allow it, say allow ${word}. Or say no.`);
      if (current()) await listen(session!.mode);
      return;
    }
    const { ready } = sentences(speakable(reply.text), reply.done);
    const sentence = spoken < MOST_SENTENCES ? ready[spoken] : undefined;
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
  if (session!.mode === "conversation" && !session!.closing) await listen("conversation");
  else endConversation();
}

const currentSession = () => session;

/** Starts a conversation, as the hotkey does. `woken` says it was called by name, and `afterMs`
 *  how much had been said after the name by the time it was heard. */
export async function startVoice(mode: VoiceMode, woken = false, afterMs = 0) {
  if (opening) return;
  if (session) {
    if (getState().voice?.phase === "speaking") await interrupted();
    return;
  }
  opening = true;
  // One piece more than was said after the name, because a piece can be on its way while the name is found.
  const said = woken && afterMs > 0 ? recent.slice(-(Math.ceil(afterMs / CHUNK_MS) + 1)) : [];
  recent = [];
  try {
    hushRoom();
    await openMicrophone(mode, woken);
    await listen(mode, woken);
    // Read again, because a conversation can end while it starts.
    const now = currentSession();
    if (now?.early) {
      const early = now.early;
      now.early = undefined;
      for (const chunk of [...said, ...early]) onAudio(chunk);
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

let lastWake: { word: string; at: number } | null = null;
/** The last time it woke to its name, for Test and repair. In memory only. */
export const lastHeardWake = () => lastWake;

export function wireVoice() {
  void bridge.onVoiceKey(onKey);
  void bridge.onWakeState((status) => {
    setWake(status);
    if (status.state === "listening") void openEar();
    else closeEar();
  });
  void bridge.onAssistantOpen((tab) => openPanel(tab as Tab));
  void bridge.onAssistantStopListening(() => {
    if (session) session.closing = true;
  });
  void bridge.onAssistantAgent(({ task, folder }) => {
    const cwd = folder || getState().settings.agentDefaultDir;
    if (!cwd) return pushError({ title: "Choose a project folder", body: "Tell it which folder to work in." });
    // The approval names the folder, and a folder the user never worked in is not started at all.
    if (!knownFolder(cwd)) return pushError({ title: "Agent not started", body: `${cwd} is not a folder you have used. Start it yourself from Agents if you meant it.` });
    void startSession({ agent: "claude-code", cwd, prompt: task, model: null, restricted: false, images: [] }, "agents", "project");
  });
  void bridge.wakeStatus().then((status) => {
    setWake(status);
    if (status.state === "listening") void openEar();
  });
  void bridge.onWakeHeard(({ word, test, afterMs }) => {
    if (test) return wakeTestHeard(word);
    lastWake = { word, at: Date.now() };
    // A perk, so it is plain it caught its name. Then it listens.
    feel("heard", HEARD_MS);
    void startVoice(getState().settings.wakeAfter, true, afterMs);
  });
}
