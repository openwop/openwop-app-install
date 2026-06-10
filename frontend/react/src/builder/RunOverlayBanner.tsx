/**
 * Live-run banner shown above the canvas while an overlay is active.
 * Extracted from BuilderShell.tsx (pure extraction — no behavior change).
 */

import { Link } from 'react-router-dom';
import { useBuilderStore } from './store/builderStore.js';

const OVERLAY_STATUS_META: Record<string, { label: string; color: string }> = {
  running: { label: 'Running', color: 'var(--clay-text)' },
  completed: { label: 'Completed', color: 'var(--color-success-text)' },
  failed: { label: 'Failed', color: 'var(--color-danger-text)' },
  cancelled: { label: 'Cancelled', color: 'var(--ink-3)' },
};

// Live-run banner shown above the canvas while an overlay is active.
// Counts painted nodes, links to the full run detail, and dismisses
// the overlay (which also tears down the SSE subscription).
export function RunOverlayBanner() {
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
      <strong style={{ color: meta.color }}>{meta.label}</strong>
      <span className="muted">
        {done} done{failed > 0 ? `, ${failed} failed` : ''}
      </span>
      <span className="builder-toolbar-spacer" />
      <Link to={`/runs/${overlay.runId}`} title="Open the full run detail — timeline, reasoning, I/O">
        Run detail →
      </Link>
      <button
        type="button"
        className="secondary u-pad-2x10 u-minh-0"
        onClick={clearOverlay}
        title="Dismiss the live overlay"
      >
        Dismiss
      </button>
    </div>
  );
}
