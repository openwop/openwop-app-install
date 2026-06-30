/**
 * Scheduled agent chats (ADR 0125 Phase 3b).
 *
 * Admin panel listing the workspace's recurring agent chats (agent · cron · active/
 * inert) with a delete action (canonical `confirm`, no window.confirm). Gates on
 * `useFeatureAccess('scheduled-agent-chats')`; org picker → a DataTable. A chat is
 * "inert" until a turn-workflow is wired (ADR 0125 Phase 2). Mirrors the reviewed
 * admin-page precedent.
 */
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
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { ActivityIcon } from '../../ui/icons/index.js';
import { listScheduledChats, deleteScheduledChat, listOrgs, type ScheduledChat, type Org } from '../../client/scheduledChatsClient.js';

export function ScheduledChatsPage(): JSX.Element {
  const { t } = useTranslation('scheduled-chats');
  const { embedded } = useHub(); // a tab inside the Chat deployment console → drop our own header
  const access = useFeatureAccess('scheduled-agent-chats');

  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [rows, setRows] = useState<ScheduledChat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (!access.enabled) return;
    void listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => cur || (o[0]?.orgId ?? '')); }).catch(() => setOrgs([]));
  }, [access.enabled]);

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
      await deleteScheduledChat(orgId, chat.chatId).catch(() => setError(t('loadError')));
      load(orgId);
    } finally {
      setDeletingId(null);
    }
  }, [orgId, load, t, deletingId]);

  const columns = useMemo<DataColumn<ScheduledChat>[]>(() => [
    { key: 'agent', header: t('colAgent'), sortValue: (r) => r.agentId, render: (r) => r.agentId },
    { key: 'cron', header: t('colSchedule'), cellClassName: 'u-tabular', render: (r) => r.cronExpr },
    { key: 'status', header: t('colStatus'), render: (r) => <StatusBadge status={r.workflowId ? 'running' : 'paused'} label={r.workflowId ? t('active') : t('inert')} /> },
    // ADR 0125 Phase 3c — the scheduler's next fire time (joined from the job).
    { key: 'next', header: t('colNextRun'), cellClassName: 'u-tabular', sortValue: (r) => r.nextRunAt ?? '', render: (r) => (r.nextRunAt ? formatDateTime(r.nextRunAt) : '—') },
    { key: 'actions', header: '', align: 'right', render: (r) => <button type="button" className="btn-ghost btn-sm" disabled={deletingId === r.chatId} onClick={() => void onDelete(r)}>{t('delete')}</button> },
  ], [t, onDelete, deletingId]);

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
        <SelectField label={t('org')} className="u-w-auto" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
          {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </SelectField>
      )}
      {error && <Notice variant="error">{error}</Notice>}
      {rows === null && !error ? (
        <SkeletonRows rows={4} columns={['1fr', '160px', '120px', '160px', '80px']} />
      ) : (
        <DataTable
          columns={columns}
          rows={rows ?? []}
          rowKey={(r) => r.chatId}
          caption={t('title')}
          empty={<StateCard icon={<ActivityIcon />} title={t('empty')} body={t('emptyHint')} />}
        />
      )}
    </>
  );
}
