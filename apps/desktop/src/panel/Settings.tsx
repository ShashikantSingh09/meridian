import { AssistantSection } from "./Assistant";
import { DetailsSection } from "./Details";
import { showDevices } from "./Devices";
import { FillSection } from "./Fill";
import { FollowSwitch } from "./Follow";
import { MyDaySection } from "./MyDay";
import { Markdown } from "./Markdown";
import { Menu } from "./Menu";
import { RepairPage, RepairRow } from "./Repair";
import { ScreenSection } from "./Screen";
import { ThemesSection } from "./Themes";
import { VoiceSection } from "./Voice";
import "./settings.css";
import { spring } from "@meridian/design-system/motion";
import { motion } from "motion/react";
import { useState, useEffect } from "react";
import { Face, FACES, type Mood } from "../island/faces";
import { bridge } from "../lib/bridge";
import { Brand } from "../lib/brands";
import { checkForUpdates, setUpdateChecks, clearHistory, feel, installUpdate, PREVIEWS, refreshAuth, resetIslandPlace, setSettingsSection, showPreview, testWake, updateSettings, useApp, type SettingsSection } from "../lib/store";
import { Icon, type IconName } from "../lib/icons";
import { teachWakeWord } from "../lib/voice";
import type { AgentInfo, Settings, WakeWord } from "../lib/types";
import { Integrations } from "./Integrations";
import { Providers } from "./Providers";

