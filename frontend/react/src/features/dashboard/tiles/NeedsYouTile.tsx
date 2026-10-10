/**
 * Needs you tile (ADR 0844) — the one ranked list of things blocked on the
 * caller: pending approvals, runs waiting for input, runs that failed in the
 * last day, and connections that need reconnecting. Each row carries the fix
 * as its link.
 *
 * Three EXISTING reads (approvals, runs, connections), each already
 * caller-scoped by its own route. A source that fails is NAMED rather than
 * dropped: "nothing needs you" is a claim, and it is only made when every
 * source answered.
 *
 * Issue 4511 — "needs you" means YOU. A member reads only the runs they
 * started (`readMyRuns`, ownership decided server-side, slim rows) and only
 * their own personal connections, with no link into the admin-tier Access page
 * they cannot open. An admin keeps the workspace view (`readRecentRuns`) and
 * the reconnect link, which is where they would fix it.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { listApprovals, type PendingApproval } from '../../../agents/approvalsClient.js';
import type { Connection } from '../../connections/connectionsClient.js';
import type { RunListItem } from '../../../client/runsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { StatusBadge } from '../../../ui/StatusBadge.js';
import { CheckIcon } from '../../../ui/icons/index.js';
import { formatRelativeTime } from '../../../i18n/format.js';
import { useEffectiveAccessState, isAdminCaller } from '../../../client/useEffectiveAccess.js';
import { readConnections } from '../sharedReads.js';
import { isFailed, isWaiting, readMyRuns, readRecentRuns } from '../runsWindow.js';
import type { DashboardTileProps } from '../tileTypes.js';

const FAILED_LOOKBACK_MS = 24 * 3_600_000;

type Source = 'approvals' | 'runs' | 'connections';

interface Item {
  key: string;
  kind: 'approval' | 'waiting' | 'failed' | 'connection';
  title: string;
  detail: string;
  at: string | undefined;
  /** Absent when the caller cannot open the target (run pages are admin-tier). */
  to: string | undefined;
  action: string;
}

type Settled<T> = { ok: true; value: T } | { ok: false };
const settle = <T,>(p: Promise<T>): Promise<Settled<T>> =>
  p.then((value) => ({ ok: true as const, value }), () => ({ ok: false as const }));

export function needsYouItems(
  approvals: readonly PendingApproval[],
  runs: readonly RunListItem[],
  connections: readonly Connection[],
  now: number,
  t: (key: string) => string,
  /** Admin tier: may open run pages and the Access page, and sees the workspace. */
  isAdmin: boolean,
): Item[] {
  const items: Item[] = [];
  for (const a of approvals) {
    items.push({
      key: `a:${a.approvalId}`,
      kind: 'approval',
      title: a.cardTitle || a.pageTitle || a.strategyTitle || t('needsApprovalTitle'),
      detail: a.proposal,
      at: a.createdAt,
      to: a.kind === 'content-publish' && a.orgId && a.pageId
        ? `/cms/p/${encodeURIComponent(a.orgId)}/${encodeURIComponent(a.pageId)}`
        : '/inbox',
      action: t('needsActionReview'),
    });
  }
  for (const r of runs) {
    const to = isAdmin ? `/runs/${encodeURIComponent(r.runId)}` : undefined;
    if (isWaiting(r.status)) {
      items.push({ key: `w:${r.runId}`, kind: 'waiting', title: r.workflowId, detail: t('needsWaitingDetail'), at: r.startedAt, to, action: t('needsActionOpenRun') });
    } else if (isFailed(r.status)) {
      const at = Date.parse(r.completedAt ?? r.startedAt ?? '');
      if (Number.isFinite(at) && now - at <= FAILED_LOOKBACK_MS) {
        items.push({ key: `f:${r.runId}`, kind: 'failed', title: r.workflowId, detail: t('needsFailedDetail'), at: r.completedAt ?? r.startedAt, to, action: t('needsActionInspect') });
      }
    }
  }
  for (const c of connections) {
    // A member cannot fix a workspace or org connection, so it is not blocked
    // on them; their own personal connection (`userId` set) is.
    if (!isAdmin && c.userId === undefined) continue;
    if (c.status === 'expired' || c.status === 'needs-reconsent') {
      items.push({
        key: `c:${c.connectionId}`,
        kind: 'connection',
        title: c.displayName || c.provider,
        detail: t(c.status === 'expired' ? 'needsConnExpired' : 'needsConnReconsent'),
        at: c.updatedAt ?? c.connectedAt,
        // The reconnect page is admin-tier; a member gets the row without a dead link.
        to: isAdmin ? '/access?tab=connections' : undefined,
        action: t('needsActionReconnect'),
      });
    }
  }
  // Newest first; an undated row sinks.
  return items.sort((x, y) => (Date.parse(y.at ?? '') || 0) - (Date.parse(x.at ?? '') || 0));
}

