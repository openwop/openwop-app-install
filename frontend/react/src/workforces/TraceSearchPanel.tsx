/**
 * Cross-run trace/audit search (EP1 GA-2). Search a workforce's runs by
 * correlationId, batchId (a day's batch — the cross-run grouping), runId,
 * outcome, or status; each result links to its run detail.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Notice } from '../ui/Notice.js';
import { searchWorkforceTrace, type TraceSearchResult } from '../client/workforcesClient.js';

export function TraceSearchPanel({ workforceId }: { workforceId: string }): JSX.Element {
  const [q, setQ] = useState('');
  const [result, setResult] = useState<TraceSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function run(): void {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    searchWorkforceTrace(workforceId, q)
      .then(setResult)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }

  return (
    <section className="surface-card u-mb-4">
      <h3 className="u-mt-0">Trace search</h3>
      <p className="muted u-mt-0">
        Search runs across the workforce by correlation id, batch id, run id, outcome, or status.
      </p>
      <form
        className="action-bar u-gap-2"
        onSubmit={(e) => { e.preventDefault(); run(); }}
      >
        <input
          aria-label="Trace query"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. overridden, or a batch / correlation id"
          className="tracesearch-input"
        />
        <button type="submit" className="btn" disabled={busy || !q.trim()}>Search</button>
      </form>

      {error ? <Notice variant="error">{error}</Notice> : null}

      {result ? (
        result.matches.length === 0 ? (
          <p className="muted">No matches (scanned {result.scanned} runs).</p>
        ) : (
          <>
            <p className="muted u-fs-14">
              {result.matches.length} match{result.matches.length === 1 ? '' : 'es'} of {result.scanned} runs
              {result.capped ? ' (capped — refine the query for more)' : ''}.
            </p>
            <table className="data-table u-w-full">
              <thead>
                <tr><th>Run</th><th>Outcome</th><th>Status</th><th>Batch</th></tr>
              </thead>
              <tbody>
                {result.matches.map((m) => (
                  <tr key={m.runId}>
                    <td><Link to={`/runs/${encodeURIComponent(m.runId)}`}>{m.runId.slice(0, 16)}…</Link></td>
                    <td>{m.outcome ?? '—'}</td>
                    <td><span className="chip chip--muted">{m.status}</span></td>
                    <td className="tracesearch-batch-cell">{m.batchId?.slice(0, 12) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )
      ) : null}
    </section>
  );
}
