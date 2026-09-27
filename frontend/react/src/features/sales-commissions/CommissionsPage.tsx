/**
 * Sales Commissions — admin surface (ADR 0280 P5). One cohesive page: pick an org,
 * author commission plans (percentage/fixed rules + attainment accelerators + cap),
 * compute a rep's statement for a period, and walk it through draft → approved →
 * paid. Built entirely from the shared ui/ design system; all money via i18n
 * formatNumber; every state (loading/empty/error) designed.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Panel } from '../../ui/layout.js';
import { StateCard } from '../../ui/StateCard.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { Notice } from '../../ui/Notice.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { TextField, SelectField } from '../../ui/Field.js';
import { UserPicker } from '../../orgs/UserPicker.js';
import { loadOrgMembers } from '../../orgs/orgMembers.js';
import { confirm } from '../../ui/confirm.js';
import type { OrgMember } from '../../client/accessClient.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { toast } from '../../ui/toast.js';
import { ScaleIcon } from '../../ui/icons/index.js';
import { formatNumber } from '../../i18n/format.js';
import {
  listOrgs, type Org,
  listPlans, createPlan, deletePlan, type CommissionPlan, type CommissionType, type AssignmentKind, type CommissionAccelerator,
  listStatements, computeStatement, approveStatement, payStatement, type CommissionStatement, type StatementStatus,
} from './commissionsClient.js';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL'];
const ASSIGNMENT_KINDS: AssignmentKind[] = ['rep', 'role', 'territory'];
const assignmentLabel = (kind: AssignmentKind, t: TFunction): string =>
  kind === 'rep' ? t('assignmentRep') : kind === 'role' ? t('assignmentRole') : t('assignmentTerritory');
// R2 COM2-M1 — `maximumFractionDigits: 0` rounded every commission for display, and this
// string is what the mark-paid confirm interpolates ("Mark {{amount}} paid to {{name}}?")
// on the action its own body calls unreversible. A 1,234.56 payout read "$1,235" on the
// dialog that authorises it. Dropping the option lets Intl use the CURRENCY's own
// exponent — two for USD, none for JPY — which is also what the backend now quantises to.
const money = (n: number, currency: string): string => formatNumber(n, { style: 'currency', currency });
const statusBadge = (s: StatementStatus, t: TFunction): { status: string; label: string } =>
  s === 'paid' ? { status: 'success', label: t('statusPaid') } : s === 'approved' ? { status: 'active', label: t('statusApproved') } : { status: 'draft', label: t('statusDraft') };
const ruleSummary = (p: CommissionPlan, t: TFunction): string => {
  const r = p.rules[0];
  if (!r) return t('noRules');
  const rate = r.type === 'percentage' ? `${r.rate}%` : money(r.rate, p.currency);
  const parts = [t('ruleBase', { rate })];
  if (r.accelerators && r.accelerators.length > 0) parts.push(t('ruleAccelerators', { count: r.accelerators.length }));
  if (r.cap !== undefined) parts.push(t('ruleCap', { cap: money(r.cap, p.currency) }));
  return parts.join(' · ');
};

export function CommissionsPage(): JSX.Element {
  const { t } = useTranslation('sales-commissions');
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [orgErr, setOrgErr] = useState<string | null>(null);

  useEffect(() => {
    listOrgs().then((o) => { setOrgs(o); const [first] = o; if (first) setOrgId((cur) => cur || first.orgId); }).catch((e) => setOrgErr(e instanceof Error ? e.message : t('loadOrgsError')));
  }, [t]);

  return (
    <div className="u-flex-col u-gap-4" data-walkthrough="commissions.page">
      <PageHeader title={t('title')} lede={t('lede')} />
      {orgErr ? <Notice variant="error">{orgErr}</Notice> : null}
      {orgs === null ? <Skeleton /> : orgs.length === 0 ? (
        <StateCard icon={<ScaleIcon />} title={t('noOrgsTitle')} body={t('noOrgsBody')} />
      ) : (
        <>
          <Panel className="surface-card">
            <SelectField label={t('orgLabel')} value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
            </SelectField>
          </Panel>
          {orgId ? <CommissionsForOrg orgId={orgId} /> : null}
        </>
      )}
    </div>
  );
}

function CommissionsForOrg({ orgId }: { orgId: string }): JSX.Element {
  const { t } = useTranslation('sales-commissions');
  const [plans, setPlans] = useState<CommissionPlan[] | null>(null);
  const [plansFailed, setPlansFailed] = useState(false);
  const [statements, setStatements] = useState<CommissionStatement[] | null>(null);
  const [statementsFailed, setStatementsFailed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setErr(null);
    // R2 COM2-I1 — the catch set a banner and left `plans === null`, so the panel below
    // shimmered forever (a skeleton is a claim — "still loading" — and it was false), and
    // the statements plan-picker showed "Create a plan first": telling the operator they
    // have no plans when the truth is that we could not find out. NOT `[]` — that is the
    // failure-as-empty defect round 1 closed for the statements read one panel over.
    setPlansFailed(false);
    listPlans(orgId)
      .then((p) => { setPlans(p); setPlansFailed(false); })
      .catch((e) => { setPlansFailed(true); setErr(e instanceof Error ? e.message : t('loadPlansError')); });
    // COM2-G1 — this used to swallow the failure into `[]`, which on a COMMISSION
    // surface renders as "no statements", i.e. "nobody is owed anything". That
    // is the most consequential thing this page can say, and it was saying it
    // whenever the read simply failed.
    setStatementsFailed(false);
    listStatements(orgId)
      .then((x) => { setStatements(x); setStatementsFailed(false); })
      .catch(() => { setStatements([]); setStatementsFailed(true); });
  }, [orgId, t]);
  useEffect(load, [load]);

  return (
    <div className="u-grid u-grid-2 u-gap-4 u-items-start">
      {err ? <Notice variant="error">{err}</Notice> : null}
      <PlansPanel orgId={orgId} plans={plans} plansFailed={plansFailed} busy={busy} setBusy={setBusy} onChange={load} />
      <StatementsPanel orgId={orgId} plans={plans ?? []} plansFailed={plansFailed} statements={statements} statementsFailed={statementsFailed} busy={busy} setBusy={setBusy} onChange={load} />
    </div>
  );
}

// ── Plans ──────────────────────────────────────────────────────────────────
function PlansPanel({ orgId, plans, plansFailed, busy, setBusy, onChange }: { orgId: string; plans: CommissionPlan[] | null; /** R2 COM2-I1 — whether the READ failed, so an unknown list is not shown as an empty one. */ plansFailed: boolean; busy: boolean; setBusy: (b: boolean) => void; onChange: () => void }): JSX.Element {
  const { t } = useTranslation('sales-commissions');
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [kind, setKind] = useState<AssignmentKind>('rep');
  const [ref, setRef] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('2026-01-01');
  const [type, setType] = useState<CommissionType>('percentage');
  const [rate, setRate] = useState('5');
  const [cap, setCap] = useState('');
  const [accelerators, setAccelerators] = useState<CommissionAccelerator[]>([]);
  const [toDelete, setToDelete] = useState<CommissionPlan | null>(null);

  // §4.5 collection kit (DESIGN.md rule 13): gated name/rep search → separate memo.
  const [query, setQuery] = useState('');
  const visiblePlans = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (plans ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.assignment.ref.toLowerCase().includes(q));
  }, [plans, query]);

  const addAccelerator = (): void => setAccelerators((a) => [...a, { attainmentGte: 100, rate: Number(rate) || 0 }]);
  const setAcc = (i: number, patch: Partial<CommissionAccelerator>): void => setAccelerators((a) => a.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const removeAcc = (i: number): void => setAccelerators((a) => a.filter((_, j) => j !== i));

  const create = async (): Promise<void> => {
    const rateN = Number(rate);
    if (!name.trim() || !ref.trim() || !Number.isFinite(rateN) || rateN < 0) { toast.error(t('planValidationError')); return; }
    setBusy(true);
    try {
      await createPlan(orgId, {
        name: name.trim(), currency, assignment: { kind, ref: ref.trim() }, effectiveFrom,
        rules: [{ basis: 'deal-won', type, rate: rateN, ...(accelerators.length > 0 ? { accelerators } : {}), ...(cap.trim() && Number.isFinite(Number(cap)) ? { cap: Number(cap) } : {}) }],
      });
      toast.success(t('planCreatedToast'));
      setName(''); setRef(''); setCap(''); setAccelerators([]);
      onChange();
    } catch (e) { toast.error(e instanceof Error ? e.message : t('createFailed')); } finally { setBusy(false); }
  };
  const remove = async (plan: CommissionPlan): Promise<void> => {
    setBusy(true);
    try { await deletePlan(orgId, plan.planId); toast.success(t('planDeletedToast')); onChange(); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('deleteFailed')); } finally { setBusy(false); setToDelete(null); }
  };

  return (
    <Panel className="surface-card u-flex-col u-gap-3">
      <h2 className="u-mb-0">{t('plansHeading')}</h2>
      <p className="u-text-muted u-mt-0">{t('plansLede')}</p>
      {plans && plans.length > 3 ? (
        <div className="filterbar" role="group" aria-label={t('filterGroup')}>
          <input
            type="search"
            className="ui-input filterbar-search"
            placeholder={t('filterPlansPlaceholder')}
            aria-label={t('filterPlansAria')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      ) : null}
      {plansFailed ? (
        <StateCard announce icon={<ScaleIcon />} title={t('plansLoadFailedTitle')} body={t('plansLoadFailedBody')} action={<Button variant="primary" onClick={onChange}>{t('retryButton')}</Button>} />
      ) : plans === null ? <Skeleton /> : plans.length === 0 ? (
        <p className="u-text-muted">{t('noPlansYet')}</p>
      ) : visiblePlans.length === 0 ? (
        <StateCard icon={<ScaleIcon />} title={t('noMatchTitle')} body={t('noMatchBody')} action={<Button variant="secondary" onClick={() => setQuery('')}>{t('clearFilters')}</Button>} />
      ) : (
        <ul className="u-flex-col u-gap-2 u-list-none u-p-0">
          {visiblePlans.map((p) => (
            <li key={p.planId} className="u-flex u-justify-between u-items-center u-gap-2">
              <div className="u-flex-col">
                <strong>{p.name}</strong>
                <span className="u-text-muted u-text-sm">{assignmentLabel(p.assignment.kind, t)}: {p.assignment.ref} · {ruleSummary(p, t)}</span>
              </div>
              <Button variant="primary" className="u-text-danger" disabled={busy} onClick={() => setToDelete(p)}>{t('deleteButton')}</Button>
            </li>
          ))}
        </ul>
      )}

      <fieldset className="u-flex-col u-gap-2 u-fieldset-bare">
        <legend className="u-text-sm u-text-muted">{t('newPlanLegend')}</legend>
        <TextField label={t('nameLabel')} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} />
        <div className="u-grid u-grid-2 u-gap-2">
          <SelectField label={t('currencyLabel')} value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </SelectField>
          <TextField label={t('effectiveFromLabel')} type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
        </div>
        <div className="u-grid u-grid-2 u-gap-2">
          <SelectField label={t('paysLabel')} value={kind} onChange={(e) => setKind(e.target.value as AssignmentKind)}>
            {ASSIGNMENT_KINDS.map((k) => <option key={k} value={k}>{assignmentLabel(k, t)}</option>)}
          </SelectField>
          {kind === 'rep'
            ? <UserPicker value={ref} onChange={setRef} orgId={orgId} label={t('repSubjectLabel')} />
            : <TextField label={kind === 'role' ? t('roleIdLabel') : t('territoryIdLabel')} value={ref} onChange={(e) => setRef(e.target.value)} />}
        </div>
        <div className="u-grid u-grid-3 u-gap-2">
          <SelectField label={t('rateTypeLabel')} value={type} onChange={(e) => setType(e.target.value as CommissionType)}>
            <option value="percentage">{t('rateTypePercentage')}</option>
            <option value="fixed">{t('rateTypeFixed')}</option>
          </SelectField>
          <TextField label={type === 'percentage' ? t('ratePercentLabel') : t('rateAmountLabel')} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
          <TextField label={t('capLabel')} inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} placeholder={t('capPlaceholder')} />
        </div>

        <div className="u-flex-col u-gap-1" role="group" aria-label={t('acceleratorsGroupLabel')}>
          <div className="u-flex u-justify-between u-items-center">
            <span className="u-text-sm u-text-muted">{t('acceleratorsHint')}</span>
            <Button variant="primary" size="sm" onClick={addAccelerator}>{t('addAccelerator')}</Button>
          </div>
          {accelerators.map((a, i) => (
            <div key={i} className="u-flex u-gap-2 u-items-end">
              <TextField label={t('attainmentGteLabel')} inputMode="decimal" value={String(a.attainmentGte)} onChange={(e) => setAcc(i, { attainmentGte: Number(e.target.value) || 0 })} />
              <TextField label={type === 'percentage' ? t('boostedRateLabel') : t('boostedAmountLabel')} inputMode="decimal" value={String(a.rate)} onChange={(e) => setAcc(i, { rate: Number(e.target.value) || 0 })} />
              <Button variant="primary" className="u-text-danger" aria-label={t('removeAcceleratorAria', { n: i + 1 })} onClick={() => removeAcc(i)}>{t('removeButton')}</Button>
            </div>
          ))}
        </div>

        <div className="action-bar">
          <Button variant="primary" disabled={busy || !name.trim() || !ref.trim()} onClick={() => void create()}>{t('createPlanButton')}</Button>
        </div>
      </fieldset>

      {toDelete ? (
        <ConfirmDialog
          title={t('deletePlanTitle')}
          body={t('deletePlanBody', { name: toDelete.name })}
          confirmLabel={t('deleteButton')}
          danger
          busy={busy}
          onConfirm={() => void remove(toDelete)}
          onCancel={() => setToDelete(null)}
        />
      ) : null}
    </Panel>
  );
}