function Choice<K extends keyof Settings>({ name, label, options }: {
  name: K;
  label: string;
  options: { value: Settings[K]; label: string }[];
}) {
  const value = useApp((s) => s.settings[name]);
  return (
    <fieldset className="setting">
      <legend>{label}</legend>
      <div className="segmented">
        {options.map((o) => (
          <button key={String(o.value)} aria-pressed={value === o.value} onClick={() => void updateSettings({ [name]: o.value } as Partial<Settings>)}>
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

type Flag = "wakeEnabled" | "wakePauseCalls" | "wakePauseLocked" | "ambient" | "autostart" | "localOnly" | "showClock" | "showBattery" | "showUsage" | "stopQuietCalls" | "islandAutoHide" | "mediaEnabled" | "monitoringPaused" | "showNextMeeting" | "sounds";

function Toggle({ name, label, hint }: { name: Flag; label: string; hint: string }) {
  const value = useApp((s) => s.settings[name]);
  return (
    <label className="setting toggle">
      <span className="stacked grow">
        <span className="label">{label}</span>
        <span className="meta">{hint}</span>
      </span>
      <input type="checkbox" role="switch" checked={value} onChange={(e) => void updateSettings({ [name]: e.target.checked })} />
    </label>
  );
}

const Fact = ({ text }: { text: string }) => <p className="fact"><Icon name="check" size={14} />{text}</p>;

function General() {
  const systemPrompt = useApp((s) => s.settings.systemPrompt);
  return (
    <section className="stack-lg">
      <h1>General</h1>
      <h2>Startup and sound</h2>
      <div className="stack">
        <Toggle name="autostart" label="Start with Windows" hint="Off by default." />
        <Toggle name="sounds" label="Sounds" hint="A soft chime when an agent finishes or needs you." />
        <Toggle name="localOnly" label="Local-only mode" hint="Nothing goes to a cloud service, including Claude Code and Codex. Only AI running on this PC is used." />
      </div>
      <label className="field">
        <span className="label">Custom instructions</span>
        <textarea
          rows={3}
          defaultValue={systemPrompt}
          placeholder="Sent as the system prompt with every API chat"
          onBlur={(e) => void updateSettings({ systemPrompt: e.target.value })}
        />
      </label>
    </section>
  );
}

const MOODS: [Mood, string][] = [
  ["done", "Happy"],
  ["error", "Sad"],
  ["needs", "Surprised"],
  ["curious", "Curious"],
  ["working", "Focused"],
  ["listen", "Listening"],
  ["think", "Thinking"],
  ["speak", "Speaking"],
  ["heard", "Heard you"],
  ["notice", "Something new"],
  ["drag", "Being moved"],
  ["wink", "Wink"],
  ["love", "Love"],
  ["dizzy", "Dizzy"],
  ["sleepy", "Sleepy"],
  ["asleep", "Asleep"],
];

function FacePicker() {
  const chosen = useApp((s) => s.settings.face);
  const feeling = useApp((s) => s.feeling);
  return (
    <>
      <h2>Face</h2>
      <div className="pick-grid face-grid">
        {FACES.map((f) => (
          <button key={f.id} className="pick" aria-pressed={f.id === chosen} title={f.note} onClick={() => void updateSettings({ face: f.id })}>
            <span className="pick-stage"><Face id={f.id} mood={feeling ?? "rest"} /></span>
            <span className="pick-name">{f.name}</span>
          </button>
        ))}
      </div>
      <div className="chips" role="group" aria-label="Try a mood">
        {MOODS.map(([mood, label]) => (
          <button key={mood} className="chip" aria-pressed={feeling === mood} onClick={() => feel(mood, 2600)}>{label}</button>
        ))}
      </div>
    </>
  );
}

function IslandSection() {
  const monitor = useApp((s) => s.settings.islandMonitor);
  const monitors = useApp((s) => s.monitors);
  const preview = useApp((s) => s.preview);
  const dragged = useApp((s) => s.islandPlace !== "top" || Object.keys(s.settings.islandSpots ?? {}).length > 0);
  return (
    <section className="stack-lg">
      <h1>Island</h1>
      <FacePicker />
      <div className="stack">
        <Choice name="islandAlign" label="Position" options={[
          { value: "left", label: "Left" },
          { value: "center", label: "Center" },
          { value: "right", label: "Right" },
        ]} />
        <div className="setting">
          <span className="stacked grow">
            <span className="label">Move it anywhere</span>
            <span className="meta">Drag the island. Off the top edge it floats, and near the top it becomes the notch again.</span>
          </span>
          <button className="ghost" disabled={!dragged} onClick={() => void resetIslandPlace()}>Back to top center</button>
        </div>
        {monitors.length > 1 && (
          <div className="setting">
            <span className="label grow">Display</span>
            <Menu label="Display" value={monitor} items={[{ value: "primary", label: "Primary" }, ...monitors.map((m) => ({ value: m, label: m }))]} empty="Primary" onPick={(islandMonitor) => void updateSettings({ islandMonitor })} />
          </div>
        )}
        <Choice name="animationSpeed" label="Animation speed" options={[
          { value: 0.75, label: "Relaxed" },
          { value: 1, label: "Normal" },
          { value: 1.35, label: "Quick" },
        ]} />
        <Choice name="motion" label="Motion" options={[
          { value: "system", label: "System" },
          { value: "full", label: "Full" },
          { value: "reduced", label: "Reduced" },
        ]} />
      </div>
      <div className="stack">
        <Toggle name="showClock" label="Show the time" hint="Beside the line while idle." />
        <Toggle name="showBattery" label="Show the battery" hint="On a laptop: the charge beside the time, with a bolt while it charges." />
        <Toggle name="showUsage" label="Show plan use" hint="A small ring by the time for how much of your Claude plan is used. Point at it for both limits." />
        <Toggle name="mediaEnabled" label="Show what is playing" hint="Any player that publishes to Windows media controls." />
        <Toggle name="showNextMeeting" label="Show the next meeting" hint="On the island when you point at it." />
        <Toggle name="islandAutoHide" label="Hide when idle" hint="Shrinks to a sliver, and returns on hover or activity." />
        <Toggle name="ambient" label="Ambient breathing" hint="The face breathes for a few seconds after activity, then rests." />
      </div>
      <p className="meta">Hide it completely from the tray icon. The shortcut brings it back.</p>
      <h2>Preview island states</h2>
      <p className="meta">Shows each state with sample data for a few seconds, so you can judge the design.</p>
      <div className="chips">
        {PREVIEWS.map((p) => (
          <button key={p.name} className="chip" aria-pressed={preview === p.name} onClick={() => showPreview(p.name)}>{p.name}</button>
        ))}
      </div>
    </section>
  );
}

function AgentRow({ agent }: { agent: AgentInfo }) {
  const auth = useApp((s) => s.auth[agent.id]);
  const signedIn = auth?.signedIn;
  const state = signedIn === true ? `signed in${auth?.plan ? `, ${auth.plan}` : ""}` : signedIn === false ? "not signed in" : "sign-in unknown";
  return (
    <div className="setting">
      <Brand id={agent.id} name={agent.name} size={30} />
      <span className="stacked grow">
        <span className="label">{agent.name}</span>
        <span className="meta truncate" title={agent.path ?? undefined}>{agent.installed ? `${agent.version}, ${state}` : "Not installed. Not found on PATH"}</span>
      </span>
      {agent.installed && <button className="ghost" onClick={() => void refreshAuth(agent.id)}>Check</button>}
      {agent.installed && signedIn !== true && <button className="solid" onClick={() => void bridge.agentLogin(agent.id)}>Sign in</button>}
    </div>
  );
}

function AgentsSection() {
  const agents = useApp((s) => s.agents);
  const defaultDir = useApp((s) => s.settings.agentDefaultDir);
  const [picking, setPicking] = useState(false);

  const pickDir = async () => {
    setPicking(true);
    const dir = await bridge.pickFolder();
    setPicking(false);
    if (dir) void updateSettings({ agentDefaultDir: dir });
  };

  return (
    <section className="stack-lg">
      <h1>Coding agents</h1>
      <div className="stack">
        <FollowSwitch label="Follow Claude Code in any terminal" explain="Answer permission requests, questions and plans from the island. Adds hooks to your Claude Code settings and keeps a backup. Turning this off removes them. Nothing leaves this PC." />
      </div>
      <div className="stack">
        {agents.map((a) => (
          <AgentRow key={a.id} agent={a} />
        ))}
      </div>
      <div className="stack">
        <div className="setting">
          <span className="stacked grow">
            <span className="label">Default project folder</span>
            <span className="meta truncate" title={defaultDir ?? undefined}>{defaultDir ?? "None"}</span>
          </span>
          <button className="ghost" disabled={picking} onClick={() => void pickDir()}>Choose</button>
        </div>
      </div>
    </section>
  );
}

function Privacy() {
  const providers = useApp((s) => s.providers);
  const localOnline = useApp((s) => s.localOnline);
  const local = providers.find((p) => p.kind === "local" && localOnline.includes(p.id)) ?? providers.find((p) => p.kind === "local");
  const onThisPc = `${local?.name ?? "The AI"} on this PC`;
  return (
    <section className="stack-lg">
      <h1>Privacy</h1>
      <div className="stack">
        <Toggle name="monitoringPaused" label="Pause all monitoring" hint="Stops contextual awareness and background fetching at once. Also in the tray menu." />
      </div>
      <div className="stack">
        <Toggle name="localOnly" label="Local-only mode" hint="Nothing leaves this PC." />
        <p className="fill-group">While it is on</p>
        <div className="setting"><span className="label grow">Write here</span><span className="meta">{onThisPc}</span></div>
        <div className="setting"><span className="label grow">Fill this form</span><span className="meta">{onThisPc}</span></div>
        <div className="setting"><span className="label grow">Finish this for me</span><span className="fill-state">Off</span></div>
        <div className="setting"><span className="label grow">Gmail and Calendar as a source</span><span className="fill-state">Off</span></div>
        <p className="details-info"><Icon name="bulb" size={14} />Replies from the AI on this PC are plainer. Filling forms works about the same, because Your details are put in by Meridian either way.</p>
      </div>
      <h2>What stays true</h2>
      <div className="stack">
        <Fact text="Your screen is read only as set under Screen, always on this PC, and shared only from a preview you approve." />
        <Fact text="Keystrokes and the clipboard are never read." />
        <Fact text="The microphone opens only while the listening view is on screen, for wake words if you turn them on, or while Microphone and headphones is open under Voice, or for a moment while Test and repair checks it. Nothing is recorded." />
        <Fact text="The island shows a dot for as long as it is listening for wake words." />
        <Fact text="Chat goes only to the engine you pick. Providers are read with read-only tools, and what they return stays on this PC." />
        <Fact text="Gmail and Google Calendar connected through your Claude account are read only when you ask, or when My Day opens, at most every half hour. What is read goes through Claude." />
        <Fact text="Notes record your microphone and this PC's sound only after you press Record, with a red dot on the island the whole time. The audio goes to your hearing service to be written down, then it is deleted." />
        <Fact text="A call's transcript goes to the AI you chose for Chat, to write the summary. The notes themselves stay on this PC." />
        <Fact text="No telemetry." />
      </div>
      <div className="stack">
        <div className="setting">
          <span className="stacked grow">
            <span className="label">Chat and session history</span>
            <span className="meta">Kept on this PC so it survives a restart. Shared images are not kept.</span>
          </span>
          <button className="ghost" onClick={clearHistory}>Clear history</button>
        </div>
      </div>
    </section>
  );
}

/** Check for a new version and install it, right here. */
function UpdatesSection() {
  const version = useApp((s) => s.version);
  const update = useApp((s) => s.update);
  const busy = useApp((s) => s.updating);
  const kind = useApp((s) => s.updateKind);
  const checks = useApp((s) => s.settings.updateChecks);
  const fresh = useApp((s) => s.whatsNew);

  // Only once the user said yes. Before that, Check for updates is the only way it asks GitHub.
  useEffect(() => {
    if (checks === true) void checkForUpdates();
  }, [checks]);

  const when = update.published ? new Date(update.published).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : null;
  return (
    <section className="stack-lg">
      <h1>Updates</h1>
      <div className="update-card">
        <div className="row">
          <span className="stacked grow">
            <span className="label">Meridian {version}</span>
            <span className="meta" role="status">{busy === "checking" ? "Checking" : busy === "installing" ? "Downloading and checking the update. Meridian will restart by itself." : update.message}</span>
          </span>
          <button className="ghost" disabled={busy !== null} onClick={() => void checkForUpdates()}>Check for updates</button>
          {update.available && <button className="solid" disabled={busy !== null} onClick={() => void installUpdate()}>{kind === "portable" ? `Get ${update.latest?.replace(/^v/, "")} on GitHub` : "Update now"}</button>}
        </div>
        {kind === "portable" && update.available && <p className="meta">This copy was not installed, so it cannot update itself. Get the new version from its release page.</p>}
        {update.notes && (
          <>
            <h2>What is new in {update.latest?.replace(/^v/, "")}{when ? `, ${when}` : ""}</h2>
            <div className="update-notes"><Markdown text={update.notes} /></div>
          </>
        )}
      </div>
      {checks === null ? (
        <div className="update-card stack">
          <span className="label">Check for new versions by itself?</span>
          <span className="meta">Meridian can look at its releases on GitHub when it starts and every few hours. Nothing else is sent.</span>
          <div className="row end">
            <button className="ghost" onClick={() => setUpdateChecks(false)}>Not now</button>
            <button className="solid" onClick={() => setUpdateChecks(true)}>Yes, check</button>
          </div>
        </div>
      ) : (
        <label className="setting toggle">
          <span className="stacked grow">
            <span className="label">Check for new versions by itself</span>
            <span className="meta">When it starts and every few hours. Check for updates works either way.</span>
          </span>
          <input type="checkbox" role="switch" checked={checks} onChange={(e) => setUpdateChecks(e.target.checked)} />
        </label>
      )}
      {fresh.length > 0 && (
        <div className="stack">
          <h2>New in {version}</h2>
          {fresh.map((thing) => (
            <span key={thing.title} className="stacked">
              <span className="label">{thing.title}</span>
              <span className="meta">{thing.line}</span>
            </span>
          ))}
        </div>
      )}
      <p className="meta">Updating ends any agent running here, so nothing installs until you press Update now. The installer opens the new version when it is done. Downloads come from Meridian's releases on GitHub, are checked against their published checksum, and run only if they match.</p>
    </section>
  );
}

const MOST_WAKE_WORDS = 8;
/** The switch for the always-on microphone, and what it listens for. */
function WakeSection() {
  const words = useApp((s) => s.settings.wakeWords);
  const status = useApp((s) => s.wake);
  const test = useApp((s) => s.wakeTest);
  const [text, setText] = useState("");
  // Typed the way a name is written, "Hey, Jarvis!" is the phrase Hey Jarvis.
  const phrase = text.replace(/[’‘]/g, "'").replace(/[.,!?;:"“”()\-–—]+/g, " ").trim().replace(/\s+/g, " ");
  const usable = /^[\p{L}\p{M}' ]{1,40}$/u.test(phrase);
  const taken = words.some((w) => w.text.toLowerCase() === phrase.toLowerCase());
  const full = words.length >= MOST_WAKE_WORDS;
  const why = !phrase ? null : !usable ? "Use letters only." : taken ? `${phrase} is already on the list.` : full ? `${MOST_WAKE_WORDS} is the most. Remove one to add another.` : null;
  const [taught, setTaught] = useState<string[]>([]);
  const [lesson, setLesson] = useState<{ word: string; say: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const first = words.find((w) => w.on && taught.includes(w.text))?.text;
  const save = (wakeWords: WakeWord[]) => void updateSettings({ wakeWords });
  const check = () => void bridge.wakeTaught(words.map((w) => w.text)).then(setTaught);
  useEffect(check, [words]);
  const teach = (word: string) => {
    setProblem(null);
    teachWakeWord(word, (recording, of) => setLesson({ word, say: `Say ${word}. ${recording} of ${of}.` }))
      .catch((err: unknown) => setProblem(String(err).replace(/^Error: /, "")))
      .finally(() => {
        setLesson(null);
        check();
      });
  };
  const remove = (word: WakeWord) => {
    save(words.filter((w) => w !== word));
    void bridge.wakeForget(word.text);
  };
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!phrase || why) return;
    save([...words, { text: phrase, on: true }]);
    setText("");
  };
  const trying =
    test.phase === "waiting"
      ? status.state === "listening" ? `Say ${first} now.` : "Getting ready."
      : test.phase === "heard"
        ? `Heard ${test.word}.`
        : test.phase === "missed"
          ? "Did not hear it. Try again, teach it again, or set How easily it wakes to Easily."
          : first ? `Press Test, then say ${first}.` : "Teach it a wake word first.";

  return (
    <section className="stack-lg">
      <header className="settings-head">
        <h1>Wake words</h1>
        <p className="meta">Teach it your voice, then say its name and it starts listening, with no keys to press.</p>
      </header>
      <div className="stack">
        <Toggle name="wakeEnabled" label="Listen for wake words" hint="Keeps the microphone on. Off until you turn it on. The island shows a dot for as long as it is listening." />
        {status.why && <p className="meta" role="status">{status.why}</p>}
      </div>
      <div className="stack">
        {words.map((word) => (
          <div className="setting toggle wake-word" key={word.text}>
            <Icon name="mic" size={15} />
            <span className="stacked grow">
              <span className="label">{word.text}</span>
              <span className="meta" role="status">{lesson?.word === word.text ? lesson.say : taught.includes(word.text) ? "Knows your voice" : "Not taught yet"}</span>
            </span>
            <button className="ghost" disabled={lesson !== null} onClick={() => teach(word.text)}>{taught.includes(word.text) ? "Teach again" : "Teach"}</button>
            <button className="ghost wake-remove" aria-label={`Remove ${word.text}`} title="Remove" onClick={() => remove(word)}>
              <Icon name="close" size={13} />
            </button>
            <input type="checkbox" role="switch" aria-label={word.text} checked={word.on} onChange={(e) => save(words.map((w) => (w === word ? { ...w, on: e.target.checked } : w)))} />
          </div>
        ))}
        <form className="setting wake-word" onSubmit={add}>
          <Icon name="plus" size={15} />
          <input className="grow" aria-label="Add a wake word" placeholder="Add a wake word, two or three words work best" maxLength={40} value={text} onChange={(e) => setText(e.target.value)} />
          <button className="ghost" disabled={!phrase || why !== null}>Add</button>
        </form>
        {why && <p className="meta" role="status">{why}</p>}
        {problem && <p className="meta bad" role="alert">{problem}</p>}
      </div>
      <div className="stack">
        <div className="setting wake-word">
          <span className="stacked grow">
            <span className="label">Try it</span>
            <span className="meta" role="status">{trying}</span>
          </span>
          <button className="ghost" disabled={!first || test.phase === "waiting"} onClick={testWake}>Test</button>
        </div>
      </div>
      <div className="stack">
        <button className="setting link-row" onClick={showDevices}>
          <span className="stacked grow">
            <span className="label">Microphone and headphones</span>
            <span className="meta">Wake words listen through the microphone chosen here.</span>
          </span>
          <Icon name="chevron" size={12} />
        </button>
      </div>
      <div className="stack">
        <Choice name="wakeSensitivity" label="How easily it wakes" options={[{ value: "sure", label: "Only when sure" }, { value: "balanced", label: "Balanced" }, { value: "easily", label: "Easily" }]} />
        <Choice name="wakeAfter" label="After it wakes" options={[{ value: "turn", label: "One question" }, { value: "conversation", label: "Keep talking" }]} />
        <Choice name="wakeListen" label="Listen" options={[{ value: "always", label: "Always" }, { value: "charger", label: "On charger" }]} />
        <Toggle name="wakePauseCalls" label="Pause during calls" hint="While another app is using the microphone." />
        <Toggle name="wakePauseLocked" label="Pause when the screen is locked" hint="Listening starts again when you unlock." />
      </div>
      <div className="stack">
        <Fact text="Listening for the name happens on this PC." />
        <Fact text="Nothing is saved, and nothing is sent, until it hears its name. After that, your words go to the hearing you chose under Voice." />
        <Fact text="It learns a word from your voice and keeps a pattern of it, not the recordings." />
      </div>
    </section>
  );
}

function About() {
  const version = useApp((s) => s.version);
  const [repairing, setRepairing] = useState(false);
  if (repairing) return <RepairPage onBack={() => setRepairing(false)} />;
  return (
    <section className="stack-lg">
      <h1>About Meridian</h1>
      <div className="stack">
        <div className="setting">
          <span className="stacked grow">
            <span className="label">Version {version}</span>
          </span>
          <button className="ghost" onClick={() => void bridge.openLogs()}>Open logs</button>
        </div>
        <RepairRow onOpen={() => setRepairing(true)} />
      </div>
      <h2>Keyboard shortcuts</h2>
      <div className="stack">
        {SHORTCUTS.map(([name, key]) => (
          <div className="setting shortcut" key={name}>
            <span className="label">{name}</span>
            <span className="keys"><kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>{key}</kbd></span>
          </div>
        ))}
      </div>
      <p className="meta">Set in Inter, used under the SIL Open Font License.</p>
    </section>
  );
}

const SHORTCUTS = [["Open the island", "Space"], ["Look at the screen", "S"], ["Talk", "V"], ["Write here, or fill this form", "F"]] as const;

interface Section {
  id: SettingsSection;
  label: string;
  icon: IconName;
  tone: string;
  /** What else is on the page, for the search box. */
  terms: string;
  page: () => React.JSX.Element;
}

const SECTIONS: Section[][] = [
  [
    { id: "general", label: "General", icon: "settings", tone: "#8e8e93", page: General, terms: "start with windows startup sounds chime local-only offline custom instructions system prompt" },
    { id: "themes", label: "Themes", icon: "bulb", tone: "#ff6b35", page: ThemesSection, terms: "appearance colour color dark light midnight daylight graphite ocean rose solid glass transparency accent time of day follow windows" },
    { id: "island", label: "Island", icon: "window", tone: "#ff9f0a", page: IslandSection, terms: "face eyes mood position display monitor animation speed motion clock time music meeting hide idle ambient breathing preview" },
  ],
  [
    { id: "assistant", label: "Assistant", icon: "chat", tone: "#34b7a7", page: AssistantSection, terms: "name calls you personality calm cheerful direct playful own words manner suggestions home starters sounds like you style writing gmail sent drafts" },
    { id: "voice", label: "Voice", icon: "mic", tone: "#ff375f", page: VoiceSection, terms: "speak hearing interrupt elevenlabs openai cartesia deepgram kokoro piper key microphone headphones speakers output headset device" },
    { id: "wake", label: "Wake words", icon: "bell", tone: "#d6336c", page: WakeSection, terms: "hey name listen sensitivity pause calls locked microphone charger" },
  ],
  [
    { id: "fill", label: "Fill in the page", icon: "pen", tone: "#32ade6", page: FillSection, terms: "write here fill this form finish this for me experimental ctrl alt f key island buttons apps sites allowed never banks sources knowledge clipboard picture" },
    { id: "myday", label: "My day", icon: "calendar", tone: "#e5484d", page: MyDaySection, terms: "cards needs you replies waiting renewals subscriptions free trials trips travel booking morning summary island gmail calendar" },
    { id: "details", label: "Your details", icon: "person", tone: "#a2845e", page: DetailsSection, terms: "name hindi birth email phone address pin code city state work company job title employee linkedin id numbers pan aadhaar passport profile" },
  ],
  [
    { id: "screen", label: "Screen", icon: "screen", tone: "#5e5ce6", page: ScreenSection, terms: "look capture awareness errors exclusions never capture password" },
    { id: "privacy", label: "Privacy", icon: "lock", tone: "#0a84ff", page: Privacy, terms: "monitoring pause telemetry history clear microphone data local-only offline" },
  ],
  [
    { id: "models", label: "AI models", icon: "bulb", tone: "#bf5af2", page: Providers, terms: "claude chatgpt openrouter ollama lm studio api key sign in local server" },
    { id: "providers", label: "Providers", icon: "providers", tone: "#30b0c7", page: Integrations, terms: "gmail calendar outlook github linear notion slack connect accounts" },
    { id: "agents", label: "Coding agents", icon: "agents", tone: "#636366", page: AgentsSection, terms: "claude code codex follow terminal hooks project folder sign in" },
  ],
  [
    { id: "updates", label: "Updates", icon: "retry", tone: "#30b35a", page: UpdatesSection, terms: "version install check new" },
    { id: "about", label: "About", icon: "lines", tone: "#8e8e93", page: About, terms: "version logs keyboard shortcuts font license test repair check problem fix report" },
  ],
];

export function SettingsPage() {
  const current = useApp((s) => s.settingsSection);
  const [search, setSearch] = useState("");
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const groups = SECTIONS.map((group) => group.filter((s) => words.every((word) => `${s.label} ${s.terms}`.toLowerCase().includes(word)))).filter((group) => group.length > 0);
  const Section = SECTIONS.flat().find((s) => s.id === current)!.page;

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && groups[0]) setSettingsSection(groups[0][0]!.id);
    if (e.key === "Escape" && search) {
      // Clears the box, and leaves the panel open.
      e.stopPropagation();
      setSearch("");
    }
  };

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings sections">
        <label className="settings-search">
          <Icon name="search" size={14} />
          <input aria-label="Search settings" placeholder="Search settings" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={onSearchKey} />
        </label>
        {groups.map((group) => (
          <div className="settings-group" key={group[0]!.id}>
            {group.map((s) => (
              <button key={s.id} className="settings-tab" aria-current={current === s.id ? "page" : undefined} onClick={() => setSettingsSection(s.id)}>
                {current === s.id && <motion.span layoutId="settings-pill" className="settings-pill" transition={spring.snap} />}
                <span className="settings-icon" style={{ background: s.tone }}><Icon name={s.icon} size={13} /></span>
                <span className="settings-tab-label">{s.label}</span>
              </button>
            ))}
          </div>
        ))}
        {groups.length === 0 && <p className="meta settings-none" role="status">Nothing matches.</p>}
      </nav>
      <motion.div key={current} className={current === "providers" ? "settings-body flush" : "settings-body"} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.14 }}>
        <Section />
      </motion.div>
    </div>
  );
}
