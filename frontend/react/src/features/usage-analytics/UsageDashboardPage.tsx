/**
 * LLM usage/cost admin dashboard (ADR 0118 Phase 3b).
 *
 * Read-only per-(provider, model) token rollup over the recorded provider usage
 * (the Phase-2 write-through). Gates on `useFeatureAccess('usage-analytics')`; org
 * picker → a sorted DataTable of token counts. Token COUNTS only — no prompt content
 * or secrets ever cross this surface. Mirrors the Analytics page precedent.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../../i18n/useFormat.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { SelectField } from '../../ui/Field.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { ActivityIcon } from '../../ui/icons/index.js';
import { fetchUsageRollup, listOrgs, type Org, type UsageRollupRow } from '../../client/usageAnalyticsClient.js';

export function UsageDashboardPage(): JSX.Element {
  const { t } = useTranslation('usage-analytics');
  const f = useFormat();
  const access = useFeatureAccess('usage-analytics');

  // The `rows === null && !error` guard below looks like it covers this and does
  // not: `error` is set by the rollup read, and a failed ORG read means that read
  // never starts. So the guard's own condition stays true forever.
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs, access.enabled);
  const [rows, setRows] = useState<UsageRollupRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // §4.5 collection kit — gated search (provider or model) + a provider facet
  // whose options are the providers actually present in the loaded rollup.
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const providerOptions = useMemo(() => [...new Set((rows ?? []).map((r) => r.provider))].sort(), [rows]);
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows ?? []).filter((r) =>
      (!q || r.provider.toLowerCase().includes(q) || r.model.toLowerCase().includes(q))
      && (!providerFilter || r.provider === providerFilter));
  }, [rows, query, providerFilter]);
  // UA-R2-4 — counted over the rows the reader can actually SEE. Counting all
  // loaded rows made the warning point at models the active filter had hidden
  // ("3 models have no rate" above a table showing none of them).
  const unpricedCount = visibleRows.filter((r) => r.costUsd === undefined).length;

  // UA-R2-3 — a `useEffect` whose whole body was `if (!access.enabled) return;`
  // lived here. It did nothing: no subscription, no fetch, no cleanup. The real
  // network gate is the `access.enabled &&` in the load effect below.

  // UA-R2-2 — every async write is guarded by a sequence token. Without it,
  // switching org A→B renders A's rollup under B's name whenever A resolves last,
  // and the numbers are attributed to the wrong organization with nothing on
  // screen to suggest it.
  //
  // A sequence token rather than the repo's more common effect-scoped
  // `let cancelled` (74 files vs 11): `load` is now called from the Retry button
  // as well as the effect, and a flag captured by one effect run cannot guard a
  // call that happens outside it.
  const loadSeq = useRef(0);
  const load = useCallback((id: string) => {
    const seq = ++loadSeq.current;
    const fresh = (): boolean => seq === loadSeq.current;
    setRows(null);
    setError(null);
    void fetchUsageRollup(id)
      .then((r) => { if (fresh()) setRows(r); })
      .catch(() => { if (fresh()) setError(t('loadError')); });
  }, [t]);

  useEffect(() => { if (access.enabled && orgId) load(orgId); }, [access.enabled, orgId, load]);

  const columns = useMemo<DataColumn<UsageRollupRow>[]>(() => [
    { key: 'provider', header: t('colProvider'), sortValue: (r) => r.provider, render: (r) => r.provider },
    { key: 'model', header: t('colModel'), sortValue: (r) => r.model, render: (r) => r.model },
    { key: 'input', header: t('colInput'), align: 'right', width: '140px', cellClassName: 'u-tabular', sortValue: (r) => r.inputTokens, render: (r) => f.number(r.inputTokens) },
    { key: 'output', header: t('colOutput'), align: 'right', width: '140px', cellClassName: 'u-tabular', sortValue: (r) => r.outputTokens, render: (r) => f.number(r.outputTokens) },
    { key: 'calls', header: t('colCalls'), align: 'right', width: '100px', cellClassName: 'u-tabular', sortValue: (r) => r.calls, render: (r) => f.number(r.calls) },
    // UA-G1 — `costUsd` is ABSENT when the rate table has no entry for the model:
    // the cost is UNKNOWN, not zero. Rendering `?? 0` printed "$0.00" against a
    // model with millions of tokens — the one number that asserts it was free —
    // and sorted those rows as the CHEAPEST. Unknown now reads as unknown and
    // sorts to the end (-1 would sort it as cheaper than free).
    {
      key: 'cost', header: t('colCost'), align: 'right', width: '110px', cellClassName: 'u-tabular',
      sortValue: (r) => (r.costUsd === undefined ? Number.POSITIVE_INFINITY : r.costUsd),
      render: (r) => (r.costUsd === undefined
        ? <span className="u-text-muted" title={t('costUnpricedHint')}>{t('costUnpriced')}</span>
        : f.currency(r.costUsd)),
    },
  ], [t, f]);

  if (!access.enabled) {
    return (
      <>
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
        <StateCard icon={<ActivityIcon />} title={t('disabled')} />
      </>
    );
  }

  return (
    <>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      {orgs && orgs.length > 1 && (
        <SelectField label={t('ui:orgPickerLabel')} className="u-w-auto" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
          {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </SelectField>
      )}
      {/* UA-G1 — if ANY visible row has no rate, the spend picture on this page
          is incomplete. Saying so once beats hoping the reader notices the dashes
          in a sorted column. Suppressed while `rows` is null: a page that has not
          loaded has nothing to be incomplete ABOUT. */}
      {rows !== null && unpricedCount > 0 && <Notice variant="warning">{t('costIncomplete', { count: unpricedCount })}</Notice>}
      {/* HG-4 — the noun and the branch ORDER (failed → zero-orgs → children)
          are `OrgSelectionState`'s, not this page's. Both org states still sit
          above the loading branch: the rollup effect is gated on `orgId`, so
          with none it never fires, `rows === null && !error` stays true FOREVER,
          and a `role="status"` "Loading…" live region told a screen-reader user
          work was permanently in progress. */}
      <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')} icon={<ActivityIcon />}>
      {/* UA-R2-1 — three states, and the FAILED one is a state rather than the
          absence of one.
          Before: a failed rollup left `rows` null and set `error`, so this guard
          (`rows === null && !error`) went false, the else-branch ran, and
          `visibleRows` — `(rows ?? [])` — was empty. `DataTable` renders its
          `empty` slot at length 0, so the page printed "No usage recorded yet."
          underneath the error. A read that never completed, asserting there is
          nothing to report.
          Note the empty was manufactured HERE, at render, by the `?? []`
          coalesce — not written into state by the catch. That is why
          `check-failed-read-sentinels.mjs`, which greps the catch, cannot see
          this shape. */}
      {rows === null ? (
        error ? (
          <StateCard
            icon={<ActivityIcon />}
            title={t('loadFailedTitle')}
            body={error}
            announce
            action={<Button variant="secondary" size="sm" onClick={() => { if (orgId) load(orgId); }}>{t('loadRetry')}</Button>}
          />
        ) : (
          <SkeletonRows rows={5} columns={['1fr', '1fr', '140px', '140px', '100px', '110px']} />
        )
      ) : (
        <>
          {rows && rows.length > 3 ? (
            <div className="filterbar" role="group" aria-label={t('filterGroup')}>
              <input
                type="search"
                className="ui-input filterbar-search"
                placeholder={t('filterPlaceholder')}
                aria-label={t('filterAria')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select className="ui-input filterbar-select" value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)} aria-label={t('filterProviderLabel')}>
                <option value="">{t('allProviders')}</option>
                {providerOptions.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          ) : null}
          {rows && rows.length > 0 && visibleRows.length === 0 ? (
            <StateCard icon={<ActivityIcon />} title={t('noMatchTitle')} body={t('noMatchBody')} action={<Button variant="secondary" onClick={() => { setQuery(''); setProviderFilter(''); }}>{t('clearFilters')}</Button>} />
          ) : (
            <DataTable
              columns={columns}
              rows={visibleRows}
              rowKey={(r) => `${r.provider}:${r.model}`}
              caption={t('title')}
              initialSort={{ key: 'input', dir: 'desc' }}
              empty={<StateCard icon={<ActivityIcon />} title={t('empty')} body={t('emptyHint')} />}
            />
          )}
        </>
      )}
      </OrgSelectionState>
    </>
  );
}
