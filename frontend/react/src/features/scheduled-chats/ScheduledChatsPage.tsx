/**
 * Scheduled agent chats (ADR 0125 Phase 3b; ADR 0985 D7).
 *
 * Two lists of the same thing, one page:
 *  1. **From your chats** — the recurring check-ins and follow-ups the caller asked an
 *     agent for in chat (`/scheduled-chats/mine`). They belong to the person, not to
 *     an org, so they are listed apart from the org picker. Before ADR 0985 they
 *     appeared nowhere on this page, and one made in a shared workspace appeared in
 *     no UI at all.
 *  2. **Workspace schedules** — the org's config-bound schedules (org picker →
 *     DataTable), as before.
 *
 * Creation is chat-first (ADR 0058, one chat): the header and both empty states name
 * chat as the way to set one up, with an Open chat button. They used to say "Create
 * a scheduled chat" on a page that has no create action.
 *
 * Every status is the JOB's (ADR 0985 D4): paused, not scheduled, the last skip with
 * its reason, or the last failure. A skipped slot no longer reads "Active".
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
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
import { ActivityIcon, MessageSquareIcon } from '../../ui/icons/index.js';
import { describeCadence } from '../../schedules/describeCadence.js';
import { skipReasonKey } from '../../schedules/skipReasonKey.js';
import {
  listScheduledChats, deleteScheduledChat, setScheduledChatEnabled, listOrgs,
  listMyChatSchedules, setMyChatScheduleEnabled, deleteMyChatSchedule,
  type ScheduledChat, type ChatSchedule, type Org,
} from '../../client/scheduledChatsClient.js';

/** One row shape for both lists, so both render the same columns the same way. */
interface Row {
  id: string;
  agentId: string;
  agentName?: string | undefined;
  prompt: string;
  conversationId: string;
  cronExpr: string;
  once: boolean;
  timezone?: string | undefined;
  enabled: boolean;
  /** Org rows only: a legacy enabled row with no turn-workflow fires nothing. */
  inert: boolean;
  nextRunAt?: string | undefined;
  lastError?: { code: string; message: string } | undefined;
  lastSkip?: { reason: string; at: string } | undefined;
  unscheduled: boolean;
  memberLeft: boolean;
  /** A one-shot follow-up whose only slot is used: Missed (or done), delete only. */
  spent: boolean;
  /** Its creator was erased (ADR 0985 D5): it can be deleted, never resumed. */
  creatorErased: boolean;
}

const fromOrg = (c: ScheduledChat): Row => ({
  id: c.chatId, agentId: c.agentId, agentName: c.agentName, prompt: c.prompt, conversationId: c.conversationId,
  cronExpr: c.cronExpr, once: false, timezone: c.timezone, enabled: c.enabled, inert: c.enabled && !c.workflowId,
  nextRunAt: c.nextRunAt, lastError: c.lastError, lastSkip: c.lastSkip, unscheduled: c.unscheduled === true, memberLeft: false,
  spent: false, creatorErased: c.createdBy === 'erased:subject',
});
const fromMine = (s: ChatSchedule): Row => ({
  id: s.jobId, agentId: s.agentId, agentName: s.agentName, prompt: s.prompt, conversationId: s.conversationId,
  cronExpr: s.cronExpr, once: s.kind === 'followup', timezone: s.timezone, enabled: s.enabled, inert: false,
  nextRunAt: s.nextRunAt, lastError: s.lastError, lastSkip: s.lastSkip, unscheduled: s.unscheduled === true,
  memberLeft: s.pausedReason === 'acting_member_removed', spent: s.spent === true, creatorErased: false,
});

const agentLabel = (r: Row): string => r.agentName ?? r.agentId;

