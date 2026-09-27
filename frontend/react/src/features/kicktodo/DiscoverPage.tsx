/**
 * KickTodo Discover (ADR 0436 §5.4 — the redesign over ADR 0414 P5). The published
 * catalog: decision-critical cards + search + content-locale negotiation. Enroll no
 * longer happens on a card — a card opens the challenge DETAIL, where the commitment
 * preview is shown before joining (the recommendation's rule). 4-locale copy; ui/
 * cohesion + the §4.5 collection canon (search over an every-entity-has-a-URL grid).
 */
import { Button } from '../../ui/Button.js';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRightIcon, FlagIcon, SearchIcon } from '../../ui/icons/index.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import {
  listChallengesForLocale,
  type NegotiatedChallenge,
  listEnrollments,
  publicChallengeCatalog,
  type ChallengeSummary,
  recommendedChallenges,
  type ChallengeRecommendation,
} from '../../client/kicktodoClient.js';
import { useAuth } from '../../auth/useAuth.js';

const CONTENT_LOCALE_KEY = 'kicktodo.contentLocale';
const CONTENT_LOCALES = ['en', 'es', 'fr', 'pt-BR'] as const;
type TimeBudget = 'all' | '10' | '20' | '30';
type DurationBudget = 'all' | '14' | '30';

function dailyMinutes(c: ChallengeSummary): number {
  const total = c.activities.reduce((sum, activity) => sum + (activity.estimatedMinutes ?? 0), 0);
  return c.durationDays > 0 ? Math.round(total / c.durationDays) : 0;
}

function localeLabel(tag: string, uiLocale: string): string {
  try { return new Intl.DisplayNames([uiLocale], { type: 'language' }).of(tag) ?? tag; }
  catch { return tag; }
}

/** Literal keys per reason (KTUX-9): the reason is rendered, never inferred. */
function reasonKey(reason: ChallengeRecommendation['reason']): string {
  switch (reason) {
    case 'next-depth': return 'discoverReasonNextDepth';
    case 'same-depth': return 'discoverReasonSameDepth';
    case 'starter': return 'discoverReasonStarter';
    default: return 'discoverReasonMore';
  }
}

