// AudioWorkletProcessor that resamples 48kHz (default) input to 16kHz
// linear16 PCM and emits 20ms frames (640 bytes) via port.postMessage.
// This file runs in the audio thread — keep it allocation-free in process().
//
// Plain .js on purpose: Vite's `?url` inliner chooses MIME type from the
// file extension, and `.ts` resolves to `video/mp2t` which breaks
// AudioWorklet.addModule. Keep this as .js so the inlined data URL ships
// with `application/javascript`.

const TARGET_SR = 16000;
const TARGET_FRAME_SAMPLES = 320;

class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_SR;
    this.acc = 0;
    this.pending = new Int16Array(TARGET_FRAME_SAMPLES);
    this.pendingLen = 0;
    this.lastSample = 0;
    this.rmsSum = 0;
    this.rmsN = 0;
    this.lastLevelAt = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || input[0].length === 0) return true;

    const ch0 = input[0];
    const ch1 = input[1];
    const len = ch0.length;
    const ratio = this.ratio;

    let srcPos = this.acc;
    while (srcPos < len) {
      const i = Math.floor(srcPos);
      const frac = srcPos - i;
      const s0 = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
      const next = i + 1 < len ? (ch1 ? (ch0[i + 1] + ch1[i + 1]) * 0.5 : ch0[i + 1]) : this.lastSample;
      const sample = s0 + (next - s0) * frac;

      const int16 = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
      this.pending[this.pendingLen++] = int16;
      this.rmsSum += sample * sample;
      this.rmsN++;

      if (this.pendingLen === TARGET_FRAME_SAMPLES) {
        const frame = new Int16Array(TARGET_FRAME_SAMPLES);
        frame.set(this.pending);
        this.port.postMessage({ type: "frame", pcm: frame.buffer }, [frame.buffer]);
        this.pendingLen = 0;
      }
      srcPos += ratio;
    }

    if (this.rmsN > 0 && currentTime - this.lastLevelAt > 0.033) {
      const rms = Math.sqrt(this.rmsSum / this.rmsN);
      this.port.postMessage({ type: "level", rms });
      this.rmsSum = 0;
      this.rmsN = 0;
      this.lastLevelAt = currentTime;
    }

    this.acc = srcPos - len;
    this.lastSample = ch1 ? (ch0[len - 1] + ch1[len - 1]) * 0.5 : ch0[len - 1];
    return true;
  }
}

registerProcessor("pcm-downsampler", PcmDownsampler);
