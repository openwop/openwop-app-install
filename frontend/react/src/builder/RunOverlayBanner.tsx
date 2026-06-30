/**
 * Live-run banner shown above the canvas while an overlay is active.
 * Extracted from BuilderShell.tsx (pure extraction — no behavior change).
 */

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
export function RunOverlayBanner() {
  const { t } = useTranslation('builder');
  const overlay = useBuilderStore((s) => s.overlay);
  const clearOverlay = useBuilderStore((s) => s.clearOverlay);
  if (!overlay) return null;
  const meta = OVERLAY_STATUS_META[overlay.runStatus] ?? OVERLAY_STATUS_META.running!;
  const statuses = Object.values(overlay.nodeStatus);
  const done = statuses.filter((s) => s === 'completed').length;
  const failed = statuses.filter((s) => s === 'failed').length;
  return (
    <div className="builder-overlay-banner" role="status">
      <span
        className="builder-overlay-dot"
        style={{
          background: meta.color,
          animation: overlay.runStatus === 'running' ? 'openwop-pulse 1.2s ease-in-out infinite' : 'none',
        }}
        aria-hidden
      />
      <strong style={{ color: meta.color }}>{t(`builder:${meta.labelKey}`)}</strong>
      <span className="muted">
        {failed > 0 ? t('overlayDoneFailed', { done, failed }) : t('overlayDone', { done })}
      </span>
      <span className="builder-toolbar-spacer" />
      <Link to={`/runs/${overlay.runId}`} title={t('runDetailTitle')}>
        {t('runDetailLink')}
      </Link>
      <button
        type="button"
        className="secondary u-pad-2x10 u-minh-0"
        onClick={clearOverlay}
        title={t('dismissOverlayTitle')}
      >
        {t('dismiss')}
      </button>
    </div>
  );
}
