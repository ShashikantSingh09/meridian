// Which microphone and speakers Meridian uses, and a way to try them. The microphone opens only
// while this section is open, and closes with it.

import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../lib/icons";
import { setSettingsSection, updateSettings, useApp } from "../lib/store";
import { Menu } from "./Menu";

type Kind = "audioinput" | "audiooutput";

/** Entries that stand for whatever Windows has set, not for a device. */
const STAND_INS = ["default", "communications"];

const realDevices = (devices: MediaDeviceInfo[], kind: Kind) => devices.filter((d) => d.kind === kind && d.deviceId && !STAND_INS.includes(d.deviceId));

/** Windows' name, without the hardware id the browser adds to USB devices. */
const deviceName = (device: MediaDeviceInfo) => device.label.replace(/ \([0-9a-f]{4}:[0-9a-f]{4}\)$/i, "");

/** Ids are hidden until the microphone has been allowed, and then nothing can be called missing. */
function isUnplugged(devices: MediaDeviceInfo[], kind: Kind, chosen: string | null) {
  if (!chosen || devices.some((d) => d.kind === kind && !d.deviceId)) return false;
  return !realDevices(devices, kind).some((d) => d.deviceId === chosen);
}

function DevicePick({ kind, icon, label, hint, devices, chosen, onPick }: { kind: Kind; icon: IconName; label: string; hint: string; devices: MediaDeviceInfo[]; chosen: string | null; onPick: (id: string | null) => void }) {
  const list = realDevices(devices, kind);
  const unplugged = isUnplugged(devices, kind, chosen);
  const items = [
    { value: "", label: "Same as Windows" },
    ...(chosen && !list.some((d) => d.deviceId === chosen) ? [{ value: chosen, label: unplugged ? "Unplugged device" : "Your chosen device" }] : []),
    ...list.map((d, i) => ({ value: d.deviceId, label: deviceName(d) || `${label} ${i + 1}` })),
  ];
  return (
    <>
      <div className="setting">
        <Icon name={icon} size={15} />
        <span className="stacked grow">
          <span className="label">{label}</span>
          <span className="meta">{hint}</span>
        </span>
        <Menu label={label} value={chosen ?? ""} items={items} empty="Same as Windows" onPick={(id) => onPick(id || null)} />
      </div>
      {unplugged && <p className="meta bad" role="alert">This is unplugged, so nothing will use it until it is back. Plug it in, or choose another.</p>}
    </>
  );
}

const MICROPHONE = {
  opening: "Opening the microphone.",
  open: "The microphone is open while this section is. Speak and watch the bar move, or play a short sound.",
  blocked: "Meridian is not allowed to use the microphone. Check microphone privacy in Windows settings.",
  failed: "The microphone would not open. Another app may be holding it.",
};