// ── Statements ───────────────────────────────────────────────────────────────
function StatementsPanel({ orgId, plans, plansFailed, statements, statementsFailed, busy, setBusy, onChange }: { orgId: string; plans: CommissionPlan[]; /** R2 review — the plans READ failed, so the picker must not claim there are none. */ plansFailed: boolean; statements: CommissionStatement[] | null; statementsFailed: boolean; busy: boolean; setBusy: (b: boolean) => void; onChange: () => void }): JSX.Element {
  // COM2-G3 — the compute form already picks a rep BY NAME via the shared
  // UserPicker ("instead of a raw subject id", as its own comment says), and the
  // table right beneath it then printed the raw subject id. Resolve names once
  // and reuse the fetch for the pickers (UserPicker takes pre-loaded members).
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  useEffect(() => {
    let live = true;
    void loadOrgMembers(orgId).then((m) => { if (live) setMembers(m); }).catch(() => { if (live) setMembers([]); });
    return () => { live = false; };
  }, [orgId]);
  const memberName = useMemo(
    () => new Map((members ?? []).flatMap((m) => (m.subject ? [[m.subject, m.displayName] as const] : []))),
    [members],
  );
  const { t } = useTranslation('sales-commissions');
  const [planId, setPlanId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [period, setPeriod] = useState('2026-Q1');
  const planName = useMemo(() => new Map(plans.map((p) => [p.planId, p.name])), [plans]);

  // §4.5 collection kit (DESIGN.md rule 13): gated rep/plan search + status facet → separate memo.
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | StatementStatus>('');
  const visibleStatements = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (statements ?? []).filter((s) =>
      (!q || s.subjectId.toLowerCase().includes(q) || (planName.get(s.planId) ?? s.planId).toLowerCase().includes(q) || s.period.toLowerCase().includes(q))
      && (!statusFilter || s.status === statusFilter));
  }, [statements, query, statusFilter, planName]);
  const clearFilters = (): void => { setQuery(''); setStatusFilter(''); };

  useEffect(() => { const [first] = plans; if (!planId && first) setPlanId(first.planId); }, [plans, planId]);

  const compute = async (): Promise<void> => {
    if (!planId || !subjectId.trim() || !period.trim()) { toast.error(t('statementValidationError')); return; }
    setBusy(true);
    try { const s = await computeStatement(orgId, planId, subjectId.trim(), period.trim()); toast.success(t('statementComputedToast', { amount: money(s.total, s.currency) })); onChange(); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('computeFailed')); } finally { setBusy(false); }
  };
  const advance = async (s: CommissionStatement, action: 'approve' | 'pay'): Promise<void> => {
    // COM2-G2 — "mark paid" SETTLES the record: the row becomes terminal with no
    // un-pay action anywhere in this UI. Every comparable money-or-destructive
    // action in this app confirms first (refund, subject erasure, pixel removal);
    // this one fired straight from the click. Submitting for review does NOT
    // confirm — it is reversible by the reviewer, and a gate on every step is a
    // gate nobody reads.
    if (action === 'pay') {
      const who = memberName.get(s.subjectId) ?? s.subjectId;
      const ok = await confirm({
        title: t('payConfirmTitle', { amount: money(s.total, s.currency), name: who }),
        body: t('payConfirmBody'),
        danger: true,
        confirmLabel: t('markPaidButton'),
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await (action === 'approve' ? approveStatement(orgId, s.statementId) : payStatement(orgId, s.statementId));
      // CFP-1 (D9): approve now SUBMITS for review (the manager decides it in the
      // shared Reviews inbox); mark-paid still settles the already-approved record.
      toast.success(action === 'approve' ? t('statementSubmittedForReviewToast') : t('statementPaidToast'));
      onChange();
    } catch (e) { toast.error(e instanceof Error ? e.message : action === 'approve' ? t('approveFailed') : t('payFailed')); } finally { setBusy(false); }
  };

  return (
    <Panel className="surface-card u-flex-col u-gap-3">
      <h2 className="u-mb-0">{t('statementsHeading')}</h2>
      <p className="u-text-muted u-mt-0">{t('statementsLede')}</p>

      <fieldset className="u-flex-col u-gap-2 u-fieldset-bare">
        <legend className="u-text-sm u-text-muted">{t('computeStatementLegend')}</legend>
        <SelectField label={t('planLabel')} value={planId} onChange={(e) => setPlanId(e.target.value)} disabled={plans.length === 0}>
          {/* R2 review — the I1 comment named TWO symptoms (the shimmering skeleton AND
              this picker saying "create a plan first") and only the first was fixed: a
              failed read still told the operator they have no plans, one panel over.
              An unknown list is not an empty one. */}
          {plansFailed ? <option value="">{t('plansUnavailableOption')}</option>
            : plans.length === 0 ? <option value="">{t('createPlanFirstOption')}</option>
              : plans.map((p) => <option key={p.planId} value={p.planId}>{p.name}</option>)}
        </SelectField>
        <div className="u-grid u-grid-2 u-gap-2">
          {/* COMM-UX-1 — pick a rep by name (shared UserPicker, ADR 0261) instead of a raw subject id */}
          <UserPicker value={subjectId} onChange={setSubjectId} orgId={orgId} label={t('repSubjectLabel')} emptyLabel={t('repSubjectPlaceholder')} {...(members ? { members } : {})} />
          <TextField label={t('periodLabel')} value={period} onChange={(e) => setPeriod(e.target.value)} placeholder={t('periodPlaceholder')} />
        </div>
        <div className="action-bar">
          <Button variant="primary" disabled={busy || !planId || !subjectId.trim()} onClick={() => void compute()}>{t('computeButton')}</Button>
        </div>
      </fieldset>

      {statementsFailed ? (
        <Notice variant="warning" announce={t('statementsLoadFailed')}>{t('statementsLoadFailed')} <Button variant="link" onClick={onChange}>{t('retryButton')}</Button></Notice>
      ) : null}

      {statements && statements.length > 3 ? (
        <div className="filterbar" role="group" aria-label={t('filterGroup')}>
          <input
            type="search"
            className="ui-input filterbar-search"
            placeholder={t('filterStatementsPlaceholder')}
            aria-label={t('filterStatementsAria')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select className="ui-input filterbar-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | StatementStatus)} aria-label={t('filterStatusLabel')}>
            <option value="">{t('allStatuses')}</option>
            <option value="draft">{t('statusDraft')}</option>
            <option value="approved">{t('statusApproved')}</option>
            <option value="paid">{t('statusPaid')}</option>
          </select>
        </div>
      ) : null}
      {statements === null ? <Skeleton /> : statements.length === 0 ? (
        <StateCard icon={<ScaleIcon />} title={t('noStatementsTitle')} body={t('noStatementsBody')} />
      ) : visibleStatements.length === 0 ? (
        <StateCard icon={<ScaleIcon />} title={t('noMatchTitle')} body={t('noMatchBody')} action={<Button variant="secondary" onClick={clearFilters}>{t('clearFilters')}</Button>} />
      ) : (
        <div className="u-overflow-x-auto">
          <table className="data-table">
            <caption className="u-text-sm u-text-muted u-text-left">{t('statementsCaption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('colRep')}</th><th scope="col">{t('colPeriod')}</th><th scope="col">{t('colPlan')}</th>
                <th scope="col" className="u-text-right">{t('colAttainment')}</th><th scope="col" className="u-text-right">{t('colTotal')}</th>
                <th scope="col">{t('colStatus')}</th><th scope="col"><span className="sr-only">{t('colActions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {visibleStatements.map((s) => {
                const b = statusBadge(s.status, t);
                return (
                  <tr key={s.statementId}>
                    <td>{memberName.get(s.subjectId) ?? s.subjectId}</td>
                    <td className="tabular-nums">{s.period}</td>
                    <td>{planName.get(s.planId) ?? s.planId}</td>
                    <td className="u-text-right tabular-nums">{s.attainmentPct !== undefined ? `${formatNumber(s.attainmentPct, { maximumFractionDigits: 0 })}%` : '—'}</td>
                    <td className="u-text-right tabular-nums">{money(s.total, s.currency)}</td>
                    <td><StatusBadge status={b.status} label={b.label} /></td>
                    <td>
                      {s.status === 'draft' ? <Button variant="primary" size="sm" disabled={busy} onClick={() => void advance(s, 'approve')}>{t('submitForApprovalButton')}</Button>
                        : s.status === 'approved' ? <Button variant="primary" size="sm" disabled={busy} onClick={() => void advance(s, 'pay')}>{t('markPaidButton')}</Button>
                          : <span className="u-text-muted u-text-sm">{t('statusPaid')}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
