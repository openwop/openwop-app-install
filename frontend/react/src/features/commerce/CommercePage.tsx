/**
 * Commerce admin (gap plan §5C C1) — the visibility gap closed: products, orders,
 * quotes, contract pricing, and the one-read revenue report, per org, over the
 * ADR 0177/0221 routes (so audit rows, host events, and the B3 approval
 * thresholds are inherited, never reimplemented). The AI surface is the shared
 * EmbeddedChatPanel scoped to the Store Assistant (ADR 0073 — no second chat).
 * Money-adjacent actions can 409 `approval_required` — surfaced as a notice
 * pointing at the reviews inbox, retry after sign-off.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { InlineState } from '../../ui/InlineState.js';
import { Field, CheckboxField } from '../../ui/Field.js';
import { Notice } from '../../ui/Notice.js';
import { toast } from '../../ui/toast.js';
import { confirm } from '../../ui/confirm.js';
import { PackageIcon, ClipboardIcon } from '../../ui/icons/index.js';
import { Link, useSearchParams } from 'react-router-dom';
import { Tabs, TabPanel, useUrlTab } from '../../ui/Tabs.js';
import { actionError, StatusChip, OrderActions } from './commerceShared.js';
import { scrollBehavior } from '../../ui/motion.js';
import { KeyFigureBand } from '../../ui/KeyFigure.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { EmbeddedChatPanel } from '../../chat/EmbeddedChatPanel.js';
import { useFormat } from '../../i18n/useFormat.js';
import { copyToClipboard } from '../../ui/copyToClipboard.js';
import {
  listOrgs, listProducts, createProduct, updateProduct, deleteProduct,
  listProductFields, createProductField, deleteProductField,
  listOrders,
  listQuotes, createQuote, sendQuote, declineQuote, acceptQuote, createQuoteShareLink,
  listPriceLists, createPriceList, deletePriceList, resolvePrice,
  listCoupons, createCoupon, commerceSummary, storefrontPath,
  CURRENCIES,
  type Org, type Product, type Order, type Quote, type PriceList, type CommerceSummary, type Coupon,
  type ProductFieldDef, type ProductFieldType,
} from './commerceClient.js';

type Tab = 'products' | 'orders' | 'quotes' | 'pricing' | 'reports' | 'assistant';
const TABS: Tab[] = ['products', 'orders', 'quotes', 'pricing', 'reports', 'assistant'];

// Collection kit (§4.5 rule 13) — facet vocabularies reuse the existing
// status_* chip keys (StatusChip), so labels can't drift from the chips.
const ORDER_STATUSES = ['pending', 'paid', 'fulfilled', 'refunding', 'refunded', 'partially_refunded', 'canceled'] as const;
const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired'] as const;
const PRODUCT_TYPES = ['physical', 'digital', 'service'] as const;

export function CommercePage(): JSX.Element {
  const { t } = useTranslation('commerce');
  const access = useFeatureAccess('commerce');
  const [searchParams, setSearchParams] = useSearchParams();
  /** The shared read. CM-R2-1's local fix wrote `setOrgs([])` beside an
   *  `orgsFailed` flag — so `orgs.length === 0` meant both "no stores" and
   *  "could not read", and only the flag separated them. The hook keeps `orgs`
   *  null on failure; `?org=` is honoured when the read confirms it exists. */
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } =
    useOrgSelection<Org>(listOrgs, access.enabled, searchParams.get('org') ?? '');
  const [tab, setTab] = useUrlTab<Tab>('tab', TABS, 'products');

  // Deep-link spine: the active store rides `?org=` so a commerce link lands on
  // the right org (URL wins when it names an accessible org, else the first
  // org). Reads the param one-shot at load; user switches persist it back.
  const selectOrg = useCallback((id: string): void => {
    setOrgId(id);
    setSearchParams((p) => { const n = new URLSearchParams(p); n.set('org', id); return n; }, { replace: true });
    // `setOrgId` comes from `ui/useOrgSelection` now rather than from a local
    // `useState`, so the linter can no longer prove it stable across renders.
    // It IS — the hook returns the raw setter — but declaring it is cheaper than
    // asserting it, and a suppression here would outlive the reason for it.
  }, [setSearchParams, setOrgId]);

  if (access.loading) return <div className="u-grid u-gap-4"><PageHeader eyebrow={t('eyebrow')} title={t('title')} /><Skeleton /></div>;
  if (!access.enabled) return <section className="u-grid u-gap-4"><PageHeader eyebrow={t('eyebrow')} title={t('title')} /><StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} /></section>;

  const orgPicker = orgs && orgs.length > 0 ? (
    <div className="action-bar u-items-center u-gap-2">
      <a className="u-text-sm" href={storefrontPath(orgId)} target="_blank" rel="noreferrer">{t('viewStorefront')}</a>
      <select value={orgId} onChange={(e) => selectOrg(e.target.value)} className="u-w-auto" aria-label={t('ui:orgPickerLabel')}>
        {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
      </select>
    </div>
  ) : null;

  return (
    <section className="u-grid u-gap-4" data-walkthrough="commerce.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={orgPicker} />
      <OrgSelectionState
        orgs={orgs}
        orgsFailed={orgsFailed}
        retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')}
        failedBody={t('orgsFailedClause')}
      >
        {/* Same loading gate as `production`: the shared component renders
            children while the org read is in flight, so without `orgId` the
            tabs would fetch for an organization nobody selected. */}
        {!orgId ? <Skeleton /> : (
        <>
          {/* The ONE tablist primitive (DESIGN.md §5 — MUST NOT hand-roll a second
              role=tablist): roving tabindex + aria-controls/labelledby wiring. */}
          <Tabs
            idBase="commerce"
            label={t('tabsLabel')}
            value={tab}
            onChange={setTab}
            items={TABS.map((k) => ({ id: k, label: t(`tab_${k}`) }))}
          />
          <TabPanel idBase="commerce" tabId={tab}>
            {tab === 'products' ? <ProductsTab orgId={orgId} focusId={searchParams.get('product') ?? undefined} /> : null}
            {tab === 'orders' ? <OrdersTab orgId={orgId} /> : null}
            {tab === 'quotes' ? <QuotesTab orgId={orgId} focusId={searchParams.get('quote') ?? undefined} /> : null}
            {tab === 'pricing' ? <PricingTab orgId={orgId} /> : null}
            {tab === 'reports' ? <ReportsTab orgId={orgId} /> : null}
            {tab === 'assistant' ? <AssistantTab /> : null}
          </TabPanel>
        </>
        )}
      </OrgSelectionState>
    </section>
  );
}

