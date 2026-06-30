/**
 * Profile Activity tab (ADR 0025) — the human's run-activity feed, the user-side
 * mirror of an agent's `AgentActivityTab`. Reads the durable runs store via
 * `GET /v1/host/openwop-app/profiles/me/activity`, so every row carries a real
 * timestamp, the run OUTCOME (a status chip), and a link to the run. Surfaces
 * runs the user's personal board / schedule fired on their behalf.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getMyActivity, type AgentActivityItem } from './profilesClient.js';
import { workflowName } from '../../agents/roleTemplates.js';
import { relativeTime } from '../../agents/agentViewModel.js';
import { useFormat } from '../../i18n/useFormat.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { ClockIcon, ZapIcon, PlayIcon, CheckIcon } from '../../ui/icons/index.js';

const SOURCE_KEY = {
  heartbeat: 'sourceHeartbeat',
  schedule: 'sourceSchedule',
  kanban: 'sourceKanban',
  approval: 'sourceApproval',
} as const;

const SOURCE_ICON: Record<AgentActivityItem['source'], JSX.Element> = {
  heartbeat: <PlayIcon size={13} />,
  schedule: <ClockIcon size={13} />,
  kanban: <ZapIcon size={13} />,
  approval: <CheckIcon size={13} />,
};

/** Map a run status to a chip class + a catalog label key (null ⇒ generic). */
function statusChip(status: string): { cls: string; labelKey: keyof typeof STATUS_LABEL_KEY | null } {
  switch (status) {
    case 'completed': return { cls: 'chip--success', labelKey: 'completed' };
    case 'failed': return { cls: 'chip--danger', labelKey: 'failed' };
    case 'running': return { cls: 'chip--accent', labelKey: 'running' };
    case 'suspended': return { cls: 'chip--warning', labelKey: 'suspended' };
    default: return { cls: 'chip--muted', labelKey: null };
  }
}

const STATUS_LABEL_KEY = {
  completed: 'statusCompleted',
  failed: 'statusFailed',
  running: 'statusRunning',
  suspended: 'statusSuspended',
} as const;

export function ProfileActivityTab(): JSX.Element {
  const { t } = useTranslation('profiles');
  const f = useFormat();
  /** Compact wall-clock duration, locale-aware: "820 ms" / "4.2 s" / "1m 5s". */
  const fmtDuration = (ms: number): string => {
    if (ms < 1000) return f.durationMs(ms, 0);
    const s = ms / 1000;
    if (s < 60) return f.durationSeconds(s, 1);
    const m = Math.floor(s / 60);
    return `${f.number(m)}m ${f.number(Math.round(s % 60))}s`;
  };
  const [items, setItems] = useState<AgentActivityItem[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await getMyActivity();
      setItems(res.items);
      setTruncated(res.truncated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  if (error) return <Notice variant="error">{error}</Notice>;
  if (items === null) return <p className="muted">{t('loadingActivity')}</p>;
  if (items.length === 0) {
    return (
      <StateCard
        icon={<ClockIcon />}
        title={t('noActivityTitle')}
        body={t('noActivityBody')}
      />
    );
  }

  return (
    <>
      <ul className="u-list-none u-m-0 u-p-0 u-flex u-flex-col u-gap-1-5">
        {items.map((item) => {
          const chip = statusChip(item.status);
          const chipLabel = chip.labelKey
            ? t(STATUS_LABEL_KEY[chip.labelKey])
            : item.status.charAt(0).toUpperCase() + item.status.slice(1);
          return (
            <li key={item.runId} className="surface-card u-flex u-flex-row u-items-center u-gap-2-5 u-wrap u-pad-2-2-5">
              <span aria-hidden="true" className="muted u-iflex">{SOURCE_ICON[item.source]}</span>
              <div className="u-flex-1 u-minw-200">
                <div className="u-fs-14">
                  {t('activityLine', { source: t(SOURCE_KEY[item.source]) })}
                  <strong>{workflowName(item.workflowId)}</strong>
                </div>
                <div className="muted u-fs-12">
                  {relativeTime(item.timestamp)}
                  {item.durationMs != null && <>{t('ranIn', { duration: fmtDuration(item.durationMs) })}</>}
                  {item.causationId && <> · <span title={t('chainedTitle')}>{t('chained')}</span></>}
                  {' · '}<Link to={`/runs/${item.runId}`}>{t('viewRun')}</Link>
                </div>
              </div>
              <span className={`chip ${chip.cls}`} title={t('runStatusTitle', { status: item.status })}>{chipLabel}</span>
            </li>
          );
        })}
      </ul>
      {truncated ? (
        <p className="agentacttab-truncated-note">{t('truncatedNote')}</p>
      ) : null}
    </>
  );
}
