/**
 * §7.2 / CV-14+CV-16 — rail geometry: clamps, collapse toggling, per-type
 * persistence, and the separator's keyboard resize path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react';
import { useRailLayout, clampRail } from '../useRailLayout.js';

// Expectations are LITERALS (the pre-CV-14 grid: 14rem / 18rem @16px; clamps
// l 176–384, r 224–448), never the product's own constants — a changed clamp
// must go red here, not move the expectation with it.
const L_DEFAULT = { w: 224, collapsed: false };
const R_DEFAULT = { w: 288, collapsed: false };
import { RailSeparator } from '../RailSeparator.js';

beforeEach(() => localStorage.clear());

describe('useRailLayout', () => {
  it('starts at the pre-CV-14 defaults and clamps resizes', () => {
    const { result } = renderHook(() => useRailLayout('canvas.test'));
    expect(result.current.l).toEqual(L_DEFAULT);
    expect(result.current.r).toEqual(R_DEFAULT);
    act(() => result.current.resize('l', 10_000));
    expect(result.current.l.w).toBe(384);
    act(() => result.current.resize('r', 1));
    expect(result.current.r.w).toBe(224);
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
    try {
      const a = renderHook(() => useRailLayout('canvas.a'));
      act(() => { a.result.current.resize('l', 300); a.result.current.toggle('r'); });
      act(() => { vi.advanceTimersByTime(200); });
    } finally {
      vi.useRealTimers();
    }
    const b = renderHook(() => useRailLayout('canvas.a'));
    expect(b.result.current.l.w).toBe(300);
    expect(b.result.current.r.collapsed).toBe(true);
    // A DIFFERENT type is untouched.
    const c = renderHook(() => useRailLayout('canvas.b'));
    expect(c.result.current.l).toEqual(L_DEFAULT);
    // Corrupt storage → defaults, no throw.
    localStorage.setItem('owp.cv.rails:canvas.z', '{nope');
    const z = renderHook(() => useRailLayout('canvas.z'));
    expect(z.result.current.r).toEqual(R_DEFAULT);
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
    expect(sep.getAttribute('aria-valuemin')).toBe('176');
    expect(sep.getAttribute('aria-valuemax')).toBe('384');
    expect(sep.getAttribute('tabindex')).toBe('0'); // focusable — the keyboard path exists
    fireEvent.keyDown(sep, { key: 'ArrowRight' }); // left rail grows rightward
    expect(w).toBe(240);
    fireEvent.keyDown(sep, { key: 'ArrowLeft' }); // …and shrinks leftward (value prop is still 224)
    expect(w).toBe(208);
    fireEvent.keyDown(sep, { key: 'End' });
    expect(w).toBe(384);
    fireEvent.keyDown(sep, { key: 'Home' });
    expect(w).toBe(176);
  });

  it('the right rail grows leftward', () => {
    let w = 288;
    render(<RailSeparator side="r" value={w} label="Resize the properties rail" onResize={(n) => { w = n; }} />);
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' });
    expect(w).toBe(304);
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' }); // shrinks rightward
    expect(w).toBe(272);
  });
});

describe('clampRail', () => {
  it('clamps per side', () => {
    expect(clampRail('l', 0)).toBe(176);
    expect(clampRail('r', 9999)).toBe(448);
  });
});
