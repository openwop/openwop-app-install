/**
 * Live-run banner shown above the canvas while an overlay is active.
 * Extracted from BuilderShell.tsx (pure extraction — no behavior change).
 */

import { Button } from '../ui/Button.js';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useBuilderStore } from './store/builderStore.js';

const OVERLAY_STATUS_META: Record<string, { labelKey: string; color: string }> = {
  running: { labelKey: 'overlayStatusRunning', color: 'var(--clay-text)' },
  completed: { labelKey: 'overlayStatusCompleted', color: 'var(--color-success-text)' },
  failed: { labelKey: 'overlayStatusFailed', color: 'var(--color-danger-text)' },
  cancelled: { labelKey: 'overlayStatusCancelled', color: 'var(--ink-3)' },
};

// Live-run banner shown above the canvas while an overlay is active.
// Counts painted nodes, links to the full run detail, and dismisses
// the overlay (which also tears down the SSE subscription).
export function RunOverlayBanner({ onDebugFromRun }: { onDebugFromRun?: (runId: string) => void }) {
  const { t } = useTranslation('builder');
  const overlay = useBuilderStore((s) => s.overlay);
  const clearOverlay = useBuilderStore((s) => s.clearOverlay);
  if (!overlay) return null;
  const statuses = Object.values(overlay.nodeStatus);
  const done = statuses.filter((s) => s === 'completed').length;
  const failed = statuses.filter((s) => s === 'failed').length;
  // ADR 0189 P3 — a suspended node means the run is WAITING on the human (a
  // connection prompt on an interactive run, an approval gate, a form). The
  // banner surfaces it as its own state + deep-links the run detail, where
  // open interrupts resolve (RunDetailPage / RenderInterrupt) — instead of a
  // stale "running" dot on a run that's actually parked. Terminal statuses
  // still win (a suspended node on a completed/failed run is history).
  const waiting = overlay.runStatus === 'running' && statuses.includes('suspended');
  const meta = waiting
    ? { labelKey: 'overlayStatusWaiting', color: 'var(--color-warning-text)' }
    : (OVERLAY_STATUS_META[overlay.runStatus] ?? OVERLAY_STATUS_META.running!);
  return (
    <div className="builder-overlay-banner" role="status">
      <span
        className="builder-overlay-dot"
        style={{
          background: meta.color,
          animation: overlay.runStatus === 'running' && !waiting ? 'openwop-pulse 1.2s ease-in-out infinite' : 'none',
        }}
        aria-hidden
      />
      <strong style={{ color: meta.color }}>{t(`builder:${meta.labelKey}`)}</strong>
      <span className="muted">
        {waiting ? t('overlayWaitingHint') : failed > 0 ? t('overlayDoneFailed', { done, failed }) : t('overlayDone', { done })}
      </span>
      <span className="cv-editor__spacer" />
      {/* Grade-ux #4 — a failed test-run's next action is the debug loop; the
          round trip through run detail and back was the only path before. */}
      {overlay.runStatus === 'failed' && onDebugFromRun ? (
        <Button
          variant="secondary" className="u-pad-2x10 u-minh-0"
          onClick={() => onDebugFromRun(overlay.runId)}
          title={t('overlayDebugTitle')}
        >
          {t('overlayDebug')}
        </Button>
      ) : null}
      <Link to={`/runs/${overlay.runId}`} title={waiting ? t('overlayWaitingLinkTitle') : t('runDetailTitle')}>
        {waiting ? t('overlayWaitingLink') : t('runDetailLink')}
      </Link>
      <Button
        variant="secondary" className="u-pad-2x10 u-minh-0"
        onClick={clearOverlay}
        title={t('dismissOverlayTitle')}
      >
        {t('dismiss')}
      </Button>
    </div>
  );
}
