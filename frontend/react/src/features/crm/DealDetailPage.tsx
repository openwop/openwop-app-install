/**
 * Deal detail page (gap-analysis §5 B1/B5) — /crm/deals/:dealId?org=<orgId>.
 * Inline edit over the existing PATCH (title / amount / close date / owner /
 * status / stage scoped to the deal's own pipeline) + the activity timeline.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { confirm } from '../../ui/confirm.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { TextField } from '../../ui/Field.js';
import { toast } from '../../ui/toast.js';
import { BriefcaseIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { ActivityTimeline } from './ActivityTimeline.js';
import { crmActionError, revertedErr } from './crmUiHelpers.js';
import { useOptimisticField } from './useOptimisticField.js';
import { formatDealAmount } from './dealMoney.js';
import { formatDate } from '../../i18n/format.js';
import { announce } from '../../ui/announce.js';
import { UserPicker } from '../../orgs/UserPicker.js';
import {
  DEAL_STATUSES,
  deleteDeal,
  getCompany,
  getDeal,
  listPipelines,
  updateDeal,
  type Company,
  type Deal,
  type DealStatus,
  type Pipeline,
  createTask, listTasks, type Task,
} from './crmOrgClient.js';

export function DealDetailPage(): JSX.Element {
  const { t } = useTranslation('crm');
  const { t: tc } = useTranslation('common');
  const crm = useFeatureAccess('crm');
  const { dealId = '' } = useParams();
  const [search] = useSearchParams();
  const orgId = search.get('org') ?? '';

  const [deal, setDeal] = useState<Deal | null>(null);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [company, setCompany] = useState<Company | null>(null);
  // R2 CC-SP-6 — a failed company read must not render identically to "this
  // deal has no company"; a failed pipelines read must not render an EMPTY,
  // silently-unusable stage select.
  const [companyFailed, setCompanyFailed] = useState(false);
  const [pipelinesFailed, setPipelinesFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrencyState] = useState('');
  const [closeDate, setCloseDate] = useState('');
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(false);
  // CRM-UX-15 — the amount validation attaches to its field (aria-invalid +
  // aria-describedby via `ui/Field`) and focuses it; the toast still announces.
  const [amountError, setAmountError] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  // Review F9 — the stages Retry must re-fetch PIPELINES only; wiring it to
  // the whole-page load() reset every in-progress form edit to server values.
  const loadPipelines = useCallback(() => {
    if (!orgId) return;
    setPipelinesFailed(false);
    void listPipelines(orgId)
      .then(setPipelines)
      .catch(() => {
        setPipelines([]); setPipelinesFailed(true);
        // CRM-UX-8 — POLITE: a load the user did not initiate (§4.6 reserves
        // assertive for a failed ACTION). Was `{ assertive: true }` under a
        // `// review F12` note that predates the rule. The visible chip stays.
        announce(t('stagesLoadFailed'));
      });
  }, [orgId, t]);

  const load = useCallback(() => {
    if (!orgId || !dealId) return;
    setError(null);
    void getDeal(orgId, dealId)
      .then((d) => {
        setDeal(d);
        setTitle(d.title); setAmount(d.amount !== undefined ? String(d.amount) : '');
        setCurrencyState(d.currency ?? '');
        setCloseDate(d.closeDate ?? ''); setOwner(d.owner ?? '');
        setCompanyFailed(false);
        if (d.companyId) {
          void getCompany(orgId, d.companyId)
            .then(setCompany)
            .catch(() => { setCompany(null); setCompanyFailed(true); });
        } else setCompany(null);
      })
      .catch((e) => setError(crmActionError(e, 'loadFailed')));
    void loadPipelines();
  }, [orgId, dealId, loadPipelines]);
  useEffect(() => { load(); }, [load]);

  // Rule 12 — destructive delete lives HERE (the entity's detail surface), not
  // on the collection cell; navigates back to the collection on success.
  const navigate = useNavigate();
  const removeDeal = useCallback(async () => {
    if (!deal) return;
    // CRM-UX-17 — the consequence, from what the backend does: `deleteDeal`
    // removes the deal row and fires the ADR 0580 record-deleted seam, whose
    // `*-crm-unlink` consumers drop the dangling `dealId` from its tasks and
    // activities — the rows are KEPT, never cascaded.
    if (!(await confirm({ title: t('deleteRecordConfirm', { name: deal.title }), body: t('deleteDealBody'), danger: true, confirmLabel: t('common:delete') }))) return;
    try {
      await deleteDeal(orgId, dealId);
      toast.success(t('dealDeleted'));
      // CRM-UX-16 — see CompanyDetailPage: the landing page focuses its title.
      navigate(`/crm?tab=deals`, { state: { focusTitle: true } });
    } catch (e) { toast.error(crmActionError(e, 'deleteFailed')); }
  }, [deal, orgId, dealId, navigate, t]);

  const stages = useMemo(
    () => pipelines.find((p) => p.pipelineId === deal?.pipelineId)?.stages ?? [],
    [pipelines, deal],
  );

  const save = useCallback(async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const amt = amount.trim() ? Number(amount) : null;
      if (amt !== null && !Number.isFinite(amt)) {
        setAmountError(t('amountMustBeNumber')); amountRef.current?.focus();
        toast.error(t('amountMustBeNumber')); setBusy(false); return;
      }
      const cur = currency.trim().toUpperCase();
      const next = await updateDeal(orgId, dealId, {
        title: title.trim(),
        amount: amt,
        currency: cur === '' ? null : cur,
        closeDate: closeDate || null,
        owner: owner.trim() || null,
      });
      setDeal(next);
      toast.success(t('dealSaved'));
    } catch (e) { toast.error(crmActionError(e, 'saveFailed')); } finally { setBusy(false); }
  }, [orgId, dealId, title, amount, currency, closeDate, owner, t]);

  // Rethrows on failure (rather than toasting itself) so the optimistic
  // selects below (CRMGAP-FE-4) can revert their local pick before toasting.
  const setField = useCallback(async (patch: { stageId?: string; status?: DealStatus }) => {
    const next = await updateDeal(orgId, dealId, patch);
    setDeal(next);
  }, [orgId, dealId]);
  const [stageId, setStageId] = useOptimisticField<string>(deal?.stageId ?? '', (next) => setField({ stageId: next }));
  const [status, setStatus] = useOptimisticField<DealStatus>(deal?.status ?? 'open', (next) => setField({ status: next }));

  if (crm.loading) return <Skeleton />;
  if (!crm.enabled) {
    return (
      <section className="u-grid u-gap-4">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </section>
    );
  }
  if (!orgId) {
    return (
      <section className="u-grid u-gap-4">
        <PageHeader eyebrow={t('eyebrow')} title={t('dealDetailTitle')} />
        <StateCard icon={<BriefcaseIcon />} title={t('missingOrgTitle')} body={t('missingOrgBody')} />
        <Link to="/crm">{t('backToCrm')}</Link>
      </section>
    );
  }

  return (
    <section className="u-grid u-gap-4">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={deal?.title ?? t('dealDetailTitle')}
        lede={company ? t('dealCompanyLede', { name: company.name }) : undefined}
        actions={(
          <span className="action-bar">
            <Link to="/crm?tab=deals" className="btn-ghost">{t('backToCrm')}</Link>
            {deal ? <Button variant="quiet" onClick={() => void removeDeal()}>{t('common:delete')}</Button> : null}
          </span>
        )}
      />
      {/* CRM-UX-4 — announced failed-read card + Retry (the SignTab.tsx bar),
          never a bare Notice carrying the transport's raw string. */}
      {error ? (
        <StateCard
          announce
          icon={<BriefcaseIcon />}
          title={tc('loadFailedTitle')}
          body={tc('loadFailedBody')}
          action={<Button variant="secondary" onClick={load}>{tc('retry')}</Button>}
        />
      ) : null}
      {!deal && !error ? <Skeleton /> : null}
      {deal ? (
        <>
          <div className="action-bar">
            <span className="chip">{t(`dealStatus_${deal.status ?? 'open'}`)}</span>
            {deal.amount !== undefined ? <span className="chip">{formatDealAmount(deal.amount, deal.currency)}</span> : null}
            {pipelinesFailed ? (
              // NOT a <label>: a button inside one inherits the label's text
              // as its accessible name, burying "Retry".
              <span className="u-iflex u-items-center u-gap-2">
                <span className="u-label-sm">{t('colStage')}</span>
                <span className="chip chip--danger">{t('stagesLoadFailed')}</span>
                <Button variant="quiet" size="sm" onClick={loadPipelines}>{t('common:retry')}</Button>
              </span>
            ) : (
              <label className="u-iflex u-items-center u-gap-2">
                <span className="u-label-sm">{t('colStage')}</span>
                <select value={stageId} onChange={(e) => void setStageId(e.target.value).catch(revertedErr)} className="u-w-auto">
                  {stages.map((s) => <option key={s.stageId} value={s.stageId}>{s.name}</option>)}
                </select>
              </label>
            )}
            <label className="u-iflex u-items-center u-gap-2">
              <span className="u-label-sm">{t('colStatus')}</span>
              <select value={status} onChange={(e) => void setStatus(e.target.value as DealStatus).catch(revertedErr)} className="u-w-auto">
                {DEAL_STATUSES.map((s) => <option key={s} value={s}>{t(`dealStatus_${s}`)}</option>)}
              </select>
            </label>
            {company ? (
              <Link to={`/crm/companies/${encodeURIComponent(company.companyId)}?org=${encodeURIComponent(orgId)}`}>{company.name}</Link>
            ) : companyFailed ? (
              <span className="muted u-fs-12">{t('companyLoadFailedInline')}</span>
            ) : null}
          </div>
          <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldTitle')}</span><input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
            <TextField ref={amountRef} label={t('fieldAmount')} error={amountError} value={amount} onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setAmount(e.target.value); setAmountError(null); }} inputMode="numeric" placeholder={t('dealAmountPlaceholder')} />
            <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldCurrency')}</span><input value={currency} onChange={(e) => setCurrencyState(e.target.value)} maxLength={3} placeholder={t('dealCurrencyPlaceholder')} /></label>
            <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldCloseDate')}</span><input type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} /></label>
            <div className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldOwner')}</span><UserPicker ariaLabel={t('fieldOwner')} emptyLabel={t('ownerPlaceholder')} value={owner} onChange={setOwner} orgId={orgId} /></div>
            <Button variant="primary" type="submit" disabled={busy || !title.trim()}>{t('common:save')}</Button>
          </form>
          <DealTasksSection orgId={orgId} dealId={dealId} />
          <ActivityTimeline orgId={orgId} dealId={dealId} />
        </>
      ) : null}
    </section>
  );
}

