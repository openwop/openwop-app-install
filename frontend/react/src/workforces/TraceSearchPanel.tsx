/**
 * Cross-run trace/audit search (EP1 GA-2). Search a workforce's runs by
 * correlationId, batchId (a day's batch — the cross-run grouping), runId,
 * outcome, or status; each result links to its run detail.
 */
import { Button } from '../ui/Button.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Notice } from '../ui/Notice.js';
import { searchWorkforceTrace, type TraceSearchResult } from '../client/workforcesClient.js';

export function TraceSearchPanel({ workforceId }: { workforceId: string }): JSX.Element {
  const { t } = useTranslation('workforces');
  const [q, setQ] = useState('');
  const [result, setResult] = useState<TraceSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // WF-R2-1 — pairwise compare from the results (the LangSmith compare-from-
  // search shape, riding OUR existing /compare page). Exactly two runs arm the
  // button; a third checkbox disables rather than silently evicting.
  const [selected, setSelected] = useState<string[]>([]);

  function run(): void {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    setSelected([]);
    searchWorkforceTrace(workforceId, q)
      .then(setResult)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }

  const toggleSelected = (runId: string): void => {
    setSelected((cur) => (cur.includes(runId) ? cur.filter((id) => id !== runId) : [...cur, runId]));
  };

  return (
    <section className="surface-card u-mb-4">
      <h3 className="u-mt-0">{t('traceSearch')}</h3>
      <p className="muted u-mt-0">
        {t('traceSearchHelp')}
      </p>
      <form
        className="action-bar u-gap-2"
        onSubmit={(e) => { e.preventDefault(); run(); }}
      >
        <input
          aria-label={t('traceQueryAriaLabel')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('traceQueryPlaceholder')}
          className="tracesearch-input"
        />
        <Button type="submit" variant="primary" disabled={busy || !q.trim()}>{t('search')}</Button>
      </form>

      {error ? <Notice variant="error">{error}</Notice> : null}

      {result ? (
        result.matches.length === 0 ? (
          <p className="muted">{t('traceNoMatches', { scanned: result.scanned })}</p>
        ) : (
          <>
            <p className="muted u-fs-14">
              {t('traceMatches', { count: result.matches.length, scanned: result.scanned })}
              {result.capped ? t('traceCapped') : ''}.
            </p>
            <table className="data-table u-w-full">
              <thead>
                <tr><th><span className="sr-only">{t('traceColSelect')}</span></th><th>{t('traceColRun')}</th><th>{t('traceColOutcome')}</th><th>{t('traceColStatus')}</th><th>{t('traceColBatch')}</th></tr>
              </thead>
              <tbody>
                {result.matches.map((m) => (
                  <tr key={m.runId}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.includes(m.runId)}
                        disabled={selected.length >= 2 && !selected.includes(m.runId)}
                        onChange={() => toggleSelected(m.runId)}
                        aria-label={t('traceSelectRun', { runId: m.runId.slice(0, 16) })}
                      />
                    </td>
                    <td><Link to={`/runs/${encodeURIComponent(m.runId)}`}>{m.runId.slice(0, 16)}…</Link></td>
                    <td>{m.outcome ?? '—'}</td>
                    <td><span className="chip chip--muted">{m.status}</span></td>
                    <td className="tracesearch-batch-cell">{m.batchId?.slice(0, 12) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="action-bar u-mt-2">
              {selected.length === 2 ? (
                <Link
                  className="btn btn-sm"
                  to={`/compare?a=${encodeURIComponent(selected[0]!)}&b=${encodeURIComponent(selected[1]!)}`}
                >
                  {t('traceCompareSelected')}
                </Link>
              ) : (
                <span className="muted u-fs-13">{t('traceCompareHint')}</span>
              )}
            </div>
          </>
        )
      ) : null}
    </section>
  );
}
