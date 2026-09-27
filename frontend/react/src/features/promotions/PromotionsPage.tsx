/**
 * Promotions admin page (ADR 0274 / MERCH-B). Promotions Manager surface: create
 * rule-based promotions (cart_threshold / product_discount / loss_leader), see them
 * ranked by priority, toggle active, delete. A loss_leader requires a loss budget
 * (the guard that makes a below-cost SKU safe). Gated by the `promotions` toggle.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { TextField, SelectField } from '../../ui/Field.js';
import { formatNumber } from '../../i18n/format.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import { ZapIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import {
  CURRENCIES,
  listOrgs, listPromotions, createPromotion, updatePromotion, deletePromotion,
  PROMOTION_TYPES, REWARD_KINDS, type Org, type Promotion, type PromotionType, type RewardKind,
} from './promotionsClient.js';

export function PromotionsPage(): JSX.Element {
  const { t } = useTranslation('promotions');
  // `useFeatureAccess` returns an OBJECT, so the previous `const enabled = …`
  // + `if (!enabled)` was ALWAYS truthy: the "not enabled" branch below was dead
  // and this page rendered regardless of its toggle. (The object-ness was visible
  // one line down, where `enabled.enabled` is what the org read already used.)
  // Destructure the flag, and keep the org read gated on it so a disabled feature
  // touches no network.
  const access = useFeatureAccess('promotions');

  // `.catch(() => setOrgs([]))` left `orgId` '' — the load below is gated on
  // it, so the table's `empty=` slot rendered its loading skeleton forever,
  // while the selector claimed there were no stores. `orgs` was declared
  // non-nullable here, so `[]` was the ONLY value a failure could take.
  //
  // CORRECTION (HG-1) — only the FAILED half of that ever landed. A SUCCESSFUL
  // read of `[]` leaves `orgId` '' just the same, so the skeleton was still
  // terminal-condition-free on the commonest first-run path of all: a tenant with
  // no store yet. Both org states now have their own branch below the form, ABOVE
  // the loading branch, and the failed one REPLACES the table instead of hanging a
  // banner beside a skeleton that keeps spinning under it.
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs, access.enabled);
  const [rows, setRows] = useState<Promotion[] | null>(null);
  // R3 P-5 — derived burn per promotion; an exhausted budget must not read Active.
  const [usage, setUsage] = useState<Record<string, { amount: number; quantity: number }>>({});
  // §4.5 collection search (DESIGN.md rule 13) — name match, view-only.
  const [query, setQuery] = useState('');
  const visibleRows = (rows ?? []).filter((p) =>
    !query.trim() || p.name.toLowerCase().includes(query.trim().toLowerCase()));
  const [error, setError] = useState<string | null>(null);
  /** The rows read FAILED — distinct from "this store has none yet". */
  const [rowsFailed, setRowsFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [type, setType] = useState<PromotionType>('cart_threshold');
  const [rewardKind, setRewardKind] = useState<RewardKind>('percentage');
  const [rewardValue, setRewardValue] = useState(10);
  const [minSpend, setMinSpend] = useState(50);
  const [budget, setBudget] = useState(50);
  const [currency, setCurrency] = useState('USD');
  // Mirrors `isDenominated` on the server: a promotion carrying an AMOUNT needs a
  // currency; a bare percentage does not.
  const needsCurrency = rewardKind === 'fixed' || type === 'cart_threshold' || type === 'loss_leader';


  const load = useCallback(async (org: string) => {
    if (!org) return;
    setRowsFailed(false);
    try { const r = await listPromotions(org); setRows(r.promotions); setUsage(r.usage); setError(null); }
    // NOT `setRows([])` — that renders "No promotions yet — Add a promotion
    // above…" beside the error Notice.
    catch (e) { setError(e instanceof Error ? e.message : t('loadFailed')); setRowsFailed(true); }
  }, [t]);
  useEffect(() => { if (orgId) void load(orgId); }, [orgId, load]);

  const add = useCallback(async () => {
    if (!orgId || !name.trim()) return;
    setBusy(true);
    try {
      await createPromotion(orgId, {
        name: name.trim(), type, reward: { kind: rewardKind, value: rewardValue },
        ...(type === 'cart_threshold' ? { minSpend } : {}),
        ...(type === 'product_discount' || type === 'loss_leader' ? { scope: { all: true } } : {}),
        ...(type === 'loss_leader' ? { budget: { maxDiscount: budget } } : {}),
        ...(needsCurrency ? { currency } : {}),
      });
      setName('');
      toast.success(t('promotionAdded'));
      await load(orgId);
    } catch (e) { toast.error(e instanceof Error ? e.message : t('addFailed')); }
    finally { setBusy(false); }
  }, [orgId, name, type, rewardKind, rewardValue, minSpend, budget, needsCurrency, currency, load, t]);

  const toggleActive = useCallback(async (p: Promotion) => {
    try { await updatePromotion(orgId, p.promotionId, { active: !p.active }); await load(orgId); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('updateFailed')); }
  }, [orgId, load, t]);

  const remove = useCallback(async (p: Promotion) => {
    if (!(await confirm({ title: t('deleteConfirm', { name: p.name }), danger: true, confirmLabel: t('common:delete') }))) return;
    try { await deletePromotion(orgId, p.promotionId); await load(orgId); toast.success(t('promotionDeleted')); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('deleteFailed')); }
  }, [orgId, load, t]);

  // PRO-G2 — a percentage reward got its `%`; a FIXED-amount reward rendered as a
  // bare number with no unit at all, so "10" could be 10 currency units or
  // anything else. A promotion carries no currency field, so (per the rule this
  // programme applied three times over) no symbol is invented — the reward KIND
  // is named instead, which is a fact we actually have.
  const rewardLabel = useCallback(
    (p: Promotion) => p.reward.kind === 'percentage'
      ? t('rewardPercent', { value: formatNumber(p.reward.value) })
      : t('rewardFixed', { value: formatNumber(p.reward.value) }),
    [t],
  );

  /**
   * PRO-G1 — `minSpend` and `budget.maxDiscount` ride in every payload and the
   * table showed neither: the two numbers that decide WHEN a promotion fires and
   * HOW MUCH it can cost. Two cart-threshold promotions differing only by
   * threshold were indistinguishable in the list.
   */
  const conditionLabels = useCallback((p: Promotion): string[] => {
    const out: string[] = [];
    if (p.minSpend !== undefined) out.push(t('condMinSpend', { value: formatNumber(p.minSpend) }));
    if (p.budget?.maxDiscount !== undefined) out.push(t('condBudget', { value: formatNumber(p.budget.maxDiscount) }));
    if (p.budget?.maxQuantity !== undefined) out.push(t('condMaxQty', { value: formatNumber(p.budget.maxQuantity) }));
    if (p.segmentId) out.push(t('condSegment', { segment: p.segmentId }));
    return out;
  }, [t]);

  const columns = useMemo<DataColumn<Promotion>[]>(() => [
    { key: 'name', header: t('colName'), render: (p) => p.name, sortValue: (p) => p.name },
    { key: 'type', header: t('colType'), render: (p) => t(`type_${p.type}`), sortValue: (p) => p.type },
    { key: 'reward', header: t('colReward'), render: (p) => rewardLabel(p) },
    { key: 'conditions', header: t('colConditions'), render: (p) => {
      const labels = conditionLabels(p);
      return labels.length === 0
        ? <span className="muted">{t('condNone')}</span>
        : <span className="u-flex u-gap-1 u-flex-wrap">{labels.map((l) => <span key={l} className="chip chip--muted">{l}</span>)}</span>;
    } },
    { key: 'priority', header: t('colPriority'), render: (p) => String(p.priority), sortValue: (p) => p.priority },
    { key: 'stackable', header: t('colStackable'), render: (p) => <span className={p.stackable ? 'chip chip--muted' : 'chip chip--warning'}>{p.stackable ? t('stackable') : t('exclusive')}</span> },
    { key: 'active', header: t('colActive'), render: (p) => {
      // R3 P-5 — a spent budget outranks the Active claim; burn shows beside it.
      const u = usage[p.promotionId];
      const spentOut = (p.budget?.maxDiscount !== undefined && (u?.amount ?? 0) >= p.budget.maxDiscount)
        || (p.budget?.maxQuantity !== undefined && (u?.quantity ?? 0) >= p.budget.maxQuantity);
      if (p.active && spentOut) return <span className="chip chip--warning">{t('exhausted')}</span>;
      return (
        <span className="u-flex u-items-center u-gap-1">
          <span className={p.active ? 'chip chip--success' : 'chip chip--muted'}>{p.active ? t('active') : t('paused')}</span>
          {u && p.budget?.maxDiscount !== undefined ? <span className="u-fs-12 muted">{t('burn', { spent: formatNumber(u.amount), cap: formatNumber(p.budget.maxDiscount) })}</span> : null}
        </span>
      );
    } },
    { key: 'actions', header: '', render: (p) => (
      <span className="action-bar">
        <Button variant="quiet" onClick={() => void toggleActive(p)} aria-label={t('toggleActiveLabel', { name: p.name })}>{p.active ? t('pause') : t('activate')}</Button>
        <Button variant="quiet" onClick={() => void remove(p)} aria-label={t('deleteRowLabel', { name: p.name })}>{t('common:delete')}</Button>
      </span>
    ) },
  ], [t, rewardLabel, conditionLabels, toggleActive, remove, usage]);

  // The toggle has not resolved yet — a shape-matched skeleton UNDER the real
  // header, not a `StateCard`: the card's only text would be the page title, so
  // it reads as a terminal answer, and it unmounts `PageHeader` on the way in and
  // out. (The corpus majority — `commerce`, `commerce-ucp-buyer`, `webinars`,
  // `creative-video` — keeps the header and swaps the body.)
  if (access.loading) {
    return (
      <section className="u-grid u-gap-4" data-walkthrough="promotions.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <SkeletonRows rows={3} columns={[160, 120, 80, 140, 70, 90, 90, 100]} />
      </section>
    );
  }
  if (!access.enabled) {
    return (
      <section className="u-grid u-gap-4" data-walkthrough="promotions.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </section>
    );
  }

  return (
    <section className="u-grid u-gap-4" data-walkthrough="promotions.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {/* HG-4 — the branch ORDER (failed → zero-orgs → children) and the NOUN
          are `OrgSelectionState`'s now. This page called the same `listOrgs`
          collection "stores" in its picker and "organizations" in its card; one
          screen does not get two nouns for one thing. Both org states still sit
          ABOVE the table, because the `empty=` slot is what BOTH of them
          rendered otherwise — a skeleton waiting on a promotions read that never
          starts, i.e. a `role="status"` "Loading…" live region with no terminal
          condition.

          It wraps the FORM too (the custom-domains shape). It did not, and the
          cost was the picker: outside the wrapper the org `<select>` still
          rendered in both org states, and in both of them `orgs` has no entries
          — a labelled combobox with nothing in it, announced as "Organization,
          combo box, 0 items". A control with no options is not a control; the
          card that replaces it says what happened. With no organization the
          submit could not write anything anyway (`disabled={… || !orgId}`).
          Loading keeps a real placeholder option, because that state DOES render
          the form and an empty combobox is no better there. */}
      <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')} icon={<ZapIcon />}>
      <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <SelectField label={t('ui:orgPickerLabel')} value={orgId} onChange={(e) => setOrgId(e.target.value)}>
          {orgs === null ? <option value="">{t('ui:orgPickerLoading')}</option> : null}
          {(orgs ?? []).map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </SelectField>
        <TextField label={t('fieldName')} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} required />
        <SelectField label={t('fieldType')} value={type} onChange={(e) => setType(e.target.value as PromotionType)}>
          {PROMOTION_TYPES.map((ty) => <option key={ty} value={ty}>{t(`type_${ty}`)}</option>)}
        </SelectField>
        <SelectField label={t('fieldRewardKind')} value={rewardKind} onChange={(e) => setRewardKind(e.target.value as RewardKind)}>
          {REWARD_KINDS.map((k) => <option key={k} value={k}>{t(`reward_${k}`)}</option>)}
        </SelectField>
        {/* The reward value's MEANING flips with the kind beside it — percent vs
            a bare amount — and the bare number gave no clue which. That help slot
            was the stated reason this migration was worth doing rather than a
            pure like-for-like swap (PRO-G3). */}
        <TextField
          className="is-narrow"
          label={t('fieldRewardValue')}
          help={rewardKind === 'percentage' ? t('rewardValueHelpPercent') : t('rewardValueHelpFixed')}
          type="number" min={0} value={rewardValue}
          onChange={(e) => setRewardValue(Math.max(0, Number(e.target.value) || 0))}
        />
        {type === 'cart_threshold' ? (
          <TextField className="is-narrow" label={t('fieldMinSpend')} type="number" min={0} value={minSpend}
            onChange={(e) => setMinSpend(Math.max(0, Number(e.target.value) || 0))} />
        ) : null}
        {type === 'loss_leader' ? (
          <TextField className="is-narrow" label={t('fieldBudget')} help={t('fieldBudgetHelp')} type="number" min={1} value={budget}
            onChange={(e) => setBudget(Math.max(1, Number(e.target.value) || 1))} />
        ) : null}
        {/* R2 PRO2-P1 — the amounts above only mean something in a currency, and the
            catalog is multi-currency. Captured at INTAKE because nothing can reconstruct
            afterwards what a stored "spend 50, get 10 off" was denominated in. A pure
            percentage with no threshold and no budget needs none. */}
        {needsCurrency ? (
          <SelectField className="is-narrow" label={t('fieldCurrency')} help={t('fieldCurrencyHelp')} value={currency}
            onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </SelectField>
        ) : null}
        <Button variant="primary" type="submit" disabled={busy || !orgId || !name.trim()}>{t('addPromotion')}</Button>
      </form>

      {type === 'loss_leader' ? <Notice variant="info">{t('lossLeaderHint')}</Notice> : null}

      {(rows?.length ?? 0) > 3 ? (
        <div className="filterbar" role="group" aria-label={t('filterGroup')}>
          <input
            type="search"
            className="ui-input filterbar-search"
            placeholder={t('filterPlaceholder')}
            aria-label={t('filterAria')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      ) : null}
            <DataTable
        stack
        rows={visibleRows}
        rowKey={(p) => p.promotionId}
        columns={columns}
        caption={t('captionPromotions')}
        empty={rowsFailed
          ? <StateCard announce icon={<ZapIcon />} title={t('rowsFailedTitle')} body={t('rowsFailedBody')} action={<Button variant="secondary" onClick={() => void load(orgId)}>{t('orgsRetry')}</Button>} />
          : rows === null
          ? <SkeletonRows rows={3} columns={[160, 120, 80, 140, 70, 90, 90, 100]} />
          : query
            ? <StateCard icon={<ZapIcon />} title={t('noMatchTitle')} body={t('noMatchBody')} action={<Button variant="secondary" onClick={() => setQuery('')}>{t('clearSearch')}</Button>} />
            : <StateCard icon={<ZapIcon />} title={t('noPromotionsTitle')} body={t('noPromotionsBody')} />}
      />
      </OrgSelectionState>
    </section>
  );
}
