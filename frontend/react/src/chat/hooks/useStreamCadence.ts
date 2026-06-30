/**
 * Maps the REAL arrival cadence of a streaming signal (token / reasoning-event
 * deltas) onto a CSS `animation-duration`. Fast deltas → short duration
 * (energetic pulse); a stalled stream → long duration (calm heartbeat).
 *
 * This is what makes the chat "thinking" indicator and streaming caret
 * data-cadenced rather than a canned loop: their tempo reflects the model's
 * actual output speed, in OpenWOP's terms the rate at which run events fold in.
 *
 * `signal` is any value that grows monotonically while streaming (e.g. the
 * streamed character count). `active` gates tracking; when it goes false the
 * tempo relaxes to the calm idle beat. Returns a CSS time string for use as
 * `--think-dur` / `--msg-caret-dur`.
 */

import { useEffect, useRef, useState } from 'react';

const IDLE_MS = 1600; // calm heartbeat — waiting on the model / stalled stream
const FAST_MS = 520;  // energetic — tokens pouring in
const WINDOW = 6;      // arrivals kept for the rolling-rate estimate
const RELAX_MS = 900;  // no delta for this long → ease back to the calm beat
const BUCKET_MS = 80;  // quantize the tempo so a single token doesn't re-render

export function useStreamCadence(signal: number, active: boolean): string {
  const [durMs, setDurMs] = useState(IDLE_MS);
  const prev = useRef(signal);
  const arrivals = useRef<number[]>([]);
  const relax = useRef<ReturnType<typeof setTimeout> | null>(null);
  const durRef = useRef(IDLE_MS);

  useEffect(() => {
    // Commit only when the QUANTIZED tempo changes. Without this, setDurMs fires
    // on every streamed delta and schedules a second render of the (heavy)
    // message subtree per token — doubling render work in the hottest path.
    const commit = (raw: number): void => {
      const bucketed = Math.round(raw / BUCKET_MS) * BUCKET_MS;
      if (bucketed === durRef.current) return;
      durRef.current = bucketed;
      setDurMs(bucketed);
    };

    if (!active) {
      arrivals.current = [];
      commit(IDLE_MS);
      return;
    }
    if (signal <= prev.current) {
      prev.current = signal;
      return;
    }
    prev.current = signal;

    const now = Date.now();
    const a = arrivals.current;
    a.push(now);
    if (a.length > WINDOW) a.shift();

    if (a.length >= 2) {
      const span = a[a.length - 1]! - a[0]!;
      const perSec = span > 0 ? ((a.length - 1) / span) * 1000 : 0;
      // ~1 delta/s → calm, ~16+ deltas/s → fast (clamped).
      const t = Math.max(0, Math.min(1, (perSec - 1) / 15));
      commit(IDLE_MS - t * (IDLE_MS - FAST_MS));
    }

    // If the stream pauses (the model is deliberating), drift back to calm so
    // the beat honestly reads "thinking" rather than holding a stale fast tempo.
    if (relax.current) clearTimeout(relax.current);
    relax.current = setTimeout(() => commit(IDLE_MS), RELAX_MS);
  }, [signal, active]);

  useEffect(() => () => { if (relax.current) clearTimeout(relax.current); }, []);

  return `${durMs}ms`;
}
