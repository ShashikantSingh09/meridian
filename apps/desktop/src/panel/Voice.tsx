// Choosing how it sounds and how it hears. Keys go straight to Windows Credential Manager, and a
// voice that runs on this PC is a download the user asks for, so nothing arrives uninvited.

import { useEffect, useState } from "react";
import { bridge, type VoiceStatus } from "../lib/bridge";
import { Brand } from "../lib/brands";
import { Icon } from "../lib/icons";
import { updateSettings, useApp } from "../lib/store";
import type { VoiceInfo } from "../lib/types";
import { say } from "../lib/voice";
import { DevicesSection } from "./Devices";

interface Provider {
  id: string;
  name: string;
  note: string;
  /** Needs a key. */
  key?: boolean;
  /** A download, by its pack id. */
  pack?: string;
}

export const SPEAKERS: Provider[] = [
  { id: "elevenlabs", name: "ElevenLabs", note: "The most lifelike", key: true },
  { id: "openai", name: "OpenAI", note: "Clear and quick", key: true },
  { id: "cartesia", name: "Cartesia", note: "Built for fast replies", key: true },
  { id: "deepgram", name: "Deepgram", note: "Quick, and can also hear you", key: true },
  { id: "kokoro", name: "Kokoro", note: "Natural and free, on this PC", pack: "kokoro" },
  { id: "piper-amy", name: "Piper, Amy", note: "Light and quick, on this PC", pack: "piper-amy" },
  { id: "piper-alan", name: "Piper, Alan", note: "Light and quick, on this PC", pack: "piper-alan" },
  { id: "windows", name: "Windows voices", note: "Already on your PC. Plainer" },
];

const HEARING = [
  { id: "local", name: "On this PC", note: "Your voice never leaves this PC, and your words appear as you speak. English only." },
  { id: "elevenlabs", name: "ElevenLabs", note: "Your voice goes to ElevenLabs to be written down, and your words appear when you finish. Uses the same key." },
  { id: "deepgram", name: "Deepgram", note: "Your voice goes to Deepgram to be written down, and your words appear when you finish. Needs its own key." },
];

const size = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);

