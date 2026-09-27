/**
 * Companies tab (org-scoped, RBAC-gated — ADR 0008) — extracted out of
 * CrmPage.tsx per the ReportsTab.tsx precedent (CRMGAP-FE-10). Zero behavior
 * change from the inline version.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { toast } from '../../ui/toast.js';
import { BuildingIcon } from '../../ui/icons/index.js';
import { createCompany, listCompanies, type Company } from './crmOrgClient.js';
import { crmActionError } from './crmUiHelpers.js';

interface Props {
  orgId: string;
}

export function CompaniesTab({ orgId }: Props): JSX.Element {
  const { t } = useTranslation('crm');
  const { t: tc } = useTranslation('common');
  const [rows, setRows] = useState<Company[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [viewMode, setViewMode] = useViewMode('crm-companies', 'list');
  // R2 CC-SP-12 — the debounce cancels un-SENT requests only; two in-flight
  // responses could still land out of order (type "ab", pause, "abc": the
  // "ab" response can arrive last and win). Sequence-stamp each load.
  const loadSeq = useRef(0);
  const load = useCallback(() => {
    setError(null);
    const seq = ++loadSeq.current;
    void listCompanies(orgId, q.trim() || undefined)
      .then((rows) => { if (seq === loadSeq.current) setRows(rows); })
      .catch((e) => {
        if (seq !== loadSeq.current) return;
        // HIGH-1 — UNKNOWN (`null`), never `[]`. Nothing strands (the empty
        // state is gated off `error` below), and a stale `[]` would render
        // "No companies yet" for the whole RETRY request, because `load()`
        // clears `error` synchronously while the failed read's data stays.
        setRows(null);
        setError(crmActionError(e, 'loadFailed'));
      });
  }, [orgId, q]);
  useEffect(() => { setRows(null); setQ(''); }, [orgId]);
  // Debounced (re)load: fires immediately on org switch (q empty), 250ms after typing.
  useEffect(() => {
    if (!orgId) return;
    const timer = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [orgId, q, load]);

  const add = useCallback(async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { await createCompany(orgId, { name: name.trim(), ...(domain.trim() ? { domain: domain.trim() } : {}) }); setName(''); setDomain(''); load(); toast.success(t('companyAdded')); }
    catch (e) { toast.error(crmActionError(e, 'addFailed')); } finally { setBusy(false); }
  }, [orgId, name, domain, load, t]);

  // Rule 12 — the destructive delete moved OFF the collection cell to the
  // company's detail page (which navigates back on success).
  const columns = useMemo<DataColumn<Company>[]>(() => [
    { key: 'name', header: t('colName'), render: (c) => <Link to={`/crm/companies/${encodeURIComponent(c.companyId)}?org=${encodeURIComponent(orgId)}`}>{c.name}</Link> },
    { key: 'domain', header: t('colDomain'), cellClassName: 'muted', render: (c) => c.domain ?? '—' },
    { key: 'tags', header: t('colTags'), render: (c) => <span className="action-bar">{c.tags.map((tag) => <span key={tag} className="chip">{tag}</span>)}</span> },
  ], [orgId, t]);

  return (
    <div className="u-grid u-gap-4">
      {/* CRM-UX-4 — announced failed-read card + Retry (the SignTab.tsx bar),
          never a bare Notice carrying the transport's raw string. */}
      {error ? (
        <StateCard
          announce
          icon={<BuildingIcon />}
          title={tc('loadFailedTitle')}
          body={tc('loadFailedBody')}
          action={<Button variant="secondary" onClick={load}>{tc('retry')}</Button>}
        />
      ) : null}
      <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldName')}</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('companyNamePlaceholder')} /></label>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldDomain')}</span><input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder={t('companyDomainPlaceholder')} /></label>
        <Button variant="primary" type="submit" disabled={busy || !name.trim()}>{t('addCompany')}</Button>
      </form>
      {/* One filterbar row (§4.5 rules 5+11+13). The search is SERVER-side
          (debounced), so the >3 gate reads the unfiltered load; an active query
          keeps it mounted so it can't vanish mid-search. */}
      {rows !== null && (rows.length > 0 || q.trim() !== '') ? (
        <div className="filterbar" role="group" aria-label={t('filterGroup')}>
          {rows.length > 3 || q.trim() !== '' ? (
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('searchCompaniesPlaceholder')}
              aria-label={t('searchCompaniesLabel')}
              className="ui-input filterbar-search"
            />
          ) : null}
          <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" labels={{ list: t('viewTable') }} />
        </div>
      ) : null}
      {(() => {
        // §Correction — a failed READ must never render as an honestly-empty
        // list. The catch above sets `[]` so no skeleton is stranded (audit
        // finding #1), but that made the empty StateCard render beside the
        // error Notice: the user is told both "it broke" and "you have none".
        // `DealsTab` already gates this off `error` (finding #2); the other
        // tabs did not, and three tests PINNED the wrong behaviour.
        //
        // Return NULL, not another Notice: unlike DealsTab this tab already
        // renders the error Notice above, so re-rendering it here produced two
        // copies of the same message — caught by the test on the first run.
        if (error) return null;
        const emptyState = rows === null ? <SkeletonRows rows={3} columns={[160, 160, 120]} /> : q.trim() ? (
          <StateCard
            icon={<BuildingIcon />}
            title={t('noMatchesTitle')}
            body={t('noMatchesBody', { q: q.trim() })}
            action={<Button variant="secondary" onClick={() => setQ('')}>{t('clearSearch')}</Button>}
          />
        ) : (
          <StateCard icon={<BuildingIcon />} title={t('noCompaniesTitle')} body={t('noCompaniesBody')} />
        );
        if (viewMode === 'grid' && rows !== null) {
          return rows.length === 0 ? emptyState : (
            <div className="card-grid">
              {rows.map((c) => (
                <Link key={c.companyId} to={`/crm/companies/${encodeURIComponent(c.companyId)}?org=${encodeURIComponent(orgId)}`} className="surface-card u-gap-2">
                  <strong className="u-fs-15">{c.name}</strong>
                  {c.domain ? <span className="u-label-sm">{c.domain}</span> : null}
                  {c.tags.length > 0 ? <span className="action-bar">{c.tags.map((tag) => <span key={tag} className="chip">{tag}</span>)}</span> : null}
                </Link>
              ))}
            </div>
          );
        }
        return (
          <DataTable stack rows={rows ?? []} rowKey={(c) => c.companyId} columns={columns} caption={t('captionCompanies')}
            empty={emptyState} />
        );
      })()}
    </div>
  );
}