function ProductsTab({ orgId, focusId }: { orgId: string; focusId?: string | undefined }): JSX.Element {
  const { t } = useTranslation('commerce');
  const fmt = useFormat();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null); // ADR 0257 — the row being edited in place
  const [managingFields, setManagingFields] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // CM-R2-2 — the reload-after-action path must keep the honesty the initial
  // load has (the quotes section three screens down is the in-file precedent).
  const reload = useCallback(() => { setLoadError(false); void listProducts(orgId).then(setProducts).catch(() => setLoadError(true)); }, [orgId]);
  // grade-code H2/H3: active-flag guard (last org wins, not last response) + a
  // distinct error state (not "no products").
  useEffect(() => { let active = true; setProducts(null); setLoadError(false); void listProducts(orgId).then((r) => { if (active) setProducts(r); }).catch(() => { if (active) { setLoadError(true); setProducts([]); } }); return () => { active = false; }; }, [orgId]);

  // Deep-link spine (Phase 2): `?tab=products&product=<id>` opens that product's
  // inline editor once its row loads (e.g. from a Reports low-stock link).
  const focusConsumed = useRef(false);
  useEffect(() => {
    if (focusConsumed.current || products === null || !focusId) return;
    const match = products.find((p) => p.productId === focusId);
    if (match) { setEditing(match); setCreating(false); }
    focusConsumed.current = true;
  }, [products, focusId]);

  const remove = useCallback(async (p: Product) => {
    if (!(await confirm({ title: t('deleteProductTitle', { name: p.name }), body: t('deleteProductBody'), danger: true, confirmLabel: t('delete') }))) return;
    try { await deleteProduct(orgId, p.productId); toast.info(t('deleted')); reload(); } catch (e) { actionError(e, t); }
  }, [orgId, reload, t]);

  const toggleActive = useCallback(async (p: Product) => {
    try { await updateProduct(orgId, p.productId, { active: !p.active }); reload(); } catch (e) { actionError(e, t); }
  }, [orgId, reload, t]);

  // Collection kit (§4.5 rule 13): gated search + type/state facets → separate memo.
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'' | Product['type']>('');
  const [stateFilter, setStateFilter] = useState<'' | 'active' | 'archived'>('');
  const visibleProducts = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (products ?? []).filter((p) =>
      (!q || p.name.toLowerCase().includes(q) || (p.tags ?? []).some((tag) => tag.toLowerCase().includes(q)))
      && (!typeFilter || p.type === typeFilter)
      && (!stateFilter || (stateFilter === 'active') === p.active));
  }, [products, query, typeFilter, stateFilter]);
  const clearFilters = useCallback(() => { setQuery(''); setTypeFilter(''); setStateFilter(''); }, []);

  return (
    <div className="surface-card u-p-4 u-grid u-gap-3">
      <div className="action-bar u-justify-between u-items-center">
        <div><strong>{t('productsTitle')}</strong><p className="u-m-0 u-text-sm muted">{t('productsHint')}</p></div>
        <div className="action-bar u-gap-1">
          <Button variant="secondary" onClick={() => setManagingFields((v) => !v)}>{managingFields ? t('cancel') : t('manageFields')}</Button>
          <Button variant="primary" onClick={() => { setEditing(null); setCreating((v) => !v); }}>{creating ? t('cancel') : t('newProduct')}</Button>
        </div>
      </div>
      {managingFields ? <ProductFieldsManager orgId={orgId} /> : null}
      {creating ? <ProductForm orgId={orgId} onDone={() => { setCreating(false); reload(); }} onCancel={() => setCreating(false)} /> : null}
      {products !== null && products.length > 3 ? (
        <div className="filterbar" role="group" aria-label={t('filterGroup')}>
          <input
            type="search"
            className="ui-input filterbar-search"
            placeholder={t('filterProductsPlaceholder')}
            aria-label={t('filterProductsAria')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select className="ui-input filterbar-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as '' | Product['type'])} aria-label={t('filterTypeLabel')}>
            <option value="">{t('allTypes')}</option>
            {PRODUCT_TYPES.map((ty) => <option key={ty} value={ty}>{t(`type_${ty}`)}</option>)}
          </select>
          <select className="ui-input filterbar-select" value={stateFilter} onChange={(e) => setStateFilter(e.target.value as '' | 'active' | 'archived')} aria-label={t('filterStateLabel')}>
            <option value="">{t('allStates')}</option>
            <option value="active">{t('productState_active')}</option>
            <option value="archived">{t('productState_archived')}</option>
          </select>
        </div>
      ) : null}
      {products === null ? <Skeleton /> : loadError ? (
        <StateCard announce title={t('loadErrorTitle')} body={t('loadErrorBody')} action={<Button variant="primary" onClick={reload}>{t('retry')}</Button>} />
      ) : products.length === 0 ? (
        <StateCard icon={<PackageIcon />} title={t('noProducts')} body={t('noProductsBody')} action={<Button variant="primary" onClick={() => setCreating(true)}>{t('newProduct')}</Button>} />
      ) : visibleProducts.length === 0 ? (
        <StateCard icon={<PackageIcon />} title={t('noMatchTitle')} body={t('noMatchBody')} action={<Button variant="secondary" onClick={clearFilters}>{t('clearFilters')}</Button>} />
      ) : (
        <ul className="u-grid u-gap-2 u-list-none u-p-0 u-m-0">
          {visibleProducts.map((p) => (
            <li key={p.productId} className="u-grid u-gap-2">
              <div className="action-bar u-justify-between u-items-center u-gap-2">
                <div className="u-flex-1">
                  <div className="u-truncate"><strong>{p.name}</strong> <span className="chip">{t(`type_${p.type}`)}</span>{!p.active ? <span className="chip chip--warning">{t('inactive')}</span> : null}</div>
                  <div className="u-text-sm muted">
                    {fmt.currency(p.price, p.currency)}
                    {p.inventory !== undefined ? <> · {t('inStock', { count: p.inventory })}{p.lowStockThreshold !== undefined && p.inventory < p.lowStockThreshold ? <span className="chip chip--warning u-ml-1">{t('lowStock')}</span> : null}</> : null}
                    {(p.tags ?? []).length > 0 ? <> · {(p.tags ?? []).join(', ')}</> : null}
                  </div>
                </div>
                <div className="action-bar u-gap-1">
                  <Button variant="secondary" aria-expanded={editing?.productId === p.productId} {...(editing?.productId === p.productId ? { 'aria-controls': `product-edit-${p.productId}` } : {})} onClick={() => { setCreating(false); setEditing((cur) => (cur?.productId === p.productId ? null : p)); }}>{editing?.productId === p.productId ? t('cancel') : t('editProduct')}</Button>
                  <Button variant="secondary" onClick={() => void toggleActive(p)}>{p.active ? t('archive') : t('activate')}</Button>
                  <Button variant="secondary" onClick={() => void remove(p)}>{t('delete')}</Button>
                </div>
              </div>
              {editing?.productId === p.productId ? (
                <div id={`product-edit-${p.productId}`} role="region" aria-label={t('editRegionLabel', { name: p.name })} className="commerce-edit-region">
                  <ProductForm key={p.productId} orgId={orgId} product={p} onDone={() => { setEditing(null); reload(); }} onCancel={() => setEditing(null)} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** ADR 0257 — define/delete the store's typed product custom fields. */
function ProductFieldsManager({ orgId }: { orgId: string }): JSX.Element {
  const { t } = useTranslation('commerce');
  const [fields, setFields] = useState<ProductFieldDef[] | null>(null);
  // R2 CM-P2-M9 — the failure path used to `setFields([])`, so a read that never
  // returned rendered "No custom fields yet." — a claim about the store made on no data.
  const [fieldsFailed, setFieldsFailed] = useState(false);
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [type, setType] = useState<ProductFieldType>('string');
  const [options, setOptions] = useState('');
  const [required, setRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => { void listProductFields(orgId).then((f) => { setFields(f); setFieldsFailed(false); }).catch(() => { setFields([]); setFieldsFailed(true); }); }, [orgId]);
  useEffect(() => { reload(); }, [reload]);
  const add = useCallback(async () => {
    if (!key.trim() || !label.trim()) { toast.error(t('fieldKeyLabelRequired')); return; }
    setBusy(true);
    try {
      await createProductField(orgId, { key: key.trim(), label: label.trim(), type, required, ...(type === 'enum' ? { options: options.split(',').map((x) => x.trim()).filter(Boolean) } : {}) });
      setKey(''); setLabel(''); setOptions(''); setRequired(false); setType('string'); reload();
    } catch (e) { actionError(e, t); } finally { setBusy(false); }
  }, [orgId, key, label, type, options, required, reload, t]);
  const remove = useCallback(async (f: ProductFieldDef) => {
    if (!(await confirm({ title: t('deleteFieldTitle', { name: f.label }), body: t('deleteFieldBody'), danger: true, confirmLabel: t('delete') }))) return;
    try { await deleteProductField(orgId, f.defId); reload(); } catch (e) { actionError(e, t); }
  }, [orgId, reload, t]);
  return (
    <div className="surface-card u-p-3 u-grid u-gap-2">
      <div><strong>{t('productFieldsTitle')}</strong><p className="u-m-0 u-text-sm muted">{t('productFieldsHint')}</p></div>
      {(fields ?? []).length > 0 ? (
        <ul className="u-grid u-gap-1 u-list-none u-p-0 u-m-0">
          {(fields ?? []).map((f) => (
            <li key={f.defId} className="action-bar u-justify-between u-items-center u-text-sm">
              <span><code>{f.key}</code> · {f.label} <span className="chip">{f.type}</span>{f.required ? <span className="chip u-ml-1">{t('requiredChip')}</span> : null}</span>
              <Button variant="secondary" onClick={() => void remove(f)}>{t('delete')}</Button>
            </li>
          ))}
        </ul>
      ) : fieldsFailed ? (
        <InlineState kind="failed" message={t('productFieldsFailed')} announce={t('productFieldsFailed')} announcePolite action={<Button variant="secondary" onClick={reload}>{t('retry')}</Button>} />
      ) : <p className="u-m-0 u-text-sm muted">{t('noProductFields')}</p>}
      <div className="action-bar u-gap-2 u-items-end">
        <Field label={t('fieldKey')}>{(w) => <input {...w} value={key} onChange={(e) => setKey(e.target.value)} maxLength={60} />}</Field>
        <Field label={t('fieldLabel')}>{(w) => <input {...w} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} />}</Field>
        <Field label={t('fieldType')}>{(w) => (
          <select {...w} value={type} onChange={(e) => setType(e.target.value as ProductFieldType)}>
            {(['string', 'number', 'boolean', 'date', 'enum'] as ProductFieldType[]).map((ty) => <option key={ty} value={ty}>{t(`ftype_${ty}`)}</option>)}
          </select>
        )}</Field>
      </div>
      {type === 'enum' ? <Field label={t('fieldOptions')} help={t('fieldOptionsHint')}>{(w) => <input {...w} value={options} onChange={(e) => setOptions(e.target.value)} />}</Field> : null}
      <label className="action-bar u-gap-1 u-items-center u-text-sm"><input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /><span>{t('fieldRequired')}</span></label>
      <div><Button variant="primary" disabled={busy} onClick={() => void add()}>{t('addField')}</Button></div>
    </div>
  );
}

/** Create OR edit a product (ADR 0257 — the edit path lets typed customFields VALUES be
 *  changed after creation). One parameterized form: `product` present ⇒ edit mode. The caller
 *  MUST remount per target (`key={product.productId}`) so the prop-seeded state re-initializes. */
export function ProductForm({ orgId, product, onDone, onCancel }: { orgId: string; product?: Product; onDone: () => void; onCancel?: () => void }): JSX.Element {
  const { t } = useTranslation('commerce');
  const isEdit = !!product;
  const [name, setName] = useState(product?.name ?? '');
  const [type, setType] = useState<'physical' | 'digital' | 'service'>(product?.type ?? 'physical');
  // R2 CM-P2-M3 — currency is captured at INTAKE (immutable afterwards, like `type`), so
  // it has to be right the first time: nothing can reconstruct what a price meant later.
  const [currency, setCurrency] = useState<string>(product?.currency ?? 'USD');
  const [price, setPrice] = useState(product ? String(product.price) : '10');
  const [inventory, setInventory] = useState(product?.inventory !== undefined ? String(product.inventory) : '');
  const [threshold, setThreshold] = useState(product?.lowStockThreshold !== undefined ? String(product.lowStockThreshold) : '');
  const [weight, setWeight] = useState(product?.weightGrams !== undefined ? String(product.weightGrams) : ''); // ADR 0250 — shipping weight (grams) for carrier rate-shopping
  const [tags, setTags] = useState((product?.tags ?? []).join(', '));
  const [attributes, setAttributes] = useState<{ label: string; value: string }[]>(product?.attributes ?? []);
  const [fields, setFields] = useState<ProductFieldDef[]>([]); // ADR 0257 — org's typed field defs
  // R2 CM-P2-M9 — a failed defs read left `fields` at [] so NO custom-field inputs were
  // rendered, while `createProduct` still validates every REQUIRED one server-side: the
  // operator filled in a complete-looking form and got a generic error naming a field
  // they were never shown. Block the write instead of staging a guaranteed failure.
  const [fieldsFailed, setFieldsFailed] = useState(false);
  const [cf, setCf] = useState<Record<string, string | number | boolean>>(product?.customFields ?? {});
  // MERCH-E (ADR 0279) — subscribe-and-save opt-in.
  const [subEnabled, setSubEnabled] = useState(product?.subscription?.enabled ?? false);
  const [subSave, setSubSave] = useState(product?.subscription?.savePercent !== undefined ? String(product.subscription.savePercent) : '10');
  const [subIntervals, setSubIntervals] = useState<string[]>(product?.subscription?.intervals ?? ['monthly']);
  const subGroupId = useId();
  const [busy, setBusy] = useState(false);
  const setAttr = (i: number, patch: Partial<{ label: string; value: string }>): void => setAttributes((a) => a.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  const [fieldsReloads, setFieldsReloads] = useState(0);
  useEffect(() => {
    let active = true;
    void listProductFields(orgId)
      .then((f) => { if (active) { setFields(f); setFieldsFailed(false); } })
      .catch(() => { if (active) setFieldsFailed(true); });
    return () => { active = false; };
  }, [orgId, fieldsReloads]);

  const submit = useCallback(async () => {
    if (fieldsFailed) { toast.error(t('productFieldsBlockSave')); return; }
    if (!name.trim()) { toast.error(t('nameRequired')); return; }
    const priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum < 0) { toast.error(t('priceInvalid')); return; }
    setBusy(true);
    try {
      const cleanAttrs = attributes.map((a) => ({ label: a.label.trim(), value: a.value.trim() })).filter((a) => a.label && a.value);
      // Keep only the values the operator actually set (empty string ⇒ drop; boolean false and
      // number 0 are kept). On EDIT this whole map is sent so a cleared field is removed. A value
      // whose field-def was later deleted has no editor row, so it isn't rendered — but it stays
      // in `cf` and is preserved here (non-destructive: an orphaned value survives an unrelated edit).
      const customFields = Object.fromEntries(Object.entries(cf).filter(([, v]) => v !== '' && v !== undefined));
      const tagList = tags.trim() ? tags.split(',').map((x) => x.trim()).filter(Boolean) : [];
      if (product) {
        // Edit is WYSIWYG: send every editable field, using null/[]/{} to CLEAR, because the
        // PATCH route replaces a field only when its key is present. `type` and `currency` are
        // immutable (the PATCH route ignores them), so they are never sent and the type selector
        // is locked. `requireAll:false` on the server allows a partial edit.
        const numOrNull = (s: string): number | null => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : null);
        await updateProduct(orgId, product.productId, {
          name: name.trim(), price: priceNum,
          ...(type === 'physical' ? { inventory: numOrNull(inventory), lowStockThreshold: numOrNull(threshold), weightGrams: weight.trim() !== '' && Number(weight) > 0 ? Number(weight) : null } : {}),
          tags: tagList,
          attributes: cleanAttrs,
          customFields,
          subscription: subEnabled && subIntervals.length > 0 ? { enabled: true, intervals: subIntervals, ...(Number.isFinite(Number(subSave)) ? { savePercent: Number(subSave) } : {}) } : null,
        });
        toast.info(t('saved'));
      } else {
        await createProduct(orgId, {
          name: name.trim(), type, price: priceNum, currency,
          ...(inventory.trim() !== '' && Number.isFinite(Number(inventory)) ? { inventory: Number(inventory) } : {}),
          ...(threshold.trim() !== '' && Number.isFinite(Number(threshold)) ? { lowStockThreshold: Number(threshold) } : {}),
          ...(type === 'physical' && weight.trim() !== '' && Number(weight) > 0 ? { weightGrams: Number(weight) } : {}),
          ...(tagList.length ? { tags: tagList } : {}),
          ...(cleanAttrs.length ? { attributes: cleanAttrs } : {}),
          ...(Object.keys(customFields).length ? { customFields } : {}),
          ...(subEnabled && subIntervals.length > 0 ? { subscription: { enabled: true, intervals: subIntervals, ...(Number.isFinite(Number(subSave)) ? { savePercent: Number(subSave) } : {}) } } : {}),
        });
        toast.info(t('created'));
      }
      onDone();
    } catch (e) { actionError(e, t); } finally { setBusy(false); }
  }, [orgId, product, name, type, currency, price, inventory, threshold, weight, tags, attributes, cf, subEnabled, subSave, subIntervals, fieldsFailed, onDone, t]);

  return (
    <div className="surface-card u-p-3 u-grid u-gap-3">
      {/* Review I6 — a block with no way out left remounting the form as the only fix. */}
      {fieldsFailed ? (
        <Notice variant="warning" announce={t('productFieldsBlockSave')}>
          {t('productFieldsBlockSave')}{' '}
          <Button variant="link" onClick={() => setFieldsReloads((n) => n + 1)}>{t('retry')}</Button>
        </Notice>
      ) : null}
      <Field label={t('fieldName')} required>{(w) => <input {...w} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus />}</Field>
      <div className="action-bar u-gap-2">
        <Field label={t('fieldType')} help={isEdit ? t('typeLockedHint') : undefined}>{(w) => (
          <select {...w} value={type} disabled={isEdit} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="physical">{t('type_physical')}</option>
            <option value="digital">{t('type_digital')}</option>
            <option value="service">{t('type_service')}</option>
          </select>
        )}</Field>
        <Field label={t('fieldPriceIn', { currency })}>{(w) => <input {...w} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />}</Field>
        <Field label={t('fieldCurrency')} help={isEdit ? t('currencyLockedHint') : undefined}>{(w) => (
          <select {...w} value={currency} disabled={isEdit} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}</Field>
        {type === 'physical' ? (
          <>
            <Field label={t('fieldInventory')}>{(w) => <input {...w} inputMode="numeric" value={inventory} onChange={(e) => setInventory(e.target.value)} />}</Field>
            <Field label={t('fieldThreshold')}>{(w) => <input {...w} inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} />}</Field>
          </>
        ) : null}
      </div>
      {/* Weight sits on its own row (not the center-aligned action-bar) so its `help` line
          doesn't push its input above the inventory/threshold baseline. */}
      {type === 'physical' ? <Field label={t('fieldWeight')} help={t('fieldWeightHint')}>{(w) => <input {...w} inputMode="numeric" value={weight} onChange={(e) => setWeight(e.target.value)} />}</Field> : null}
      <Field label={t('fieldTags')} help={t('fieldTagsHint')}>{(w) => <input {...w} value={tags} onChange={(e) => setTags(e.target.value)} />}</Field>
      {/* ADR 0257 — typed custom fields (defined per store). One typed input per field def; a
          boolean uses the CheckboxField primitive (label-beside-box) rather than a raw checkbox
          under a field-label (DESIGN.md §5.1). */}
      {fields.map((f) => (
        f.type === 'boolean' ? (
          <CheckboxField key={f.defId} label={f.label} required={f.required} checked={cf[f.key] === true} onChange={(e) => setCf((c) => ({ ...c, [f.key]: e.target.checked }))} />
        ) : (
          <Field key={f.defId} label={f.label} required={f.required}>{(w) => (
            f.type === 'enum' ? (
              <select {...w} value={String(cf[f.key] ?? '')} onChange={(e) => setCf((c) => ({ ...c, [f.key]: e.target.value }))}>
                <option value="">{t('customFieldPick')}</option>
                {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input {...w} type={f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'number' ? 'decimal' : undefined}
                value={String(cf[f.key] ?? '')}
                onChange={(e) => setCf((c) => ({ ...c, [f.key]: f.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value }))} />
            )
          )}</Field>
        )
      ))}
      <div className="u-grid u-gap-1">
        <span className="u-label-sm">{t('fieldAttributes')}</span>
        <span className="u-label-sm muted">{t('fieldAttributesHint')}</span>
        {attributes.map((a, i) => (
          <div key={i} className="action-bar u-gap-1">
            <input value={a.label} onChange={(e) => setAttr(i, { label: e.target.value })} placeholder={t('attributeLabelPlaceholder')} aria-label={`${t('attributeLabelPlaceholder')} ${i + 1}`} maxLength={120} />
            <input value={a.value} onChange={(e) => setAttr(i, { value: e.target.value })} placeholder={t('attributeValuePlaceholder')} aria-label={`${t('attributeValuePlaceholder')} ${i + 1}`} maxLength={120} />
            <Button variant="secondary" onClick={() => setAttributes((arr) => arr.filter((_, idx) => idx !== i))} aria-label={`${t('attributeRemove')} ${i + 1}`}>{t('attributeRemove')}</Button>
          </div>
        ))}
        {attributes.length < 20 ? <div><Button variant="secondary" onClick={() => setAttributes((a) => [...a, { label: '', value: '' }])}>{t('attributeAdd')}</Button></div> : null}
      </div>
      {/* MERCH-E (ADR 0279) — subscribe-and-save opt-in. */}
      <div className="u-grid u-gap-1">
        <CheckboxField label={t('subEnable')} checked={subEnabled} onChange={(e) => setSubEnabled(e.target.checked)} />
        {subEnabled ? (
          <>
            <Field label={t('subSavePercent')} help={t('subSaveHint')}>{(w) => <input {...w} inputMode="numeric" value={subSave} onChange={(e) => setSubSave(e.target.value)} />}</Field>
            <span className="u-label-sm" id={`${subGroupId}-label`}>{t('subIntervals')}</span>
            <div className="action-bar u-gap-2" role="group" aria-labelledby={`${subGroupId}-label`}
              {...(subIntervals.length === 0 ? { 'aria-describedby': `${subGroupId}-req` } : {})}>
              {(['weekly', 'monthly', 'quarterly', 'yearly'] as const).map((iv) => (
                <CheckboxField key={iv} label={t(`subInterval_${iv}`)} checked={subIntervals.includes(iv)}
                  onChange={(e) => setSubIntervals((cur) => e.target.checked ? [...new Set([...cur, iv])] : cur.filter((x) => x !== iv))} />
              ))}
            </div>
            {subIntervals.length === 0 ? <Notice variant="warning" id={`${subGroupId}-req`}>{t('subIntervalsRequired')}</Notice> : null}
          </>
        ) : null}
      </div>
      <div className="action-bar u-gap-2">
        <Button variant="primary" disabled={busy || (subEnabled && subIntervals.length === 0)} onClick={() => void submit()}>{busy ? t(isEdit ? 'saving' : 'creating') : t(isEdit ? 'save' : 'create')}</Button>
        {onCancel ? <Button variant="secondary" disabled={busy} onClick={onCancel}>{t('cancel')}</Button> : null}
      </div>
    </div>
  );
}

function OrdersTab({ orgId }: { orgId: string }): JSX.Element {
  const { t } = useTranslation('commerce');
  const fmt = useFormat();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  // CM-R2-2 — same reload-honesty fix as products (the quotes precedent).
  const reload = useCallback(() => { setLoadError(false); void listOrders(orgId).then(setOrders).catch(() => setLoadError(true)); }, [orgId]);
  useEffect(() => { let active = true; setOrders(null); setLoadError(false); void listOrders(orgId).then((r) => { if (active) setOrders(r); }).catch(() => { if (active) { setLoadError(true); setOrders([]); } }); return () => { active = false; }; }, [orgId]);

  // Collection kit (§4.5 rule 13): gated search + status facet → separate memo.
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | (typeof ORDER_STATUSES)[number]>('');
  const visibleOrders = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (orders ?? []).filter((o) =>
      (!q || o.orderId.toLowerCase().includes(q) || (o.couponCode ?? '').toLowerCase().includes(q))
      && (!statusFilter || o.status === statusFilter));
  }, [orders, query, statusFilter]);

  return (
    <div className="surface-card u-p-4 u-grid u-gap-3">
      <div><strong>{t('ordersTitle')}</strong><p className="u-m-0 u-text-sm muted">{t('ordersHint')}</p></div>
      <Notice variant="info">{t('approvalHint')}</Notice>
      {orders !== null && orders.length > 3 ? (
        <div className="filterbar" role="group" aria-label={t('filterGroup')}>
          <input
            type="search"
            className="ui-input filterbar-search"
            placeholder={t('filterOrdersPlaceholder')}
            aria-label={t('filterOrdersAria')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select className="ui-input filterbar-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | (typeof ORDER_STATUSES)[number])} aria-label={t('filterOrderStatusLabel')}>
            <option value="">{t('allOrderStatuses')}</option>
            {ORDER_STATUSES.map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
          </select>
        </div>
      ) : null}
      {orders === null ? <Skeleton /> : loadError ? <StateCard announce title={t('loadErrorTitle')} body={t('loadErrorBody')} action={<Button variant="primary" onClick={reload}>{t('retry')}</Button>} /> : orders.length === 0 ? <StateCard title={t('noOrders')} body={t('noOrdersBody')} /> : visibleOrders.length === 0 ? (
        <StateCard title={t('noMatchTitle')} body={t('noMatchBody')} action={<Button variant="secondary" onClick={() => { setQuery(''); setStatusFilter(''); }}>{t('clearFilters')}</Button>} />
      ) : (
        <ul className="u-grid u-gap-2 u-list-none u-p-0 u-m-0">
          {visibleOrders.map((o) => (
            <li key={o.orderId} className="action-bar u-justify-between u-items-center u-gap-2">
              <div className="u-flex-1">
                <div className="u-truncate"><Link className="inline-link u-text-sm" to={`/commerce/orders/${encodeURIComponent(o.orderId)}?org=${encodeURIComponent(orgId)}`}>{o.orderId}</Link> <StatusChip value={o.status} /> {(o.status === 'paid' || o.status === 'fulfilled') ? <StatusChip value={o.fulfillmentStatus} /> : null}</div>
                <div className="u-text-sm muted">
                  {fmt.currency(o.total, o.currency)}
                  {(o.taxTotal ?? 0) > 0 ? <> · {t('taxLabel')} {fmt.currency(o.taxTotal!, o.currency)}</> : null}
                  {(o.shippingCost ?? 0) > 0 ? <> · {t('shippingLabel')} {fmt.currency(o.shippingCost!, o.currency)}</> : null}
                  {(o.refundedAmount ?? 0) > 0 ? <> · {t('refundedLabel')} {fmt.currency(o.refundedAmount!, o.currency)}</> : null}
                  {' · '}{t('itemCount', { count: o.items.length })} · {fmt.date(o.createdAt)}{o.couponCode ? <> · {o.couponCode}</> : null}
                </div>
              </div>
              <OrderActions orgId={orgId} order={o} onChanged={reload} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function QuotesTab({ orgId, focusId }: { orgId: string; focusId?: string | undefined }): JSX.Element {
  const { t } = useTranslation('commerce');
  const fmt = useFormat();
  const [quotes, setQuotes] = useState<Quote[] | null>(null);
  // Deep-link spine (Phase 2): `?tab=quotes&quote=<id>` scrolls to + highlights the row.
  const focusRef = useRef<HTMLLIElement | null>(null);
  // Scroll to + focus the deep-linked quote row so keyboard/SR users land on it
  // (grade-ux DL-UX-2); the row is tabIndex=-1 below.
  useEffect(() => { if (focusId && focusRef.current) { focusRef.current.scrollIntoView({ block: 'center', behavior: scrollBehavior() }); focusRef.current.focus({ preventScroll: true }); } }, [focusId, quotes]);
  const [products, setProducts] = useState<Product[]>([]);
  const [creating, setCreating] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const reload = useCallback(() => { setLoadError(false); void listQuotes(orgId).then(setQuotes).catch(() => setLoadError(true)); }, [orgId]);
  // grade-ux I4: a failed fetch is an ERROR state, not the empty "No quotes yet".
  useEffect(() => { let active = true; setQuotes(null); setLoadError(false); void listQuotes(orgId).then((r) => { if (active) setQuotes(r); }).catch(() => { if (active) { setLoadError(true); setQuotes([]); } }); void listProducts(orgId).then((r) => { if (active) setProducts(r); }).catch(() => { if (active) setProducts([]); }); return () => { active = false; }; }, [orgId]);

  const act = useCallback(async (fn: () => Promise<unknown>) => { try { await fn(); reload(); } catch (e) { actionError(e, t); } }, [reload, t]);
  const share = useCallback(async (q: Quote) => {
    try {
      const { token } = await createQuoteShareLink(orgId, q.quoteId);
      const url = `${window.location.origin}/shared/${token}`;
      // Was `await navigator.clipboard?.writeText(url)` followed by an
      // unconditional "copied" toast — with no clipboard the `?.` yields
      // undefined, the await resolves, and it claimed a copy that never happened.
      await copyToClipboard(url, t('quoteLinkCopied'));
    } catch (e) { actionError(e, t); }
  }, [orgId, t]);

  // Collection kit (§4.5 rule 13): gated search + status facet → separate memo.
  // The deep-linked ?quote= row always stays resolvable against the FULL list.
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | (typeof QUOTE_STATUSES)[number]>('');
  const visibleQuotes = useMemo(() => {
    const qq = query.trim().toLowerCase();
    return (quotes ?? []).filter((q) =>
      (!qq || q.quoteId.toLowerCase().includes(qq) || (q.note ?? '').toLowerCase().includes(qq))
      && (!statusFilter || q.status === statusFilter));
  }, [quotes, query, statusFilter]);

  return (
    <div className="surface-card u-p-4 u-grid u-gap-3">
      <div className="action-bar u-justify-between u-items-center">
        <div><strong>{t('quotesTitle')}</strong><p className="u-m-0 u-text-sm muted">{t('quotesHint')}</p></div>
        <Button variant="primary" onClick={() => setCreating((v) => !v)}>{creating ? t('cancel') : t('newQuote')}</Button>
      </div>
      {creating ? <QuoteForm orgId={orgId} products={products} onDone={() => { setCreating(false); reload(); }} /> : null}
      {quotes !== null && quotes.length > 3 ? (
        <div className="filterbar" role="group" aria-label={t('filterGroup')}>
          <input
            type="search"
            className="ui-input filterbar-search"
            placeholder={t('filterQuotesPlaceholder')}
            aria-label={t('filterQuotesAria')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select className="ui-input filterbar-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | (typeof QUOTE_STATUSES)[number])} aria-label={t('filterQuoteStatusLabel')}>
            <option value="">{t('allQuoteStatuses')}</option>
            {QUOTE_STATUSES.map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
          </select>
        </div>
      ) : null}
      {quotes === null ? <Skeleton /> : loadError ? <StateCard announce title={t('loadErrorTitle')} body={t('loadErrorBody')} action={<Button variant="primary" onClick={reload}>{t('retry')}</Button>} /> : quotes.length === 0 ? <StateCard title={t('noQuotes')} body={t('noQuotesBody')} /> : visibleQuotes.length === 0 ? (
        <StateCard title={t('noMatchTitle')} body={t('noMatchBody')} action={<Button variant="secondary" onClick={() => { setQuery(''); setStatusFilter(''); }}>{t('clearFilters')}</Button>} />
      ) : (
        <ul className="u-grid u-gap-2 u-list-none u-p-0 u-m-0">
          {visibleQuotes.map((q) => {
            const focused = q.quoteId === focusId;
            return (
            <li key={q.quoteId} ref={focused ? focusRef : undefined} tabIndex={focused ? -1 : undefined} aria-current={focused ? 'location' : undefined} className={`action-bar u-justify-between u-items-center u-gap-2${focused ? ' is-deeplink-focus' : ''}`}>
              <div className="u-flex-1">
                <div className="u-truncate"><code className="u-text-sm">{q.quoteId}</code> <StatusChip value={q.status} /> <span className="chip">v{q.version}</span></div>
                <div className="u-text-sm muted">{fmt.currency(q.total, q.currency)} · {t('itemCount', { count: q.lines.length })}{q.note ? <> · {q.note}</> : null}</div>
              </div>
              <div className="action-bar u-gap-1">
                {q.status === 'draft' ? <Button variant="secondary" onClick={() => void act(() => sendQuote(orgId, q.quoteId))}>{t('send')}</Button> : null}
                {q.status === 'sent' ? (
                  <>
                    <button type="button" className="icon-button" aria-label={t('copyQuoteLink')} onClick={() => void share(q)}><ClipboardIcon /></button>
                    <Button variant="secondary" onClick={() => void act(() => acceptQuote(orgId, q.quoteId))}>{t('acceptQuote')}</Button>
                    <Button variant="secondary" onClick={() => void act(() => declineQuote(orgId, q.quoteId))}>{t('declineQuote')}</Button>
                  </>
                ) : null}
              </div>
            </li>
          );})}
        </ul>
      )}
    </div>
  );
}

function QuoteForm({ orgId, products, onDone }: { orgId: string; products: Product[]; onDone: () => void }): JSX.Element {
  const { t } = useTranslation('commerce');
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unitPrice, setUnitPrice] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    if (!productId) { toast.error(t('productRequired')); return; }
    setBusy(true);
    try {
      await createQuote(orgId, {
        lines: [{ productId, quantity: Number(quantity) || 1, ...(unitPrice.trim() !== '' && Number.isFinite(Number(unitPrice)) ? { unitPrice: Number(unitPrice) } : {}) }],
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      toast.info(t('created'));
      onDone();
    } catch (e) { actionError(e, t); } finally { setBusy(false); }
  }, [orgId, productId, quantity, unitPrice, note, onDone, t]);

  return (
    <div className="surface-card u-p-3 u-grid u-gap-3">
      <div className="action-bar u-gap-2">
        <Field label={t('fieldProduct')} required>{(w) => (
          <select {...w} value={productId} onChange={(e) => setProductId(e.target.value)} autoFocus>
            <option value="">{t('pickProduct')}</option>
            {products.map((p) => <option key={p.productId} value={p.productId}>{p.name}</option>)}
          </select>
        )}</Field>
        <Field label={t('fieldQuantity')}>{(w) => <input {...w} inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} />}</Field>
        <Field label={t('fieldNegotiatedPrice')} help={t('fieldNegotiatedPriceHint')}>{(w) => <input {...w} inputMode="decimal" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />}</Field>
      </div>
      <Field label={t('fieldNote')}>{(w) => <input {...w} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />}</Field>
      <div className="action-bar u-gap-2"><Button variant="primary" disabled={busy} onClick={() => void submit()}>{busy ? t('creating') : t('create')}</Button></div>
    </div>
  );
}

function PricingTab({ orgId }: { orgId: string }): JSX.Element {
  const { t } = useTranslation('commerce');
  const fmt = useFormat();
  const [lists, setLists] = useState<PriceList[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [coupons, setCoupons] = useState<Coupon[] | null>(null);
  // A failed coupon read must not render as "No coupons yet" — that is a
  // claim about the store we cannot make when the request never returned.
  const [couponsFailed, setCouponsFailed] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const reload = useCallback(() => {
    setLoadError(false);
    void listPriceLists(orgId).then(setLists).catch(() => setLoadError(true));
    setCouponsFailed(false);
    void listCoupons(orgId).then(setCoupons).catch(() => { setCouponsFailed(true); setCoupons([]); });
  }, [orgId]);
  // grade-ux I4/N2: distinct error state for price lists; coupons load with a skeleton.
  useEffect(() => { let active = true; setLists(null); setCoupons(null); setCouponsFailed(false); setLoadError(false); void listPriceLists(orgId).then((r) => { if (active) setLists(r); }).catch(() => { if (active) { setLoadError(true); setLists([]); } }); void listCoupons(orgId).then((r) => { if (active) setCoupons(r); }).catch(() => { if (active) { setCouponsFailed(true); setCoupons([]); } }); void listProducts(orgId).then((r) => { if (active) setProducts(r); }).catch(() => { if (active) setProducts([]); }); return () => { active = false; }; }, [orgId]);

  const remove = useCallback(async (pl: PriceList) => {
    if (!(await confirm({ title: t('deletePriceListTitle', { name: pl.name }), body: t('deletePriceListBody'), danger: true, confirmLabel: t('delete') }))) return;
    try { await deletePriceList(orgId, pl.priceListId); reload(); } catch (e) { actionError(e, t); }
  }, [orgId, reload, t]);

  // Collection kit (§4.5 rule 13): gated name search over the price lists.
  const [query, setQuery] = useState('');
  const visibleLists = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (lists ?? []).filter((pl) => !q || pl.name.toLowerCase().includes(q));
  }, [lists, query]);

  return (
    <div className="u-grid u-gap-3">
      <div className="surface-card u-p-4 u-grid u-gap-3">
        <div><strong>{t('priceListsTitle')}</strong><p className="u-m-0 u-text-sm muted">{t('priceListsHint')}</p></div>
        <PriceListForm orgId={orgId} products={products} onDone={reload} />
        {lists !== null && lists.length > 3 ? (
          <div className="filterbar" role="group" aria-label={t('filterGroup')}>
            <input
              type="search"
              className="ui-input filterbar-search"
              placeholder={t('filterPriceListsPlaceholder')}
              aria-label={t('filterPriceListsAria')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        ) : null}
        {lists === null ? <Skeleton /> : loadError ? <StateCard announce title={t('loadErrorTitle')} body={t('loadErrorBody')} action={<Button variant="primary" onClick={reload}>{t('retry')}</Button>} /> : lists.length === 0 ? <StateCard title={t('noPriceLists')} body={t('noPriceListsBody')} /> : visibleLists.length === 0 ? (
          <StateCard title={t('noMatchTitle')} body={t('noMatchBody')} action={<Button variant="secondary" onClick={() => setQuery('')}>{t('clearFilters')}</Button>} />
        ) : (
          <ul className="u-grid u-gap-2 u-list-none u-p-0 u-m-0">
            {visibleLists.map((pl) => (
              <li key={pl.priceListId} className="action-bar u-justify-between u-items-center u-gap-2">
                <div className="u-flex-1">
                  <div><strong>{pl.name}</strong> <span className="chip">{t('priority', { n: pl.priority })}</span> <span className="chip">{pl.currency}</span></div>
                  <div className="u-text-sm muted">{t('entryCount', { count: pl.entries.length })} · {t('assignedTo', { count: (pl.assignment.contactIds?.length ?? 0) + (pl.assignment.companyIds?.length ?? 0) })}</div>
                </div>
                <Button variant="secondary" onClick={() => void remove(pl)}>{t('delete')}</Button>
              </li>
            ))}
          </ul>
        )}
        <PricePreview orgId={orgId} products={products} />
      </div>
      <div className="surface-card u-p-4 u-grid u-gap-3">
        <div><strong>{t('couponsTitle')}</strong><p className="u-m-0 u-text-sm muted">{t('couponsHint')}</p></div>
        <CouponForm orgId={orgId} products={products} onDone={reload} />
        {coupons === null ? <InlineState kind="loading" /> : couponsFailed ? <InlineState kind="failed" message={t('couponsFailed')} /> : coupons.length === 0 ? <InlineState kind="empty" message={t('noCoupons')} /> : (
          <div className="action-bar u-gap-1 u-flex-wrap">
            {/* R2 CM-P2-M2 — a fixed coupon used to render `fmt.currency(cp.value, 'USD')`
                unconditionally: "10 off" on a EUR store read "$10.00" and deducted €10.
                A pre-R2 row has no captured currency, so state the bare amount rather
                than picking one — and free_shipping is not an amount at all. */}
            {coupons.map((cp) => (
              <span key={cp.couponId} className="chip">
                {cp.code} · {cp.type === 'percentage' ? `${cp.value}%`
                  : cp.type === 'free_shipping' ? t('couponFreeShipping')
                  : cp.currency ? fmt.currency(cp.value, cp.currency)
                  : t('couponAmountNoCurrency', { value: cp.value })}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PriceListForm({ orgId, products, onDone }: { orgId: string; products: Product[]; onDone: () => void }): JSX.Element {
  const { t } = useTranslation('commerce');
  const [name, setName] = useState('');
  // R2 CM-P2-M4 — this was hardcoded 'USD' while the resolver matches the product's
  // currency by EXACT string, so on a non-USD catalog the list never won a single
  // resolution and the key account it was built for was quietly billed list price.
  // Default to the catalog's own currency; warn when they disagree. The default has to
  // SYNC (review M-8): `products` is [] on first paint and fills asynchronously, so a
  // `useState` initialiser — which runs once — was always 'USD', i.e. the very bug the
  // comment claimed to fix. `touched` keeps a deliberate operator choice.
  const [currency, setCurrency] = useState<string>('USD');
  const [currencyTouched, setCurrencyTouched] = useState(false);
  useEffect(() => { if (!currencyTouched && products[0]) setCurrency(products[0].currency); }, [products, currencyTouched]);
  const [priority, setPriority] = useState('1');
  const [contactIds, setContactIds] = useState('');
  const [productId, setProductId] = useState('');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const selectedProduct = products.find((p) => p.productId === productId);

  const submit = useCallback(async () => {
    if (!name.trim() || !productId || price.trim() === '') { toast.error(t('priceListFieldsRequired')); return; }
    setBusy(true);
    try {
      await createPriceList(orgId, {
        name: name.trim(), currency, priority: Number(priority) || 0,
        contactIds: contactIds.split(',').map((x) => x.trim()).filter(Boolean),
        entries: [{ productId, price: Number(price) }],
      });
      toast.info(t('created'));
      setName(''); setContactIds(''); setPrice('');
      onDone();
    } catch (e) { actionError(e, t); } finally { setBusy(false); }
  }, [orgId, name, currency, priority, contactIds, productId, price, onDone, t]);

  return (
    <div className="surface-form">
      <Field label={t('fieldName')}>{(w) => <input {...w} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />}</Field>
      <Field label={t('fieldPriority')}>{(w) => <input {...w} inputMode="numeric" value={priority} onChange={(e) => setPriority(e.target.value)} className="u-w-auto" />}</Field>
      <Field label={t('fieldContactIds')} help={t('fieldContactIdsHint')}>{(w) => <input {...w} value={contactIds} onChange={(e) => setContactIds(e.target.value)} />}</Field>
      <Field label={t('fieldProduct')}>{(w) => (
        <select {...w} value={productId} onChange={(e) => setProductId(e.target.value)}>
          <option value="">{t('pickProduct')}</option>
          {products.map((p) => <option key={p.productId} value={p.productId}>{p.name}</option>)}
        </select>
      )}</Field>
      <Field label={t('fieldContractPrice')}>{(w) => <input {...w} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} className="u-w-auto" />}</Field>
      <Field label={t('fieldCurrency')}>{(w) => (
        <select {...w} value={currency} onChange={(e) => { setCurrencyTouched(true); setCurrency(e.target.value); }}>
          {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      )}</Field>
      {selectedProduct && selectedProduct.currency !== currency ? (
        <Notice variant="warning">{t('priceListCurrencyMismatch', { list: currency, product: selectedProduct.currency })}</Notice>
      ) : null}
      <Button variant="primary" disabled={busy} onClick={() => void submit()}>{busy ? t('creating') : t('addPriceList')}</Button>
    </div>
  );
}

/** "View as buyer" — the C4 explainability answer, verbatim from the resolver. */
function PricePreview({ orgId, products }: { orgId: string; products: Product[] }): JSX.Element {
  const { t } = useTranslation('commerce');
  const fmt = useFormat();
  const [productId, setProductId] = useState('');
  const [contactId, setContactId] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (!productId) return;
    try {
      const r = await resolvePrice(orgId, { productId, ...(contactId.trim() ? { contactId: contactId.trim() } : {}) });
      setAnswer(r.source === 'default'
        ? t('previewDefault', { price: fmt.currency(r.price, r.currency) })
        : t('previewWon', { price: fmt.currency(r.price, r.currency), source: r.priceListName ?? r.source }));
    } catch (e) { actionError(e, t); }
  }, [orgId, productId, contactId, t, fmt]);

  return (
    <div className="u-grid u-gap-2">
      <div className="u-text-sm"><strong>{t('previewTitle')}</strong> <span className="muted">{t('previewHint')}</span></div>
      <div className="surface-form">
        <Field label={t('fieldProduct')}>{(w) => (
          <select {...w} value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">{t('pickProduct')}</option>
            {products.map((p) => <option key={p.productId} value={p.productId}>{p.name}</option>)}
          </select>
        )}</Field>
        <Field label={t('fieldContactId')}>{(w) => <input {...w} value={contactId} onChange={(e) => setContactId(e.target.value)} />}</Field>
        <Button variant="secondary" onClick={() => void run()}>{t('previewRun')}</Button>
      </div>
      {answer ? <Notice variant="info">{answer}</Notice> : null}
    </div>
  );
}

function CouponForm({ orgId, products, onDone }: { orgId: string; products: Product[]; onDone: () => void }): JSX.Element {
  const { t } = useTranslation('commerce');
  const [code, setCode] = useState('');
  const [type, setType] = useState<'percentage' | 'fixed' | 'free_shipping'>('percentage');
  const [value, setValue] = useState('10');
  // R2 CM-P2-M2 — a `fixed` coupon is an AMOUNT, so it only means anything in a stated
  // currency; capture it here because nothing can reconstruct it afterwards. The form
  // only offered percentages, so the other two types existed solely over the API — one
  // of which (free_shipping) silently did nothing until this pass.
  const [currency, setCurrency] = useState<string>('USD');
  const [currencyTouched, setCurrencyTouched] = useState(false);
  // Same async-catalog sync as the price-list form (review M-8) — and a fixed coupon
  // stamped USD on a EUR store is INERT, so this default mattered more here.
  useEffect(() => { if (!currencyTouched && products[0]) setCurrency(products[0].currency); }, [products, currencyTouched]);
  const catalogCurrency = products[0]?.currency;
  const [busy, setBusy] = useState(false);
  const submit = useCallback(async () => {
    if (!code.trim()) { toast.error(t('codeRequired')); return; }
    setBusy(true);
    try {
      await createCoupon(orgId, { code: code.trim(), type, value: type === 'free_shipping' ? 0 : Number(value) || 0, ...(type === 'fixed' ? { currency } : {}) });
      setCode(''); onDone();
    } catch (e) { actionError(e, t); } finally { setBusy(false); }
  }, [orgId, code, type, value, currency, onDone, t]);
  return (
    <div className="surface-form">
      <Field label={t('fieldCode')}>{(w) => <input {...w} value={code} onChange={(e) => setCode(e.target.value)} maxLength={120} />}</Field>
      <Field label={t('fieldCouponType')}>{(w) => (
        <select {...w} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
          <option value="percentage">{t('couponType_percentage')}</option>
          <option value="fixed">{t('couponType_fixed')}</option>
          <option value="free_shipping">{t('couponType_free_shipping')}</option>
        </select>
      )}</Field>
      {type !== 'free_shipping' ? (
        <Field label={type === 'percentage' ? t('fieldPercentOff') : t('fieldAmountOff')}>{(w) => <input {...w} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} className="u-w-auto" />}</Field>
      ) : null}
      {type === 'fixed' ? (
        <Field label={t('fieldCurrency')} help={t('couponCurrencyHint')}>{(w) => (
          <select {...w} value={currency} onChange={(e) => { setCurrencyTouched(true); setCurrency(e.target.value); }}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}</Field>
      ) : null}
      {type === 'fixed' && catalogCurrency && catalogCurrency !== currency ? (
        <Notice variant="warning">{t('couponCurrencyMismatch', { coupon: currency, catalog: catalogCurrency })}</Notice>
      ) : null}
      <Button variant="primary" disabled={busy} onClick={() => void submit()}>{t('addCoupon')}</Button>
    </div>
  );
}

function ReportsTab({ orgId }: { orgId: string }): JSX.Element {
  const { t } = useTranslation('commerce');
  const fmt = useFormat();
  const [sum, setSum] = useState<CommerceSummary | null>(null);
  const [loadError, setLoadError] = useState(false);
  const load = useCallback(() => { setSum(null); setLoadError(false); void commerceSummary(orgId).then(setSum).catch(() => setLoadError(true)); }, [orgId]);
  useEffect(() => { let active = true; setSum(null); setLoadError(false); void commerceSummary(orgId).then((r) => { if (active) setSum(r); }).catch(() => { if (active) setLoadError(true); }); return () => { active = false; }; }, [orgId]);

  // The canonical stat surface (DESIGN.md §4.5/§5.1 — the serif-numeral figure band),
  // not a hand-rolled surface-card grid. DEF-6 — one band per currency the org sold in;
  // the paid-order count is currency-agnostic, shown once on the primary band.
  const bands = useMemo(() => {
    if (!sum) return [];
    const ccys = sum.byCurrency.length > 0 ? sum.byCurrency : [{ currency: sum.currency, gmv: sum.gmv, netRevenue: sum.netRevenue, aov: sum.aov, paidOrders: 0, couponUsage: [] }];
    return ccys.map((c, i) => ({
      currency: c.currency,
      figures: [
        { key: `gmv-${c.currency}`, label: t('gmv'), value: fmt.currency(c.gmv, c.currency) },
        { key: `net-${c.currency}`, label: t('netRevenue'), value: fmt.currency(c.netRevenue, c.currency) },
        { key: `aov-${c.currency}`, label: t('aov'), value: fmt.currency(c.aov, c.currency) },
        ...(i === 0 ? [{ key: 'paid', label: t('paidOrders'), value: String(sum.orderCounts.paid + sum.orderCounts.fulfilled) }] : []),
      ],
    }));
  }, [sum, t, fmt]);
  // Per-currency top products (ADR 0239 follow-on) — only currencies that actually have sales.
  const topProductBands = useMemo(
    () => (sum?.byCurrency ?? []).filter((c) => c.topProducts.length > 0).map((c) => ({ currency: c.currency, topProducts: c.topProducts })),
    [sum],
  );

  if (loadError) return <div className="surface-card u-p-4"><StateCard announce title={t('loadErrorTitle')} body={t('loadErrorBody')} action={<Button variant="primary" onClick={load}>{t('retry')}</Button>} /></div>;
  if (!sum) return <div className="surface-card u-p-4"><Skeleton /></div>;
  const multiCurrency = bands.length > 1;
  return (
    <div className="u-grid u-gap-3">
      {bands.map((b) => (
        <div key={b.currency} className="u-grid u-gap-1">
          {multiCurrency ? <span className="chip">{b.currency}</span> : null}
          <KeyFigureBand figures={b.figures} ariaLabel={multiCurrency ? t('reportsFiguresLabelForCurrency', { currency: b.currency }) : t('reportsFiguresLabel')} />
        </div>
      ))}
      <div className="surface-card u-p-4 u-grid u-gap-2">
        <strong>{t('topProducts')}</strong>
        {/* ADR 0239 follow-on — top products are bucketed PER currency, so revenue shows
            honestly with its own symbol (was units-only when multi-currency). */}
        {topProductBands.length === 0 ? <p className="u-m-0 u-text-sm muted">{t('noRevenueYet')}</p> : topProductBands.map((band) => (
          <div key={band.currency} className="u-grid u-gap-1"
            {...(multiCurrency ? { role: 'group', 'aria-label': t('reportsFiguresLabelForCurrency', { currency: band.currency }) } : {})}>
            {multiCurrency ? <span className="chip">{band.currency}</span> : null}
            <ul className="u-grid u-gap-1 u-list-none u-p-0 u-m-0">
              {band.topProducts.map((p) => (
                <li key={p.productId} className="action-bar u-justify-between u-text-sm"><span>{p.name}</span><span>{fmt.currency(p.revenue, band.currency)} · {t('unitCount', { count: p.units })}</span></li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {sum.lowStock.length > 0 ? (
        <div className="surface-card u-p-4 u-grid u-gap-2">
          <strong>{t('lowStockTitle')}</strong>
          <ul className="u-grid u-gap-1 u-list-none u-p-0 u-m-0">
            {sum.lowStock.map((p) => (
              <li key={p.productId} className="action-bar u-justify-between u-text-sm"><span>{p.name}</span><span className="chip chip--warning">{t('lowStockOf', { n: p.inventory, of: p.lowStockThreshold })}</span></li>
            ))}
          </ul>
        </div>
      ) : null}
      {sum.couponUsage.length > 0 ? (
        <div className="surface-card u-p-4 u-grid u-gap-2">
          <strong>{t('couponUsage')}</strong>
          <ul className="u-grid u-gap-1 u-list-none u-p-0 u-m-0">
            {sum.couponUsage.map((cp) => (
              <li key={cp.code} className="action-bar u-justify-between u-text-sm"><span>{cp.code}</span><span>{t('orderCount', { count: cp.orders })} · −{fmt.currency(cp.discount, sum.currency)}</span></li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function AssistantTab(): JSX.Element {
  const { t } = useTranslation('commerce');
  return (
    <div className="surface-card u-p-4 commerce-assistant-panel">
      <div><strong>{t('assistantTitle')}</strong><p className="u-m-0 u-text-sm muted">{t('assistantHint')}</p></div>
      <EmbeddedChatPanel agentId="feature.commerce.agents.store-assistant" />
    </div>
  );
}
