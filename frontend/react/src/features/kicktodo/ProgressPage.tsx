/**
 * KickTodo Progress (ADR 0436 §5.6) — transformation, consistency, and evidence,
 * not activity volume. It NEVER shows a bare percentage that implies false
 * precision: every figure states its basis ("6 of 10 required actions"), and
 * consistency is framed as recovery, never a broken streak or a failure. Backed
 * by the existing per-enrollment ProgressView; the richer achievement/verifier
 * trace (§5.6 detail) is honestly deferred until the backend exposes it.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SparklesIcon } from '../../ui/icons/index.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { KeyFigureBand } from '../../ui/KeyFigure.js';
import { Button } from '../../ui/Button.js';
import {
  listChallengesForLocale,
  listEnrollmentsWithProgress,
  type ProgressView,
} from '../../client/kicktodoClient.js';
import { formatDate } from '../../i18n/format.js';

interface Row { enrollmentId: string; challengeId: string; title: string; progress: ProgressView | null }

export function ProgressPage() {
  const { t, i18n } = useTranslation('kicktodo');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState(false);
  const [reloadSequence, setReloadSequence] = useState(0);

  useEffect(() => {
    let current = true;
    setRows(null);
    void (async () => {
      try {
        setError(false);
        // KTX-3 — ONE batch read for enrollments + all progress projections
        // (the per-enrollment fan-out was a per-IP rate-limit hazard).
        const [{ enrollments, progress }, catalog] = await Promise.all([
          listEnrollmentsWithProgress(),
          listChallengesForLocale(i18n.language).catch(() => []),
        ]);
        const titleOf = new Map(catalog.map((n) => [n.challenge.id, n.challenge.title]));
        if (!current) return;
        setRows(enrollments.map((e): Row => ({
          enrollmentId: e.id,
          challengeId: e.challengeId,
          title: titleOf.get(e.challengeId) ?? e.challengeId,
          progress: progress[e.id] ?? null,
        })));
      } catch {
        if (current) setError(true);
      }
    })();
    return () => { current = false; };
  }, [i18n.language, reloadSequence]);

  const isEmpty = rows !== null && rows.length === 0;

  return (
    <div data-walkthrough="kicktodo-progress.page" className="page">
      <header className="page-header">
        <h1 className="page-header__title">{t('progressTitle')}</h1>
        <p className="page-header__lede">{t('progressLede')}</p>
        <div className="action-bar">
          <Link className="btn-ghost btn-sm" to="/journal">{t('openJournal')}</Link>
        </div>
      </header>

      {error && (
        <StateCard
          announce
          title={t('progressLoadError')}
          body={t('progressLoadErrorBody')}
          action={<Button variant="accent-solid" onClick={() => setReloadSequence((n) => n + 1)}>{t('progressRetry')}</Button>}
        />
      )}
      {rows === null && !error && <StateCard loading title={t('progressTitle')} />}
      {isEmpty && !error && (
        <StateCard icon={<SparklesIcon aria-hidden />} title={t('progressEmptyTitle')} body={t('progressEmptyBody')}
          action={<Link className="btn-accent-solid" to="/discover">{t('browseChallenges')}</Link>} />
      )}

      {rows && rows.length > 0 && (
        <div className="kt-progress-stack">
          {rows.map((r) => <ProgressCard key={r.enrollmentId} row={r} />)}
        </div>
      )}
    </div>
  );
}

function ProgressCard({ row }: { row: Row }) {
  const { t } = useTranslation('kicktodo');
  const p = row.progress;
  const done = p?.completedActivities ?? 0;
  const total = p?.totalRequiredActivities ?? 0;
  const remaining = Math.max(0, total - done);
  const pct = useMemo(() => (total > 0 ? Math.round((done / total) * 100) : null), [done, total]);
  const completed = p?.state === 'completed' || p?.goalState === 'closed';
  const hasPlanBasis = total > 0;

  return (
    <section className="surface-card kt-progress-card" aria-labelledby={`progress-${row.enrollmentId}`}>
      <header className="kt-progress-card__header">
        <div>
          <p className="eyebrow">{completed ? t('progressJourneyComplete') : t('progressJourneyActive')}</p>
        {/* Screen-polish: the One Thing's signature type treatment stays on
            the signature (ADR 0436 §4.3 one-signature discipline) — Progress
            cards use the plain title register. */}
          <h2 id={`progress-${row.enrollmentId}`} className="kt-progress-title">{row.title}</h2>
          {p && <p className="muted u-m-0">{completed ? t('progressStatusComplete') : t('progressStatusActive', { current: p.currentDay, total: p.durationDays })}</p>}
        </div>
        {completed
          ? <span className="chip chip--success">{t('progressCompleted')}</span>
          : p && <span className="chip">{t('dayOf', { current: p.currentDay, total: p.durationDays })}</span>}
      </header>

      {p ? (
        <>
          {hasPlanBasis ? (
            <div className="kt-progress-story">
              <div className="kt-progress-story__heading">
                <div>
                  <p className="eyebrow">{t('progressPlanHeading')}</p>
                  <p className="kt-progress-story__statement">{t('progressMeaningful', { done, total })}</p>
                </div>
                {pct !== null && <span className="kt-progress-story__basis">{t('progressPctBasis', { pct })}</span>}
              </div>
              <progress className="kt-progress-meter" value={Math.min(done, total)} max={total} aria-label={t('progressMeterLabel', { done, total })} />
              <p className="muted u-m-0">{completed ? t('progressPlanCompleteBody') : t('progressPlanRemainingBody', { count: remaining })}</p>
            </div>
          ) : (
            <Notice variant="warning">{t('progressPlanUnknown')}</Notice>
          )}

          {/* The §5.6 serif figure band (one-pager pass) — the sanctioned
              KeyFigureBand primitive. Every figure carries its basis in the
              label; never a bare percentage. */}
          <KeyFigureBand ariaLabel={t('progressConsistency')} figures={[
            { key: 'checkins', label: t('progressFigCheckins'), value: p.checkInCount, sub: t('progressFigObserved') },
            { key: 'day', label: t('progressFigDay', { total: p.durationDays }), value: p.currentDay, sub: t('progressFigSchedule') },
            { key: 'done', label: t('progressFigActions', { total }), value: done, sub: hasPlanBasis ? t('progressFigOutcome') : t('progressFigUnknown') },
          ]} />

          <section className="kt-progress-narrative" aria-labelledby={`progress-story-${row.enrollmentId}`}>
            <p className="eyebrow">{t('progressNarrativeHeading')}</p>
            <h3 id={`progress-story-${row.enrollmentId}`}>{completed ? t('progressNarrativeCompleteTitle') : done > 0 ? t('progressNarrativeBuildingTitle') : t('progressNarrativeStartTitle')}</h3>
            <p>{completed
              ? t('progressNarrativeCompleteBody', { count: p.checkInCount })
              : done > 0
                ? t('progressNarrativeBuildingBody', { done, remaining })
                : t('progressNarrativeStartBody')}</p>
          </section>

          {/* §5.6 — REAL recovery state (store-backed recovery:: occurrences),
              framed as part of the plan, never a broken streak. Silent at zero. */}
          {p.recovery.offered > 0 && (
            <Notice variant="info">{t('progressRecoveryLine', { completed: p.recovery.completed, offered: p.recovery.offered })}</Notice>
          )}

          {/* §5.6 — the evidence trace, collapsed so the card stays scannable.
              Every row is the participant's own record: what, when, and whether
              it happened; recovery rows carry their own chip; an activity that
              no longer resolves is stated as such, never given an invented name. */}
          {p.trace.length > 0 && (
            <details className="kt-trace">
              <summary>{t('progressTraceHeading', { count: p.trace.length })}</summary>
              <p className="muted u-fs-13">{t('progressTraceBody')}</p>
              <ul role="list" className="list-plain">
                {p.trace.map((r) => (
                  <li key={`${r.stableActivityId}@${r.dateLocal}`} className="list-row">
                    <div>
                      <p className="u-m-0">{r.title ?? (r.recovery ? t('progressTraceRecoveryTitle') : t('progressTraceUnresolved'))}</p>
                      <p className="muted u-fs-13 u-m-0">
                        {r.day !== null ? `${t('progressTraceDay', { day: r.day })} · ` : ''}
                        {(() => { try { return formatDate(r.dateLocal, { dateStyle: 'medium' }); } catch { return r.dateLocal; } })()}
                      </p>
                    </div>
                    <span className={r.completed ? 'chip chip--success' : 'chip chip--muted'}>
                      {r.completed ? t('progressTraceDone') : t('progressTraceNotDone')}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {completed && <Notice variant="success">{t('progressCompletionCelebration')}</Notice>}
          <div className="kt-progress-next">
            <div>
              <p className="eyebrow">{t('progressNextHeading')}</p>
              <h3>{completed ? t('progressNextReflectTitle') : t('progressNextActionTitle')}</h3>
              <p>{completed ? t('progressNextReflectBody') : t('progressNextActionBody')}</p>
            </div>
            <div className="action-bar">
              <Link className="btn-accent-solid btn-sm" to={completed ? '/journal' : '/today'}>{completed ? t('openJournal') : t('navTodayLabel')}</Link>
              <Link className="btn-ghost btn-sm" to="/?agent=host:kickbot">{t('askKickbot')}</Link>
            </div>
          </div>
        </>
      ) : (
        <div className="kt-progress-unknown">
          <h3>{t('progressUnavailableTitle')}</h3>
          <p>{t('progressUnavailable')}</p>
          <div className="action-bar">
            <Link className="btn-accent-solid btn-sm" to="/today">{t('navTodayLabel')}</Link>
            <Link className="btn-ghost btn-sm" to="/?agent=host:kickbot">{t('askKickbot')}</Link>
          </div>
        </div>
      )}
    </section>
  );
}
