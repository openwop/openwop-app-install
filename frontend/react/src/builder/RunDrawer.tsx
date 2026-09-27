/**
 * RunDrawer — §7.2.5/§7.9 canon / CV-17: the builder's bottom run/inspect
 * drawer (the n8n/Retool consensus — counts on nodes, payloads in the
 * drawer). Renders while a run overlay is active: one row per node that has
 * run (status chip + node name + latest transition time), expandable to the
 * terminal event's payload as pretty JSON. Collapsed by default to a summary
 * strip; a type-payload drawer, NOT a permanent bottom bar (§7.2.5).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBuilderStore, type NodeRunStatus } from './store/builderStore.js';
import { ChevronDownIcon, ChevronUpIcon } from '../ui/icons/index.js';
import { formatTime } from '../i18n/format.js';

const STATUS_LABEL: Record<NodeRunStatus, string> = {
  running: 'runDrawerStatusRunning',
  completed: 'runDrawerStatusCompleted',
  failed: 'runDrawerStatusFailed',
  suspended: 'runDrawerStatusSuspended',
};

function fmtPayload(payload: unknown): string {
  try {
    const s = JSON.stringify(payload, null, 2);
    // Keep the drawer honest but bounded — a giant artifact payload should
    // be read on the run page, not scrolled here.
    return s.length > 4000 ? `${s.slice(0, 4000)}\n…` : s;
  } catch {
    return String(payload);
  }
}

export function RunDrawer(): JSX.Element | null {
  const { t } = useTranslation('builder');
  const overlay = useBuilderStore((s) => s.overlay);
  const nodes = useBuilderStore((s) => s.nodes);
  const [open, setOpen] = useState(false);
  if (!overlay) return null;

  const rows = Object.entries(overlay.nodeDetail);
  const counts = rows.reduce<Record<string, number>>((acc, [, d]) => {
    acc[d.status] = (acc[d.status] ?? 0) + 1;
    return acc;
  }, {});
  const nameOf = (builderId: string): string => nodes.find((n) => n.id === builderId)?.name ?? builderId;

  return (
    <section className="builder-run-drawer" aria-label={t('runDrawerLabel')}>
      <button
        type="button"
        className="builder-run-drawer__head u-button-bare"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="builder-run-drawer__title">{t('runDrawerTitle')}</span>
        <span className="builder-run-drawer__summary">
          {(['running', 'completed', 'failed', 'suspended'] as const)
            .filter((s) => counts[s])
            .map((s) => `${counts[s]} ${t(STATUS_LABEL[s])}`)
            .join(' · ') || t('runDrawerEmpty')}
        </span>
        {open ? <ChevronDownIcon size={14} aria-hidden /> : <ChevronUpIcon size={14} aria-hidden />}
      </button>
      {open ? (
        <ul className="builder-run-drawer__list">
          {rows.length === 0 ? <li className="builder-run-drawer__empty">{t('runDrawerEmpty')}</li> : null}
          {rows.map(([builderId, d]) => (
            <li key={builderId} className="builder-run-drawer__row">
              <span className={`status-badge ${d.status === 'suspended' ? 'running' : d.status}`}>{t(STATUS_LABEL[d.status])}</span>
              <span className="builder-run-drawer__node">{nameOf(builderId)}</span>
              <span className="builder-run-drawer__at">{formatTime(d.at)}</span>
              {d.payload !== undefined ? (
                <details className="builder-run-drawer__payload">
                  <summary>{t('runDrawerPayload')}</summary>
                  <pre>{fmtPayload(d.payload)}</pre>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
