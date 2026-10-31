// Runs on the audio thread. Gathers the microphone into 100 ms chunks of 16-bit audio.
class PcmChunks extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 10);
    this.chunk = new Int16Array(this.size);
    this.filled = 0;
  }

  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples) {
      for (const sample of samples) {
        this.chunk[this.filled++] = Math.max(-1, Math.min(1, sample)) * 32767;
        if (this.filled === this.size) {
          this.port.postMessage(this.chunk.slice(0));
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm-chunks", PcmChunks);