const KIND_STATUS: Record<Item['kind'], string> = {
  approval: 'waiting-approval',
  waiting: 'waiting-input',
  failed: 'failed',
  connection: 'expired',
};

export default function NeedsYouTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const [state, setState] = useState<{ items: Item[]; failed: Source[] } | null>(null);
  const { access, resolved } = useEffectiveAccessState();
  const isAdmin = isAdminCaller(access);

  useEffect(() => {
    // Which runs to read depends on the tier — never read the workspace's on a guess.
    if (!resolved) return undefined;
    let live = true;
    void Promise.all([
      settle(listApprovals('pending')),
      settle(isAdmin ? readRecentRuns() : readMyRuns()),
      settle(readConnections()),
    ]).then(([a, r, c]) => {
      if (!live) return;
      const failed: Source[] = [];
      if (!a.ok) failed.push('approvals');
      if (!r.ok) failed.push('runs');
      if (!c.ok) failed.push('connections');
      const items = needsYouItems(a.ok ? a.value : [], r.ok ? r.value : [], c.ok ? c.value : [], Date.now(), (k: string) => t(k), isAdmin);
      setState({ items, failed });
    });
    return () => { live = false; };
  }, [t, isAdmin, resolved]);

  if (state === null) return <SkeletonRows rows={3} columns={['20%', '60%', '30%']} />;

  const limit = compact ? 4 : 6;
  const shown = state.items.slice(0, limit);
  const more = state.items.length - shown.length;
  const unreadable = state.failed.length > 0
    ? <p className="dash-tile__state muted">{t('needsUnreadable', { sources: state.failed.map((s) => t(`needsSource_${s}`)).join(', ') })}</p>
    : null;

  if (shown.length === 0) {
    // "All clear" only when every source answered — otherwise it is unknown.
    if (state.failed.length === 3) return <p className="dash-tile__state muted">{t('tileError')}</p>;
    return (
      <div className="u-flex u-flex-col u-gap-2">
        {state.failed.length === 0 ? (
          <p className="dash-needs__clear"><CheckIcon size={16} aria-hidden /> {t('needsClear')}</p>
        ) : null}
        {unreadable}
      </div>
    );
  }

  return (
    <div className="u-flex u-flex-col u-gap-2">
      <ul className="dash-needs u-list-none u-m-0 u-p-0">
        {shown.map((it) => (
          <li key={it.key} className="dash-needs__item">
            <StatusBadge status={KIND_STATUS[it.kind]} label={t(`needsKind_${it.kind}`)} className="dash-needs__badge" />
            <span className="dash-needs__text">
              <span className="dash-needs__title u-truncate" title={it.title}>{it.title}</span>
              <span className="dash-needs__detail muted">{it.detail}</span>
            </span>
            {it.at ? <span className="dash-tile__row-meta muted">{formatRelativeTime(it.at)}</span> : null}
            {it.to ? <Link to={it.to} className="btn secondary btn-sm dash-needs__action">{it.action}</Link> : null}
          </li>
        ))}
      </ul>
      {more > 0 ? <p className="dash-tile__state muted">{t('needsMore', { count: more })}</p> : null}
      {unreadable}
    </div>
  );
}
