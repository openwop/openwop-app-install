/**
 * Tasks tab (org-scoped — ADR 0008) — extracted out of CrmPage.tsx per the
 * ReportsTab.tsx precedent (CRMGAP-FE-10). The status `<select>` now uses
 * `useOptimisticField` (CRMGAP-FE-4) instead of waiting on the round trip.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../../ui/confirm.js';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { toast } from '../../ui/toast.js';
import { CheckIcon } from '../../ui/icons/index.js';
import { createTask, deleteTask, listDeals, listTasks, setTaskDueDate, setTaskStatus, TASK_STATUSES, type Deal, type Task, type TaskStatus } from './crmOrgClient.js';
import { Link } from 'react-router-dom';
import { crmActionError, crudErr, focusFirst, revertedErr } from './crmUiHelpers.js';
import { announce } from '../../ui/announce.js';
import { useOptimisticField } from './useOptimisticField.js';

interface Props {
  orgId: string;
}

/** The row's status `<select>` — its own component so the optimistic hook
 *  (a hook, so it can't live inside a `.map` render callback) has a stable
 *  per-row instance. */
function TaskStatusSelect({ orgId, task, onChanged }: {
  orgId: string;
  task: Task;
  onChanged: () => void;
}): JSX.Element {
  const { t } = useTranslation('crm');
  const [status, setStatus] = useOptimisticField(task.status, (next) => setTaskStatus(orgId, task.taskId, next));
  return (
    <select
      value={status}
      onChange={(e) => { void setStatus(e.target.value as TaskStatus).then(onChanged).catch(revertedErr); }}
      className="u-w-auto"
      aria-label={t('statusSelectLabel', { title: task.title })}
    >
      {/* Localized labels (rule 13) — a raw enum in the control is an i18n defect. */}
      {TASK_STATUSES.map((s) => <option key={s} value={s}>{t(`taskStatus_${s}`)}</option>)}
    </select>
  );
}

/** Today in the viewer's local zone, as `YYYY-MM-DD` — the shape `<input
 *  type="date">` and the stored `dueDate` both use. Compared as strings, which
 *  is safe for this format and avoids a timezone round-trip on a date-only value. */
function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** CRM-G1 — the row's due date. Its own component for the same reason as the
 *  status select: `useOptimisticField` is a hook and can't live in a `.map`. */
function TaskDueDate({ orgId, task, onChanged }: {
  orgId: string;
  task: Task;
  onChanged: () => void;
}): JSX.Element {
  const { t } = useTranslation('crm');
  const [due, setDue] = useOptimisticField(task.dueDate ?? '', (next) => setTaskDueDate(orgId, task.taskId, next || null));
  // Overdue only matters while there is still something to do — a done task
  // with a past date is not a problem, and colouring it red would be noise.
  const overdue = Boolean(due) && due < todayKey() && task.status !== 'done';
  return (
    <span className="u-flex u-items-center u-gap-2">
      <input
        type="date"
        className="u-w-auto"
        value={due}
        onChange={(e) => { void setDue(e.target.value).then(onChanged).catch(revertedErr); }}
        aria-label={t('dueDateLabel', { title: task.title })}
      />
      {overdue ? <span className="chip chip--danger">{t('overdue')}</span> : null}
    </span>
  );
}

