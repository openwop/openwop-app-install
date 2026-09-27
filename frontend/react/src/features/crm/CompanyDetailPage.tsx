/**
 * Company detail page (gap-analysis §5 B1) — /crm/companies/:companyId?org=<orgId>.
 * Composes the existing GET/PATCH company routes, the deals ?companyId= filter,
 * and the append-only activity timeline. Org context rides the query string
 * (companies are org-scoped; the list page always links with it).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { confirm } from '../../ui/confirm.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { toast } from '../../ui/toast.js';
import { BuildingIcon, BriefcaseIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { ActivityTimeline } from './ActivityTimeline.js';
import { deleteCompany, getCompany, listDeals, updateCompany, type Company, type Deal } from './crmOrgClient.js';
import { formatDealAmount } from './dealMoney.js';
import { crmActionError } from './crmUiHelpers.js';

export function CompanyDetailPage(): JSX.Element {
  const { t } = useTranslation('crm');
  const { t: tc } = useTranslation('common');
  const crm = useFeatureAccess('crm');
  const { companyId = '' } = useParams();
  const [search] = useSearchParams();
  const orgId = search.get('org') ?? '';

  const [company, setCompany] = useState<Company | null>(null);
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [dealsFailed, setDealsFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [size, setSize] = useState('');
  const [revenue, setRevenue] = useState('');
  const [busy, setBusy] = useState(false);

  // CRM-UX-9 — the deals read is its OWN callback, and the deals panel's Retry
  // calls only this. Wiring that Retry to the whole-page `load()` re-hydrated
  // `name`/`domain`/`size`/`revenue` from the server, so retrying a failed
  // *deals* read silently discarded an unsaved company edit. `DealDetailPage`
  // already fixed exactly this class for its stages Retry (its Review F9 note).
  //
  // CRM-R2-1 — a failed deals read must not claim this company has no deals
  // (a false sales claim on the record page).
  const loadDeals = useCallback(() => {
    if (!orgId || !companyId) return;
    setDealsFailed(false);
    // HIGH-1 — UNKNOWN (`null`), never `[]`. `dealsFailed` is cleared
    // synchronously above, so a stale `[]` rendered "No deals for this
    // company" — a false SALES claim on a record page — for the whole retry
    // request. `null` also fixes the FIRST load, which had the same hole:
    // `deals` starts null and the empty slot only branched on `dealsFailed`.
    void listDeals(orgId, { companyId }).then(setDeals).catch(() => { setDeals(null); setDealsFailed(true); });
  }, [orgId, companyId]);

  // The company read — re-hydrates the form, so ONLY the page-level failed-read
  // Retry may call it (at which point `company` is null and there is no edit to
  // lose).
  const loadCompany = useCallback(() => {
    if (!orgId || !companyId) return;
    setError(null);
    void getCompany(orgId, companyId)
      .then((c) => { setCompany(c); setName(c.name); setDomain(c.domain ?? ''); setSize(c.size !== undefined ? String(c.size) : ''); setRevenue(c.revenue !== undefined ? String(c.revenue) : ''); })
      .catch((e) => setError(crmActionError(e, 'loadFailed')));
  }, [orgId, companyId]);

  useEffect(() => { loadCompany(); loadDeals(); }, [loadCompany, loadDeals]);

  // Rule 12 — destructive delete lives HERE (the entity's detail surface), not
  // on the collection cell; navigates back to the collection on success.
  const navigate = useNavigate();
  const removeCompany = useCallback(async () => {
    if (!company) return;
    // CRM-UX-17 — the consequence, from what the backend does: the ADR 0580
    // record-deleted seam's `*-crm-unlink` consumers drop the dangling
    // `companyId` from this org's deals, tasks and activities — the rows are
    // KEPT, never cascaded.
    if (!(await confirm({ title: t('deleteRecordConfirm', { name: company.name }), body: t('deleteCompanyBody'), danger: true, confirmLabel: t('common:delete') }))) return;
    try {
      await deleteCompany(orgId, companyId);
      toast.success(t('companyDeleted'));
      // CRM-UX-16 — the landing page (CrmPage) reads this and moves focus to
      // its title, so the navigation is not silent for keyboard / SR users.
      navigate(`/crm?tab=companies`, { state: { focusTitle: true } });
    } catch (e) { toast.error(crmActionError(e, 'deleteFailed')); }
  }, [company, orgId, companyId, navigate, t]);

  const save = useCallback(async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const sizeNum = size.trim() ? Number(size) : null;
      const revenueNum = revenue.trim() ? Number(revenue) : null;
      const next = await updateCompany(orgId, companyId, {
        name: name.trim(), domain: domain.trim() || null,
        size: sizeNum !== null && Number.isFinite(sizeNum) ? sizeNum : null,
        revenue: revenueNum !== null && Number.isFinite(revenueNum) ? revenueNum : null,
      });
      setCompany(next);
      toast.success(t('companySaved'));
    } catch (e) { toast.error(crmActionError(e, 'saveFailed')); } finally { setBusy(false); }
  }, [orgId, companyId, name, domain, size, revenue, t]);

  const dealColumns: DataColumn<Deal>[] = [
    { key: 'title', header: t('colTitle'), render: (d) => <Link to={`/crm/deals/${encodeURIComponent(d.dealId)}?org=${encodeURIComponent(orgId)}`}>{d.title}</Link> },
    { key: 'amount', header: t('colAmount'), cellClassName: 'muted', render: (d) => (d.amount !== undefined ? formatDealAmount(d.amount, d.currency) : '—') },
    { key: 'status', header: t('colStatus'), render: (d) => <span className="chip">{t(`dealStatus_${d.status ?? 'open'}`)}</span> },
  ];

  if (crm.loading) return <Skeleton />;
  if (!crm.enabled) {
    return (
      <section className="u-grid u-gap-4" data-walkthrough="crm-company.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </section>
    );
  }
  if (!orgId) {
    return (
      <section className="u-grid u-gap-4" data-walkthrough="crm-company.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('companyDetailTitle')} />
        <StateCard icon={<BuildingIcon />} title={t('missingOrgTitle')} body={t('missingOrgBody')} />
        <Link to="/crm">{t('backToCrm')}</Link>
      </section>
    );
  }

  return (
    <section className="u-grid u-gap-4" data-walkthrough="crm-company.page">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={company?.name ?? t('companyDetailTitle')}
        lede={company?.domain ?? undefined}
        actions={(
          <span className="action-bar">
            <Link to="/crm?tab=companies" className="btn-ghost">{t('backToCrm')}</Link>
            {company ? <Button variant="quiet" onClick={() => void removeCompany()}>{t('common:delete')}</Button> : null}
          </span>
        )}
      />
      {/* CRM-UX-4 — announced failed-read card + Retry (the SignTab.tsx bar),
          never a bare Notice carrying the transport's raw string. Retry re-reads
          the COMPANY only; the deals panel has its own (CRM-UX-9). */}
      {error ? (
        <StateCard
          announce
          icon={<BuildingIcon />}
          title={tc('loadFailedTitle')}
          body={tc('loadFailedBody')}
          action={<Button variant="secondary" onClick={loadCompany}>{tc('retry')}</Button>}
        />
      ) : null}
      {!company && !error ? <Skeleton /> : null}
      {company ? (
        <>
          <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldName')}</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldDomain')}</span><input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder={t('companyDomainPlaceholder')} /></label>
            <label className="u-grid u-gap-1 is-narrow"><span className="u-label-sm">{t('fieldSize')}</span><input type="number" min={0} value={size} onChange={(e) => setSize(e.target.value)} placeholder={t('companySizePlaceholder')} /></label>
            <label className="u-grid u-gap-1 is-narrow"><span className="u-label-sm">{t('fieldRevenue')}</span><input type="number" min={0} value={revenue} onChange={(e) => setRevenue(e.target.value)} placeholder={t('companyRevenuePlaceholder')} /></label>
            <Button variant="primary" type="submit" disabled={busy || !name.trim()}>{t('common:save')}</Button>
          </form>
          {company.tags.length > 0 ? (
            <div role="group" className="action-bar" aria-label={t('colTags')}>
              {company.tags.map((tag) => <span key={tag} className="chip">{tag}</span>)}
            </div>
          ) : null}
          <section className="u-grid u-gap-2" aria-label={t('companyDealsLabel')}>
            <h2 className="u-fs-14 u-m-0">{t('companyDealsTitle')}</h2>
            <DataTable stack rows={deals ?? []} rowKey={(d) => d.dealId} columns={dealColumns} caption={t('companyDealsTitle')}
              empty={dealsFailed
                ? <StateCard announce icon={<BriefcaseIcon />} title={t('loadFailed')} body={t('companyDealsUnavailable')} action={<Button variant="secondary" size="sm" onClick={loadDeals}>{t('retry')}</Button>} />
                : deals === null
                  ? <Skeleton />
                  : <StateCard icon={<BriefcaseIcon />} title={t('noDealsTitle')} body={t('noDealsForCompanyBody')} />} />
          </section>
          <ActivityTimeline orgId={orgId} companyId={companyId} />
        </>
      ) : null}
    </section>
  );
}
