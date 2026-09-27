/**
 * Sales Maps — the shared MapView (ADR 0282 P1/P3/P5).
 *
 * A CSP-safe bundled-GeoJSON SVG choropleth (NO external tile CDN, NO map lib):
 * regions are projected via the equirectangular `projection` and coloured by a
 * value (e.g. territory attainment) as accent-OPACITY (a token-only sequential
 * scale — no color literals); dealer/outlet points project onto the same
 * transform as pins.
 *
 * P5 interactivity: viewBox zoom (pinch/⌘-wheel anchored to the cursor,
 * double-click, +/−/reset buttons — pure math in `mapViewport.ts`), drag-pan when
 * zoomed, a designed hover tooltip (regions: name + value; pins: name, kind,
 * address), and clickable pins that select their row in the locations table —
 * the same click→table tie regions have (P3).
 *
 * ACCESSIBILITY IS A GATE (ADR 0282 §9 / ux-review): an SVG map is not
 * keyboard/screen-reader navigable, so the SAME data is ALWAYS rendered as a
 * <table> below the map (the accessible representation). The SVG carries
 * role="img" + an aria-label summary; the zoom buttons are real, labelled
 * buttons; the tooltip is pointer-only chrome (aria-hidden). Both views are
 * driven from one `regions`/`points` model.
 *
 * @see docs/adr/0282-dynamic-sales-maps.md
 */
