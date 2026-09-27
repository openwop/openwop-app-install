/**
 * Catalog & content-health (ADR 0438 A3) — the operator's read-only lens over the
 * KickTodo content lifecycle: the Challenge-Factory candidate pipeline (counts by
 * state + the privacy-floored publish rate) and the published catalog by lifecycle
 * state. Composes the EXISTING reads — `kicktodoMetricsClient.getFactory` (ADR 0432
 * projections, computed-on-read) + `kicktodoClient.listChallenges` — at admin
 * authority (`<AdminLayout>` gates `isAdminCaller`). No new backend, no wire.
 *
 * Honesty: a `FlooredCell` withheld below the k-anonymity floor renders as
 * "withheld", never a fabricated number (§3.4 metric trustworthiness).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { getFactory, type FactoryMetrics } from '../../client/kicktodoMetricsClient.js';
import { listChallenges, type ChallengeSummary } from '../../client/kicktodoClient.js';
import { countByState } from './catalogHealth.js';

export function CatalogHealthPage(): JSX.Element {
  const { t } = useTranslation('kicktodo-admin');
  const [factory, setFactory] = useState<FactoryMetrics | null | undefined>(undefined);
  const [challenges, setChallenges] = useState<ChallengeSummary[] | null>(null);
  const [error, setError] = useState(false);

  // KTUX-18 — a reusable load so the error state can offer a retry.
  const reload = useCallback(async () => {
    setError(false);
    // UX-KTA-3 — the two inner `.catch`es meant `Promise.all` could NEVER
    // reject, so the outer `catch { setError(true) }` was unreachable and the
    // KTUX-18 retry affordance below was dead code that could not render. The
    // comment above promises "the error state can offer a retry"; there was no
    // reachable error state.
    //
    // UX-KTA-2 — worse, the swallowed reads fabricated data. `listChallenges()`
    // → `[]` feeds `countByState([])`, i.e. a full set of ZERO counts, and
    // `getFactory()` → null blanks the pipeline. This file's docstring commits
    // to the opposite in as many words: "Honesty: ... never a fabricated number
    // (§3.4 metric trustworthiness)". The k-anonymity floor was honoured while
    // the failure path quietly invented zeros.
    const [f, cs] = await Promise.allSettled([getFactory(), listChallenges()]);
    if (f.status === 'fulfilled') setFactory(f.value);
    if (cs.status === 'fulfilled') setChallenges(cs.value);
    setError(f.status === 'rejected' || cs.status === 'rejected');
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const loading = factory === undefined && challenges === null && !error;
  const pipeline = factory ? Object.entries(factory.candidatesByState).sort(([a], [b]) => a.localeCompare(b)) : [];
  const catalog = countByState(challenges ?? []);

  // KTUX-17 (grade-ux, §4.5 rule 13) — no raw backend enum in a chip. Candidate
  // pipeline states + challenge lifecycle statuses get localized labels (raw fallback).
  const candStateLabel = (s: string): string =>
    s === 'intake' ? t('candState_intake')
      : s === 'researched' ? t('candState_researched')
      : s === 'planned' ? t('candState_planned')
      : s === 'published' ? t('candState_published')
      : s === 'withdrawn' ? t('candState_withdrawn')
      : s;
  const catalogStatusLabel = (s: string): string =>
    s === 'draft' ? t('challengeStatus_draft')
      : s === 'published' ? t('challengeStatus_published')
      : s === 'retired' ? t('challengeStatus_retired')
      : s;

  return (
    <div className="page">
      <div className="action-bar">
        <Link className="btn-ghost btn-sm" to="/admin/kicktodo">{t('backToConsole')}</Link>
      </div>
      <header className="page-header">
        <h1 className="page-header__title">{t('catalogTitle')}</h1>
        <p className="page-header__lede">{t('catalogLede')}</p>
      </header>

      {error && (
        <>
          <Notice variant="error">{t('catalogError')}</Notice>
          <div className="action-bar">
            <Button variant="quiet" size="sm" onClick={() => void reload()}>{t('retry')}</Button>
          </div>
        </>
      )}
      {loading && <StateCard loading title={t('catalogTitle')} />}

      {!loading && (
        <>
          {/* Candidate pipeline health (ADR 0432 factory projection). */}
          <section className="surface-card" aria-label={t('pipelineHeading')}>
            <h2 className="kt-eyebrow">{t('pipelineHeading')}</h2>
            {!factory ? (
              <p className="muted u-fs-13">{t('pipelineUnavailable')}</p>
            ) : (
              <>
                <div className="action-bar">
                  {pipeline.length === 0
                    ? <span className="muted u-fs-13">{t('pipelineEmpty')}</span>
                    : pipeline.map(([state, n]) => (
                      <span key={state} className="chip chip--muted">{t('pipelineState', { state: candStateLabel(state), count: n })}</span>
                    ))}
                </div>
                <p className="u-fs-13">
                  {factory.publishRate.value === null
                    ? <span className="muted">{t('publishRateWithheld', { contributors: factory.publishRate.contributors })}</span>
                    : t('publishRate', { rate: Math.round(factory.publishRate.value * 100) })}
                </p>
              </>
            )}
          </section>

          {/* Published catalog by lifecycle state. */}
          <section className="surface-card" aria-label={t('catalogStateHeading')}>
            <h2 className="kt-eyebrow">{t('catalogStateHeading')}</h2>
            {challenges === null ? (
              // UX-KTA-2 — an unread catalog must not claim "No published
              // challenges yet." That is the fabricated number this file's
              // docstring says it never produces.
              <p className="muted u-fs-13">{t('catalogUnknown')}</p>
            ) : catalog.length === 0 ? (
              <p className="muted u-fs-13">{t('catalogEmpty')}</p>
            ) : (
              <div className="action-bar">
                {catalog.map(([state, n]) => (
                  <span key={state} className={state === 'retired' ? 'chip chip--muted' : 'chip'}>
                    {t('catalogStateCount', { state: catalogStatusLabel(state), count: n })}
                  </span>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
