/**
 * ADR 0855 P5 — "Check a pull request" on the Ledger tab: a person who can edit
 * the project names a GitHub pull request; the server reads it through their
 * read-only GitHub connection and runs the drift check against the ledger.
 * Unexplained departures arrive under Possible decisions. Every failure is said
 * (no connection, not found, budget spent), never shown as "nothing found".
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { checkPullRequestDrift } from './teamLedgerClient.js';

type Outcome = { kind: 'done'; unexplained: number } | { kind: 'failed'; message: string };

export function PullRequestDriftCheck({ projectId, onChecked }: { projectId: string; onChecked: () => void }): JSX.Element {
  const { t } = useTranslation('projects');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const check = async (): Promise<void> => {
    setBusy(true);
    setOutcome(null);
    try {
      const r = await checkPullRequestDrift(projectId, url.trim());
      setOutcome({ kind: 'done', unexplained: r.unexplained });
      if (r.unexplained > 0) onChecked();
    } catch (err) {
      const status = (err as { status?: number }).status;
      const key = status === 424 ? 'ledgerPrNoConnection' : status === 404 ? 'ledgerPrNotFound' : status === 400 ? 'ledgerPrBadUrl'
        : status === 429 ? 'ledgerPrBudget' : 'ledgerPrFailed';
      setOutcome({ kind: 'failed', message: t(key) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="surface-card" aria-labelledby="ledger-pr-check">
      <h2 id="ledger-pr-check" className="u-fs-14">{t('ledgerPrTitle')}</h2>
      <p className="muted u-fs-12">{t('ledgerPrLede')}</p>
      <form className="action-bar u-mt-1" onSubmit={(e) => { e.preventDefault(); if (url.trim() && !busy) void check(); }}>
        <label className="sr-only" htmlFor="ledger-pr-url">{t('ledgerPrUrl')}</label>
        <input id="ledger-pr-url" className="input" type="url" inputMode="url" placeholder="https://github.com/owner/repo/pull/123"
          value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy} />
        <Button type="submit" variant="secondary" size="sm" disabled={busy || !url.trim()}>{busy ? t('ledgerPrChecking') : t('ledgerPrCheck')}</Button>
      </form>
      {outcome?.kind === 'failed' ? <Notice variant="error" announce={outcome.message}>{outcome.message}</Notice> : null}
      {outcome?.kind === 'done' ? (
        <p className="u-fs-12" role="status">{outcome.unexplained > 0 ? t('ledgerPrFound', { count: outcome.unexplained }) : t('ledgerPrClean')}</p>
      ) : null}
    </section>
  );
}
