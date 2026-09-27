/**
 * ViewportSurface — the pannable/zoomable wrapper for canvas scenes
 * (ADR 0333 Phase 1; Phase 2 adds the controlled mode, zoom-to-selection,
 * keyboard pan, and edge scrolling via the hook). A canvas TYPE composes this
 * around its own scene element (the GraphSurface precedent: the surface owns
 * its viewport internally), so type-owned chrome (snap toggles, selection
 * counts) stays OUTSIDE the transform and never scales with zoom.
 *
 * The stage is a plain in-flow div carrying a CSS transform — consumers'
 * pointer math via `getScreenCTM().inverse()` keeps working unchanged (the
 * matrix reflects the rendered geometry), and SVG content stays vector-crisp
 * at any zoom. At zoom 1 / pan 0 the layout is byte-identical to the
 * un-wrapped scene (`preserveAspectRatio` already letterbox-fits the
 * artboard), so "reset" IS "fit" and the percent readout is relative to the
 * fitted view.
 *
 * Keyboard path (WCAG): the wrapper is focusable — arrow keys pan (Shift = ×4);
 * every zoom action has a single-click chrome button.
 */
import { useTranslation } from 'react-i18next';
import { useMemo, type ReactNode } from 'react';
import { useCanvasViewport, type CanvasViewport } from './useCanvasViewport.js';
import type { ViewBounds, ZoomLimits } from './viewport.js';
import { ZoomCluster } from './ZoomCluster.js';
import { usePublishViewportHandle, type ViewportZoomHandle } from './viewportHandle.js';

export interface ViewportSurfaceProps {
  children: ReactNode;
  /** Zoom clamp override (default [0.25, 8]); uncontrolled mode only. */
  limits?: ZoomLimits;
  /** CONTROLLED mode (ADR 0333 Phase 2): supply the viewport created by your
   *  own `useCanvasViewport` call when the consumer must drive it (fit from
   *  external events, coordinate with drags). Omitted = the surface owns one. */
  vp?: CanvasViewport;
  /** CLIENT-coordinate bounds of the current selection (screen px — e.g. the
   *  selection's corners through `getScreenCTM`), or null when nothing is
   *  selected. Presence adds the zoom-to-selection chrome button. */
  selectionBounds?: () => ViewBounds | null;
}

export function ViewportSurface({ children, limits, vp: controlled, selectionBounds }: ViewportSurfaceProps): JSX.Element {
  const { t } = useTranslation('canvas');
  const own = useCanvasViewport(limits ? { limits } : undefined);
  const vp = controlled ?? own;
  const cls = `cv-viewport${vp.panning ? ' is-panning' : vp.panReady ? ' is-pan-ready' : ''}`;
  const identity = vp.zoom === 1 && vp.pan.x === 0 && vp.pan.y === 0;
  const sel = selectionBounds?.() ?? null;
  // Publish the §7.3 zoom handle so the chassis's ⇧1/⇧2/⇧0 registry
  // shortcuts reach whichever surface owns the center viewport.
  const { reset, zoomToPercent, fitClientBounds } = vp;
  const handle = useMemo<ViewportZoomHandle>(() => ({
    fit: reset,
    zoomToPercent,
    zoomToSelection: selectionBounds
      ? () => { const b = selectionBounds(); if (b) fitClientBounds(b); }
      : undefined,
  }), [reset, zoomToPercent, fitClientBounds, selectionBounds]);
  usePublishViewportHandle(handle);
  return (
    // The wrapper is a focusable, labeled region so keyboard users can pan
    // with arrows (the WCAG alternative to drag-pan); pointer handlers are the
    // pointer duplicates of those keyboard paths — the GraphSurface precedent.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div className={cls} {...vp.wrapperProps} onKeyDown={vp.onKeyDown} tabIndex={0} role="region" aria-label={t('viewportLabel')}>
      <div
        className="cv-viewport__stage"
        // The identity transform is omitted entirely so the default rendering
        // (and any consumer CSS expecting an untransformed subtree) is
        // byte-identical to the pre-viewport layout.
        style={identity ? undefined : { transform: `translate(${vp.pan.x}px, ${vp.pan.y}px) scale(${vp.zoom})` }}
      >
        {children}
      </div>
      <ZoomCluster
        percent={vp.percent}
        zoomIn={vp.zoomIn}
        zoomOut={vp.zoomOut}
        zoomToPercent={vp.zoomToPercent}
        onFit={vp.reset}
        onZoomToSelection={handle.zoomToSelection}
        hasSelection={sel != null}
      />
    </div>
  );
}
