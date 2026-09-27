/**
 * VoiceWaveform (ADR 0141 RT-8) — the live-conversation voice animation. A scrolling,
 * mirrored bar waveform driven by the REAL audio graph: the caller's mic level paints
 * clay bars, the model's speech paints azure (info) bars, and whichever side is louder
 * wins each time-slot — so the strip visibly "turns toward" whoever is speaking, with
 * peaks snapping up (fast attack) and falling smoothly (slow release).
 *
 * Discipline:
 *  - Colors come from DESIGN tokens resolved at draw-time via getComputedStyle (canvas
 *    can't reference `var()` directly) — re-resolved once a second so theme flips apply.
 *  - `prefers-reduced-motion` ⇒ no scrolling history; a gentle 8 fps level meter.
 *  - Decorative: `aria-hidden` (the composer's live button carries the state for AT;
 *    the placeholder announces live mode).
 *  - Analysis-only: reads AnalyserNode taps; nothing here is in the audible path.
 */
import { useEffect, useRef } from 'react';
import type { VoiceAudioGraph } from './realtimeClient.js';
import { computeRms, perceptualLevel, followEnvelope, pushLevel } from './audioLevels.js';
import { prefersReducedMotion } from '../../ui/motion.js';

const BARS = 28;             // time-slots across the strip
const IDLE_BASE = 0.06;      // resting bar height fraction — a quiet "breathing" baseline

interface Slot { level: number; who: 'in' | 'out' | 'idle' }

export function VoiceWaveform({ graph, tone = 'live' }: { graph: VoiceAudioGraph | null; tone?: 'live' | 'recording' }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const graphRef = useRef<VoiceAudioGraph | null>(graph);
  graphRef.current = graph;
  // `tone` keeps the existing color language: clay = "in a conversation" (live),
  // danger red = "recording a clip" — the mic-side bar token flips accordingly.
  const toneRef = useRef(tone);
  toneRef.current = tone;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g2d = canvas.getContext('2d');
    if (!g2d) return;

    const reduced = prefersReducedMotion();
    const history: number[] = [];
    const whoHistory: Slot['who'][] = [];
    let envIn = 0;
    let envOut = 0;
    let colors = { in: '', out: '', idle: '' };
    let colorsAt = 0;
    let raf = 0;
    let lastDraw = 0;
    const sampleBuf = new Float32Array(1024);

    const readLevel = (a: AnalyserNode | null): number => {
      if (!a) return 0;
      a.getFloatTimeDomainData(sampleBuf);
      return perceptualLevel(computeRms(sampleBuf));
    };

    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw);
      // Reduced motion: a slow meter (8 fps), no scroll. Full motion: scroll ~50 slots/s.
      const interval = reduced ? 125 : 20;
      if (now - lastDraw < interval) return;
      lastDraw = now;

      if (now - colorsAt > 1000) { // theme flips re-resolve within a second
        const cs = getComputedStyle(canvas);
        colors = {
          in: cs.getPropertyValue(toneRef.current === 'recording' ? '--color-danger' : '--clay').trim(),
          out: cs.getPropertyValue('--color-info').trim(),
          idle: cs.getPropertyValue('--rule').trim(),
        };
        colorsAt = now;
      }

      const g = graphRef.current;
      envIn = followEnvelope(envIn, readLevel(g?.input ?? null));
      envOut = followEnvelope(envOut, readLevel(g?.output ?? null));
      const level = Math.max(envIn, envOut, IDLE_BASE);
      const who: Slot['who'] = level <= IDLE_BASE ? 'idle' : envOut > envIn ? 'out' : 'in';
      if (reduced) {
        history.length = 0; whoHistory.length = 0;
        for (let i = 0; i < BARS; i += 1) { history.push(level); whoHistory.push(who); }
      } else {
        pushLevel(history, level, BARS);
        whoHistory.push(who);
        while (whoHistory.length > BARS) whoHistory.shift();
      }

      // ── paint ──
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
      g2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      g2d.clearRect(0, 0, w, h);
      const slot = w / BARS;
      const barW = Math.max(2, slot * 0.55);
      const mid = h / 2;
      for (let i = 0; i < BARS; i += 1) {
        const lv = history[i] ?? IDLE_BASE;
        const whoI = whoHistory[i] ?? 'idle';
        const barH = Math.max(2, lv * (h - 2));
        const x = i * slot + (slot - barW) / 2;
        g2d.fillStyle = whoI === 'idle' ? colors.idle : whoI === 'out' ? colors.out : colors.in;
        // Mirrored rounded bar around the midline.
        g2d.beginPath();
        g2d.roundRect(x, mid - barH / 2, barW, barH, barW / 2);
        g2d.fill();
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={canvasRef} className="chatinput-live-wave" aria-hidden="true" />;
}

export default VoiceWaveform;