import { Button } from '../../ui/Button.js';
import { useEffect, useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { StateCard } from '../../ui/StateCard.js';
import { ZoomInIcon, ZoomOutIcon, RotateCwIcon } from '../../ui/icons/index.js';
import { formatNumber } from '../../i18n/format.js';
import { project, geometryToPath, type GeoGeometry } from './projection.js';
import { HOME_VIEWPORT, MIN_SCALE, MAX_SCALE, viewBoxOf, zoomAtPoint, panByPixels, type MapViewport } from './mapViewport.js';

const coord = (n: number): string => formatNumber(n, { maximumFractionDigits: 2 });

export interface MapRegion { id: string; name: string; geometry: GeoGeometry; value?: number }
export interface MapPoint { id: string; lat: number; lng: number; label: string; kind?: 'dealer' | 'outlet'; sublabel?: string }

interface Tooltip { x: number; y: number; title: string; lines: string[] }

const DRAG_THRESHOLD_PX = 4; // beyond this a pointer gesture is a pan, not a click

export function MapView({ regions, points = [], valueLabel, formatValue = (n) => String(n), caption, emptyMessage, onPointClick, comparable = true }: {
  regions: MapRegion[];
  points?: MapPoint[];
  valueLabel: string;
  formatValue?: (n: number) => string;
  caption: string;
  emptyMessage?: string;
  /** Overrides the default pin-click (select the locations-table row). The
   *  consuming page owns any navigation — MapView stays feature-agnostic
   *  (ADR 0001; it is shared beyond sales-maps). */
  onPointClick?: (pointId: string) => void;
  /** R2 SM2-F3 — are the region values in ONE unit? When they are not (a cross-currency
   *  total), the choropleth must not rank them: it renders presence at a uniform
   *  opacity instead of a magnitude ramp, because shading unlike units is a comparison
   *  the data cannot support. Defaults true — a caller with comparable values says
   *  nothing and gets the ramp. */
  comparable?: boolean;
}): JSX.Element {
  const { t } = useTranslation('sales-maps');
  const [showTable, setShowTable] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null); // hovered or selected region (P3)
  const [activePointId, setActivePointId] = useState<string | null>(null); // selected pin (P5)
  const [viewport, setViewport] = useState<MapViewport>(HOME_VIEWPORT);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const [panning, setPanning] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Pan gesture bookkeeping (refs — no re-render per pointermove beyond the viewport set)
  const drag = useRef<{ pointerId: number; lastX: number; lastY: number; moved: number } | null>(null);

  const maxValue = useMemo(() => regions.reduce((m, r) => (r.value !== undefined && r.value > m ? r.value : m), 0), [regions]);
  const paths = useMemo(() => regions.map((r) => ({ r, d: geometryToPath(r.geometry) })), [regions]);
  // Table order: coloured regions first (value desc), then the rest by name — with
  // a whole-world region set most rows are unmatched, so matches must lead.
  const tableRegions = useMemo(() => [...regions].sort((a, b) =>
    (b.value ?? -1) - (a.value ?? -1) || a.name.localeCompare(b.name)), [regions]);
  const select = (id: string): void => { setActiveId(id); setActivePointId(null); setShowTable(true); }; // click ties the map to the table row (P3)
  // Pin click: the page's handler when provided (e.g. sales-map → outlet detail
  // deep-link), else select the locations-table row (P5 default).
  const selectPoint = onPointClick ?? ((id: string): void => { setActivePointId(id); setActiveId(null); setShowTable(true); });
  const hasOutlets = points.some((p) => p.kind === 'outlet');

  // Screen-fraction (0..1) of a mouse position across the rendered map.
  const fractionOf = (clientX: number, clientY: number): [number, number] => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return [0.5, 0.5];
    return [(clientX - rect.left) / rect.width, (clientY - rect.top) / rect.height];
  };

  // Wheel zoom (pinch arrives as ctrlKey wheel; ⌘/ctrl+scroll for mice). Plain
  // scroll is left to the page — a full-width map must not hijack scrolling.
  // React's onWheel can't preventDefault (passive), so bind natively.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const [fx, fy] = fractionOf(e.clientX, e.clientY);
      const factor = Math.exp(-e.deltaY * 0.0025);
      setViewport((v) => zoomAtPoint(v, fx, fy, v.scale * factor));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onDoubleClick = (e: ReactMouseEvent<SVGSVGElement>): void => {
    const [fx, fy] = fractionOf(e.clientX, e.clientY);
    setViewport((v) => zoomAtPoint(v, fx, fy, v.scale * 2));
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (viewport.scale <= MIN_SCALE || e.button !== 0) return;
    drag.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY, moved: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
    setPanning(true);
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.lastX;
    const dy = e.clientY - d.lastY;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    d.moved += Math.abs(dx) + Math.abs(dy);
    const width = svgRef.current?.getBoundingClientRect().width ?? 0;
    if (width > 0) setViewport((v) => panByPixels(v, dx, dy, width));
  };
  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (drag.current?.pointerId === e.pointerId) setPanning(false);
    // Keep drag.current until the click event fires (click follows pointerup) —
    // onClickCapture reads `moved` to tell a pan from a click, then clears it.
  };
  const onClickCapture = (e: ReactMouseEvent<SVGSVGElement>): void => {
    const wasPan = (drag.current?.moved ?? 0) > DRAG_THRESHOLD_PX;
    drag.current = null;
    if (wasPan) { e.stopPropagation(); }
  };

  const moveTooltip = (e: ReactMouseEvent, title: string, lines: string[]): void => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top, title, lines });
  };

  if (regions.length === 0 && points.length === 0) {
    return <StateCard title={t('nothingTitle')} body={emptyMessage ?? t('nothingBody')} />;
  }

  // Sequential scale as OPACITY (token-only): 0.12 (floor, so a coloured region is
  // always faintly visible) → 0.9 at the max value. Uncoloured regions get a neutral fill.
  // R2 SM2-F9 — `maxValue <= 0` sent every MATCHED region to opacity 0 while unmatched
  // ones kept 0.6, so on the common first-run state (a territory model before its first
  // closed-won deal) the countries WITH data vanished and the rest of the world looked
  // like the data. The 0.12 floor exists precisely so a coloured region is always
  // visible; the guard meant to protect the division was bypassing it.
  //
  // R2 SM2-F3 — and when the figures are not in one currency, the RAMP is a
  // cross-currency comparison: a JPY territory's total is ~150× a USD one for the same
  // business, so Japan is always darkest. Suppressing the label while keeping the ramp
  // is the worse state — the reader loses the cue that would make them distrust the
  // shading. `comparable={false}` renders presence, not magnitude.
  const fillOpacity = (v: number | undefined): number => {
    if (v === undefined) return 0;
    // Review M5 — the comment used to cite the 0.12 floor while returning 0.45. Two
    // DISTINCT states deserve two values: an all-zero map is a ranked map whose values
    // are all zero (the floor, so the region is visible), and an unrankable one is not a
    // ranking at all (a mid weight that reads as "present", not as "middling").
    if (!comparable) return 0.45; // presence — deliberately not on the ramp's scale
    if (maxValue <= 0) return 0.12; // the floor the ramp already documents
    return 0.12 + 0.78 * (v / maxValue);
  };

  // R2 SM2-F16 — `regions.length` is always 176 (the caller passes the whole world), so
  // a screen-reader user was told the map has 176 regions while a sighted user read
  // "3 of 176 countries matched". Describe what is actually shaded.
  const shadedCount = regions.filter((r) => r.value !== undefined).length;
  // Review I1/I2 — `_one/_other` (the count is routinely small now) and BOTH numbers, so
  // the spoken summary matches the sighted "N of 176 countries matched" line.
  const ariaSummary = t('ariaSummary', { regions: shadedCount, total: regions.length, points: points.length });
  // Review M2 — when the map is drawing PRESENCE, a "Lower → Higher" gradient is the
  // strongest false cue on the screen: it tells the reader darker means more, on a map
  // where every shaded region is identical.
  const ranked = comparable && maxValue > 0;
  const zoomed = viewport.scale > MIN_SCALE;
  const pinScale = viewport.scale; // pins counter-scale so they stay dot-sized on screen
  // Flip the tooltip to the left of the cursor near the right edge so it stays on-map.
  const tooltipFlip = tooltip && wrapRef.current ? tooltip.x > wrapRef.current.clientWidth * 0.6 : false;

  return (
    <div className="u-flex-col u-gap-2">
      <div ref={wrapRef} className="surface-card salesmap-card">
        <svg
          ref={svgRef}
          viewBox={viewBoxOf(viewport)}
          role="img"
          aria-label={ariaSummary}
          style={{ display: 'block', width: '100%', height: 'auto', background: 'var(--paper-2)', cursor: zoomed ? (panning ? 'grabbing' : 'grab') : 'default', touchAction: zoomed ? 'none' : 'auto' }}
          onDoubleClick={onDoubleClick}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onClickCapture={onClickCapture}
          onMouseLeave={() => setTooltip(null)}
        >
          {paths.map(({ r, d }) => (
            <path
              key={r.id}
              d={d}
              fill={r.value !== undefined ? 'var(--clay-text)' : 'var(--paper)'}
              fillOpacity={r.value !== undefined ? fillOpacity(r.value) : 0.6}
              stroke={activeId === r.id ? 'var(--clay-text)' : 'var(--rule)'}
              strokeWidth={activeId === r.id ? 2.5 : 1}
              vectorEffect="non-scaling-stroke"
              className="u-cursor-pointer"
              onMouseEnter={() => setActiveId(r.id)}
              onMouseMove={(e) => moveTooltip(e, r.name, r.value !== undefined ? [`${valueLabel}: ${formatValue(r.value)}`] : [])}
              onMouseLeave={() => { setActiveId((cur) => (cur === r.id ? null : cur)); setTooltip(null); }}
              onClick={() => select(r.id)}
            />
          ))}
          {points.map((p) => {
            const [x, y] = project(p.lng, p.lat);
            const active = activePointId === p.id;
            const kindLabel = t(p.kind === 'outlet' ? 'legendOutlet' : p.kind === 'dealer' ? 'legendDealer' : 'pointKindPoint');
            return (
              <circle
                key={p.id}
                cx={x}
                cy={y}
                r={(active ? 6.5 : 5) / pinScale}
                fill={p.kind === 'outlet' ? 'var(--color-success)' : 'var(--clay-text)'}
                stroke={active ? 'var(--clay-text)' : 'var(--paper)'}
                strokeWidth={(active ? 2 : 1.5) / pinScale}
                className="u-cursor-pointer"
                onMouseMove={(e) => moveTooltip(e, p.label, [kindLabel, ...(p.sublabel ? [p.sublabel] : [])])}
                onMouseLeave={() => setTooltip(null)}
                onClick={() => selectPoint(p.id)}
              />
            );
          })}
        </svg>

        {/* Zoom controls — real buttons (the keyboard path to zoom; the SVG gestures
            are pointer-only). Overlaid so they never shift the layout. */}
        <div className="u-flex-col salesmap-controls">
          <Button variant="quiet" size="sm" aria-label={t('zoomIn')} title={t('zoomIn')} disabled={viewport.scale >= MAX_SCALE} onClick={() => setViewport((v) => zoomAtPoint(v, 0.5, 0.5, v.scale * 2))}><ZoomInIcon /></Button>
          <Button variant="quiet" size="sm" aria-label={t('zoomOut')} title={t('zoomOut')} disabled={!zoomed} onClick={() => setViewport((v) => zoomAtPoint(v, 0.5, 0.5, v.scale / 2))}><ZoomOutIcon /></Button>
          <Button variant="quiet" size="sm" aria-label={t('zoomReset')} title={t('zoomReset')} disabled={!zoomed} onClick={() => setViewport(HOME_VIEWPORT)}><RotateCwIcon /></Button>
        </div>

        {/* Designed hover tooltip — replaces the native SVG <title> (slow, unstyled,
            pointer-only either way). Chrome, not content: the table carries the data. */}
        {tooltip ? (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: tooltip.x,
              top: tooltip.y,
              transform: tooltipFlip ? 'translate(calc(-100% - 0.75rem), 0.75rem)' : 'translate(0.75rem, 0.75rem)',
              pointerEvents: 'none',
              background: 'var(--paper)',
              border: '1px solid var(--rule)',
              borderRadius: '0.5rem',
              padding: '0.375rem 0.625rem',
              maxWidth: '18rem',
              zIndex: 1,
            }}
          >
            <div className="u-text-sm u-fw-600">{tooltip.title}</div>
            {tooltip.lines.map((line, i) => <div key={i} className="u-text-sm u-text-muted">{line}</div>)}
          </div>
        ) : null}
      </div>

      {/* Legend — the choropleth scale + pin kinds (MAP-UX-2). Not color-only: each
          swatch is labelled, and the table below carries the same data. */}
      <div className="u-flex u-gap-3 u-items-center u-text-sm u-text-muted" role="group" aria-label={t('legendLabel')}>
        {ranked ? (
          <span className="u-flex u-gap-1 u-items-center">
            {t('legendLow')}
            <span aria-hidden="true" className="salesmap-legend-ramp" />
            {t('legendHigh')}
          </span>
        ) : (
          <span className="u-flex u-gap-1 u-items-center">
            <span aria-hidden="true" className="salesmap-legend-presence" />
            {t('legendPresence')}
          </span>
        )}
        {points.length > 0 ? (
          <span className="u-flex u-gap-2 u-items-center">
            {hasOutlets ? <span className="u-flex u-gap-1 u-items-center"><span aria-hidden="true" className="salesmap-legend-dot salesmap-legend-dot--outlet" />{t('legendOutlet')}</span> : null}
            <span className="u-flex u-gap-1 u-items-center"><span aria-hidden="true" className="salesmap-legend-dot" />{t('legendDealer')}</span>
          </span>
        ) : null}
        <span>{t('zoomHint')}</span>
      </div>

      {/* Mandatory a11y data-table fallback — the accessible representation of the map. */}
      <div>
        <Button variant="primary" size="sm" aria-expanded={showTable} onClick={() => setShowTable((s) => !s)}>
          {showTable ? t('hideTable') : t('showTable')}
        </Button>
      </div>
      {showTable ? (
        <div className="u-overflow-x-auto">
          <table className="data-table">
            <caption className="u-text-sm u-text-muted u-text-left">{caption}</caption>
            <thead>
              <tr><th scope="col">{t('colRegion')}</th><th scope="col" className="u-text-right">{valueLabel}</th></tr>
            </thead>
            <tbody>
              {tableRegions.map((r) => (
                <tr key={r.id} aria-current={activeId === r.id ? 'true' : undefined} style={activeId === r.id ? { background: 'var(--paper-2)' } : undefined}>
                  <td>{r.name}</td><td className="u-text-right tabular-nums">{r.value !== undefined ? formatValue(r.value) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {points.length > 0 ? (
            <table className="data-table u-mt-2">
              <caption className="u-text-sm u-text-muted u-text-left">{t('plottedCaption')}</caption>
              <thead><tr><th scope="col">{t('colLocation')}</th><th scope="col">{t('colType')}</th><th scope="col" className="u-text-right">{t('colLatLng')}</th></tr></thead>
              <tbody>
                {points.map((p) => (
                  <tr key={p.id} aria-current={activePointId === p.id ? 'true' : undefined} style={activePointId === p.id ? { background: 'var(--paper-2)' } : undefined}>
                    {/* R2 SM2-F11 — the pin's real payload is its click handler (the
                        page deep-links to the outlet). The SVG circles carry no tabIndex
                        and no key handler, and this table was read-only — so that
                        destination was unreachable without a mouse, on a feature whose
                        own ADR calls a11y the gate. The handler already exists; give the
                        keyboard a way to invoke it. */}
                    <td>
                      <Button variant="link" onClick={() => selectPoint(p.id)}>{p.label}</Button>
                    </td><td>{p.kind ? t(p.kind === 'outlet' ? 'legendOutlet' : 'legendDealer') : t('pointKindPoint')}</td><td className="u-text-right tabular-nums">{coord(p.lat)}, {coord(p.lng)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
