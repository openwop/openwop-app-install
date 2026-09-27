/**
 * useRailLayout — §7.2 / CV-14+CV-16: the canvas editor's rail geometry.
 * Both rails are fixed-position, RESIZABLE (drag the inner edge / arrow keys
 * on the separator) and INDEPENDENTLY COLLAPSIBLE (the Figma UI3 GA lesson —
 * users asked for per-panel collapse back); both collapsed = focus mode
 * (`[` / `]` in the shortcut registry, §7.5). Persisted per canvas type
 * (`localStorage`, the useViewMode precedent) so a slides author's layout
 * never leaks into the CAD editor.
 *
 * Geometry reaches CSS as custom properties on `.cv-editor__cols`
 * (`--cv-rail-l` / `--cv-rail-r`) — the sanctioned dynamic-inline path
 * (DESIGN.md §10): the grid template stays in the stylesheet.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type RailSide = 'l' | 'r';
export interface RailState { w: number; collapsed: boolean }
export interface RailLayout {
  l: RailState;
  r: RailState;
  /** Set an explicit width (px, clamped) — the drag/arrow-resize path. */
  resize: (side: RailSide, w: number) => void;
  /** Toggle collapse — the chevron buttons and the `[` / `]` shortcuts. */
  toggle: (side: RailSide) => void;
  /** True when BOTH rails are collapsed (focus mode). */
  focus: boolean;
}

// Clamps (px). The defaults mirror the pre-CV-14 grid (14rem / 18rem @16px).
export const RAIL_DEFAULTS: Record<RailSide, RailState> = {
  l: { w: 224, collapsed: false },
  r: { w: 288, collapsed: false },
};
export const RAIL_CLAMPS: Record<RailSide, { min: number; max: number }> = {
  l: { min: 176, max: 384 },
  r: { min: 224, max: 448 },
};
/** The collapsed strip width (px) — room for the expand button only. */
export const RAIL_COLLAPSED_W = 36;

export const clampRail = (side: RailSide, w: number): number => {
  const { min, max } = RAIL_CLAMPS[side];
  return Math.round(Math.max(min, Math.min(max, w)));
};

interface Persisted { l?: Partial<RailState>; r?: Partial<RailState> }

const storageKey = (typeId: string): string => `owp.cv.rails:${typeId}`;

function load(typeId: string, defaults: Record<RailSide, RailState>): { l: RailState; r: RailState } {
  const out = { l: { ...defaults.l }, r: { ...defaults.r } };
  try {
    const raw = localStorage.getItem(storageKey(typeId));
    if (!raw) return out;
    const p: unknown = JSON.parse(raw);
    if (typeof p !== 'object' || p === null) return out;
    for (const side of ['l', 'r'] as const) {
      const s = (p as Persisted)[side];
      if (typeof s?.w === 'number' && Number.isFinite(s.w)) out[side].w = clampRail(side, s.w);
      if (typeof s?.collapsed === 'boolean') out[side].collapsed = s.collapsed;
    }
  } catch { /* corrupt/absent storage falls back to defaults */ }
  return out;
}

export function useRailLayout(typeId: string, defaults?: Partial<Record<RailSide, RailState>>): RailLayout {
  const [rails, setRails] = useState(() => load(typeId, {
    l: defaults?.l ?? RAIL_DEFAULTS.l,
    r: defaults?.r ?? RAIL_DEFAULTS.r,
  }));

  // Grade-pass MED-2 — persistence is a trailing EFFECT, never a side effect
  // inside the setState updater (impure: double-writes under StrictMode) and
  // never per pointer-move (a drag fires dozens of commits; one debounced
  // write after the gesture settles is enough for a UI preference).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return undefined; }
    const t = setTimeout(() => {
      try { localStorage.setItem(storageKey(typeId), JSON.stringify(rails)); } catch { /* private mode */ }
    }, 150);
    return () => clearTimeout(t);
  }, [rails, typeId]);

  const resize = useCallback((side: RailSide, w: number) => {
    setRails((cur) => ({ ...cur, [side]: { ...cur[side], w: clampRail(side, w), collapsed: false } }));
  }, []);

  const toggle = useCallback((side: RailSide) => {
    setRails((cur) => ({ ...cur, [side]: { ...cur[side], collapsed: !cur[side].collapsed } }));
  }, []);

  return useMemo(() => ({
    l: rails.l,
    r: rails.r,
    resize,
    toggle,
    focus: rails.l.collapsed && rails.r.collapsed,
  }), [rails, resize, toggle]);
}