export function TasksTab({ orgId }: Props): JSX.Element {
  const { t } = useTranslation('crm');
  const { t: tc } = useTranslation('common');
  const [rows, setRows] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [dealId, setDealId] = useState('');
  const [busy, setBusy] = useState(false);
  // R2 CRM-R2-1 (promotes round-1's CRM-G2) — deal-linked tasks. The deals
  // list feeds the picker AND names the Deal column; a failed read is named
  // (the XCC-1 rule), never a silently absent picker.
  const [deals, setDeals] = useState<Deal[]>([]);
  const [dealsFailed, setDealsFailed] = useState(false);
  // R2 CRM-R2-2 (promotes CRM-G3) — due-date sort, the ContactsTab
  // sortByTriage checkbox pattern (console-wide column sort stays a recorded
  // console-level decision).
  const [sortByDue, setSortByDue] = useState(false);
  // CRM-UX-16 — focus targets after a row delete: search, else caption, else
  // the create form's title input (mounted in every state — the search only
  // above 3 rows, the caption only while the table has rows). Deferred via
  // `pendingFocusRef` to the effect on `rows` so it runs AFTER the reload
  // decided what is still mounted.
  const pendingFocusRef = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const captionRef = useRef<HTMLTableCaptionElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  // Collection kit (§4.5 rule 13): gated search + status facet → separate memo.
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | TaskStatus>('');
  const visibleTasks = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (rows ?? []).filter((row) =>
      (!q || row.title.toLowerCase().includes(q))
      && (!statusFilter || row.status === statusFilter));
    if (!sortByDue) return list;
    // Dated tasks first (soonest due leads); undated sink to the bottom.
    return [...list].sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));
  }, [rows, query, statusFilter, sortByDue]);
  const load = useCallback(() => {
    setError(null);
    void listTasks(orgId)
      .then(setRows)
      .catch((e) => {
        // HIGH-1 — UNKNOWN (`null`), never `[]`. Nothing strands (the empty
        // slot is gated off `error`), and a stale `[]` would render "No tasks
        // yet" for the whole RETRY request, because `load()` clears `error`
        // synchronously while the failed read's data stays behind it.
        setRows(null);
        setError(crmActionError(e, 'loadFailed'));
      });
  }, [orgId]);
  useEffect(() => { setRows(null); if (orgId) load(); }, [orgId, load]);
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    pendingFocusRef.current = false;
    focusFirst(searchRef.current, captionRef.current, titleInputRef.current);
  }, [rows]);
  useEffect(() => {
    if (!orgId) return;
    // Review F7 — same stale-late-write class XCC-4 fixed elsewhere: org A's
    // slow deals response must not populate org B's picker.
    let stale = false;
    setDeals([]); setDealsFailed(false);
    void listDeals(orgId).then((d) => { if (!stale) setDeals(d); }).catch(() => {
      if (stale) return;
      setDeals([]); setDealsFailed(true);
      // CRM-UX-8 — POLITE: a load the user did not initiate (§4.6 reserves
      // assertive for a failed ACTION). Was `{ assertive: true }` under a
      // `// review F12` note that predates the rule.
      announce(t('dealsLoadFailedInline'));
    });
    return () => { stale = true; };
  }, [orgId, t]);
  const dealTitleById = useMemo(() => new Map(deals.map((d) => [d.dealId, d.title])), [deals]);

  const add = useCallback(async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await createTask(orgId, { title: title.trim(), ...(dueDate ? { dueDate } : {}), ...(dealId ? { dealId } : {}) });
      setTitle(''); setDueDate(''); setDealId(''); load(); toast.success(t('taskAdded'));
    }
    catch (e) { toast.error(crmActionError(e, 'addFailed')); } finally { setBusy(false); }
  }, [orgId, title, dueDate, dealId, load, t]);

  const columns = useMemo<DataColumn<Task>[]>(() => [
    { key: 'title', header: t('colTitle'), render: (row) => row.title },
    { key: 'status', header: t('colStatus'), render: (row) => (
      <TaskStatusSelect orgId={orgId} task={row} onChanged={load} />
    ) },
    { key: 'dueDate', header: t('colDueDate'), render: (row) => (
      <TaskDueDate orgId={orgId} task={row} onChanged={load} />
    ) },
    { key: 'deal', header: t('colDeal'), cellClassName: 'muted', render: (row) => row.dealId ? (
      <Link to={`/crm/deals/${encodeURIComponent(row.dealId)}?org=${encodeURIComponent(orgId)}`}>{dealTitleById.get(row.dealId) ?? row.dealId}</Link>
    ) : <span className="muted">—</span> },
    // CRM-UX-17 — the consequence (only the task goes). CRM-UX-16 — the row's
    // own button unmounts with the reload; the effect on `rows` moves focus.
    { key: 'actions', header: '', render: (row) => <Button variant="quiet" onClick={() => void confirm({ title: t('deleteRecordConfirm', { name: row.title }), body: t('deleteTaskBody'), danger: true, confirmLabel: t('common:delete') }).then((ok) => { if (ok) deleteTask(orgId, row.taskId).then(() => { pendingFocusRef.current = true; load(); }).catch(crudErr); })}>{t('common:delete')}</Button> },
  ], [orgId, load, dealTitleById, t]);

  return (
    <div className="u-grid u-gap-4">
      {/* CRM-UX-4 — announced failed-read card + Retry (the SignTab.tsx bar),
          never a bare Notice carrying the transport's raw string. */}
      {error ? (
        <StateCard
          announce
          icon={<CheckIcon />}
          title={tc('loadFailedTitle')}
          body={tc('loadFailedBody')}
          action={<Button variant="secondary" onClick={load}>{tc('retry')}</Button>}
        />
      ) : null}
      <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldTitle')}</span><input ref={titleInputRef} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('taskTitlePlaceholder')} /></label>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldDueDate')}</span><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></label>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldDeal')}</span>
          <select value={dealId} onChange={(e) => setDealId(e.target.value)}>
            <option value="">—</option>
            {deals.map((d) => <option key={d.dealId} value={d.dealId}>{d.title}</option>)}
          </select>
          {dealsFailed ? <span className="muted u-fs-12">{t('dealsLoadFailedInline')}</span> : null}
        </label>
        <Button variant="primary" type="submit" disabled={busy || !title.trim()}>{t('addTask')}</Button>
      </form>
      {rows !== null && rows.length > 3 ? (
        <div className="filterbar" role="group" aria-label={t('filterGroup')}>
          <input
            ref={searchRef}
            type="search"
            className="ui-input filterbar-search"
            placeholder={t('filterTasksPlaceholder')}
            aria-label={t('filterTasksAria')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select className="ui-input filterbar-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | TaskStatus)} aria-label={t('filterTaskStatusLabel')}>
            <option value="">{t('allTaskStatuses')}</option>
            {TASK_STATUSES.map((s) => <option key={s} value={s}>{t(`taskStatus_${s}`)}</option>)}
          </select>
          <label className="u-iflex u-items-center u-gap-2">
            <input type="checkbox" checked={sortByDue} onChange={(e) => setSortByDue(e.target.checked)} />
            <span className="u-label-sm">{t('sortByDueDate')}</span>
          </label>
        </div>
      ) : null}
      <DataTable stack rows={visibleTasks} rowKey={(row) => row.taskId} columns={columns} caption={t('captionTasks')} captionRef={captionRef}
        // §Correction — a failed READ must not render as "No tasks yet". The
        // catch sets `[]` so no skeleton strands (audit finding #1), but that
        // made the empty StateCard render beside the error Notice: the user is
        // told both "it broke" and "you have none". `DealsTab` already gates
        // this off `error` (finding #2); this tab did not, and a test pinned it.
        empty={error ? null : rows === null ? <SkeletonRows rows={3} columns={[220, 120, 160, 90]} /> : (query.trim() || statusFilter) && rows.length > 0 ? (
          <StateCard
            icon={<CheckIcon />}
            title={t('noMatchesTitle')}
            body={t('noFilterMatchesBody')}
            action={<Button variant="secondary" onClick={() => { setQuery(''); setStatusFilter(''); }}>{t('clearFilters')}</Button>}
          />
        ) : (
          <StateCard icon={<CheckIcon />} title={t('noTasksTitle')} body={t('noTasksBody')} />
        )} />
    </div>
  );
}
