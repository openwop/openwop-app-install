/**
 * Scheduled agent chats (ADR 0125 Phase 3b).
 *
 * Admin panel listing the workspace's recurring agent chats (agent · cron · active/
 * inert) with a delete action (canonical `confirm`, no window.confirm). Gates on
 * `useFeatureAccess('scheduled-agent-chats')`; org picker → a DataTable. A chat is
 * "inert" until a turn-workflow is wired (ADR 0125 Phase 2). Mirrors the reviewed
 * admin-page precedent.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { useHub } from '../../chrome/hubContext.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { SelectField } from '../../ui/Field.js';
import { formatDateTime } from '../../i18n/format.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { ActivityIcon } from '../../ui/icons/index.js';
import { listScheduledChats, deleteScheduledChat, setScheduledChatEnabled, listOrgs, type ScheduledChat, type Org } from '../../client/scheduledChatsClient.js';

export function ScheduledChatsPage(): JSX.Element {
  const { t } = useTranslation('scheduled-chats');
  const { embedded } = useHub(); // a tab inside the Chat deployment console → drop our own header
  const access = useFeatureAccess('scheduled-agent-chats');

  // HG-4 — the org read rides the shared seam. Hand-rolled, its `.catch` set BOTH
  // `setOrgs([])` and the flag, so it carried the very sentinel the flag exists to
  // replace: `orgId` stayed '', the load effect below never fired, `rows` stayed
  // null, and the page rendered its LOADING SKELETON FOREVER with no error
  // anywhere. The rows read on this page was already hardened; the failure walked
  // back in one level up, because the state that fails is not the state the page
  // renders. A tenant with genuinely NO organizations reached the same dead end,
  // and this page had no branch for it at all.
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } =
    useOrgSelection<Org>(listOrgs, access.enabled);
  const [rows, setRows] = useState<ScheduledChat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  // §4.5 collection kit (DESIGN.md rule 13): gated search over agent + prompt.
  const [query, setQuery] = useState('');

  const load = useCallback((id: string) => {
    setRows(null);
    setError(null);
    void listScheduledChats(id).then(setRows).catch(() => setError(t('loadError')));
  }, [t]);

  useEffect(() => { if (access.enabled && orgId) load(orgId); }, [access.enabled, orgId, load]);

  const onDelete = useCallback(async (chat: ScheduledChat) => {
    if (deletingId) return; // a delete is already in flight — short-circuit re-entry
    if (!(await confirm({ title: t('delete'), danger: true, confirmLabel: t('delete') }))) return;
    setDeletingId(chat.chatId);
    try {
      // Surface a genuine failure through the toast — the previous inline
      // setError was wiped synchronously by the reload, so a failed delete read
      // as a silent success.
      await deleteScheduledChat(orgId, chat.chatId);
      load(orgId);
    } catch {
      toast.error(t('deleteFailed'));
    } finally {
      setDeletingId(null);
    }
  }, [orgId, load, t, deletingId]);

  const onToggleEnabled = useCallback(async (chat: ScheduledChat) => {
    if (togglingId) return; // one flip at a time
    setTogglingId(chat.chatId);
    try {
      await setScheduledChatEnabled(orgId, chat.chatId, !chat.enabled);
      load(orgId);
    } catch {
      toast.error(t('toggleFailed'));
    } finally {
      setTogglingId(null);
    }
  }, [orgId, load, t, togglingId]);

  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows ?? [];
    return (rows ?? []).filter((r) => `${r.agentId} ${r.prompt}`.toLowerCase().includes(q));
  }, [rows, query]);

  const columns = useMemo<DataColumn<ScheduledChat>[]>(() => [
    { key: 'agent', header: t('colAgent'), sortValue: (r) => r.agentId, render: (r) => r.agentId },
    { key: 'cron', header: t('colSchedule'), cellClassName: 'u-tabular', render: (r) => r.cronExpr },
    // Status reflects the REAL enabled state (the scheduler job's `enabled`), not
    // merely whether a turn-workflow is wired: a paused chat reads "Paused"; an active
    // one "Active"; the rare enabled-but-unwired legacy row still reads "Inert".
    { key: 'status', header: t('colStatus'), render: (r) => {
      const st = !r.enabled ? { s: 'paused' as const, l: t('paused') } : r.workflowId ? { s: 'running' as const, l: t('active') } : { s: 'paused' as const, l: t('inert') };
      return <StatusBadge status={st.s} label={st.l} />;
    } },
    // ADR 0125 Phase 3c — the scheduler's next fire time (joined from the job).
    { key: 'next', header: t('colNextRun'), cellClassName: 'u-tabular', sortValue: (r) => r.nextRunAt ?? '', render: (r) => (r.enabled && r.nextRunAt ? formatDateTime(r.nextRunAt) : '—') },
    { key: 'actions', header: '', align: 'right', render: (r) => (
      <span className="u-flex u-gap-1 u-justify-end">
        <Button variant="secondary" size="sm" disabled={togglingId === r.chatId} onClick={() => void onToggleEnabled(r)}>{r.enabled ? t('pause') : t('resume')}</Button>
        <Button variant="quiet" size="sm" disabled={deletingId === r.chatId} onClick={() => void onDelete(r)}>{t('delete')}</Button>
      </span>
    ) },
  ], [t, onDelete, onToggleEnabled, deletingId, togglingId]);

  // Toggle UNRESOLVED. Without this branch `access.enabled` is the resolver's
  // FALLBACK `false` for the whole first paint, so every visitor to an ENABLED
  // feature was shown "Scheduled chats are not available" — a terminal answer to
  // a question nobody had answered yet — which then silently swapped for the
  // page. Loading may only say it is loading (DESIGN.md §4.6). The header stays
  // and the body is a shape-matched skeleton, not a title-only `StateCard` that
  // would read as an answer and unmount `PageHeader` on the way in.
  if (access.loading) {
    return (
      <>
        {embedded ? null : <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />}
        <SkeletonRows rows={4} columns={['22%', '20%', '18%', '20%', '20%']} />
      </>
    );
  }
  if (!access.enabled) {
    return (
      <>
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
        <StateCard icon={<ActivityIcon />} title={t('disabled')} />
      </>
    );
  }

  return (
    <>
      {embedded ? null : <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />}
      {orgs && orgs.length > 1 && (
        <SelectField label={t('ui:orgPickerLabel')} className="u-w-auto" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
          {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </SelectField>
      )}
      {/* HG-4 — the noun and the branch ORDER (failed → zero-orgs → children) are
          `OrgSelectionState`'s, and both org states stay above BOTH branches below:
          a failed or empty org read leaves `orgId` empty, so the rows load never
          fires, `error` never gets set, and the skeleton would render forever. */}
      <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')} icon={<ActivityIcon />}>
      {error ? (
        // ONLY the error. This used to render the Notice and then FALL THROUGH to
        // the table, whose empty state reads "No scheduled chats yet — create a
        // scheduled chat to run an agent on a cron schedule." Acting on that after
        // a failed read creates a DUPLICATE recurring, side-effecting job. Of the
        // two messages the instruction is the one that reads as the answer.
        <>
          <Notice variant="error">{error}</Notice>
          <div><Button variant="quiet" size="sm" onClick={() => orgId && load(orgId)}>{t('retry')}</Button></div>
        </>
      ) : rows === null ? (
        <SkeletonRows rows={4} columns={['1fr', '160px', '120px', '160px', '80px']} />
      ) : (
        <>
          {rows && rows.length > 3 ? (
            <div className="filterbar" role="group" aria-label={t('filterGroup')}>
              <input
                type="search"
                className="ui-input filterbar-search"
                placeholder={t('searchPlaceholder')}
                aria-label={t('searchAria')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          ) : null}
          {rows && rows.length > 0 && visibleRows.length === 0 ? (
            <StateCard
              icon={<ActivityIcon />}
              title={t('noMatchTitle')}
              body={t('noMatchBody')}
              action={<Button variant="secondary" onClick={() => setQuery('')}>{t('clearFilters')}</Button>}
            />
          ) : (
            <DataTable
              columns={columns}
              rows={visibleRows}
              rowKey={(r) => r.chatId}
              caption={t('title')}
              empty={<StateCard icon={<ActivityIcon />} title={t('empty')} body={t('emptyHint')} />}
            />
          )}
        </>
      )}
      </OrgSelectionState>
    </>
  );
}
