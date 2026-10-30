import { useEffect, useRef } from "react";

/** Keeps the preview alive without touching the microphone. */
const simulated = () => 0.4 + 0.3 * Math.sin(performance.now() / 260);

/**
 * Live microphone level, 0 to 1, read on demand so it never re-renders React.
 * The mic opens only when `enabled` and only while the listening view is
 * mounted, and nothing here records or stores audio. No device reads as a
 * quiet line.
 */
export function useMicLevel(enabled: boolean) {
  const level = useRef(0);
  const read = useRef<() => number>(simulated);

  useEffect(() => {
    if (!enabled) {
      read.current = simulated;
      return;
    }
    let stream: MediaStream | null = null;
    let audio: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let cancelled = false;
    const data = new Uint8Array(256);

    read.current = () => {
      if (!analyser) return 0;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / data.length);
      level.current = level.current * 0.6 + Math.min(1, rms * 5) * 0.4;
      return level.current;
    };

    navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        audio = new AudioContext();
        analyser = audio.createAnalyser();
        analyser.fftSize = 512;
        audio.createMediaStreamSource(s).connect(analyser);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
      void audio?.close();
    };
  }, [enabled]);

  return useRef(() => read.current()).current;
}