/** The columns both lists share. `onToggle`/`onDelete` act on the row's own list. */
function useColumns(
  onToggle: (r: Row) => void, onDelete: (r: Row) => void, busyId: string | null,
): DataColumn<Row>[] {
  const { t } = useTranslation('scheduled-chats');
  return useMemo<DataColumn<Row>[]>(() => {
    const cadence = (r: Row): string => (r.once ? t('cadenceOnce') : describeCadence(r.cronExpr, {
      hourly: () => t('cadenceHourly'),
      daily: (time) => t('cadenceDaily', { time }),
      weekdays: (time) => t('cadenceWeekdays', { time }),
      weekly: (day, time) => t('cadenceWeekly', { day, time }),
    }));
    return [
      { key: 'agent', header: t('colAgent'), sortValue: (r) => agentLabel(r), render: (r) => (
        <span className="u-flex u-flex-col u-gap-0-5 u-min-w-0">
          <strong>{agentLabel(r)}</strong>
          {r.prompt ? <span className="u-fs-12 muted u-truncate" title={r.prompt}>{r.prompt}</span> : null}
        </span>
      ) },
      { key: 'cron', header: t('colSchedule'), render: (r) => (
        <span className="u-flex u-flex-col u-gap-0-5">
          <span>{cadence(r)}</span>
          {r.timezone ? <span className="u-fs-11 muted">{r.timezone}</span> : null}
        </span>
      ) },
      { key: 'status', header: t('colStatus'), render: (r) => {
        // ADR 0985 D4/D7 — the badge is the job's real state. A skipped slot is
        // "Skipped", never a healthy "Active" with a footnote (grade-ux SC2UX-1).
        const badge = r.unscheduled ? <StatusBadge status="failed" label={t('notScheduled')} />
          : r.spent ? <StatusBadge status="cancelled" label={t('missed')} />
          : !r.enabled ? <StatusBadge status="paused" label={t('paused')} />
          : r.lastSkip ? <StatusBadge status="waiting" label={t('skipped')} />
          : r.inert ? <StatusBadge status="paused" label={t('inert')} />
          : <StatusBadge status="running" label={t('active')} />;
        // Say why: not scheduled, its creator erased, paused because the person left,
        // the last skip and its reason, the last failure (ADR 0879 D7), or inert.
        const note = r.unscheduled ? t('notScheduledHint')
          : r.creatorErased ? t('creatorErasedHint')
          : r.memberLeft ? t('pausedMemberLeft')
          : r.lastSkip ? t('lastSkipped', { reason: t(skipReasonKey(r.lastSkip.reason)) })
          : r.lastError ? (r.lastError.code === 'conversation_write_refused' ? t('lastRunNotPosted') : t('lastRunFailed', { reason: r.lastError.message }))
          : r.inert ? t('inertHint')
          : null;
        const quiet = !r.unscheduled && !r.creatorErased && !r.memberLeft && !r.lastError;
        return note
          ? <span className="u-flex u-flex-col u-gap-0-5">{badge}<span className={`u-fs-11 ${quiet ? 'muted' : 'u-text-danger'}`}>{note}</span></span>
          : badge;
      } },
      // ADR 0125 Phase 3c — the scheduler's next fire time (joined from the job).
      { key: 'next', header: t('colNextRun'), cellClassName: 'u-tabular', sortValue: (r) => r.nextRunAt ?? '', render: (r) => (r.enabled && !r.unscheduled && r.nextRunAt ? formatDateTime(r.nextRunAt) : '—') },
      { key: 'actions', header: '', align: 'right', render: (r) => (
        <span className="u-flex u-flex-wrap u-gap-1 u-justify-end u-items-center">
          {r.conversationId ? (
            <Link className="btn btn-ghost btn-sm" to={`/chat?conversation=${encodeURIComponent(r.conversationId)}`} aria-label={t('openConversationAria', { agent: agentLabel(r) })}>{t('openConversation')}</Link>
          ) : null}
          {r.unscheduled || r.memberLeft || r.spent || (r.creatorErased && !r.enabled) ? null : (
            <Button variant="secondary" size="sm" disabled={busyId === r.id} aria-label={t(r.enabled ? 'pauseAria' : 'resumeAria', { agent: agentLabel(r) })} onClick={() => onToggle(r)}>{r.enabled ? t('pause') : t('resume')}</Button>
          )}
          <Button variant="quiet" size="sm" disabled={busyId === r.id} aria-label={t('deleteAria', { agent: agentLabel(r) })} onClick={() => onDelete(r)}>{t('delete')}</Button>
        </span>
      ) },
    ];
  }, [t, onToggle, onDelete, busyId]);
}

