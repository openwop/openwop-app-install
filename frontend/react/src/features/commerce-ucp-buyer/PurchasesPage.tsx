/**
 * UCP-buyer purchases — the agentic-procurement back office (ADR 0258 / deep-link
 * ADR 0336). A read-only list of purchases an agent placed over UCP; each row
 * deep-links to its detail. The landing surface for the commerce.ucp-buyer.*
 * notifications. Gated on the `commerce-ucp-buyer` toggle (independent of the
 * seller-side `commerce`).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { PackageIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { useFormat } from '../../i18n/useFormat.js';
import { listOrgs, listPurchases, merchantLabel, type Org, type UcpPurchase } from './ucpBuyerClient.js';

/** status → chip tone (DESIGN §5.3 — label always present, colour never the sole signal). */
export const STATUS_TONE: Record<string, string> = {
  placed: 'chip--success',
  awaiting_approval: 'chip--ai', placing: 'chip--ai',
  failed: 'chip--danger', canceled: 'chip--warning', unknown: 'chip--warning',
  // draft is deliberately neutral (no tone).
};

const STATUSES = ['draft', 'awaiting_approval', 'placing', 'placed', 'unknown', 'failed', 'canceled'] as const;

export function PurchaseStatusChip({ status }: { status: string }): JSX.Element {
  const { t } = useTranslation('commerce-ucp-buyer');
  const tone = STATUS_TONE[status] ?? '';
  return <span className={`chip ${tone}`.trim()}>{t(`status_${status}`, { defaultValue: status })}</span>;
}

export function PurchasesPage(): JSX.Element {
  const { t } = useTranslation('commerce-ucp-buyer');
  const access = useFeatureAccess('commerce-ucp-buyer');
  const [searchParams, setSearchParams] = useSearchParams();
  // `.catch(() => setOrgs([]))` rendered "No workspaces — create a workspace to
  // see its agent purchases" over a failed read. The `?org=` deep link rides
  // through the hook so a shared purchases link still resolves.
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs, access.enabled, searchParams.get('org') ?? '');
  const [purchases, setPurchases] = useState<UcpPurchase[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const fmt = useFormat();

  // DESIGN §4.5-r13 filterbar (grade-ux DL-UX-5): search merchant/order + status facet.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (purchases ?? []).filter((p) =>
      (!needle || merchantLabel(p).toLowerCase().includes(needle) || (p.extOrderId ?? '').toLowerCase().includes(needle))
      && (!statusFilter || p.status === statusFilter));
  }, [purchases, q, statusFilter]);

  const selectOrg = useCallback((id: string) => {
    setOrgId(id);
    setSearchParams((p) => { const n = new URLSearchParams(p); n.set('org', id); return n; }, { replace: true });
  }, [setSearchParams, setOrgId]);

  const reload = useCallback(() => {
    if (!orgId) return;
    setPurchases(null); setLoadError(false);
    void listPurchases(orgId).then(setPurchases).catch(() => { setLoadError(true); setPurchases([]); });
  }, [orgId]);
  useEffect(reload, [reload]);

  if (access.loading) return <section className="u-grid u-gap-4" data-walkthrough="commerce-purchases.page"><PageHeader eyebrow={t('eyebrow')} title={t('title')} /><Skeleton /></section>;
  if (!access.enabled) return <section className="u-grid u-gap-4" data-walkthrough="commerce-purchases.page"><PageHeader eyebrow={t('eyebrow')} title={t('title')} /><StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} /></section>;

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => selectOrg(e.target.value)} className="u-w-auto" aria-label={t('orgPickerLabel')}>
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : null;

  return (
    <section className="u-grid u-gap-4" data-walkthrough="commerce-purchases.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={orgPicker} />
      {/* HG-4 — the noun and the branch ORDER (failed → zero-orgs → children) are
          `OrgSelectionState`'s now. This page had it inverted (the skeleton was
          checked ABOVE the zero-org branch); the purchases card is the CHILD,
          which makes the right order unskippable. `reload()` is gated on `orgId`,
          so with no organization the purchases read never starts and `purchases`
          stays `null` — the skeleton below keys on THAT sentinel, not on `orgs`. */}
      <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')} icon={<PackageIcon />}>
        <div className="surface-card u-p-4 u-grid u-gap-3">
          {purchases === null ? <Skeleton /> : loadError ? (
            <StateCard announce title={t('loadErrorTitle')} body={t('loadErrorBody')} action={<Button variant="primary" onClick={reload}>{t('retry')}</Button>} />
          ) : purchases.length === 0 ? (
            <StateCard icon={<PackageIcon />} title={t('emptyTitle')} body={t('emptyBody')} />
          ) : (
            <>
              {purchases.length > 3 ? (
                <div className="filterbar" role="group" aria-label={t('filterGroup')}>
                  <input type="search" className="ui-input filterbar-search" placeholder={t('filterPlaceholder')} aria-label={t('filterPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
                  {/* Self-describing "All statuses" option carries the facet's label — an
                      eyebrow label would break the one-row filterbar baseline. */}
                  <select className="ui-input filterbar-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label={t('statusFilterLabel')}>
                    <option value="">{t('statusAll')}</option>
                    {STATUSES.map((s) => <option key={s} value={s}>{t(`status_${s}`, { defaultValue: s })}</option>)}
                  </select>
                </div>
              ) : null}
              {filtered.length === 0 ? (
                <StateCard icon={<PackageIcon />} title={t('noMatchTitle')} body={t('noMatchBody')} action={<Button variant="secondary" onClick={() => { setQ(''); setStatusFilter(''); }}>{t('clearFilters')}</Button>} />
              ) : (
              <ul className="u-grid u-gap-2 u-list-none u-p-0 u-m-0">
              {filtered.map((p) => (
                <li key={p.purchaseId} className="action-bar u-justify-between u-items-center u-gap-2">
                  <div className="u-flex-1 u-minw-0">
                    <div className="u-truncate u-flex u-items-center u-gap-2 u-wrap">
                      <Link className="inline-link u-text-sm" to={`/commerce/purchases/${encodeURIComponent(p.purchaseId)}?org=${encodeURIComponent(orgId)}`}>{merchantLabel(p)}</Link>
                      <PurchaseStatusChip status={p.status} />
                      {p.extStatus ? <span className="chip chip--muted">{p.extStatus}</span> : null}
                    </div>
                    <div className="u-text-sm muted">
                      {fmt.currencyMinor(p.cartMandate.totalMinor, p.cartMandate.currency)} · {t('itemCount', { count: p.cartMandate.lines.length })} · {fmt.date(p.createdAt)}
                      {p.extOrderId ? <> · {p.extOrderId}</> : null}
                    </div>
                  </div>
                </li>
              ))}
              </ul>
              )}
            </>
          )}
        </div>
      </OrgSelectionState>
    </section>
  );
}
