/**
 * PCM capture worklet (ADR 0141 RT-8/RT-9a) — runs in the AudioWorkletGlobalScope, off
 * the main thread (replaces the deprecated ScriptProcessorNode).
 *
 * RT-9a: the context runs at the mic's NATIVE rate (forcing a 16 kHz AudioContext trips
 * Chrome's MediaStreamSource rate limitation), and THIS worklet downsamples to Gemini
 * Live's required 16 kHz via linear interpolation — the same algorithm as
 * `audioLevels.resamplePcm` (the worklet scope can't import; keep them in step). Output
 * posts in 2048-sample chunks (128 ms @ 16 kHz) to the main thread, which PCM16-encodes
 * them onto the socket tagged `rate=16000`.
 *
 * Plain .js (not .ts): the worklet scope has no DOM lib; it is shipped verbatim as a
 * same-origin Vite asset via `new URL(..., import.meta.url)` — CSP `script-src 'self'` covers it.
 */
/* global AudioWorkletProcessor, registerProcessor, sampleRate */

const TARGET_RATE = 16000;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(2048); // 128 ms @ 16 kHz — snappy VAD cadence
    this._n = 0;
    this._ratio = sampleRate / TARGET_RATE; // ≥ 1 for real mics (44.1/48 kHz)
    this._carry = new Float32Array(0); // input tail kept for interpolation continuity
    this._pos = 0; // fractional read position into the carried+current input
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true; // keep alive across silent/missing input quanta

    // Merge the carried tail with this quantum, then consume with a fractional step.
    const merged = new Float32Array(this._carry.length + ch.length);
    merged.set(this._carry, 0);
    merged.set(ch, this._carry.length);

    let pos = this._pos;
    while (pos + 1 < merged.length) {
      const i = Math.floor(pos);
      const f = pos - i;
      this._buf[this._n] = merged[i] * (1 - f) + merged[i + 1] * f;
      this._n += 1;
      if (this._n === this._buf.length) {
        // Copy out — a transferable would detach our reusable buffer.
        this.port.postMessage(this._buf.slice(0));
        this._n = 0;
      }
      pos += this._ratio;
    }
    const keep = Math.floor(pos);
    this._carry = merged.slice(keep);
    this._pos = pos - keep;
    return true;
  }
}

registerProcessor('openwop-pcm-capture', PcmCaptureProcessor);