/** The level is drawn straight onto the bar, so a moving voice does not re-render the page. */
function TryThem({ microphone, output, microphoneGone, outputGone, onOpened }: { microphone: string | null; output: string | null; microphoneGone: boolean; outputGone: boolean; onOpened: () => void }) {
  const bar = useRef<HTMLElement>(null);
  const [state, setState] = useState<keyof typeof MICROPHONE>("opening");
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (microphoneGone) return;
    let live = true;
    let close = () => {};
    setState("opening");
    navigator.mediaDevices.getUserMedia({ audio: microphone ? { deviceId: { exact: microphone } } : true }).then(
      (stream) => {
        const stopTracks = () => stream.getTracks().forEach((track) => track.stop());
        if (!live) return stopTracks();
        const context = new AudioContext();
        const meter = context.createAnalyser();
        meter.fftSize = 512;
        context.createMediaStreamSource(stream).connect(meter);
        const samples = new Uint8Array(meter.fftSize);
        let frame = 0;
        const draw = () => {
          meter.getByteTimeDomainData(samples);
          let sum = 0;
          for (const value of samples) sum += ((value - 128) / 128) ** 2;
          if (bar.current) bar.current.style.width = `${Math.min(100, Math.sqrt(sum / samples.length) * 400)}%`;
          frame = requestAnimationFrame(draw);
        };
        draw();
        close = () => {
          cancelAnimationFrame(frame);
          stopTracks();
          void context.close();
        };
        setState("open");
        onOpened();
      },
      (err: Error) => live && setState(err.name === "NotAllowedError" ? "blocked" : "failed"),
    );
    return () => {
      live = false;
      close();
    };
    // Only what decides which microphone is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [microphone, microphoneGone]);

  const playSound = async () => {
    setProblem(null);
    const context = new AudioContext();
    try {
      if (output) await (context as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(output);
      const tone = context.createOscillator();
      const level = context.createGain();
      tone.frequency.value = 660;
      level.gain.setValueAtTime(0.08, context.currentTime);
      level.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.5);
      tone.connect(level).connect(context.destination);
      tone.onended = () => void context.close();
      tone.start();
      tone.stop(context.currentTime + 0.5);
    } catch {
      setProblem("That output would not play.");
      void context.close();
    }
  };

  const open = state === "open" && !microphoneGone;
  return (
    <div className="stack">
      <div className="setting">
        <span className="stacked grow">
          <span className="label">Try them</span>
          <span className="meta" role="status">{microphoneGone ? "Your chosen microphone is unplugged, so it is not open." : MICROPHONE[state]}</span>
          {problem && <span className="meta bad" role="alert">{problem}</span>}
        </span>
        <span className="level-track device-level" data-open={open} aria-hidden="true"><i ref={bar} style={{ width: 0 }} /></span>
        <button className="ghost" disabled={outputGone} onClick={() => void playSound()}>Play sound</button>
      </div>
    </div>
  );
}

let openOnArrival = false;

/** Goes to the Voice page with this section open. */
export function showDevices() {
  openOnArrival = true;
  setSettingsSection("voice");
}

export function DevicesSection() {
  const microphone = useApp((s) => s.settings.voiceMicrophone);
  const output = useApp((s) => s.settings.voiceOutput);
  // Null until Windows has answered, because an empty list would call every device unplugged.
  const [known, setDevices] = useState<MediaDeviceInfo[] | null>(null);
  const devices = known ?? [];
  const [open, setOpen] = useState(openOnArrival);
  const box = useRef<HTMLDetailsElement>(null);

  const refresh = () => navigator.mediaDevices.enumerateDevices().then(setDevices, () => {});
  useEffect(() => {
    void refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    if (openOnArrival) box.current?.scrollIntoView();
    openOnArrival = false;
    return () => navigator.mediaDevices.removeEventListener("devicechange", refresh);
  }, []);

  const microphoneGone = !!known && isUnplugged(known, "audioinput", microphone);
  const outputGone = !!known && isUnplugged(known, "audiooutput", output);
  return (
    <details ref={box} className="devices" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="stack">
        <span className="setting">
          <Icon name="mic" size={15} />
          <span className="stacked grow">
            <span className="label">Microphone and headphones</span>
            <span className={microphoneGone || outputGone ? "meta bad" : "meta"}>{microphoneGone ? "Your chosen microphone is unplugged." : outputGone ? "Your chosen output is unplugged." : "Choose what Meridian hears and speaks through."}</span>
          </span>
          <span className="devices-chevron"><Icon name="chevron" size={12} /></span>
        </span>
      </summary>
      {open && (
        <div className="stack-lg devices-body">
          <div className="stack">
            <DevicePick kind="audioinput" icon="mic" label="Microphone" hint="What you speak into, for conversations and wake words." devices={devices} chosen={microphone} onPick={(voiceMicrophone) => void updateSettings({ voiceMicrophone })} />
            <DevicePick kind="audiooutput" icon="music" label="Headphones or speakers" hint="What Meridian speaks through." devices={devices} chosen={output} onPick={(voiceOutput) => void updateSettings({ voiceOutput })} />
          </div>
          {known && <TryThem microphone={microphone} output={output} microphoneGone={microphoneGone} outputGone={outputGone} onOpened={() => void refresh()} />}
          <div className="stack">
            <p className="fact"><Icon name="check" size={14} />If your chosen microphone is unplugged, it says so and waits. It never switches to another microphone by itself.</p>
          </div>
        </div>
      )}
    </details>
  );
}
