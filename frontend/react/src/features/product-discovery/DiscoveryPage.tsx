/**
 * Discovery admin page (ADR 0275 / MERCH-C). Merchandiser console: manage collections
 * (manual + dynamic-by-category), a simple merch-rule (hide a category), and preview
 * faceted search. Gated by the `discovery` toggle.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { TextField, SelectField } from '../../ui/Field.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import { BoxesIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { formatCurrency, formatNumber } from '../../i18n/format.js';
import {
  listOrgs, listCollections, createCollection, deleteCollection,
  listRules, createRule, deleteRule, search,
  type Org, type Collection, type MerchRule, type SearchResponse,
} from './discoveryClient.js';

/** How many preview rows/facet values the console shows. Exported as named
 *  constants so the "showing N of M" copy can never drift from the slice. */
const PRODUCT_CAP = 12;
const FACET_CAP = 3;

export function DiscoveryPage(): JSX.Element {
  const { t } = useTranslation('product-discovery');
  // `useFeatureAccess` returns an OBJECT, so the previous `const enabled = …`
  // + `if (!enabled)` was ALWAYS truthy: the "not enabled" branch below was dead
  // and this page rendered regardless of its toggle. (The object-ness was visible
  // one line down, where `enabled.enabled` is what the org read already used.)
  // Destructure the flag, and keep the org read gated on it so a disabled feature
  // touches no network.
  const access = useFeatureAccess('discovery');

  // `.catch(() => setOrgs([]))` left `orgId` '' — the load below is gated on
  // it, so the table's `empty=` slot rendered its loading skeleton forever,
  // while the selector claimed there were no stores. `orgs` was declared
  // non-nullable here, so `[]` was the ONLY value a failure could take.
  //
  // CORRECTION (HG-1) — only the FAILED half of that ever landed. A SUCCESSFUL
  // read of `[]` leaves `orgId` '' just the same, so BOTH tables' skeletons were
  // still terminal-condition-free on the commonest first-run path of all: a tenant
  // with no store yet. Both org states now have their own branch that stands in
  // for the whole store-scoped block below, and the failed one REPLACES it instead
  // of hanging a banner beside two skeletons that keep spinning under it.
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs, access.enabled);
  const [collections, setCollections] = useState<Collection[] | null>(null);
  // PD-G3 — `rules` was `[]` from the start, so "still loading" and "the load
  // failed" both rendered as "no rules". A merch rule HIDES products from
  // shoppers, so "are there any?" has to be answerable. Null = not yet known.
  const [rules, setRules] = useState<MerchRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The rows read FAILED — distinct from "this store has none yet". */
  // R2 PD2-2 — ONE flag for both store-scoped reads: they load together and fail
  // together, and a per-table flag is how the rules table kept its empty state on a
  // failed load. Named for what it covers, not for one of its two consumers.
  const [rowsFailed, setRowsFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const [colName, setColName] = useState('');
  const [colType, setColType] = useState<'manual' | 'dynamic'>('dynamic');
  const [colCategory, setColCategory] = useState('');
  const [ruleName, setRuleName] = useState('');
  const [ruleCategory, setRuleCategory] = useState('');
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<SearchResponse | null>(null);
  // R3 PD2-8 — a failed search must not leave the PREVIOUS query's results
  // standing as the new query's answer; the toast vanishes in 5s, the wrong
  // list does not. Failure clears the panel and states itself persistently.
  const [searchFailed, setSearchFailed] = useState(false);


  const load = useCallback(async (org: string) => {
    if (!org) return;
    setRowsFailed(false);
    try { const [c, r] = await Promise.all([listCollections(org), listRules(org)]); setCollections(c); setRules(r); setError(null); }
    // NOT `setCollections([])` — that lands on "No collections yet — Add a
    // collection above…", an instruction rendered BESIDE the error Notice. The
    // instruction is the half that reads as the answer.
    // R2 PD2-2 — `setRules([])` landed the RULES table on its EMPTY state, whose body
    // reads "None are active, so shoppers see everything" — a designed, commercially
    // consequential falsehood rendered two inches under the error banner. The comment
    // above explains exactly why that is wrong, for collections, on the previous line.
    // One failure flag now feeds BOTH tables.
    catch (e) { setError(e instanceof Error ? e.message : t('loadFailed')); setRowsFailed(true); setRules([]); }
  }, [t]);
  useEffect(() => { if (orgId) void load(orgId); }, [orgId, load]);

  const addCollection = useCallback(async () => {
    if (!orgId || !colName.trim()) return;
    setBusy(true);
    try {
      await createCollection(orgId, colType === 'dynamic'
        ? { name: colName.trim(), type: 'dynamic', rule: { categories: colCategory.trim() ? [colCategory.trim().toLowerCase()] : [] } }
        : { name: colName.trim(), type: 'manual', productIds: [] });
      setColName(''); setColCategory('');
      toast.success(t('collectionAdded'));
      await load(orgId);
    } catch (e) { toast.error(e instanceof Error ? e.message : t('addFailed')); }
    finally { setBusy(false); }
  }, [orgId, colName, colType, colCategory, load, t]);

  const removeCollection = useCallback(async (c: Collection) => {
    if (!(await confirm({ title: t('deleteCollectionConfirm', { name: c.name }), danger: true, confirmLabel: t('common:delete') }))) return;
    try { await deleteCollection(orgId, c.collectionId); await load(orgId); toast.success(t('collectionDeleted')); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('deleteFailed')); }
  }, [orgId, load, t]);

  const addRule = useCallback(async () => {
    if (!orgId || !ruleName.trim() || !ruleCategory.trim()) return;
    setBusy(true);
    try {
      await createRule(orgId, { name: ruleName.trim(), scope: 'all', actions: [{ kind: 'hide', predicate: { categories: [ruleCategory.trim().toLowerCase()] } }] });
      setRuleName(''); setRuleCategory('');
      toast.success(t('ruleAdded'));
      await load(orgId);
    } catch (e) { toast.error(e instanceof Error ? e.message : t('addFailed')); }
    finally { setBusy(false); }
  }, [orgId, ruleName, ruleCategory, load, t]);

  const removeRule = useCallback(async (r: MerchRule) => {
    if (!(await confirm({ title: t('deleteRuleConfirm', { name: r.name }), danger: true, confirmLabel: t('common:delete') }))) return;
    try { await deleteRule(orgId, r.ruleId); await load(orgId); toast.success(t('ruleDeleted')); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('deleteFailed')); }
  }, [orgId, load, t]);

  const runSearch = useCallback(async () => {
    setBusy(true);
    try {
      setPreview(await search(orgId, query.trim()));
      setSearchFailed(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('searchFailed'));
      setPreview(null); // never the previous query's answer
      setSearchFailed(true);
    }
    finally { setBusy(false); }
  }, [orgId, query, t]);

  const colColumns = useMemo<DataColumn<Collection>[]>(() => [
    { key: 'name', header: t('colName'), render: (c) => c.name, sortValue: (c) => c.name },
    { key: 'type', header: t('colType'), render: (c) => <span className={c.type === 'dynamic' ? 'chip chip--accent' : 'chip chip--muted'}>{t(`type_${c.type}`)}</span> },
    { key: 'detail', header: t('colDetail'), render: (c) => c.type === 'dynamic' ? (c.rule?.categories?.join(', ') ?? '—') : t('itemsCount', { count: c.productIds?.length ?? 0 }) },
    { key: 'actions', header: '', render: (c) => <Button variant="quiet" onClick={() => void removeCollection(c)} aria-label={t('deleteRowLabel', { name: c.name })}>{t('common:delete')}</Button> },
  ], [t, removeCollection]);

  const ruleColumns = useMemo<DataColumn<MerchRule>[]>(() => [
    { key: 'name', header: t('colName'), render: (r) => r.name, sortValue: (r) => r.name },
    { key: 'scope', header: t('colScope'), render: (r) => r.scope },
    { key: 'holdout', header: t('colHoldout'), render: (r) => (r.holdoutPct ? `${r.holdoutPct}%` : '—') },
    { key: 'actions', header: '', render: (r) => <Button variant="quiet" onClick={() => void removeRule(r)} aria-label={t('deleteRowLabel', { name: r.name })}>{t('common:delete')}</Button> },
  ], [t, removeRule]);

  // The toggle has not resolved yet — a shape-matched skeleton UNDER the real
  // header, not a `StateCard`: the card's only text would be the page title, so
  // it reads as a terminal answer, and it unmounts `PageHeader` on the way in and
  // out. (The corpus majority — `commerce`, `commerce-ucp-buyer`, `webinars`,
  // `creative-video` — keeps the header and swaps the body.)
  if (access.loading) {
    return (
      <section className="u-grid u-gap-4" data-walkthrough="discovery.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <SkeletonRows rows={3} columns={[160, 90, 160, 80]} />
      </section>
    );
  }
  if (!access.enabled) {
    return (
      <section className="u-grid u-gap-4" data-walkthrough="discovery.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </section>
    );
  }

  return (
    <section className="u-grid u-gap-4" data-walkthrough="discovery.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {/* HG-4 — the branch ORDER (failed → zero-orgs → children) and the NOUN
          are `OrgSelectionState`'s now; this page called the same `listOrgs`
          collection "stores" in its picker and "organizations" in its card. One
          org-state card still covers the WHOLE store-scoped block — both tables
          and the rule form between them — because both `empty=` slots otherwise
          render a skeleton waiting on the same read that never starts.
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
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')} icon={<BoxesIcon />}>
      <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void addCollection(); }}>
        <SelectField label={t('ui:orgPickerLabel')} value={orgId} onChange={(e) => setOrgId(e.target.value)}>
          {orgs === null ? <option value="">{t('ui:orgPickerLoading')}</option> : null}
          {(orgs ?? []).map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </SelectField>
        <TextField label={t('fieldCollectionName')} value={colName} onChange={(e) => setColName(e.target.value)} placeholder={t('collectionPlaceholder')} required />
        <SelectField label={t('fieldType')} value={colType} onChange={(e) => setColType(e.target.value as 'manual' | 'dynamic')}>
          <option value="dynamic">{t('type_dynamic')}</option>
          <option value="manual">{t('type_manual')}</option>
        </SelectField>
        {colType === 'dynamic' ? (
          <TextField label={t('fieldCategory')} help={t('fieldCategoryHelp')} value={colCategory} onChange={(e) => setColCategory(e.target.value)} placeholder={t('categoryPlaceholder')} />
        ) : null}
        <Button variant="primary" type="submit" disabled={busy || !orgId || !colName.trim()}>{t('addCollection')}</Button>
      </form>

      {/* Branch order is load-bearing, and the branch covers the WHOLE
          store-scoped block — both tables and the rule form between them — because
          both tables' `empty=` slots rendered a skeleton waiting on the same read
          that never starts. One org-state card, not two identical ones. */}
            <>
      <DataTable stack rows={collections ?? []} rowKey={(c) => c.collectionId} columns={colColumns} caption={t('captionCollections')}
        empty={rowsFailed
          ? <StateCard announce icon={<BoxesIcon />} title={t('rowsFailedTitle')} body={t('rowsFailedBody')} action={<Button variant="secondary" onClick={() => void load(orgId)}>{t('orgsRetry')}</Button>} />
          : collections === null ? <SkeletonRows rows={2} columns={[160, 90, 160, 80]} /> : <StateCard icon={<BoxesIcon />} title={t('noCollectionsTitle')} body={t('noCollectionsBody')} />} />

      <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void addRule(); }}>
        <h2 className="u-label-sm">{t('rulesTitle')}</h2>
        <TextField label={t('fieldRuleName')} value={ruleName} onChange={(e) => setRuleName(e.target.value)} placeholder={t('rulePlaceholder')} required />
        {/* This hides matching products from the live storefront — the help slot
            is where that consequence belongs, and it was the reason this
            migration was worth more than a like-for-like swap. */}
        <TextField label={t('fieldHideCategory')} help={t('fieldHideCategoryHelp')} value={ruleCategory} onChange={(e) => setRuleCategory(e.target.value)} placeholder={t('categoryPlaceholder')} required />
        <Button variant="primary" type="submit" disabled={busy || !orgId || !ruleName.trim() || !ruleCategory.trim()}>{t('addRule')}</Button>
      </form>

      {/* PD-G3 — collections get a skeleton and a designed empty state; the rules
          table rendered NOTHING at all when empty, so a merchandiser could not
          tell "no rules" from "not loaded". Same treatment for both. */}
      <DataTable stack rows={rules ?? []} rowKey={(r) => r.ruleId} columns={ruleColumns} caption={t('captionRules')}
        empty={rowsFailed
          ? <StateCard announce icon={<BoxesIcon />} title={t('rulesFailedTitle')} body={t('rulesFailedBody')} action={<Button variant="secondary" onClick={() => void load(orgId)}>{t('orgsRetry')}</Button>} />
          : rules === null ? <SkeletonRows rows={2} columns={[160, 90, 80, 80]} /> : <StateCard icon={<BoxesIcon />} title={t('noRulesTitle')} body={t('noRulesBody')} />} />

      {/* INSIDE the wrapper, and it was not. Taking `children` stops a caller
          rendering content ABOVE the guard, but a sibling BELOW it escapes the
          branch order just as completely: this search console rendered in full
          over a failed organization read, with a submit that `!orgId` made
          silently inert. A search box you can type into and press that answers
          nothing is a worse account of the failure than no search box. */}
      <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void runSearch(); }}>
        <TextField label={t('fieldSearch')} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('searchPlaceholder')} />
        <Button variant="primary" type="submit" disabled={busy || !orgId}>{t('runSearch')}</Button>
        {searchFailed ? (
          <Notice variant="error" announce={t('searchFailedPersistent')}>{t('searchFailedPersistent')} <Button variant="quiet" size="sm" onClick={() => void runSearch()}>{t('common:retry')}</Button></Notice>
        ) : null}
        {preview ? (
          <div className="u-grid u-gap-2">
            {preview.facets.length > 0 ? (
              <div className="action-bar u-flex-wrap">
                {preview.facets.flatMap((f) => f.values.slice(0, FACET_CAP).map((v) => (
                  <span key={`${f.key}:${v.value}`} className="chip chip--muted">{f.label}: {v.value} ({formatNumber(v.count)})</span>
                )))}
                {/* PD-G2 — a facet with more values than the cap used to drop the
                    rest in silence, which reads as "these are all the values". */}
                {/* R2 PD2-9 — `values.length` is already capped at 30 server-side, so a
                    facet with 200 distinct values was truncated twice and its real
                    cardinality was invisible at both layers. */}
                {/* Review M2 — `totalValues > 3 ⟺ values.length > 3` for every input (the
                    server cap is 30), so keying the CONDITION off it changed nothing. The
                    point of the field is the NUMBER: say "of how many". */}
                {preview.facets.some((f) => (f.totalValues ?? f.values.length) > FACET_CAP)
                  ? <span className="u-text-sm muted">{t('facetsTruncated', { shown: FACET_CAP, total: formatNumber(Math.max(...preview.facets.map((f) => f.totalValues ?? f.values.length))) })}</span>
                  : null}
              </div>
            ) : null}
            {/* Review M1 — the hidden-by-rules line lived inside the non-empty branch, so
                when hide rules removed EVERY match the operator got a bare "No products
                matched" — the one case where "where did they go?" most needs answering. */}
            {preview.hiddenByRules ? (
              <p className="u-text-sm muted u-m-0">{t('hiddenByRules', { count: preview.hiddenByRules, formatted: formatNumber(preview.hiddenByRules) })}</p>
            ) : null}
            {preview.products.length === 0 ? <Notice variant="info">{t('searchEmpty')}</Notice> : (
              <>
                <ul className="u-grid u-gap-1">
                  {/* PD-G1 — was `{p.price} {p.currency}`: a bare number and a
                      code ("1299.5 USD") where every other money surface in this
                      app renders locale-formatted currency. */}
                  {preview.products.slice(0, PRODUCT_CAP).map((p) => (
                    <li key={p.productId}>{p.name} — {formatCurrency(p.price, p.currency)}</li>
                  ))}
                </ul>
                {/* PD-G2 — the list silently stopped at 12. The count is known
                    client-side, so say it rather than imply the result set ends. */}
                {/* R2 PD2-3 — `preview.products.length` IS the server's page cap, so the
                    round-1 line stated the cap as the total ("first 12 of 48" for a
                    5,000-product catalog) — a cap reading as completeness more
                    convincingly than before it was "fixed". Use the real match count. */}
                {preview.total > PRODUCT_CAP ? (
                  <p className="u-text-sm muted u-m-0">
                    {t('productsTruncated', { shown: Math.min(PRODUCT_CAP, preview.products.length), total: formatNumber(preview.total) })}
                  </p>
                ) : null}
                {/* …and a preview shortened by HIDE rules says so: "where did that
                    product go?" is the question this screen exists to answer. */}

              </>
            )}
          </div>
        ) : null}
      </form>
      </>
      </OrgSelectionState>
    </section>
  );
}
