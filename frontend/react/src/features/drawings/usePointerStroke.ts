/**
 * Pointer→spine capture for ink tools (ADR 0333 Phase 3, research doc D2).
 * The verified stylus pipeline: coalesced events for precision (every sample
 * the OS batched between frames), real pressure from pens, velocity-simulated
 * pressure for mice/touch (`simulatePressure`), pointer capture for the
 * gesture's lifetime. Streamline smoothing applies LIVE as points arrive
 * (the perfect-freehand `streamline` idea). Predicted events are consumed by
 * the live overlay only — they never enter the committed spine.
 *
 * jsdom note: getCoalescedEvents is guarded (absent there); the geometry the
 * hook feeds is proven by the pure shapeGeometry/strokePath suites.
 */
import { useCallback, useRef, useState } from 'react';
import type * as React from 'react';
import { streamlinePoint, type Pt } from './shapeGeometry.js';

const STREAMLINE = 0.35;

export interface LiveStroke {
  points: Pt[];
  pressures: number[];
  /** True when NO real pressure track exists (mouse/touch). */
  simulatePressure: boolean;
  pointerType: string;
}

export interface PointerStrokeApi {
  /** The in-flight stroke (render it on a transient overlay), or null. */
  live: LiveStroke | null;
  /** True once a pen pointer has been seen this session — fingers then
   *  navigate instead of inking (the Procreate convention). */
  penSeen: boolean;
  begin: (e: React.PointerEvent, toCanvas: (clientX: number, clientY: number) => Pt) => void;
  /** Extend with every coalesced sample of this move. */
  extend: (e: React.PointerEvent, toCanvas: (clientX: number, clientY: number) => Pt) => void;
  /** Finish and return the completed spine (null if it never began). */
  finish: () => LiveStroke | null;
  cancel: () => void;
}

export function usePointerStroke(): PointerStrokeApi {
  const [live, setLive] = useState<LiveStroke | null>(null);
  const liveRef = useRef<LiveStroke | null>(null);
  const penSeenRef = useRef(false);
  const [penSeen, setPenSeen] = useState(false);

  const begin = useCallback((e: React.PointerEvent, toCanvas: (x: number, y: number) => Pt) => {
    if (e.pointerType === 'pen' && !penSeenRef.current) { penSeenRef.current = true; setPenSeen(true); }
    const isPen = e.pointerType === 'pen';
    const p = toCanvas(e.clientX, e.clientY);
    const s: LiveStroke = {
      points: [p],
      pressures: isPen ? [Math.max(0, Math.min(1, e.pressure || 0.5))] : [],
      simulatePressure: !isPen,
      pointerType: e.pointerType,
    };
    liveRef.current = s;
    setLive(s);
  }, []);

  const extend = useCallback((e: React.PointerEvent, toCanvas: (x: number, y: number) => Pt) => {
    const s = liveRef.current;
    if (!s) return;
    // Every sample the OS batched since the last delivered event (Apple's
    // drawing-app guidance; PointerEvent.getCoalescedEvents on the web).
    const native = e.nativeEvent;
    const samples: { clientX: number; clientY: number; pressure: number }[] =
      typeof native.getCoalescedEvents === 'function' && native.getCoalescedEvents().length
        ? native.getCoalescedEvents()
        : [{ clientX: e.clientX, clientY: e.clientY, pressure: e.pressure }];
    const isPen = !s.simulatePressure;
    let last = s.points[s.points.length - 1];
    for (const sm of samples) {
      const raw = toCanvas(sm.clientX, sm.clientY);
      const pt = streamlinePoint(last, raw, STREAMLINE);
      // Drop sub-pixel jitter (also keeps the spine under the 600 budget longer).
      if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 0.35) continue;
      s.points.push(pt);
      if (isPen) s.pressures.push(Math.max(0, Math.min(1, sm.pressure || 0.5)));
      last = pt;
    }
    // New object identity so React re-renders the overlay.
    const nextLive = { ...s, points: s.points, pressures: s.pressures };
    liveRef.current = nextLive;
    setLive(nextLive);
  }, []);

  const finish = useCallback((): LiveStroke | null => {
    const s = liveRef.current;
    liveRef.current = null;
    setLive(null);
    return s;
  }, []);

  const cancel = useCallback(() => { liveRef.current = null; setLive(null); }, []);

  return { live, penSeen, begin, extend, finish, cancel };
}
