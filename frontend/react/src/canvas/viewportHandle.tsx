/**
 * ViewportHandleContext — the chassis's line of sight to WHICHEVER surface
 * owns the center viewport (DESIGN.md §7.3 / architect ruling P1-2). Exactly
 * one center surface exists per editor (the center-panel precedence), but it
 * may be the chassis's own Renderer wrap, a type's `InteractivePreview`
 * (drawings/CAD own their `ViewportSurface`), or `GraphSurface`. Each
 * publishes its zoom handle on mount and clears it on unmount; the chassis
 * registers the §7.3 view shortcuts (⇧1 fit / ⇧2 selection / ⇧0 100%)
 * against the current handle — keeping the ONE window-keydown owner
 * (ADR 0333) instead of a second listener in the cluster.
 */
import { createContext, useContext, useEffect } from 'react';

export interface ViewportZoomHandle {
  /** Zoom to fit — semantics stay consumer-owned (the graph fits at its
   *  ≤1:1 clamp; artboards reset to the fitted 1:1 layout). */
  fit: () => void;
  /** Absolute zoom about the viewport center (100 = fitted 1:1). */
  zoomToPercent: (pct: number) => void;
  /** Zoom to the current selection, when the surface supports it AND
   *  something is selected (checked at dispatch time). */
  zoomToSelection?: (() => void) | undefined;
}

export interface ViewportHandleSlot {
  publish: (h: ViewportZoomHandle | null) => void;
  /** Named `get` (not `current`) — a `.current` member on a context value
   *  trips the react-hooks ref heuristic in effect cleanups. */
  get: () => ViewportZoomHandle | null;
}

/** Default slot is inert — a surface mounted outside an editor page (chat
 *  cards, public viewers) publishes into the void, harmlessly. */
const INERT: ViewportHandleSlot = { publish: () => undefined, get: () => null };

export const ViewportHandleContext = createContext<ViewportHandleSlot>(INERT);

/** Publish `handle` into the enclosing editor's slot for this mount's
 *  lifetime. Last mount wins (only one center surface renders at a time);
 *  unmount clears only its own handle. */
export function usePublishViewportHandle(handle: ViewportZoomHandle | null): void {
  const slot = useContext(ViewportHandleContext);
  useEffect(() => {
    if (!handle) return undefined;
    slot.publish(handle);
    return () => {
      if (slot.get() === handle) slot.publish(null);
    };
  }, [slot, handle]);
}
