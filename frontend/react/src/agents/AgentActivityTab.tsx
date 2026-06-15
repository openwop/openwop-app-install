/**
 * Per-agent Activity tab (PRD §9 Activity) — the richer, runs-derived activity
 * log for ONE agent. Unlike the fleet feed (AgentActivityFeed, derived from
 * current board state), this reads the durable runs store via
 * `GET /v1/host/openwop-app/roster/:id/activity`, so every row carries a real
 * timestamp, the run OUTCOME (a status chip), and links to the run.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getAgentActivity, type AgentActivityItem } from './rosterClient.js';
import { workflowName } from './roleTemplates.js';
import { relativeTime } from './agentViewModel.js';
import { Notice } from '../ui/Notice.js';
import { ClockIcon, ZapIcon, PlayIcon, CheckIcon } from '../ui/icons/index.js';

const SOURCE_TEXT: Record<AgentActivityItem['source'], string> = {
  heartbeat: 'picked up a task',
  schedule: 'ran on a schedule',
  kanban: 'started a workflow from a card',
  approval: 'ran an approved proposal',
};

const SOURCE_ICON: Record<AgentActivityItem['source'], JSX.Element> = {
  heartbeat: <PlayIcon size={13} />,
  schedule: <ClockIcon size={13} />,
  kanban: <ZapIcon size={13} />,
  approval: <CheckIcon size={13} />,
};

/** Compact wall-clock duration: "820 ms" / "4.2 s" / "1m 5s". */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

/** Map a run status to a chip class + label. */
function statusChip(status: string): { cls: string; label: string } {
  switch (status) {
    case 'completed': return { cls: 'chip--success', label: 'Completed' };
    case 'failed': return { cls: 'chip--danger', label: 'Failed' };
    case 'running': return { cls: 'chip--accent', label: 'Running' };
    case 'suspended': return { cls: 'chip--warning', label: 'Suspended' };
    default: return { cls: 'chip--muted', label: status.charAt(0).toUpperCase() + status.slice(1) };
  }
}

export function AgentActivityTab({ rosterId, persona, refreshSignal }: { rosterId: string; persona: string; refreshSignal?: number }): JSX.Element {
  const [items, setItems] = useState<AgentActivityItem[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await getAgentActivity(rosterId);
      setItems(res.items);
      setTruncated(res.truncated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [rosterId]);

  useEffect(() => { void refresh(); }, [refresh]);
  // Re-fetch when the parent signals an activity-affecting action (e.g. the
  // header's "Check now" heartbeat started a run).
  useEffect(() => { void refresh(); }, [refreshSignal, refresh]);

  if (error) return <Notice variant="error">{error}</Notice>;
  if (items === null) return <p className="muted">Loading activity…</p>;
  if (items.length === 0) {
    return (
      <p className="muted">
        No runs yet. Click <strong>Check now</strong> or run a workflow, and {persona}'s activity — with outcomes and
        timestamps — will appear here.
      </p>
    );
  }

  return (
    <>
    <ul className="u-list-none u-m-0 u-p-0 u-flex u-flex-col u-gap-1-5">
      {items.map((item) => {
        const chip = statusChip(item.status);
        return (
          <li
            key={item.runId}
            className="surface-card u-flex u-items-center u-gap-2-5 u-wrap u-pad-2-2-5"
          >
            <span aria-hidden="true" className="muted u-iflex">{SOURCE_ICON[item.source]}</span>
            <div className="u-flex-1 u-minw-200">
              <div className="u-fs-14">
                {persona} {SOURCE_TEXT[item.source]} · <strong>{workflowName(item.workflowId)}</strong>
              </div>
              <div className="muted u-fs-12">
                {relativeTime(item.timestamp)}
                {item.durationMs != null && <> · ran in {fmtDuration(item.durationMs)}</>}
                {item.causationId && <> · <span title="Caused by an upstream trigger">chained</span></>}
                {' · '}<Link to={`/runs/${item.runId}`}>view run</Link>
              </div>
            </div>
            <span className={`chip ${chip.cls}`} title={`Run ${item.status}`}>{chip.label}</span>
          </li>
        );
      })}
    </ul>
    {truncated ? (
      <p className="agentacttab-truncated-note">
        Showing {persona}'s most recent activity. Older runs may exist beyond this window.
      </p>
    ) : null}
    </>
  );
}
