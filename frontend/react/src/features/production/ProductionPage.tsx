/**
 * Production Intelligence page (ADR 0172) — the Vendor Directory + generated
 * production plans. Gates on useFeatureAccess('production'). An org picker drives
 * both org-scoped tabs. Plan GENERATION is not here: it rides the shared chat
 * scoped to the Production Planner agent (ADR 0058 — "Plan with AI" deep-links,
 * no second chat panel).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n/index.js';
import { formatCurrency, formatNumber } from '../../i18n/format.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { DeepLinkMissNotice, isDeepLinkMiss } from '../../ui/DeepLinkMissNotice.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { Modal } from '../../ui/Modal.js';
import { useUrlTab } from '../../ui/Tabs.js';
import { Field } from '../../ui/Field.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { toast } from '../../ui/toast.js';
import { confirm } from '../../ui/confirm.js';
import { handleTablistKeyDown } from '../../ui/rovingTabs.js';
import { PlusIcon, PencilIcon, TrashIcon, SparklesIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import {
  listOrgs,
  listVendors,
  createVendor,
  updateVendor,
  deleteVendor,
  listPlans,
  setPlanStatus,
  VENDOR_TYPES,
  CONTRACT_STATUSES,
  PRODUCTION_CATEGORIES,
  type Org,
  type Vendor,
  type VendorType,
  type ContractStatus,
  type VendorCapability,
  type ProductionCategory,
  PRICE_UNITS,
  type PriceUnit,
  type ProductionPlan,
  type PlanStatus,
} from './productionClient.js';

const PRODUCTION_PLANNER_AGENT = 'feature.production.agents.production-planner';

const crudErr = (e: unknown): void => { toast.error(e instanceof Error ? e.message : i18n.t('production:actionFailed')); };

type Tab = 'vendors' | 'plans';

export function ProductionPage(): JSX.Element {
  const { t } = useTranslation('production');
  const prod = useFeatureAccess('production');
  // Tab rides `?tab=` (useUrlTab) — reload/share keeps the view.
  const [tab, setTab] = useUrlTab<Tab>('tab', ['vendors', 'plans'], 'vendors');
  // PROD-G1 — `catch(() => setX([]))` is the most invisible form of this class:
  // the failure is swallowed ENTIRELY and the page renders its empty state. All
  // three empty states here are INSTRUCTIVE ("Create an organization first",
  // "Add contractors…", "Ask the Production Planner…"), so a failed read told
  // the user to go and do work they may already have done.
  //
  // The local fix paired `setOrgs([])` with an `orgsFailed` flag and a
  // hand-rolled retry counter, so `orgs.length === 0` meant two things and only
  // the flag told them apart. The shared hook keeps `orgs` null on failure and
  // owns the retry, which removes the ambiguity rather than guarding it.
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs, prod.enabled);

  if (prod.loading) {
    return <div className="u-grid u-gap-4"><PageHeader eyebrow={t('eyebrow')} title={t('title')} /><Skeleton /></div>;
  }
  if (!prod.enabled) {
    return (
      <section className="u-grid u-gap-4" data-walkthrough="production.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </section>
    );
  }

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label={t('ui:orgPickerLabel')}>
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  return (
    <section className="u-grid u-gap-4" data-walkthrough="production.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={orgPicker} />

      <div className="tabs" role="tablist" aria-label={t('tablistLabel')} onKeyDown={handleTablistKeyDown}>
        {(['vendors', 'plans'] as Tab[]).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} className="tab" onClick={() => setTab(id)}>
            {t(id === 'vendors' ? 'tabVendors' : 'tabPlans')}
          </button>
        ))}
      </div>

      <OrgSelectionState
        orgs={orgs}
        orgsFailed={orgsFailed}
        retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')}
        failedBody={t('orgsFailedClause')}
      >
        {/* `OrgSelectionState` renders children while the org read is STILL IN
            FLIGHT (its third branch is "reading, or we have organizations"), so
            the feature owns its own loading gate. Without this the tabs mount
            with `orgId === ''` and fire `listVendors('')` — a request for an
            organization nobody selected, whose failure would then be reported
            as a failed vendor read. Caught by the retry test, not by review. */}
        {orgId
          ? (tab === 'vendors' ? <VendorsTab orgId={orgId} /> : <PlansTab orgId={orgId} />)
          : <Skeleton />}
      </OrgSelectionState>
    </section>
  );
}

