/**
 * ZoomCluster — the ONE §7.3 zoom chrome cluster (DESIGN.md §7.3 / CV-3):
 * `− · %▾ · +` floating bottom-right of every spatial surface. The percent
 * readout is a `ui/Menu` trigger carrying the presets (50/100/200%), Zoom to
 * fit (⇧1), Zoom to selection (⇧2, when the surface supports it), and 100%
 * (⇧0). Consumed by `ViewportSurface` and `GraphSurface`; the builder's
 * xyflow `<Controls>` converges here in the Phase-3 builder-convergence pass.
 *
 * Pure chrome: all math lives in `useCanvasViewport` (the architect P1-1
 * ruling) — this component holds no viewport state and registers no window
 * listeners (shortcuts stay with the chassis registry, ruling P1-2).
 */
import { Button } from '../ui/Button.js';
import { useTranslation } from 'react-i18next';
import { Menu, type MenuEntry } from '../ui/Menu.js';
import { comboLabel } from './shortcuts.js';
import { ZoomInIcon, ZoomOutIcon } from '../ui/icons/index.js';

export interface ZoomClusterProps {
  percent: number;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomToPercent: (pct: number) => void;
  /** Consumer-owned fit semantics (artboard reset vs the graph's ≤1:1 fit). */
  onFit: () => void;
  /** Present only when the surface supports zoom-to-selection. */
  onZoomToSelection?: (() => void) | undefined;
  /** Whether a selection currently exists (dims the menu entry). */
  hasSelection?: boolean | undefined;
  zoomInDisabled?: boolean | undefined;
  zoomOutDisabled?: boolean | undefined;
}

const PRESETS = [50, 100, 200];
// Platform-aware shortcut hints (grade-pass MED-4) — the same comboLabel the
// cheatsheet + ⌘K palette print, so "⇧1" (mac) vs "Shift+1" never diverge.
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform);

export function ZoomCluster(p: ZoomClusterProps): JSX.Element {
  const { t } = useTranslation('canvas');
  const entries: MenuEntry[] = [
    ...PRESETS.map((pct) => ({
      id: `pct-${pct}`,
      // Numerals need no catalog entry; the ⇧0 hint rides the 100% row.
      label: pct === 100 ? `100% ${comboLabel('shift+0', IS_MAC)}` : `${pct}%`,
      onSelect: () => p.zoomToPercent(pct),
    })),
    { id: 'sep', separator: true as const },
    { id: 'fit', label: `${t('zoomToFit')} ${comboLabel('shift+1', IS_MAC)}`, onSelect: p.onFit },
    ...(p.onZoomToSelection
      ? [{
          id: 'sel',
          label: `${t('zoomToSelection')} ${comboLabel('shift+2', IS_MAC)}`,
          onSelect: p.onZoomToSelection,
          disabled: !p.hasSelection,
        }]
      : []),
  ];
  return (
    <div className="cv-viewport__chrome" role="group" aria-label={t('zoomControls')}>
      <Button variant="quiet" size="sm" onClick={p.zoomOut} disabled={p.zoomOutDisabled} aria-label={t('zoomOut')} title={t('zoomOut')}>
        <ZoomOutIcon />
      </Button>
      <Menu
        label={t('zoomMenu', { pct: p.percent })}
        triggerContent={<>{p.percent}%</>}
        triggerClassName="btn-ghost btn-sm cv-viewport__pct"
        triggerTitle={t('zoomMenu', { pct: p.percent })}
        items={entries}
        dropUp
      />
      <Button variant="quiet" size="sm" onClick={p.zoomIn} disabled={p.zoomInDisabled} aria-label={t('zoomIn')} title={t('zoomIn')}>
        <ZoomInIcon />
      </Button>
    </div>
  );
}