function explained(err: unknown): string | null {
  const status = (err as { status?: unknown } | null)?.status;
  const message = ((err as { body?: unknown } | null)?.body as { message?: unknown } | undefined)?.message;
  return typeof status === 'number' && status >= 400 && status < 500 && typeof message === 'string' && message.length > 0 ? message : null;
}

/** Shared write handling: one in-flight action at a time, failures as a toast (an
 *  inline error would be wiped by the reload and read as a silent success). */
function useRowActions(
  toggle: (r: Row) => Promise<unknown>, remove: (r: Row) => Promise<unknown>, reload: () => void,
): { busyId: string | null; onToggle: (r: Row) => void; onDelete: (r: Row) => void } {
  const { t } = useTranslation('scheduled-chats');
  const [busyId, setBusyId] = useState<string | null>(null);
  const act = useCallback(async (r: Row, op: () => Promise<unknown>, failed: string) => {
    if (busyId) return;
    setBusyId(r.id);
    // A refusal the server explained (a 409 `creator_erased` / `unscheduled` /
    // `agent_missing`, a 403) is shown in its own words; anything else is generic.
    try { await op(); reload(); } catch (err) { toast.error(explained(err) ?? failed); } finally { setBusyId(null); }
  }, [busyId, reload]);
  const onToggle = useCallback((r: Row) => { void act(r, () => toggle(r), t('toggleFailed')); }, [act, toggle, t]);
  const onDelete = useCallback((r: Row) => {
    void (async () => {
      if (busyId) return;
      if (!(await confirm({ title: t('deleteAria', { agent: agentLabel(r) }), body: t('deleteBody'), danger: true, confirmLabel: t('delete') }))) return;
      await act(r, () => remove(r), t('deleteFailed'));
    })();
  }, [act, remove, busyId, t]);
  return { busyId, onToggle, onDelete };
}

function OpenChatButton({ variant = 'secondary' }: { variant?: 'primary' | 'secondary' }): JSX.Element {
  const { t } = useTranslation('scheduled-chats');
  const navigate = useNavigate();
  return <Button variant={variant} onClick={() => navigate('/chat')}><MessageSquareIcon aria-hidden="true" /> {t('openChat')}</Button>;
}

/** 1 — the caller's own schedules created from chat (ADR 0985 D6). */
function MySchedules(): JSX.Element {
  const { t } = useTranslation('scheduled-chats');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    setFailed(false);
    void listMyChatSchedules().then((s) => setRows(s.map(fromMine))).catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);
  const toggle = useCallback((r: Row) => setMyChatScheduleEnabled(r.id, !r.enabled), []);
  const remove = useCallback((r: Row) => deleteMyChatSchedule(r.id), []);
  const { busyId, onToggle, onDelete } = useRowActions(toggle, remove, load);
  const columns = useColumns(onToggle, onDelete, busyId);
  return (
    <section className="u-flex u-flex-col u-gap-2" aria-labelledby="sched-mine-title">
      <div>
        <h2 id="sched-mine-title" className="u-fs-16 u-m-0">{t('mineTitle')}</h2>
        <p className="muted u-fs-13 u-m-0">{t('mineHint')}</p>
      </div>
      {failed ? (
        <>
          <Notice variant="error">{t('mineLoadError')}</Notice>
          <div><Button variant="quiet" size="sm" onClick={load}>{t('retry')}</Button></div>
        </>
      ) : rows === null ? (
        <SkeletonRows rows={2} columns={['1fr', '160px', '120px', '160px', '200px']} />
      ) : (
        <DataTable
          stack
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          caption={t('mineTitle')}
          empty={<StateCard icon={<MessageSquareIcon />} title={t('mineEmpty')} body={t('mineEmptyHint')} action={<OpenChatButton />} />}
        />
      )}
    </section>
  );
}