/** R2 CRM-R2-1 — the deal's own tasks (the bidirectional half of the
 *  deal-linked-task convention: HubSpot/Pipedrive/Attio/Copper all create AND
 *  show tasks from the deal record). Auto-links new tasks to this deal. */
function DealTasksSection({ orgId, dealId }: { orgId: string; dealId: string }): JSX.Element {
  const { t } = useTranslation('crm');
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDue, setTaskDue] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    void listTasks(orgId, { dealId })
      .then(setTasks)
      .catch(() => {
        setTasks([]); setFailed(true);
        // CRM-UX-8 — POLITE (see the sibling note above).
        announce(t('dealTasksLoadFailed'));
      });
  }, [orgId, dealId, t]);
  useEffect(() => { setTasks(null); load(); }, [load]);

  const add = useCallback(async () => {
    if (!taskTitle.trim()) return;
    setBusy(true);
    try {
      await createTask(orgId, { title: taskTitle.trim(), dealId, ...(taskDue ? { dueDate: taskDue } : {}) });
      setTaskTitle(''); setTaskDue(''); load();
      toast.success(t('taskAdded'));
    } catch (e) { toast.error(crmActionError(e, 'addFailed')); } finally { setBusy(false); }
  }, [orgId, dealId, taskTitle, taskDue, load, t]);

  return (
    <div className="surface-card u-p-4 u-grid u-gap-3">
      <h2 className="u-fs-14 u-m-0">{t('dealTasksTitle')}</h2>
      {failed ? (
        <span className="action-bar">
          <span className="chip chip--danger">{t('dealTasksLoadFailed')}</span>
          <Button variant="quiet" size="sm" onClick={load}>{t('common:retry')}</Button>
        </span>
      ) : tasks === null ? (
        <Skeleton />
      ) : tasks.length === 0 ? (
        <p className="muted u-fs-12 u-m-0">{t('dealTasksEmpty')}</p>
      ) : (
        <ul className="u-grid u-gap-2 u-list-none u-p-0 u-m-0">
          {tasks.map((task) => (
            <li key={task.taskId} className="u-flex u-items-center u-gap-2 u-flex-wrap">
              <span className={task.status === 'done' ? 'muted' : ''}>{task.title}</span>
              <span className="chip chip--muted">{t(`taskStatus_${task.status}`)}</span>
              {/* CRM-UX-10 — locale-formatted, like every sibling date. `dueDate`
                  is a DATE-ONLY `YYYY-MM-DD`, which `new Date()` parses as UTC
                  midnight; formatting in UTC is what keeps a viewer west of
                  Greenwich from being shown the previous day (the app's
                  established date-only idiom — see BookingMonthGrid). */}
              {task.dueDate ? <span className="muted u-fs-12">{formatDate(task.dueDate, { dateStyle: 'medium', timeZone: 'UTC' })}</span> : null}
            </li>
          ))}
        </ul>
      )}
      <form className="action-bar" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder={t('dealTaskTitlePlaceholder')} aria-label={t('dealTaskTitlePlaceholder')} />
        <input type="date" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} aria-label={t('fieldDueDate')} />
        <Button variant="secondary" size="sm" type="submit" disabled={busy || !taskTitle.trim()}>{t('addTask')}</Button>
      </form>
    </div>
  );
}

