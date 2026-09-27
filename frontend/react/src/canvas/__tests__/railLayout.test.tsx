/**
 * §7.2 / CV-14+CV-16 — rail geometry: clamps, collapse toggling, per-type
 * persistence, and the separator's keyboard resize path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react';
import { useRailLayout, clampRail, RAIL_CLAMPS, RAIL_DEFAULTS } from '../useRailLayout.js';
import { RailSeparator } from '../RailSeparator.js';

beforeEach(() => localStorage.clear());

describe('useRailLayout', () => {
  it('starts at the pre-CV-14 defaults and clamps resizes', () => {
    const { result } = renderHook(() => useRailLayout('canvas.test'));
    expect(result.current.l).toEqual(RAIL_DEFAULTS.l);
    act(() => result.current.resize('l', 10_000));
    expect(result.current.l.w).toBe(RAIL_CLAMPS.l.max);
    act(() => result.current.resize('r', 1));
    expect(result.current.r.w).toBe(RAIL_CLAMPS.r.min);
  });

  it('toggle collapses independently; both collapsed = focus mode', () => {
    const { result } = renderHook(() => useRailLayout('canvas.test'));
    act(() => result.current.toggle('l'));
    expect(result.current.l.collapsed).toBe(true);
    expect(result.current.r.collapsed).toBe(false);
    expect(result.current.focus).toBe(false);
    act(() => result.current.toggle('r'));
    expect(result.current.focus).toBe(true);
  });

  it('persists per canvas type and re-hydrates (corrupt storage falls back)', () => {
    // Persistence is a trailing debounced EFFECT (grade-pass MED-2) — flush it.
    vi.useFakeTimers();
    const a = renderHook(() => useRailLayout('canvas.a'));
    act(() => { a.result.current.resize('l', 300); a.result.current.toggle('r'); });
    act(() => { vi.advanceTimersByTime(200); });
    vi.useRealTimers();
    const b = renderHook(() => useRailLayout('canvas.a'));
    expect(b.result.current.l.w).toBe(300);
    expect(b.result.current.r.collapsed).toBe(true);
    // A DIFFERENT type is untouched.
    const c = renderHook(() => useRailLayout('canvas.b'));
    expect(c.result.current.l).toEqual(RAIL_DEFAULTS.l);
    // Corrupt storage → defaults, no throw.
    localStorage.setItem('owp.cv.rails:canvas.z', '{nope');
    const z = renderHook(() => useRailLayout('canvas.z'));
    expect(z.result.current.r).toEqual(RAIL_DEFAULTS.r);
  });

  it('resize un-collapses the rail (a resized rail is visible)', () => {
    const { result } = renderHook(() => useRailLayout('canvas.test'));
    act(() => result.current.toggle('l'));
    act(() => result.current.resize('l', 250));
    expect(result.current.l).toEqual({ w: 250, collapsed: false });
  });
});

describe('RailSeparator', () => {
  it('is a labeled vertical window-splitter with keyboard resize (grow/shrink per side)', () => {
    let w = 224;
    render(<RailSeparator side="l" value={w} label="Resize the left rail" onResize={(n) => { w = n; }} />);
    const sep = screen.getByRole('separator', { name: 'Resize the left rail' });
    expect(sep.getAttribute('aria-orientation')).toBe('vertical');
    expect(sep.getAttribute('aria-valuenow')).toBe('224');
    fireEvent.keyDown(sep, { key: 'ArrowRight' }); // left rail grows rightward
    expect(w).toBe(240);
    fireEvent.keyDown(sep, { key: 'End' });
    expect(w).toBe(RAIL_CLAMPS.l.max);
    fireEvent.keyDown(sep, { key: 'Home' });
    expect(w).toBe(RAIL_CLAMPS.l.min);
  });

  it('the right rail grows leftward', () => {
    let w = 288;
    render(<RailSeparator side="r" value={w} label="Resize the properties rail" onResize={(n) => { w = n; }} />);
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' });
    expect(w).toBe(304);
  });
});

describe('clampRail', () => {
  it('clamps per side', () => {
    expect(clampRail('l', 0)).toBe(RAIL_CLAMPS.l.min);
    expect(clampRail('r', 9999)).toBe(RAIL_CLAMPS.r.max);
  });
});
