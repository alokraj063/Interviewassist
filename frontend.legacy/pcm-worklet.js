// AudioWorklet: resamples mic / call audio to 16 kHz linear16 (mono) and posts
// ~80 ms PCM frames (1280 samples) back to the main thread for Deepgram Flux.
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate; // `sampleRate` = context rate (global)
    this.frameSize = 1280; // 80 ms @ 16 kHz
    this.out = new Int16Array(this.frameSize);
    this.outIdx = 0;
    this.carry = new Float32Array(0);
    this.readPos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];

    // Prepend leftover samples from the previous block.
    const merged = new Float32Array(this.carry.length + ch.length);
    merged.set(this.carry, 0);
    merged.set(ch, this.carry.length);

    let pos = this.readPos;
    while (pos < merged.length - 1) {
      const i = Math.floor(pos);
      const frac = pos - i;
      // Linear interpolation between neighbouring samples.
      let s = merged[i] * (1 - frac) + merged[i + 1] * frac;
      s = Math.max(-1, Math.min(1, s));
      this.out[this.outIdx++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.outIdx === this.frameSize) {
        // Transfer a copy of the buffer to the main thread (zero-copy handoff).
        const buf = this.out.slice(0).buffer;
        this.port.postMessage(buf, [buf]);
        this.outIdx = 0;
      }
      pos += this.ratio;
    }

    const consumed = Math.floor(pos);
    this.carry = merged.slice(consumed);
    this.readPos = pos - consumed;
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
