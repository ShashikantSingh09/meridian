// Two soft chimes, synthesised, so there are no audio files to ship. A chime is
// never the only sign of anything: the island shows the same news.

const NOTES = {
  done: [659.25, 987.77],
  attention: [880, 880],
  open: [392, 587.33],
  close: [523.25, 349.23],
} as const;

let context: AudioContext | null = null;

export function chime(kind: keyof typeof NOTES) {
  context ??= new AudioContext();
  const start = context.currentTime + 0.01;
  NOTES[kind].forEach((frequency, i) => {
    const at = start + i * 0.11;
    const tone = context!.createOscillator();
    const level = context!.createGain();
    tone.type = "sine";
    tone.frequency.value = frequency;
    level.gain.setValueAtTime(0, at);
    level.gain.linearRampToValueAtTime(kind === "open" || kind === "close" ? 0.035 : 0.07, at + 0.012);
    level.gain.exponentialRampToValueAtTime(0.0001, at + 0.34);
    tone.connect(level).connect(context!.destination);
    tone.start(at);
    tone.stop(at + 0.36);
  });
}