/** 2 — the workspace's org-scoped schedules. */
function WorkspaceSchedules(): JSX.Element {
  const { t } = useTranslation('scheduled-chats');
  // HG-4 — the org read rides the shared seam. Hand-rolled, its `.catch` set BOTH
  // `setOrgs([])` and the flag, so `orgId` stayed '' and the page rendered its
  // loading skeleton forever with no error anywhere; a tenant with NO orgs reached
  // the same dead end.
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs, true);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // §4.5 collection kit (DESIGN.md rule 13): gated search over agent + prompt.
  const [query, setQuery] = useState('');

  const load = useCallback((id: string) => {
    setRows(null);
    setError(null);
    void listScheduledChats(id).then((c) => setRows(c.map(fromOrg))).catch(() => setError(t('loadError')));
  }, [t]);
  useEffect(() => { if (orgId) load(orgId); }, [orgId, load]);
  const reload = useCallback(() => { if (orgId) load(orgId); }, [orgId, load]);
  const toggle = useCallback((r: Row) => setScheduledChatEnabled(orgId, r.id, !r.enabled), [orgId]);
  const remove = useCallback((r: Row) => deleteScheduledChat(orgId, r.id), [orgId]);
  const { busyId, onToggle, onDelete } = useRowActions(toggle, remove, reload);
  const columns = useColumns(onToggle, onDelete, busyId);

  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows ?? [];
    return (rows ?? []).filter((r) => `${agentLabel(r)} ${r.agentId} ${r.prompt}`.toLowerCase().includes(q));
  }, [rows, query]);

  return (
    <section className="u-flex u-flex-col u-gap-2" aria-labelledby="sched-ws-title">
      <h2 id="sched-ws-title" className="u-fs-16 u-m-0">{t('workspaceTitle')}</h2>
      {orgs && orgs.length > 1 && (
        <SelectField label={t('ui:orgPickerLabel')} className="u-w-auto" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
          {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </SelectField>
      )}
      {/* HG-4 — the org states stay above BOTH branches below: a failed or empty org
          read leaves `orgId` empty, so the rows load never fires and the skeleton
          would render forever. */}
      <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')} icon={<ActivityIcon />}>
      {error ? (
        // ONLY the error: falling through to the table's empty state after a failed
        // read invited a DUPLICATE recurring, side-effecting job.
        <>
          <Notice variant="error">{error}</Notice>
          <div><Button variant="quiet" size="sm" onClick={reload}>{t('retry')}</Button></div>
        </>
      ) : rows === null ? (
        <SkeletonRows rows={3} columns={['1fr', '160px', '120px', '160px', '200px']} />
      ) : (
        <>
          {rows.length > 3 ? (
            <div className="filterbar" role="group" aria-label={t('filterGroup')}>
              <input type="search" className="ui-input filterbar-search" placeholder={t('searchPlaceholder')} aria-label={t('searchAria')} value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          ) : null}
          {rows.length > 0 && visibleRows.length === 0 ? (
            <StateCard icon={<ActivityIcon />} title={t('noMatchTitle')} body={t('noMatchBody')}
              action={<Button variant="secondary" onClick={() => setQuery('')}>{t('clearFilters')}</Button>} />
          ) : (
            <DataTable stack columns={columns} rows={visibleRows} rowKey={(r) => r.id} caption={t('workspaceTitle')}
              empty={<StateCard icon={<ActivityIcon />} title={t('empty')} body={t('emptyHint')} action={<OpenChatButton />} />} />
          )}
        </>
      )}
      </OrgSelectionState>
    </section>
  );
}

export function ScheduledChatsPage(): JSX.Element {
  const { t } = useTranslation('scheduled-chats');
  const { embedded } = useHub(); // a tab inside the Chat deployment console → drop our own header
  const access = useFeatureAccess('scheduled-agent-chats');
  const header = embedded ? null : <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={access.enabled ? <OpenChatButton variant="primary" /> : undefined} />;

  // Toggle UNRESOLVED: `access.enabled` is the resolver's FALLBACK `false` for the
  // first paint, so this must say "loading", never the terminal "off" answer
  // (DESIGN.md §4.6). The header stays; the body is a shape-matched skeleton.
  if (access.loading) {
    return (
      <>
        {header}
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
      {header}
      <div className="u-flex u-flex-col u-gap-6">
        <MySchedules />
        <WorkspaceSchedules />
      </div>
    </>
  );
}
