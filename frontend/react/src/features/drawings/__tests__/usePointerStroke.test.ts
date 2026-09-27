/**
 * usePointerStroke (ADR 0333 Phase 3 · grade-pass DRAW-R2) — the stylus capture
 * hook that had no coverage. Drives it with fake pointer events + an identity
 * toCanvas (the real toSvg needs a DOM CTM jsdom lacks): pen pressure vs
 * mouse simulate-pressure, coalesced-sample consumption, jitter drop, the
 * pen-seen latch, and finish/cancel lifecycle.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePointerStroke } from '../usePointerStroke.js';

const id = (x: number, y: number): { x: number; y: number } => ({ x, y });
type Ev = { pointerType: string; clientX: number; clientY: number; pressure?: number; nativeEvent: { getCoalescedEvents?: () => { clientX: number; clientY: number; pressure: number }[] } };
const pen = (x: number, y: number, pressure = 0.5, coalesced?: { clientX: number; clientY: number; pressure: number }[]): Ev =>
  ({ pointerType: 'pen', clientX: x, clientY: y, pressure, nativeEvent: coalesced ? { getCoalescedEvents: () => coalesced } : {} });
const mouse = (x: number, y: number): Ev => ({ pointerType: 'mouse', clientX: x, clientY: y, nativeEvent: {} });
const toCanvas = (x: number, y: number): { x: number; y: number } => id(x, y);

describe('usePointerStroke', () => {
  it('a pen begins a real pressure track and latches penSeen', () => {
    const { result } = renderHook(() => usePointerStroke());
    expect(result.current.penSeen).toBe(false);
    act(() => result.current.begin(pen(10, 10, 0.7) as never, toCanvas));
    expect(result.current.penSeen).toBe(true);
    expect(result.current.live?.simulatePressure).toBe(false);
    expect(result.current.live?.points).toEqual([{ x: 10, y: 10 }]);
    expect(result.current.live?.pressures).toEqual([0.7]);
  });

  it('a mouse simulates pressure (no track)', () => {
    const { result } = renderHook(() => usePointerStroke());
    act(() => result.current.begin(mouse(0, 0) as never, toCanvas));
    expect(result.current.live?.simulatePressure).toBe(true);
    expect(result.current.live?.pressures).toEqual([]);
    expect(result.current.penSeen).toBe(false);
  });

  it('extend consumes every coalesced sample (Apple pipeline)', () => {
    const { result } = renderHook(() => usePointerStroke());
    act(() => result.current.begin(pen(0, 0, 0.5) as never, toCanvas));
    act(() => result.current.extend(pen(20, 0, 0.6, [
      { clientX: 5, clientY: 0, pressure: 0.5 },
      { clientX: 12, clientY: 0, pressure: 0.55 },
      { clientX: 20, clientY: 0, pressure: 0.6 },
    ]) as never, toCanvas));
    // Start + 3 coalesced (streamlined, but all >0.35 apart) = 4 points.
    expect(result.current.live!.points.length).toBe(4);
    expect(result.current.live!.pressures.length).toBe(4);
  });

  it('drops sub-pixel jitter', () => {
    const { result } = renderHook(() => usePointerStroke());
    act(() => result.current.begin(mouse(0, 0) as never, toCanvas));
    act(() => result.current.extend(mouse(0.1, 0.1) as never, toCanvas)); // < 0.35 from start
    expect(result.current.live!.points.length).toBe(1);
  });

  it('finish returns the spine and clears; cancel just clears', () => {
    const { result } = renderHook(() => usePointerStroke());
    act(() => result.current.begin(mouse(0, 0) as never, toCanvas));
    let out: ReturnType<typeof result.current.finish> = null;
    act(() => { out = result.current.finish(); });
    expect(out).not.toBeNull();
    expect(result.current.live).toBeNull();

    act(() => result.current.begin(mouse(1, 1) as never, toCanvas));
    act(() => result.current.cancel());
    expect(result.current.live).toBeNull();
  });

  it('penSeen stays latched across a later mouse stroke', () => {
    const { result } = renderHook(() => usePointerStroke());
    act(() => result.current.begin(pen(0, 0) as never, toCanvas));
    act(() => { result.current.finish(); });
    act(() => result.current.begin(mouse(5, 5) as never, toCanvas));
    expect(result.current.penSeen).toBe(true); // fingers navigate once a pen was seen
  });
});