export function VoiceSection() {
  const provider = useApp((s) => s.settings.voiceProvider);
  const chosen = useApp((s) => s.settings.voiceId);
  const hearing = useApp((s) => s.settings.voiceHearing);
  const interrupt = useApp((s) => s.settings.voiceInterrupt);
  const [status, setStatus] = useState<VoiceStatus>({ packs: [], keys: [] });
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [key, setKey] = useState("");
  const [fetched, setFetched] = useState<{ id: string; bytes: number; total: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const current = SPEAKERS.find((s) => s.id === provider) ?? SPEAKERS[SPEAKERS.length - 1]!;
  const pack = status.packs.find((p) => p.id === current.pack);
  const engine = status.packs.find((p) => p.id === "engine");
  const ears = status.packs.find((p) => p.id === "hearing");
  /** Whether this pack and the engine it runs on are both here. */
  const usable = (wanted?: VoiceStatus["packs"][number]) => wanted?.installed && engine?.installed;
  /** What is left to fetch for a pack, which may be only the engine. */
  const toFetch = (wanted?: VoiceStatus["packs"][number]) => (wanted?.installed ? 0 : (wanted?.bytes ?? 0)) + (engine?.installed ? 0 : (engine?.bytes ?? 0));
  const ready = current.key ? status.keys.includes(current.id) : !current.pack || usable(pack);

  const refresh = () => bridge.voiceStatus().then(setStatus);
  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    setVoices([]);
    setProblem(null);
    if (!ready) return;
    // A slow list must not land on the next provider, or one service's voice goes to another.
    let live = true;
    bridge.voiceList(current.id).then((list) => live && setVoices(list), (err) => live && setProblem(String(err)));
    return () => {
      live = false;
    };
    // Only what decides the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.id, ready]);

  const saveKey = async () => {
    setProblem(null);
    await bridge.voiceKeySet(current.id, key);
    setKey("");
    await refresh();
  };

  const download = async (id: string) => {
    const total = toFetch(status.packs.find((p) => p.id === id));
    setProblem(null);
    setFetched({ id, bytes: 0, total });
    try {
      await bridge.voiceDownload(id, (bytes) => setFetched({ id, bytes, total }));
      await refresh();
    } catch (err) {
      setProblem(String(err));
    }
    setFetched(null);
  };

  const remove = async (id: string) => {
    await bridge.voiceRemove(id);
    await refresh();
  };

  const tryVoice = (id: string) => {
    setProblem(null);
    say("Hello. This is how I sound.", current.id, id).catch((err) => setProblem(String(err)));
  };

  const pick = (id: string) => void updateSettings({ voiceProvider: id, voiceId: null });
  const downloading = (id: string) => fetched?.id === id;

  return (
    <div className="stack-lg voice-page">
      <header className="settings-head">
        <h1>Voice</h1>
        <p className="meta">Hold Ctrl Alt V and talk. Tap it for one question, or tap twice to keep talking.</p>
      </header>

      <h2>The voice it speaks with</h2>
      <div className="stack voice-tiles" role="group" aria-label="Voice">
        {SPEAKERS.map((s) => (
          <button key={s.id} className="voice-tile" aria-pressed={s.id === provider} onClick={() => pick(s.id)}>
            <Brand id={s.id} name={s.name} size={26} />
            <span className="stacked grow">
              <span className="label truncate">{s.name}</span>
              <span className="meta truncate">{s.note}{s.key && status.keys.includes(s.id) ? ". Key saved" : ""}</span>
            </span>
            {s.id === provider && <Icon name="check" size={15} />}
          </button>
        ))}
      </div>

      {(current.key || (current.pack && pack) || problem || (ready && voices.length > 0)) && (
        <div className="stack">
          {current.key && (
            <div className="setting">
              <span className="stacked grow">
                <span className="label">{current.name} key</span>
                <span className="meta">Kept in Windows Credential Manager, and sent only to {current.name}. What it says goes to them to be spoken.</span>
              </span>
              <input className="setting-input" type="password" aria-label={`${current.name} API key`} placeholder={status.keys.includes(current.id) ? "Key saved" : "Paste your API key"} value={key} onChange={(e) => setKey(e.target.value)} />
              {key ? <button className="solid" onClick={() => void saveKey()}>Save</button> : status.keys.includes(current.id) && <button className="ghost" onClick={() => void bridge.voiceKeyClear(current.id).then(refresh)}>Remove</button>}
            </div>
          )}
          {current.pack && pack && (
            <div className="setting">
              <span className="stacked grow">
                <span className="label">{current.name}</span>
                <span className="meta">Runs on this PC. What it says never leaves your machine.</span>
              </span>
              {usable(pack) ? (
                <button className="ghost" onClick={() => void remove(pack.id)}>Remove</button>
              ) : downloading(pack.id) ? (
                <Progress done={fetched!.bytes} total={fetched!.total} />
              ) : (
                <button className="solid" disabled={fetched !== null} onClick={() => void download(pack.id)}>Download, {size(toFetch(pack))}</button>
              )}
            </div>
          )}
          {problem && <p className="meta bad" role="alert">{problem}</p>}
          {ready && voices.length > 0 && (
            <ul className="list voice-list">
              {voices.map((v) => {
                const on = (chosen ?? voices[0]!.id) === v.id;
                return (
                  <li key={v.id}>
                    <div className="voice-row" data-chosen={on}>
                      <button className="grow text-button stacked" onClick={() => void updateSettings({ voiceId: v.id })}>
                        <span className="label truncate">{v.name}</span>
                        {v.note && <span className="meta truncate">{v.note}</span>}
                      </button>
                      {on && <Icon name="check" size={15} />}
                      <button className="round" aria-label={`Hear ${v.name}`} title={`Hear ${v.name}`} onClick={() => tryVoice(v.id)}><Icon name="play" size={13} /></button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <div className="stack">
        <div className="setting">
          <span className="label">How it hears you</span>
          <div className="segmented" role="group" aria-label="How it hears you">
            {HEARING.map((h) => (
              <button key={h.id} aria-pressed={h.id === hearing} onClick={() => void updateSettings({ voiceHearing: h.id })}>{h.name}</button>
            ))}
          </div>
        </div>
        <p className="meta">{HEARING.find((h) => h.id === hearing)?.note}</p>
        {hearing === "local" && ears && !usable(ears) && (
          downloading("hearing") ? <Progress done={fetched!.bytes} total={fetched!.total} /> : (
            <button className="solid voice-get" disabled={fetched !== null} onClick={() => void download("hearing")}>Download, {size(toFetch(ears))}</button>
          )
        )}
        {hearing !== "local" && !status.keys.includes(hearing) && <p className="meta bad">Add a key for {HEARING.find((h) => h.id === hearing)?.name} first, by choosing it as the voice above.</p>}
        <label className="setting toggle">
          <span className="stacked grow">
            <span className="label">Talk over it to interrupt</span>
            <span className="meta">Start talking and it stops at once, like a person would. The microphone stays open while it answers.</span>
          </span>
          <input type="checkbox" role="switch" checked={interrupt} onChange={(e) => void updateSettings({ voiceInterrupt: e.target.checked })} />
        </label>
      </div>

      <DevicesSection />
    </div>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="stack-sm voice-progress-row" role="status">
      <span className="level-track voice-progress"><i style={{ width: `${percent}%`, background: "var(--accent)" }} /></span>
      <span className="meta tabular">Downloading, {size(done)} of {size(total)}</span>
    </div>
  );
}