export function DiscoverPage() {
  const { t, i18n } = useTranslation('kicktodo');
  const [contentLocale, setContentLocale] = useState<string>(
    () => localStorage.getItem(CONTENT_LOCALE_KEY) ?? i18n.language ?? 'en',
  );
  const [servedBy, setServedBy] = useState<Record<string, NegotiatedChallenge>>({});
  const [challenges, setChallenges] = useState<ChallengeSummary[] | null>(null);
  const [enrolledIds, setEnrolledIds] = useState<Set<string>>(new Set());
  const { user } = useAuth();
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [depth, setDepth] = useState<'all' | 'beginner' | 'intermediate' | 'advanced'>('all');
  const [timeBudget, setTimeBudget] = useState<TimeBudget>('all');
  const [durationBudget, setDurationBudget] = useState<DurationBudget>('all');
  // ADR 0692 — "what next", signed-in only; empty ⇒ no section.
  const [recommended, setRecommended] = useState<ChallengeRecommendation[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        setError(false);
        // ADR 0684 phase 4 — an ANONYMOUS visitor reads the public catalog, which
        // resolves org → tenant server-side, and skips `listEnrollments` entirely.
        // Not an optimisation: a signed-out visitor's tenant is a fresh
        // `anon:<sid>`, so the authenticated calls would 401 and, worse, a
        // successful empty read would render "no challenges" as though the
        // programme had none. There is also no "my enrolments" for a stranger —
        // `enrollmentService.ts:175` fetches from the ENROLLING tenant, so nobody
        // can enroll from this surface. Enrolling is what signing up is for.
        if (!user) {
          const publicList = await publicChallengeCatalog(contentLocale);
          setServedBy({});
          setChallenges(publicList);
          setEnrolledIds(new Set());
          setRecommended([]);
          return;
        }
        const [negotiated, mine, reco] = await Promise.all([listChallengesForLocale(contentLocale), listEnrollments(), recommendedChallenges()]);
        setRecommended(reco);
        setServedBy(Object.fromEntries(negotiated.map((n) => [n.challenge.id, n])));
        setChallenges(negotiated.map((n) => n.challenge));
        // KT-EXP-5 (grade-data): key the enrolled badge by challengeId, NOT
        // challengeId@version — a published version bump (v1→v2) must not hide the
        // badge and invite a returning participant to re-enroll at v2 (a client-
        // surfaced duplicate). ChallengeDetail's `alreadyEnrolled` matches by id too.
        setEnrolledIds(new Set(mine.map((e) => e.challengeId)));
      } catch {
        setError(true);
      }
    })();
  }, [contentLocale, user]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const maxMinutes = timeBudget === 'all' ? null : Number(timeBudget);
    const maxDays = durationBudget === 'all' ? null : Number(durationBudget);
    return (challenges ?? []).filter((c) => {
      const daily = dailyMinutes(c);
      return (depth === 'all' || c.depthLevel === depth)
        && (!maxMinutes || (daily > 0 && daily <= maxMinutes))
        && (!maxDays || c.durationDays <= maxDays)
        && (!q || [c.title, c.summary, c.outcome].some((s) => s.toLowerCase().includes(q)));
    });
  }, [challenges, query, depth, timeBudget, durationBudget]);

  // ADR 0443 R4 — literal keys so check-i18n sees them (the KTUX-9 rule).
  const depthLabel = (d: 'beginner' | 'intermediate' | 'advanced'): string =>
    d === 'beginner' ? t('depth_beginner') : d === 'intermediate' ? t('depth_intermediate') : t('depth_advanced');

  const hasTimeData = (challenges ?? []).some((challenge) => dailyMinutes(challenge) > 0);
  const hasFitFilters = query.trim() !== '' || depth !== 'all' || timeBudget !== 'all' || durationBudget !== 'all';

  return (
    <div className="page" data-walkthrough="kicktodo-discover.page">
      <header className="kt-discover-hero">
        <div className="kt-discover-hero__copy">
          <p className="kt-discover-hero__eyebrow">{t('discoverEyebrow')}</p>
          <h1 className="kt-discover-hero__title">{t('discoverTitle')}</h1>
          <p className="kt-discover-hero__lede">{t('discoverLede')}</p>
        </div>
        <ol className="kt-discover-steps" aria-label={t('discoverHowLabel')}>
          <li><span aria-hidden>1</span><strong>{t('discoverStepChoose')}</strong><small>{t('discoverStepChooseBody')}</small></li>
          <li><span aria-hidden>2</span><strong>{t('discoverStepFit')}</strong><small>{t('discoverStepFitBody')}</small></li>
          <li><span aria-hidden>3</span><strong>{t('discoverStepAct')}</strong><small>{t('discoverStepActBody')}</small></li>
        </ol>
      </header>

      {/* The §4.5 collection canon filterbar (screen-polish: filters lived in
          the header's button-cluster). Goal search stays visible even for a
          small catalog: it teaches visitors what this collection is for. */}
      <section className="kt-discover-search" aria-labelledby="discover-goal-label">
        <div className="kt-discover-search__field">
          <label id="discover-goal-label" className="kt-discover-search__label" htmlFor="discover-goal-search">{t('discoverSearchLabel')}</label>
          <span className="kt-discover-search__control">
            <SearchIcon size={19} aria-hidden />
            <input id="discover-goal-search" type="search" className="ui-input" value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('discoverSearchPlaceholder')} aria-describedby="discover-goal-hint" />
          </span>
          <small id="discover-goal-hint">{t('discoverSearchHint')}</small>
        </div>
        <div className="kt-discover-search__filters">
          {hasTimeData && (
            <label className="field">
              <span className="field-label">{t('discoverTimeBudgetLabel')}</span>
              <select className="filterbar-select" value={timeBudget} onChange={(e) => setTimeBudget(e.target.value as TimeBudget)}>
                <option value="all">{t('discoverTimeBudgetAny')}</option>
                <option value="10">{t('discoverTimeBudgetOption', { count: 10 })}</option>
                <option value="20">{t('discoverTimeBudgetOption', { count: 20 })}</option>
                <option value="30">{t('discoverTimeBudgetOption', { count: 30 })}</option>
              </select>
            </label>
          )}
          {(challenges?.length ?? 0) > 1 && (
            <label className="field">
              <span className="field-label">{t('discoverDurationBudgetLabel')}</span>
              <select className="filterbar-select" value={durationBudget} onChange={(e) => setDurationBudget(e.target.value as DurationBudget)}>
                <option value="all">{t('discoverDurationBudgetAny')}</option>
                <option value="14">{t('discoverDurationBudgetOption', { count: 14 })}</option>
                <option value="30">{t('discoverDurationBudgetOption', { count: 30 })}</option>
              </select>
            </label>
          )}
          {(challenges?.length ?? 0) > 4 && (challenges ?? []).some((c) => c.depthLevel) && (
            <label className="field">
              <span className="field-label">{t('depthFilterLabel')}</span>
              <select className="filterbar-select" value={depth} onChange={(e) => setDepth(e.target.value as typeof depth)}>
                <option value="all">{t('depthAll')}</option>
                <option value="beginner">{t('depth_beginner')}</option>
                <option value="intermediate">{t('depth_intermediate')}</option>
                <option value="advanced">{t('depth_advanced')}</option>
              </select>
            </label>
          )}
          <label className="field">
            <span className="field-label">{t('contentLocaleLabel')}</span>
            <select className="filterbar-select" value={contentLocale}
              onChange={(e) => { setContentLocale(e.target.value); localStorage.setItem(CONTENT_LOCALE_KEY, e.target.value); }}>
              {CONTENT_LOCALES.map((loc) => <option key={loc} value={loc}>{localeLabel(loc, i18n.language)}</option>)}
            </select>
          </label>
        </div>
      </section>

      {error && <Notice variant="error">{t('loadChallengesError')}</Notice>}
      {!challenges && !error && <StateCard loading title={t('discoverTitle')} />}
      {challenges && challenges.length === 0 && !error && (
        <StateCard icon={<FlagIcon aria-hidden />} title={t('discoverEmptyTitle')} body={t('discoverEmptyBody')} />
      )}
      {challenges && challenges.length > 0 && shown.length === 0 && (
        <StateCard title={t('discoverNoMatchTitle')} body={t('discoverNoMatchBody')}
          action={<Button variant="quiet" size="sm" onClick={() => {
            setQuery(''); setDepth('all'); setTimeBudget('all'); setDurationBudget('all');
          }}>{t('clearFilters')}</Button>} />
      )}

      {/* ADR 0692 — "what next": the participant's own next steps, with the reason
          stated verbatim. Signed-in only; hidden when empty; never above the filters. */}
      {recommended.length > 0 && (
        <section className="surface-card" aria-label={t('discoverRecommendedHeading')}>
          <h2 className="u-fs-13 muted">{t('discoverRecommendedHeading')}</h2>
          <ul className="list-plain">
            {recommended.map((r) => (
              <li key={`${r.id}@${r.version}`} className="list-row">
                <Link className="title-link" to={`/discover/${encodeURIComponent(r.id)}`}>{r.title}</Link>
                <span className="chip chip--muted">{t(reasonKey(r.reason))}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {challenges && challenges.length > 0 && shown.length > 0 && (
        <section className="kt-discover-catalog" aria-labelledby="discover-catalog-heading">
          <div className="kt-discover-catalog__heading">
            <h2 id="discover-catalog-heading">{t('discoverCatalogHeading')}</h2>
            <span>{t('discoverCatalogCount', { count: shown.length })}</span>
          </div>
          <div className="card-grid kt-challenge-grid">
            {shown.map((c) => {
              const enrolled = enrolledIds.has(c.id);
              const daily = dailyMinutes(c);
              const fitReasons = [
                query.trim() ? t('discoverFitGoal', { query: query.trim() }) : null,
                timeBudget !== 'all' && daily > 0 ? t('discoverFitTime', { count: daily }) : null,
                durationBudget !== 'all' ? t('discoverFitDuration', { count: c.durationDays }) : null,
                depth !== 'all' && c.depthLevel ? depthLabel(c.depthLevel) : null,
              ].filter((reason): reason is string => Boolean(reason));
              return (
                <article key={`${c.id}@${c.version}`} className="surface-card kt-challenge-card">
                  <Link className="kt-challenge-card__link" to={`/discover/${encodeURIComponent(c.id)}`}>
                    <div className="kt-challenge-card__topline">
                      <span>{enrolled ? t('enrolledBadge') : t('discoverChallengeLabel')}</span>
                      <ArrowRightIcon size={18} aria-hidden />
                    </div>
                    <h3>{c.title}</h3>
                    <p className="kt-challenge-card__summary">{c.summary}</p>
                    {hasFitFilters && fitReasons.length > 0 ? (
                      <div className="kt-challenge-card__fit">
                        <span>{t('discoverFitLabel')}</span>
                        <p>{fitReasons.join(' · ')}</p>
                      </div>
                    ) : null}
                    <div className="action-bar">
                      <span className="chip">{t('daysLabel', { count: c.durationDays })}</span>
                      {daily > 0 && <span className="chip">{t('dailyMinutesLabel', { count: daily })}</span>}
                      <span className="chip">{t('activitiesLabel', { count: c.activities.length })}</span>
                      {c.depthLevel && (
                        <span className="chip chip--muted">
                          {/* The 9-square depth strip (deck lineage, one-pager pass) —
                              decorative doubling of the text label, tokens only. */}
                          <span className={`kt-depth kt-depth--${c.depthLevel}`} aria-hidden>
                            {Array.from({ length: 9 }, (_, i) => (
                              <span key={i} className={i < (c.depthLevel === 'beginner' ? 3 : c.depthLevel === 'intermediate' ? 6 : 9) ? 'kt-depth__sq kt-depth__sq--on' : 'kt-depth__sq'} />
                            ))}
                          </span>
                          {depthLabel(c.depthLevel)}
                        </span>
                      )}
                      {servedBy[c.id] && !servedBy[c.id]!.exactLocale && (
                        <span className="chip chip--muted">{t('shownInLocale', { locale: localeLabel(servedBy[c.id]!.servedLocale, i18n.language) })}</span>
                      )}
                    </div>
                    <div className="kt-challenge-card__outcome">
                      <span>{t('outcomeHeading')}</span>
                      <p>{c.outcome}</p>
                    </div>
                    <span className="kt-challenge-card__cta">{t('viewChallenge')} <ArrowRightIcon size={16} aria-hidden /></span>
                  </Link>
                </article>
              );
            })}
          </div>
        </section>
      )}
      {challenges && challenges.length > 0 && shown.length > 0 && (
        <p className="muted u-fs-13">{t('discoverPreviewNote')}</p>
      )}
    </div>
  );
}
