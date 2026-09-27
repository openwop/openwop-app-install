/**
 * Audit log (Deferred Phase B.2 / UX ADM-7) — the first-class admin READ view
 * over the ADR 0028 audit store (`GET /host/openwop-app/governance/audit`).
 * The backend is the authority and tenant-scopes fail-closed; this page adds
 * filters (action prefix, window, limit) and renders the superadmin gate as
 * an honest message state (the feature-toggles precedent), never a blank.
 */
import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../ui/PageHeader.js';
import { StateCard } from '../ui/StateCard.js';
import { Notice } from '../ui/Notice.js';
import { DataTable, type DataColumn } from '../ui/DataTable.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { ShieldIcon, RotateCwIcon, SearchIcon } from '../ui/icons/index.js';
import { listAudit, downloadAuditChainExport, type AuditRecord } from '../client/governanceClient.js';
import { ApiError } from '../client/requestJson.js';
import { formatDateTime } from '../i18n/format.js';

const PREFIX_PRESETS = ['', 'assistant.', 'policy.', 'connector.', 'run.', 'email.', 'crm.', 'twin.'];

export function AuditLogPage(): JSX.Element {
  const { t } = useTranslation('settings');
  const [rows, setRows] = useState<AuditRecord[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefix, setPrefix] = useState('');
  // Debounced fetch key — typing a prefix must not fan out one request per
  // keystroke against the per-IP read budget (the documented 429 hazard).
  const [debouncedPrefix, setDebouncedPrefix] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedPrefix(prefix), 300);
    return () => window.clearTimeout(id);
  }, [prefix]);
  const [limit, setLimit] = useState(100);
  // §4.5 facet — outcome is an open vocabulary, so the options come from the
  // distinct values actually present in the loaded window (client-side filter).
  const [outcome, setOutcome] = useState('');
  // Out-of-order guard: a slow older response must not overwrite a newer one.
  const generation = useRef(0);
  /** AU-G1 — the read failed, so `rows === []` carries no information. */
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(() => {
    const gen = ++generation.current;
    setRows(null); setError(null); setForbidden(false); setLoadFailed(false);
    listAudit({ actionPrefix: debouncedPrefix, limit })
      .then((r) => { if (gen === generation.current) setRows(r); })
      .catch((err) => {
        if (gen !== generation.current) return;
        if (err instanceof ApiError && err.status === 403) setForbidden(true);
        else setError(err instanceof Error ? err.message : String(err));
        // AU-G1 — `[]` here is our ignorance, not the audit trail's contents.
        // This page correctly avoids the loading-sentinel trap by setting rows,
        // but the value it sets renders "No audited actions match — try clearing
        // the prefix filter", an INSTRUCTIVE empty state that implies the read
        // succeeded and simply matched nothing. On an audit surface that is the
        // worst thing to imply: an operator checking whether an action was
        // logged is told to adjust their filter.
        setRows([]);
        setLoadFailed(true);
      });
  }, [debouncedPrefix, limit]);
  useEffect(() => { load(); }, [load]);

  const outcomes = useMemo(
    () => (rows ? Array.from(new Set(rows.map((r) => r.outcome))).sort() : []),
    [rows],
  );
  const visibleRows = useMemo(
    () => (rows ?? []).filter((r) => !outcome || r.outcome === outcome),
    [rows, outcome],
  );
  const hasActiveFilters = prefix.trim() !== '' || outcome !== '';
  const clearFilters = (): void => { setPrefix(''); setOutcome(''); };

  // ADR 0416 P3 — tenant audit-chain export. Tenant-admin authority (NOT the
  // superadmin gate above), so the action renders even in the forbidden state.
  const [exporting, setExporting] = useState<'jsonl' | 'csv' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const exportChain = (format: 'jsonl' | 'csv'): void => {
    setExporting(format); setExportError(null);
    downloadAuditChainExport(format)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) setExportError(t('auditExportForbidden'));
        else setExportError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setExporting(null));
  };

  const columns: DataColumn<AuditRecord>[] = [
    { key: 'timestamp', header: t('auditColTime'), render: (r) => <span className="u-fs-12">{formatDateTime(r.timestamp)}</span>, sortValue: (r) => r.timestamp },
    { key: 'action', header: t('auditColAction'), render: (r) => <code className="u-fs-12">{r.action}</code>, sortValue: (r) => r.action },
    { key: 'principalId', header: t('auditColActor'), render: (r) => <span className="u-fs-12 u-truncate">{r.principalId}</span>, sortValue: (r) => r.principalId },
    { key: 'resource', header: t('auditColResource'), render: (r) => <span className="u-fs-12 u-truncate">{r.resource}</span>, sortValue: (r) => r.resource },
    {
      key: 'outcome', header: t('auditColOutcome'),
      render: (r) => <span className={`chip ${r.outcome === 'success' ? 'chip--success' : 'chip--danger'}`}>{t(`auditOutcome_${r.outcome}`, { defaultValue: r.outcome })}</span>,
      sortValue: (r) => r.outcome,
    },
  ];

  return (
    <section data-walkthrough="audit-log.page">
      <PageHeader eyebrow={t('auditEyebrow')} title={t('auditTitle')} lede={t('auditLede')} />
      <div className="action-bar u-wrap u-mb-3" role="group" aria-label={t('auditExportAria')}>
        <span className="u-fs-12 u-text-muted">{t('auditExportLabel')}</span>
        <Button variant="secondary" size="sm" disabled={exporting !== null} onClick={() => exportChain('jsonl')}>
          {exporting === 'jsonl' ? t('auditExporting') : t('auditExportJsonl')}
        </Button>
        <Button variant="secondary" size="sm" disabled={exporting !== null} onClick={() => exportChain('csv')}>
          {exporting === 'csv' ? t('auditExporting') : t('auditExportCsv')}
        </Button>
      </div>
      {exportError && <Notice variant="error">{exportError}</Notice>}
      {forbidden ? (
        <StateCard icon={<ShieldIcon size={20} />} title={t('auditForbiddenTitle')} body={t('auditForbiddenBody')} />
      ) : (
        <>
          <div className="filterbar action-bar u-wrap u-mb-3">
            <label className="u-flex u-items-center u-gap-1-5">
              <SearchIcon size={14} aria-hidden />
              <input
                list="audit-prefixes"
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder={t('auditPrefixPlaceholder')}
                aria-label={t('auditPrefixAria')}
              />
              <datalist id="audit-prefixes">
                {PREFIX_PRESETS.filter((p) => p).map((p) => <option key={p} value={p} />)}
              </datalist>
            </label>
            {outcomes.length > 1 ? (
              <select className="ui-input filterbar-select" value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label={t('auditOutcomeAria')}>
                <option value="">{t('auditOutcomeAll')}</option>
                {outcomes.map((o) => <option key={o} value={o}>{t(`auditOutcome_${o}`, { defaultValue: o })}</option>)}
              </select>
            ) : null}
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} aria-label={t('auditLimitAria')}>
              {[50, 100, 250, 500].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <Button variant="secondary" size="sm" onClick={load}>
              <RotateCwIcon size={13} /> {t('auditRefresh')}
            </Button>
            {hasActiveFilters ? (
              <Button variant="quiet" size="sm" onClick={clearFilters}>{t('auditClearFilters')}</Button>
            ) : null}
          </div>
          {error && <Notice variant="error">{error}</Notice>}
          {rows === null ? (
            <SkeletonRows rows={6} columns={['15%', '25%', '20%', '25%', '10%']} />
          ) : loadFailed ? (
            <StateCard announce
              icon={<ShieldIcon size={20} />}
              title={t('auditLoadFailedTitle')}
              body={t('auditLoadFailedBody')}
              action={<Button variant="secondary" size="sm" onClick={load}>{t('auditRetry')}</Button>}
            />
          ) : rows.length === 0 ? (
            <StateCard icon={<ShieldIcon size={20} />} title={t('auditEmptyTitle')} body={t('auditEmptyBody')} />
          ) : visibleRows.length === 0 ? (
            <StateCard icon={<ShieldIcon size={20} />} title={t('auditNoMatchTitle')} body={t('auditNoMatchBody')} action={<Button variant="secondary" size="sm" onClick={clearFilters}>{t('auditClearFilters')}</Button>} />
          ) : (
            <DataTable columns={columns} rows={visibleRows} rowKey={(r) => `${r.timestamp}:${r.principalId}:${r.action}:${r.resource}`} />
          )}
        </>
      )}
    </section>
  );
}