// ── Vendors ──────────────────────────────────────────────────────────────────
function VendorsTab({ orgId }: { orgId: string }): JSX.Element {
  const { t } = useTranslation('production');
  const [vendors, setVendors] = useState<Vendor[] | null>(null);
  const [editing, setEditing] = useState<Vendor | 'new' | null>(null);
  // §4.5 collection kit (DESIGN.md rule 13): gated search + type/contract-status
  // facets over the loaded directory. Filters feed a SEPARATE visible list — the
  // full `vendors` stays the source for gating + the true-empty branch.
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'' | VendorType>('');
  const [statusFilter, setStatusFilter] = useState<'' | ContractStatus>('');

  const [vendorsFailed, setVendorsFailed] = useState(false);
  const load = useCallback(() => {
    setVendors(null);
    void listVendors(orgId)
      .then((v) => { setVendors(v); setVendorsFailed(false); })
      .catch(() => { setVendors([]); setVendorsFailed(true); });
  }, [orgId]);
  useEffect(load, [load]);

  const visibleVendors = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (vendors ?? []).filter((v) =>
      (!q || v.name.toLowerCase().includes(q)) &&
      (!typeFilter || v.type === typeFilter) &&
      (!statusFilter || v.contractStatus === statusFilter));
  }, [vendors, query, typeFilter, statusFilter]);
  const clearVendorFilters = (): void => { setQuery(''); setTypeFilter(''); setStatusFilter(''); };

  const remove = async (v: Vendor): Promise<void> => {
    if (!(await confirm({ title: t('deleteVendorTitle', { name: v.name }), body: t('deleteVendorBody'), danger: true, confirmLabel: t('delete') }))) return;
    try {
      await deleteVendor(orgId, v.vendorId);
      toast.success(t('deleted'));
      load();
    } catch (e) { crudErr(e); }
  };

  const typeLabel = (ty: VendorType): string => t(ty === 'agency' ? 'typeAgency' : 'typeContractor');
  const columns: DataColumn<Vendor>[] = [
    { key: 'name', header: t('colName'), render: (v) => <strong>{v.name}</strong>, sortValue: (v) => v.name },
    { key: 'type', header: t('colType'), render: (v) => typeLabel(v.type), sortValue: (v) => v.type },
    { key: 'capabilities', header: t('colCapabilities'), render: (v) => v.capabilities.map((c) => c.name).join(', ') || <span className="muted">—</span> },
    { key: 'status', header: t('colStatus'), render: (v) => <StatusBadge status={v.contractStatus === 'preferred' ? 'completed' : v.contractStatus === 'inactive' ? 'cancelled' : 'running'} label={t(`status_${v.contractStatus}`)} />, sortValue: (v) => v.contractStatus },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (v) => (
        <span className="action-bar">
          <Button variant="secondary" size="sm" onClick={() => setEditing(v)} aria-label={t('edit')}><PencilIcon size={13} /></Button>
          <Button variant="secondary" size="sm" onClick={() => void remove(v)} aria-label={t('delete')}><TrashIcon size={13} /></Button>
        </span>
      ),
    },
  ];

  return (
    <div className="u-grid u-gap-3">
      <div className="action-bar u-justify-end">
        <Button variant="primary" onClick={() => setEditing('new')}><PlusIcon size={14} /> {t('addVendor')}</Button>
      </div>
      {!vendors ? <Skeleton /> : vendors.length === 0 ? (
        vendorsFailed
          ? <StateCard announce title={t('vendorsFailedTitle')} body={t('vendorsFailedBody')}
              action={<Button variant="secondary" onClick={load}>{t('retry')}</Button>} />
          : <StateCard title={t('vendorsEmptyTitle')} body={t('vendorsEmptyBody')} />
      ) : (
        <>
          {vendors.length > 3 ? (
            <div className="filterbar" role="group" aria-label={t('vendorsFilterGroup')}>
              <input
                type="search"
                className="ui-input filterbar-search"
                placeholder={t('vendorsSearchPlaceholder')}
                aria-label={t('vendorsSearchAria')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select className="ui-input filterbar-select" aria-label={t('vendorsFilterTypeAria')} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as '' | VendorType)}>
                <option value="">{t('allTypes')}</option>
                {VENDOR_TYPES.map((ty) => <option key={ty} value={ty}>{typeLabel(ty)}</option>)}
              </select>
              <select className="ui-input filterbar-select" aria-label={t('vendorsFilterStatusAria')} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | ContractStatus)}>
                <option value="">{t('allStatuses')}</option>
                {CONTRACT_STATUSES.map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
              </select>
            </div>
          ) : null}
          {visibleVendors.length === 0 ? (
            <StateCard title={t('vendorsNoMatchTitle')} body={t('vendorsNoMatchBody')} action={<Button variant="secondary" onClick={clearVendorFilters}>{t('clearFilters')}</Button>} />
          ) : (
            <DataTable columns={columns} rows={visibleVendors} rowKey={(v) => v.vendorId} />
          )}
        </>
      )}
      {editing && (
        <VendorForm
          orgId={orgId}
          vendor={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function VendorForm({ orgId, vendor, onClose, onSaved }: { orgId: string; vendor: Vendor | null; onClose: () => void; onSaved: () => void }): JSX.Element {
  const { t } = useTranslation('production');
  const [name, setName] = useState(vendor?.name ?? '');
  const [type, setType] = useState<VendorType>(vendor?.type ?? 'contractor');
  const [region, setRegion] = useState(vendor?.region ?? '');
  const [contractStatus, setContractStatus] = useState<ContractStatus>(vendor?.contractStatus ?? 'active');
  const [notes, setNotes] = useState(vendor?.notes ?? '');
  const [capabilities, setCapabilities] = useState<VendorCapability[]>(vendor?.capabilities ?? []);
  // PROD2-B3 — the vendor form rendered six controls and none of them was
  // pricing, while `vendorsEmptyBody`, the toggle description and manual test
  // PROD-01 all instruct the user to enter it. `priceRanges` was settable only
  // by raw HTTP or the demo seeder — so a whole redaction subsystem
  // (`vendorRedaction`, the route gate, the surface, the KB carve-out, two
  // tests) existed to protect a field no user could create, and PROD-01 could
  // not pass as written.
  // PROD2-R1 — `priceRanges` is REDACTED OUT of the GET for anyone without
  // `host:members:manage`, while EDITING needs only `workspace:write`. So an
  // editor loads a vendor whose rates are absent, and the first cut of this
  // repeater then sent `priceRanges: []` unconditionally — the PATCH route
  // patches any key present in the body, so saving a NAME CHANGE destroyed the
  // rates, with a "Vendor updated" toast. Runtime-proven by the review. It also
  // disarmed PROD2-B2, whose whole point is grounding budgets on those rates.
  //
  // The presence of the KEY is the entitlement signal (the server deletes it,
  // rather than emptying it), so an absent key means "you may not see or set
  // these" — not "there are none".
  const pricingVisible = !vendor || Array.isArray(vendor.priceRanges);
  const [priceRanges, setPriceRanges] = useState<Vendor['priceRanges']>(vendor?.priceRanges ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addCap = (): void => setCapabilities((c) => [...c, { name: '', category: 'design' }]);
  const setCap = (i: number, patch: Partial<VendorCapability>): void => setCapabilities((c) => c.map((cap, idx) => (idx === i ? { ...cap, ...patch } : cap)));
  const removeCap = (i: number): void => setCapabilities((c) => c.filter((_, idx) => idx !== i));
  const addPrice = (): void => setPriceRanges((p) => [...p, { capability: '', min: 0, max: 0, unit: 'per-hour' }]);
  const setPrice = (i: number, patch: Partial<Vendor['priceRanges'][number]>): void => setPriceRanges((p) => p.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removePrice = (i: number): void => setPriceRanges((p) => p.filter((_, idx) => idx !== i));

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!name.trim()) { setError(t('nameRequired')); return; }
    setBusy(true);
    setError(null);
    const input = {
      type,
      name: name.trim(),
      contractStatus,
      // PROD2-M3 (R3) — on EDIT a cleared field sends null (the server's clear
      // signal); omission is only for CREATE. Omitting on edit made clearing
      // Region/Notes a silent no-op under a "Vendor updated" toast.
      ...(region.trim() ? { region: region.trim() } : vendor ? { region: null } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : vendor ? { notes: null } : {}),
      capabilities: capabilities.filter((c) => c.name.trim()).map((c) => ({ name: c.name.trim(), category: c.category, ...(c.qualityRating ? { qualityRating: c.qualityRating } : {}) })),
      // Omitted entirely when the caller never saw them — the route patches only
      // keys that are PRESENT, so omission is what leaves the stored rates alone.
      ...(pricingVisible
        ? {
          priceRanges: priceRanges
            .filter((r) => r.capability.trim() && Number.isFinite(r.min) && Number.isFinite(r.max))
            .map((r) => ({ capability: r.capability.trim(), min: r.min, max: r.max, unit: r.unit })),
        }
        : {}),
    };
    try {
      if (vendor) await updateVendor(orgId, vendor.vendorId, input);
      else await createVendor(orgId, input);
      toast.success(vendor ? t('updated') : t('created'));
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('actionFailed'));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={vendor ? t('editVendor') : t('addVendor')} error={error ? error : undefined} showClose>
      <form className="u-grid u-gap-3" onSubmit={(e) => void submit(e)}>
        <h2 className="u-m-0">{vendor ? t('editVendor') : t('addVendor')}</h2>
        <Field label={t('fieldName')} required>
          {(w) => <input {...w} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus />}
        </Field>
        <div className="u-grid u-gap-3">
          <Field label={t('fieldType')}>
            {(w) => (
              <select {...w} value={type} onChange={(e) => setType(e.target.value as VendorType)}>
                {VENDOR_TYPES.map((ty) => <option key={ty} value={ty}>{t(ty === 'agency' ? 'typeAgency' : 'typeContractor')}</option>)}
              </select>
            )}
          </Field>
          <Field label={t('fieldContractStatus')}>
            {(w) => (
              <select {...w} value={contractStatus} onChange={(e) => setContractStatus(e.target.value as ContractStatus)}>
                {CONTRACT_STATUSES.map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
              </select>
            )}
          </Field>
        </div>
        <Field label={t('fieldRegion')}>
          {(w) => <input {...w} value={region} onChange={(e) => setRegion(e.target.value)} maxLength={120} />}
        </Field>

        <Field label={t('fieldCapabilities')} help={t('capabilitiesHelp')}>
          {(w) => (
          <div className="u-grid u-gap-2" aria-describedby={w['aria-describedby']}>
            {capabilities.map((cap, i) => (
              <div key={i} className="action-bar">
                <input value={cap.name} placeholder={t('capNamePlaceholder')} onChange={(e) => setCap(i, { name: e.target.value })} maxLength={100} />
                <select value={cap.category} onChange={(e) => setCap(i, { category: e.target.value as ProductionCategory })} aria-label={t('capCategory')}>
                  {PRODUCTION_CATEGORIES.map((c) => <option key={c} value={c}>{t(`category_${c}`)}</option>)}
                </select>
                <Button variant="secondary" size="sm" onClick={() => removeCap(i)} aria-label={t('delete')}><TrashIcon size={13} /></Button>
              </div>
            ))}
            <div className="action-bar"><Button variant="secondary" size="sm" onClick={addCap}><PlusIcon size={13} /> {t('addCapability')}</Button></div>
          </div>
          )}
        </Field>

        {!pricingVisible ? (
          /* PROD2-R1 — rendering an EMPTY repeater here would claim this vendor
             has no rates when it has rates this user may not see: the same lie
             the prompt path was careful to avoid. */
          <Notice variant="info">{t('pricingHidden')}</Notice>
        ) : (
        <Field label={t('fieldPricing')} help={t('pricingHelp')}>
          {(w) => (
          <div className="u-grid u-gap-2" aria-describedby={w['aria-describedby']}>
            {priceRanges.map((r, i) => (
              <div key={i} className="action-bar">
                <input value={r.capability} placeholder={t('priceCapabilityPlaceholder')} onChange={(e) => setPrice(i, { capability: e.target.value })} maxLength={100} />
                <input type="number" min={0} step="any" value={r.min} aria-label={t('priceMin')} onChange={(e) => setPrice(i, { min: Number(e.target.value) })} />
                <input type="number" min={0} step="any" value={r.max} aria-label={t('priceMax')} onChange={(e) => setPrice(i, { max: Number(e.target.value) })} />
                <select value={r.unit} onChange={(e) => setPrice(i, { unit: e.target.value as PriceUnit })} aria-label={t('priceUnit')}>
                  {PRICE_UNITS.map((u) => <option key={u} value={u}>{t(`priceUnit_${u}`)}</option>)}
                </select>
                <Button variant="secondary" size="sm" onClick={() => removePrice(i)} aria-label={t('delete')}><TrashIcon size={13} /></Button>
              </div>
            ))}
            <div className="action-bar"><Button variant="secondary" size="sm" onClick={addPrice}><PlusIcon size={13} /> {t('addPriceRange')}</Button></div>
          </div>
          )}
        </Field>
        )}

        <Field label={t('fieldNotes')}>
          {(w) => <textarea {...w} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={3} />}
        </Field>

        <div className="action-bar u-justify-end">
          <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" type="submit" disabled={busy}>{busy ? t('saving') : t('save')}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Plans ────────────────────────────────────────────────────────────────────
const PLAN_TONE: Record<PlanStatus, string> = { draft: 'waiting-approval', approved: 'completed', in_production: 'running', completed: 'completed' };

function PlansTab({ orgId }: { orgId: string }): JSX.Element {
  const { t } = useTranslation('production');
  const navigate = useNavigate();
  const [plans, setPlans] = useState<ProductionPlan[] | null>(null);
  // Deep-link spine (ADR 0336): the open plan rides ?plan= (the URL owns it); the
  // detail derives from the loaded list (validity: an unknown id reads as closed).
  const [searchParams, setSearchParams] = useSearchParams();
  const openId = searchParams.get('plan');
  const open = useMemo(() => plans?.find((p) => p.planId === openId) ?? null, [plans, openId]);
  const setOpenId = useCallback((id: string | null) => {
    setSearchParams((prev) => { const n = new URLSearchParams(prev); if (id) n.set('plan', id); else n.delete('plan'); return n; }, { replace: true });
  }, [setSearchParams]);
  // §4.5 collection kit — gated search over the plan strategy summary. Filters
  // feed a separate visible list; the deep-linked plan resolves against the full
  // `plans` (an open plan filtered out of the table still renders its detail).
  const [query, setQuery] = useState('');

  const [plansFailed, setPlansFailed] = useState(false);
  const load = useCallback(() => {
    setPlans(null);
    void listPlans(orgId)
      .then((p) => { setPlans(p); setPlansFailed(false); })
      .catch(() => { setPlans([]); setPlansFailed(true); });
  }, [orgId]);
  useEffect(load, [load]);

  const visiblePlans = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (plans ?? []).filter((p) => !q || p.strategySummary.toLowerCase().includes(q));
  }, [plans, query]);

  const planWithAi = (): void => { void navigate(`/?agent=${encodeURIComponent(PRODUCTION_PLANNER_AGENT)}`); };

  const columns: DataColumn<ProductionPlan>[] = [
    { key: 'summary', header: t('colStrategy'), render: (p) => <span className="u-truncate">{p.strategySummary || <span className="muted">—</span>}</span> },
    { key: 'recs', header: t('colRecs'), align: 'right', render: (p) => formatNumber(p.recommendations.length), sortValue: (p) => p.recommendations.length },
    { key: 'status', header: t('colStatus'), render: (p) => <StatusBadge status={PLAN_TONE[p.status]} label={t(`planStatus_${p.status}`)} />, sortValue: (p) => p.status },
  ];

  return (
    <div className="u-grid u-gap-3">
      <div className="action-bar u-justify-end">
        <Button variant="primary" onClick={planWithAi}><SparklesIcon size={14} /> {t('planWithAi')}</Button>
      </div>
      {!plans ? <Skeleton /> : plans.length === 0 ? (
        plansFailed ? (
          <StateCard announce title={t('plansFailedTitle')} body={t('plansFailedBody')}
            action={<Button variant="secondary" onClick={load}>{t('retry')}</Button>} />
        ) : (
          <StateCard
            title={t('plansEmptyTitle')}
            body={t('plansEmptyBody')}
            action={<Button variant="primary" onClick={planWithAi}><SparklesIcon size={14} /> {t('planWithAi')}</Button>}
          />
        )
      ) : (
        <>
          <DeepLinkMissNotice show={isDeepLinkMiss(openId, plans !== null, open)} onClear={() => setOpenId(null)} />
          {plans.length > 3 ? (
            <div className="filterbar" role="group" aria-label={t('plansFilterGroup')}>
              <input
                type="search"
                className="ui-input filterbar-search"
                placeholder={t('plansSearchPlaceholder')}
                aria-label={t('plansSearchAria')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          ) : null}
          {visiblePlans.length === 0 ? (
            <StateCard title={t('plansNoMatchTitle')} body={t('plansNoMatchBody')} action={<Button variant="secondary" onClick={() => setQuery('')}>{t('clearFilters')}</Button>} />
          ) : (
            <DataTable columns={columns} rows={visiblePlans} rowKey={(p) => p.planId} onRowClick={(p) => setOpenId(p.planId)} />
          )}
        </>
      )}
      {open && <PlanDetail orgId={orgId} plan={open} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}

function PlanDetail({ orgId, plan, onClose, onChanged }: { orgId: string; plan: ProductionPlan; onClose: () => void; onChanged: (p: ProductionPlan) => void }): JSX.Element {
  const { t } = useTranslation('production');
  const [busy, setBusy] = useState(false);
  // Render from a local copy so a status transition reflects immediately (the
  // parent's derived `plan` catches up on the list refresh — ADR 0336 review).
  const [current, setCurrent] = useState(plan);
  useEffect(() => setCurrent(plan), [plan]);

  // UX_UPGRADE-production R2 (PROD2-B2/PROD2-I1) — `formatCurrency`, not
  // `formatNumber` with the code bolted on as ASCII. `i18n/format.ts`'s own
  // header forbids hand-rolled money strings, the sibling cards already use the
  // shared helper, and the raw form both mis-places the symbol for non-USD
  // locales and exposes the model's unquantised floats (`6,000.333 USD`)
  // through Intl's default 3-fraction-digit ceiling.
  const budget = (b: { min: number; max: number; currency: string }): string =>
    `${formatCurrency(b.min, b.currency)}–${formatCurrency(b.max, b.currency)}`;
  const routeLabel = (r: string): string => t(`route_${r}`, { defaultValue: r });

  const transition = async (status: PlanStatus): Promise<void> => {
    setBusy(true);
    try {
      const updated = await setPlanStatus(orgId, current.planId, status);
      toast.success(t('planUpdated'));
      setCurrent(updated);
      onChanged(updated);
    } catch (e) { crudErr(e); } finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} label={t('planDetailTitle')} showClose>
      <div className="u-grid u-gap-3">
        <div className="action-bar u-justify-between u-items-center">
          <h2 className="u-m-0">{t('planDetailTitle')}</h2>
          <StatusBadge status={PLAN_TONE[current.status]} label={t(`planStatus_${current.status}`)} />
        </div>
        {current.strategySummary && <p className="u-m-0">{current.strategySummary}</p>}

        {current.recommendations.length > 0 && (
          <div className="u-grid u-gap-2">
            <h3 className="u-m-0 u-text-sm muted">{t('recommendations')}</h3>
            {current.recommendations.map((r, i) => (
              <div key={i} className="surface-card u-p-3 u-grid u-gap-1">
                <div className="action-bar u-justify-between u-items-center">
                  <strong>{r.assetType}</strong>
                  <span className="chip">{routeLabel(r.executionRoute)}</span>
                </div>
                {r.rationale && <p className="u-m-0 u-text-sm muted">{r.rationale}</p>}
                {/* PROD2-B2 — the figure is MODEL-GENERATED. Even grounded in
                    the vendor rates now supplied to the prompt, it is an
                    estimate, and this modal rendered it as a plain number range
                    with no provenance marker anywhere. The agent prompt asks the
                    model to label estimates in CHAT; the persisted plan a user
                    opens carried no label at all. */}
                <div className="u-text-sm muted">
                  {budget(r.budget)}
                  <span className="chip chip--muted u-ml-1">{t('budgetEstimated')}</span>
                  {r.timelineEstimate ? ` · ${r.timelineEstimate}` : ''}
                </div>
              </div>
            ))}
          </div>
        )}

        {current.capabilityAssessment.gaps.length > 0 && (
          <p className="u-m-0 u-text-sm"><strong>{t('gaps')}:</strong> {current.capabilityAssessment.gaps.join(', ')}</p>
        )}

        <div className="action-bar u-justify-end">
          {current.status !== 'approved' && current.status !== 'completed' && (
            <Button variant="secondary" disabled={busy} onClick={() => void transition('approved')}>{t('approve')}</Button>
          )}
          {current.status === 'approved' && (
            <Button variant="secondary" disabled={busy} onClick={() => void transition('in_production')}>{t('markInProduction')}</Button>
          )}
          {current.status === 'in_production' && (
            <Button variant="secondary" disabled={busy} onClick={() => void transition('completed')}>{t('markCompleted')}</Button>
          )}
          <Button variant="primary" onClick={onClose}>{t('close')}</Button>
        </div>
      </div>
    </Modal>
  );
}
