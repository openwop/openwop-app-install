/**
 * Deals tab (board + table, org-scoped — ADR 0008) — extracted out of
 * CrmPage.tsx per the ReportsTab.tsx precedent (CRMGAP-FE-10). The board's
 * DnD move (KanbanBoardView) already reconciles optimistically; the table's
 * stage `<select>` now shares that pattern via `useOptimisticField`
 * (CRMGAP-FE-4) instead of waiting on the round trip before showing the pick.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { formatDealAmount, formatGroupedSums } from './dealMoney.js';
import { announce } from '../../ui/announce.js';
import { KanbanBoardView } from '../../kanban/KanbanBoardView.js';
import type { KanbanBoard, KanbanCard } from '../../kanban/kanbanClient.js';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { TextField } from '../../ui/Field.js';
import { toast } from '../../ui/toast.js';
import { BriefcaseIcon } from '../../ui/icons/index.js';
import {
  createDeal,
  listCompanies,
  listDeals,
  listPipelines,
  moveDeal,
  type Company,
  type Deal,
  type Pipeline,
  type PipelineStage,
} from './crmOrgClient.js';
import { crmActionError, revertedErr } from './crmUiHelpers.js';
import { useOptimisticField } from './useOptimisticField.js';

interface Props {
  orgId: string;
}

/** The table row's stage `<select>` — its own component so the optimistic
 *  hook (a hook, so it can't live inside a `.map` render callback) has a
 *  stable per-row instance. */
function DealStageSelect({ orgId, deal, stages, onMoved }: {
  orgId: string;
  deal: Deal;
  stages: readonly PipelineStage[];
  onMoved: () => void;
}): JSX.Element {
  const { t } = useTranslation('crm');
  const [stageId, setStageId] = useOptimisticField(deal.stageId, (next) => moveDeal(orgId, deal.dealId, next));
  return (
    <select
      value={stageId}
      onChange={(e) => { void setStageId(e.target.value).then(onMoved).catch(revertedErr); }}
      className="u-w-auto"
      aria-label={t('stageSelectLabel', { title: deal.title })}
    >
      {stages.map((s) => <option key={s.stageId} value={s.stageId}>{s.name}</option>)}
    </select>
  );
}

export function DealsTab({ orgId }: Props): JSX.Element {
  const { t } = useTranslation('crm');
  const { t: tc } = useTranslation('common');
  const [rows, setRows] = useState<Deal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pipelines, setPipelines] = useState<Pipeline[] | null>(null);
  // CRM-UX-12 — tracked SEPARATELY from `error` (which a failed DEALS read also
  // sets): without a pipeline the create form would POST a deal with no
  // `pipelineId` while the surface below says the read failed. A failed deals
  // LIST read leaves creation perfectly valid, so only this flag gates the form.
  const [pipelinesFailed, setPipelinesFailed] = useState(false);
  const [pipelineId, setPipelineId] = useState('');
  const [companies, setCompanies] = useState<Company[]>([]);
  // R2 CC-SP-9 — a failed companies read silently emptied the dropdown; the
  // user files deals uncompanied believing none exist.
  const [companiesFailed, setCompaniesFailed] = useState(false);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [busy, setBusy] = useState(false);
  // CRM-UX-15 — a validation failure ATTACHES to its field (`ui/Field` wires
  // aria-invalid + aria-describedby to the message) and moves focus there, so
  // the user learns WHICH field, not just that "something" failed. The toast
  // stays as the assertive announcement; the field is where it is fixed.
  const [amountError, setAmountError] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  // Rule 11 — the Board⇄Table switch IS the shared collection-view control
  // (the Kanban board is this collection's grid), persisted per-surface.
  const [viewMode, setViewMode] = useViewMode('crm-deals', 'grid');
  // Collection kit (rule 13): search + status facet over the loaded pipeline.
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | NonNullable<Deal['status']>>('');
  const visibleDeals = useMemo(() => {
    if (!rows) return rows;
    const q = query.trim().toLowerCase();
    return rows.filter((d) =>
      (!q || d.title.toLowerCase().includes(q))
      && (!statusFilter || (d.status ?? 'open') === statusFilter));
  }, [rows, query, statusFilter]);

  // The selected pipeline drives BOTH the deal list filter and the stage
  // options, so a row's stage <select> always shows its own pipeline's stages
  // (a cross-pipeline stageId would be refused by the backend's resolveStage).
  const pipeline = useMemo(
    () => pipelines?.find((p) => p.pipelineId === pipelineId) ?? null,
    [pipelines, pipelineId],
  );

  // CRM-UX-4 — its own callback so the failed-read card's Retry can re-drive the
  // whole tab: resolving pipelines re-mints `load`'s identity (its `pipelines`
  // dep), which re-fires the deals read below.
  const loadPipelines = useCallback(() => {
    if (!orgId) return;
    setError(null);
    setPipelinesFailed(false);
    void listPipelines(orgId)
      .then((p) => {
        setPipelines(p);
        setPipelineId((cur) => (p.some((x) => x.pipelineId === cur) ? cur : (p[0]?.pipelineId ?? '')));
        // No pipeline (backend seeds one lazily, so only a failure path in
        // practice): leave no skeleton behind — load() no-ops without an id.
        if (p.length === 0) setRows([]);
      })
      .catch((e) => {
        // HIGH-1 — both collections go UNKNOWN (`null`), never `[]`. They used
        // to be emptied so no skeleton stranded behind the error card (audit
        // finding #1), but the board's empty state is gated off `error`
        // (finding #2), so nothing strands — while the stale `[]` DID render
        // "No deals yet" for the whole RETRY request, since this callback
        // clears `error`/`pipelinesFailed` synchronously at the top.
        setPipelines(null); setRows(null); setPipelinesFailed(true);
        setError(crmActionError(e, 'loadFailed'));
      });
  }, [orgId]);

  useEffect(() => {
    // Full per-org reset — INCLUDING the create-form's companyId (a stale
    // cross-org id would ride into createDeal; audit CRMGAP-FE-5).
    setPipelines(null); setPipelineId(''); setRows(null); setCompanyId(''); setError(null); setPipelinesFailed(false);
    if (!orgId) return;
    loadPipelines();
    setCompaniesFailed(false);
    void listCompanies(orgId)
      .then(setCompanies)
      .catch(() => {
        setCompanies([]); setCompaniesFailed(true);
        // CRM-UX-8 — POLITE: a load the user did not initiate (§4.6 reserves
        // assertive for a failed ACTION). Was `{ assertive: true }` under a
        // `// review F12` note that predates the rule.
        announce(t('companiesLoadFailedInline'));
      });
  }, [orgId, t, loadPipelines]);

  const load = useCallback(() => {
    // Guard on the CURRENT org's resolved pipelines: on an org switch this
    // callback re-fires with the PREVIOUS org's pipelineId before the reset
    // effect's state lands — a cross-org query (audit CRMGAP-FE-3).
    if (!orgId || !pipelineId || !pipelines?.some((p) => p.pipelineId === pipelineId)) return;
    setError(null);
    void listDeals(orgId, { pipelineId })
      .then(setRows)
      .catch((e) => {
        // HIGH-1 — see `loadPipelines`: UNKNOWN, never a stale `[]` that a
        // later `load()` (a retry, or the refresh after `add`) would render as
        // "No deals yet" the instant it cleared `error`.
        setRows(null);
        setError(crmActionError(e, 'loadFailed'));
      });
  }, [orgId, pipelineId, pipelines]);
  useEffect(() => { setRows(null); load(); }, [load]);

  // B2: the deal board — synthesized straight from the selected pipeline +
  // its deals; the shared KanbanBoardView owns DnD + keyboard moves. No
  // add-card affordance (deals are created by the domain form below).
  const board = useMemo<KanbanBoard | null>(() => pipeline ? {
    id: pipeline.pipelineId,
    tenantId: '',
    name: pipeline.name,
    columns: pipeline.stages.map((s) => ({ id: s.stageId, name: s.name })),
    createdAt: '',
    updatedAt: '',
  } : null, [pipeline]);
  const boardCards = useMemo<KanbanCard[]>(() => (visibleDeals ?? []).map((d, i) => ({
    id: d.dealId,
    boardId: pipeline?.pipelineId ?? '',
    columnId: d.stageId,
    title: d.title,
    ...(d.amount !== undefined ? { description: formatDealAmount(d.amount, d.currency) } : {}),
    order: i,
    createdAt: '',
    updatedAt: '',
  })), [visibleDeals, pipeline]);
  const moveFromBoard = useCallback((dealId: string, toStageId: string) => {
    // CRM-UX-19 — the board moved the card OPTIMISTICALLY (KanbanBoardView's
    // local mirror) and the `load()` here snaps it back, so the failure is a
    // REVERT, the same shape the table's stage select reports via
    // `revertedErr`: say "reverted", not just "failed".
    void moveDeal(orgId, dealId, toStageId).then(load).catch((e) => { revertedErr(e); load(); });
  }, [orgId, load]);
  const columnFooter = useCallback((_col: { id: string }, cards: KanbanCard[]) => {
    // R2 CC-SP-3 — never one blind total across currencies.
    const colDeals = (rows ?? []).filter((d) => cards.some((c) => c.id === d.dealId));
    return <div className="muted u-fs-12">{t('boardColumnMeta', { count: cards.length, sum: formatGroupedSums(colDeals) })}</div>;
  }, [rows, t]);

  const add = useCallback(async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const amt = amount.trim() ? Number(amount) : undefined;
      if (amt !== undefined && !Number.isFinite(amt)) {
        setAmountError(t('amountMustBeNumber')); amountRef.current?.focus();
        toast.error(t('amountMustBeNumber')); setBusy(false); return;
      }
      const cur = currency.trim().toUpperCase();
      if (cur && amt === undefined) {
        // Review F10 — a typed currency with no amount was silently dropped.
        setAmountError(t('currencyNeedsAmount')); amountRef.current?.focus();
        toast.error(t('currencyNeedsAmount')); setBusy(false); return;
      }
      await createDeal(orgId, { title: title.trim(), ...(amt !== undefined ? { amount: amt } : {}), ...(amt !== undefined && cur ? { currency: cur } : {}), ...(companyId ? { companyId } : {}), ...(pipelineId ? { pipelineId } : {}) });
      setTitle(''); setAmount(''); setCurrency(''); setCompanyId(''); load(); toast.success(t('dealAdded'));
    } catch (e) { toast.error(crmActionError(e, 'addFailed')); } finally { setBusy(false); }
  }, [orgId, title, amount, currency, companyId, pipelineId, load, t]);

  const columns = useMemo<DataColumn<Deal>[]>(() => [
    { key: 'title', header: t('colTitle'), render: (d) => <Link to={`/crm/deals/${encodeURIComponent(d.dealId)}?org=${encodeURIComponent(orgId)}`}>{d.title}</Link> },
    { key: 'amount', header: t('colAmount'), cellClassName: 'muted', render: (d) => (d.amount !== undefined ? formatDealAmount(d.amount, d.currency) : '—') },
    { key: 'status', header: t('colStatus'), render: (d) => <span className="chip">{t(`dealStatus_${d.status ?? 'open'}`)}</span> },
    { key: 'stage', header: t('colStage'), render: (d) => (
      <DealStageSelect orgId={orgId} deal={d} stages={pipeline?.stages ?? []} onMoved={load} />
    ) },
    // Rule 12 — delete moved OFF the collection cell to the deal's detail page.
  ], [orgId, pipeline, load, t]);

  return (
    <div className="u-grid u-gap-4">
      <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldTitle')}</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('dealTitlePlaceholder')} /></label>
        <TextField ref={amountRef} label={t('fieldAmount')} error={amountError} value={amount} onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setAmount(e.target.value); setAmountError(null); }} inputMode="numeric" placeholder={t('dealAmountPlaceholder')} />
        {/* "Currency needs an amount" attaches to the AMOUNT field (where the fix
            goes); typing in either field clears it. */}
        <TextField label={t('fieldCurrency')} value={currency} onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setCurrency(e.target.value); setAmountError(null); }} maxLength={3} placeholder={t('dealCurrencyPlaceholder')} />
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldCompany')}</span>
          <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}><option value="">—</option>{companies.map((co) => <option key={co.companyId} value={co.companyId}>{co.name}</option>)}</select>
          {companiesFailed ? <span className="muted u-fs-12">{t('companiesLoadFailedInline')}</span> : null}
        </label>
        {/* CRM-UX-12 — a deal cannot be filed into a pipeline that was never
            read. Name the consequence rather than accepting a submit that would
            post without a `pipelineId`. */}
        {pipelinesFailed ? <p className="muted u-fs-12 u-m-0">{t('addDealBlockedNoPipelines')}</p> : null}
        <Button variant="primary" type="submit" disabled={busy || !title.trim() || pipelinesFailed}>{t('addDeal')}</Button>
      </form>
      {/* One filterbar row (§4.5 rules 5+11+13): pipeline scope + gated search +
          status facet, with the SHARED view control (never a hand-rolled pair —
          Board is this collection's grid view). */}
      <div className="filterbar" role="group" aria-label={t('filterGroup')}>
        {pipelines && pipelines.length > 1 ? (
          <label className="u-iflex u-items-center u-gap-2">
            <span className="u-label-sm">{t('pipelinePickerLabel')}</span>
            <select value={pipelineId} onChange={(e) => setPipelineId(e.target.value)} className="u-w-auto">
              {pipelines.map((p) => <option key={p.pipelineId} value={p.pipelineId}>{p.name}</option>)}
            </select>
          </label>
        ) : null}
        {rows !== null && rows.length > 3 ? (
          <>
            <input
              type="search"
              className="ui-input filterbar-search"
              placeholder={t('filterDealsPlaceholder')}
              aria-label={t('filterDealsAria')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select className="ui-input filterbar-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | NonNullable<Deal['status']>)} aria-label={t('filterDealStatusLabel')}>
              <option value="">{t('allDealStatuses')}</option>
              {(['open', 'won', 'lost'] as const).map((s) => <option key={s} value={s}>{t(`dealStatus_${s}`)}</option>)}
            </select>
          </>
        ) : null}
        {/* CRM-UX-2 — the board's columns and the Reports tab's weighted
            forecast are BOTH driven by this org's pipeline stages; before this
            link there was no surface anywhere that could edit them. */}
        <Link to={`/crm/pipelines?org=${encodeURIComponent(orgId)}`} className="u-fs-12">{t('pipelinesLink')}</Link>
        <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" labels={{ grid: t('viewBoard'), list: t('viewTable') }} />
      </div>
      {(() => {
        if (error) {
          // A pipeline/deal load failure must never read as an honestly-empty
          // board or table (UX audit finding #2) — the failed-read card replaces
          // both empty states outright. CRM-UX-4: the canonical announced
          // StateCard + Retry (the SignTab.tsx bar), not a bare Notice carrying
          // the transport's raw string with a page reload as the only recovery.
          return (
            <StateCard
              announce
              icon={<BriefcaseIcon />}
              title={tc('loadFailedTitle')}
              body={tc('loadFailedBody')}
              action={<Button variant="secondary" onClick={loadPipelines}>{tc('retry')}</Button>}
            />
          );
        }
        // Skeleton → filter zero-match (with a clear action, rule 13) → true-empty.
        const emptyState = rows === null ? <SkeletonRows rows={3} columns={[180, 100, 120]} />
          : (query.trim() || statusFilter) && rows.length > 0 ? (
            <StateCard
              icon={<BriefcaseIcon />}
              title={t('noMatchesTitle')}
              body={t('noFilterMatchesBody')}
              action={<Button variant="secondary" onClick={() => { setQuery(''); setStatusFilter(''); }}>{t('clearFilters')}</Button>}
            />
          ) : (
            <StateCard icon={<BriefcaseIcon />} title={t('noDealsTitle')} body={t('noDealsBody')} />
          );
        if (viewMode === 'grid' && board) {
          return rows === null ? <SkeletonRows rows={3} columns={[180, 180, 180]} /> : (visibleDeals ?? []).length === 0 ? emptyState : (
            <KanbanBoardView board={board} cards={boardCards} onMoveCard={moveFromBoard} columnFooter={columnFooter} />
          );
        }
        return (
          <DataTable stack rows={visibleDeals ?? []} rowKey={(d) => d.dealId} columns={columns} caption={t('captionDeals')}
            empty={emptyState} />
        );
      })()}
    </div>
  );
}
