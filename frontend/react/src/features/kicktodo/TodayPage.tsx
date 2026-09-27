/**
 * KickTodo Today (ADR 0436 §3.2/§3.3 — the redesign over ADR 0414 P5). The
 * participant home: a greeting + a truthful workload summary → "The One Thing"
 * hero focus card (the signature) → compact rows for other due actions →
 * recovery (snooze/resume). It NEVER leads with streaks, points, or a chart, and
 * progress updates after evidence is accepted (no "Check progress" button — that
 * lives on the Progress surface, §5.6). Completion is evidence-aware (KTFULL-B6).
 * All copy i18n'd (4 locales); status → chips; ui/ cohesion + Daybreak tokens only.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRightIcon, CalendarIcon, FlagIcon, SparklesIcon } from '../../ui/icons/index.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { TheOneThing, ActionCompleter, washPosition, daypartOf } from './TheOneThing.js';
import { ReminderDelivery } from './ReminderDelivery.js';
import {
  checkIn,
  acceptRecovery,
  getToday,
  listChallenges,
  setSnooze,
  setSchedulePreference,
  listEnrollments,
  substituteAction,
  type ChallengeSummary,
  type CheckInEvidence,
  type Enrollment,
  type TodayAction,
  type TodayView,
} from '../../client/kicktodoClient.js';
import { useBackendSession } from '../../auth/backendSession.js';

interface TodayLocationState {
  kicktodoWelcome?: { enrollmentId: string; challengeTitle: string };
}

function welcomeFromState(state: unknown): TodayLocationState['kicktodoWelcome'] {
  if (!state || typeof state !== 'object' || !('kicktodoWelcome' in state)) return undefined;
  const welcome = (state as TodayLocationState).kicktodoWelcome;
  return welcome
    && typeof welcome.enrollmentId === 'string'
    && typeof welcome.challengeTitle === 'string'
    ? welcome
    : undefined;
}

/** The publisher-approved swap control (ADR 0429) — kept as a compact secondary on
 *  Today; the full plan editor (§5.5) is a later surface. */
function Substitute({ action, busy, expanded, onToggle, onPick }: {
  action: TodayAction;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onPick: (cardId: string, altId: string) => void;
}) {
  const { t } = useTranslation('kicktodo');
  if (!(action.alternatives?.length)) return null;
  const cardId = action.occurrence.cardId;
  return (
    <>
      <Button variant="quiet" size="sm" aria-expanded={expanded}
        aria-label={`${t('substitute')}: ${action.card?.title ?? ''}`} disabled={busy} onClick={onToggle}>
        {t('substitute')}
      </Button>
      {expanded && (
        <ul className="list-plain" role="group" aria-label={t('substituteGroupLabel')}>
          {action.alternatives.map((alt) => (
            <li key={alt.stableActivityId} className="list-row">
              <button type="button"
                className={action.occurrence.substitutedActivityId === alt.stableActivityId ? 'chip chip--success' : 'chip'}
                aria-pressed={action.occurrence.substitutedActivityId === alt.stableActivityId}
                disabled={busy} onClick={() => onPick(cardId, alt.stableActivityId)}>
                {alt.title}
              </button>
              <span className="muted u-fs-13">{alt.instructions}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function TodayPage() {
  const { t, i18n } = useTranslation('kicktodo');
  const location = useLocation();
  // The §4.2 serif human moment: "Good morning, Ada" when a display name
  // exists (shared backend-session store; anon sessions greet namelessly).
  const displayName = useBackendSession().user?.displayName ?? null;
  const [today, setToday] = useState<TodayView | null>(null);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [error, setError] = useState(false);
  // Screen-polish: a failed CHECK-IN is not a failed LOAD — separate signal.
  const [actionError, setActionError] = useState(false);
  const [catalog, setCatalog] = useState<ChallengeSummary[]>([]);
  const [busyCard, setBusyCard] = useState<string | null>(null);
  const [busyEnrollment, setBusyEnrollment] = useState<string | null>(null);
  const [substituteFor, setSubstituteFor] = useState<string | null>(null);
  const [recoverySuccess, setRecoverySuccess] = useState<number | null>(null);

  const reload = useCallback(async () => {
    try {
      setError(false);
      // ADR 0443 R1 — the enrollment rows carry the reminder preference (the
      // TodayView projection doesn't); one extra bounded read, same pattern as
      // Discover's enrolled-badge fetch.
      const [t, es, cs] = await Promise.all([
        getToday(),
        listEnrollments().catch(() => [] as Enrollment[]),
        listChallenges().catch(() => [] as ChallengeSummary[]),
      ]);
      setToday(t);
      setEnrollments(es);
      setCatalog(cs);
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const onSetDaypart = async (enrollmentId: string, daypart: 'morning' | 'afternoon' | 'evening' | null) => {
    setBusyEnrollment(enrollmentId);
    try { await setSchedulePreference(enrollmentId, daypart); await reload(); }
    catch { setActionError(true); }
    finally { setBusyEnrollment(null); }
  };

  const onComplete = async (cardId: string, evidence?: CheckInEvidence) => {
    setBusyCard(cardId);
    try { await checkIn(cardId, evidence); await reload(); }
    catch { setActionError(true); }
    finally { setBusyCard(null); }
  };
  const onSubstitute = async (cardId: string, altId: string) => {
    setBusyCard(cardId);
    try { await substituteAction(cardId, altId); setSubstituteFor(null); await reload(); }
    catch { setActionError(true); }
    finally { setBusyCard(null); }
  };
  const onSnooze = async (enrollmentId: string, snoozed: boolean) => {
    setBusyEnrollment(enrollmentId);
    try { setActionError(false); await setSnooze(enrollmentId, snoozed); await reload(); }
    catch { setActionError(true); }
    finally { setBusyEnrollment(null); }
  };
  const onRecover = async (enrollmentId: string, missed: number) => {
    setBusyEnrollment(enrollmentId);
    try {
      setActionError(false);
      const added = await acceptRecovery(enrollmentId);
      await reload();
      if (added) setRecoverySuccess(missed);
    } catch { setActionError(true); }
    finally { setBusyEnrollment(null); }
  };

  const challengeTitle = (challengeId: string): string | null =>
    catalog.find((c) => c.id === challengeId)?.title ?? null;

  const hour = useMemo(() => new Date().getHours(), []);
  const daypart = daypartOf(hour);
  const formattedDate = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(i18n.resolvedLanguage ?? i18n.language, {
        weekday: 'long', month: 'long', day: 'numeric',
      }).format(new Date());
    } catch {
      return new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
    }
  }, [i18n.language, i18n.resolvedLanguage]);

  // Active enrollments drive the hero + due list; snoozed ones are set aside for
  // recovery; a fully-done day is celebrated, not left blank.
  const active = useMemo(() => (today?.enrollments ?? []).filter((e) => e.state === 'active'), [today]);
  const snoozed = useMemo(() => (today?.enrollments ?? []).filter((e) => e.state === 'snoozed'), [today]);
  const allActive = useMemo(() => active.flatMap((e) => e.actions.map((a) => ({ a, e }))), [active]);
  const due = useMemo(() => allActive.filter(({ a }) => !a.card?.completed), [allActive]);
  const doneCount = allActive.length - due.length;
  const arcFill = allActive.length ? doneCount / allActive.length : 1;
  const hero = due[0];
  const dueChallengeCount = new Set(due.map((item) => item.e.enrollmentId)).size;
  const recoveryEnrollment = active.find((enrollment) => enrollment.recovery);
  const recovery = recoveryEnrollment?.recovery;
  const capacityGuard = !recovery && (due.length > 2 || dueChallengeCount > 1);
  // "Later today" is the WHOLE rest of the day, done rows included (design law:
  // completed work stays visible, struck through — the day never shrinks).
  const others = useMemo(
    () => allActive.filter((x) => x !== hero).sort((a, b) => Number(!!a.a.card?.completed) - Number(!!b.a.card?.completed)),
    [allActive, hero],
  );
  const hasEnrollments = (today?.enrollments.length ?? 0) > 0;
  const featuredChallenge = catalog[0] ?? null;
  const busyOf = (a: TodayAction) => busyCard === a.occurrence.cardId;
  const requestedWelcome = welcomeFromState(location.state);
  // Navigation state is only a presentation hint. A stale or fabricated state
  // cannot claim success unless the fresh enrollment read confirms the id.
  const welcome = requestedWelcome && enrollments.some((enrollment) => enrollment.id === requestedWelcome.enrollmentId)
    ? requestedWelcome
    : undefined;
  const heroChallengeTitle = hero ? challengeTitle(hero.e.challengeId) : null;

  const substituteFor_ = (a: TodayAction) => (
    <Substitute action={a} busy={busyOf(a)} expanded={substituteFor === a.occurrence.cardId}
      onToggle={() => setSubstituteFor(substituteFor === a.occurrence.cardId ? null : a.occurrence.cardId)}
      onPick={(c, alt) => void onSubstitute(c, alt)} />
  );

  return (
    <div className="page" data-walkthrough="kicktodo-today.page">
      <header className="kt-greeting">
        <div className="kt-greeting__copy">
          <p className="kt-greeting__date"><CalendarIcon size={15} aria-hidden /> {formattedDate}</p>
          <h1 className="kt-greeting__hello">
            {displayName ? t(`greetingNamed_${daypart}`, { name: displayName }) : t(`greeting_${daypart}`)}
          </h1>
          {today && hasEnrollments && (
            <p className="kt-greeting__summary">
              {active.length === 0 && snoozed.length > 0
                ? t('summaryPaused')
                : due.length === 0
                  ? t('summaryAllDone')
                  : t('summaryDue', { due: due.length, done: doneCount, total: allActive.length })}
              {due.length > 0 && dueChallengeCount > 1 && <> · {t('summaryAcrossChallenges', { count: dueChallengeCount })}</>}
              {due.length > 0 && allActive.length <= 2 && <> · {t('summaryLightDay')}</>}
            </p>
          )}
        </div>
        <Link className="kt-greeting__guide" to="/guide">
          <SparklesIcon size={18} aria-hidden />
          <span><strong>{t('todayGuideCta')}</strong><small>{t('todayGuideHint')}</small></span>
          <ArrowRightIcon size={16} aria-hidden />
        </Link>
      </header>

      {welcome ? (
        <Notice
          variant="success"
          announce={`${t('todayWelcomeTitle', { title: welcome.challengeTitle })} ${t('todayWelcomeBody')}`}
        >
          <strong>{t('todayWelcomeTitle', { title: welcome.challengeTitle })}</strong>{' '}
          {t('todayWelcomeBody')}
        </Notice>
      ) : null}

      {error && (
        <Notice variant="error">
          {navigator.onLine ? t('loadTodayError') : t('offlineNotice')}{' '}
          <Button variant="quiet" size="sm" onClick={() => void reload()}>{t('common:retry')}</Button>
        </Notice>
      )}
      {actionError && <Notice variant="error">{t('todayActionError')}</Notice>}
      {recoverySuccess !== null && (
        <Notice variant="success" announce={t('recoveryAddedNotice', { count: recoverySuccess })}>
          {t('recoveryAddedNotice', { count: recoverySuccess })}
        </Notice>
      )}
      {!today && !error && <StateCard loading title={t('todayTitle')} />}

      {today && !hasEnrollments && !error && (
        <section className="kt-today-empty" aria-labelledby="today-empty-heading">
          <div className="kt-today-empty__main">
            <span className="kt-today-empty__icon" aria-hidden><FlagIcon size={24} /></span>
            <p className="kt-today-empty__eyebrow">{t('todayEmptyEyebrow')}</p>
            <h2 id="today-empty-heading">{t('todayEmptyTitle')}</h2>
            <p>{t('todayEmptyBody')}</p>
            <ol className="kt-today-empty__steps">
              <li><span aria-hidden>1</span><div><strong>{t('todayEmptyStepChoose')}</strong><small>{t('todayEmptyStepChooseBody')}</small></div></li>
              <li><span aria-hidden>2</span><div><strong>{t('todayEmptyStepFit')}</strong><small>{t('todayEmptyStepFitBody')}</small></div></li>
              <li><span aria-hidden>3</span><div><strong>{t('todayEmptyStepReturn')}</strong><small>{t('todayEmptyStepReturnBody')}</small></div></li>
            </ol>
            <Link className="btn-accent-solid" to="/discover">{t('browseChallenges')} <ArrowRightIcon size={16} aria-hidden /></Link>
          </div>
          {featuredChallenge ? (
            <Link className="kt-today-empty__featured" to={`/discover/${encodeURIComponent(featuredChallenge.id)}`}>
              <span>{t('todayFeaturedLabel')}</span>
              <strong>{featuredChallenge.title}</strong>
              <p>{featuredChallenge.summary}</p>
              <small>{t('daysLabel', { count: featuredChallenge.durationDays })} · {t('todayFeaturedCta')}</small>
            </Link>
          ) : null}
        </section>
      )}

      {today && allActive.length > 0 && due.length === 0 && !error && (
        <StateCard icon={<SparklesIcon aria-hidden />} title={t('allCaughtUpTitle')} body={t('allCaughtUpBody')}
          action={<Link className="btn-ghost btn-sm" to="/discover">{t('browseChallenges')}</Link>} />
      )}

      {today && active.length === 0 && snoozed.length > 0 && !error && (
        <StateCard title={t('allPausedTitle')} body={t('allPausedBody')} />
      )}

      {recoveryEnrollment && recovery && (
        <section className="surface-card kt-recovery" aria-labelledby="today-recovery-heading">
          <div className="kt-recovery__heading">
            <span className="kt-recovery__icon" aria-hidden><FlagIcon size={20} /></span>
            <div>
              <p>{recovery.mode === 'offer' ? t('recoveryOfferLabel') : t('recoveryReviewLabel')}</p>
              <h2 id="today-recovery-heading">
                {recovery.mode === 'offer'
                  ? t('recoveryOfferTitle', { count: recovery.missed })
                  : t('recoveryReviewTitle', { count: recovery.missed })}
              </h2>
            </div>
          </div>
          <p className="kt-recovery__body">
            {recovery.mode === 'offer' ? t('recoveryOfferBody') : t('recoveryReviewBody')}
          </p>
          <div className="kt-recovery__impact">
            <strong>{t('recoveryImpactLabel')}</strong>
            <p>{recovery.mode === 'offer' ? t('recoveryOfferImpact') : t('recoveryReviewImpact')}</p>
          </div>
          <div className="action-bar">
            {recovery.mode === 'offer' ? (
              <Button variant="accent-solid" loading={busyEnrollment === recoveryEnrollment.enrollmentId}
                onClick={() => void onRecover(recoveryEnrollment.enrollmentId, recovery.missed)}>
                {t('recoveryAddAction')}
              </Button>
            ) : (
              <Link className="btn-accent-solid" to="/guide">{t('recoveryAskGuide')}</Link>
            )}
            <Button variant="quiet" disabled={busyEnrollment === recoveryEnrollment.enrollmentId}
              onClick={() => void onSnooze(recoveryEnrollment.enrollmentId, true)}>
              {challengeTitle(recoveryEnrollment.challengeId)
                ? t('snoozeNamed', { title: challengeTitle(recoveryEnrollment.challengeId) })
                : t('snoozeChallenge')}
            </Button>
          </div>
        </section>
      )}

      {hero && (
        <TheOneThing arcFill={arcFill} washX={washPosition(hour)}
          eyebrowSuffix={daypart === 'morning' ? t('daypart_morning') : daypart === 'afternoon' ? t('daypart_afternoon') : t('daypart_evening')}>
          <h2 className="kt-onething__title">{hero.a.card?.title ?? hero.a.occurrence.stableActivityId}</h2>
          {hero.a.card?.description && <p className="kt-onething__meta">{hero.a.card.description}</p>}
          <p className="kt-onething__reason">
            <strong>{t('whyThisActionLabel')}</strong>{' '}
            {heroChallengeTitle ? t('whyThisActionPlan', { title: heroChallengeTitle }) : t('whyThisActionToday')}
          </p>
          <div className="kt-onething__actions">
            <ActionCompleter action={hero.a} busy={busyOf(hero.a)} onComplete={(c, ev) => void onComplete(c, ev)} />
          </div>
          <div className="action-bar">
            {substituteFor_(hero.a)}
            <Link className="btn-ghost btn-sm" to="/?agent=host:kickbot">{t('askKickbot')}</Link>
          </div>
        </TheOneThing>
      )}

      {capacityGuard && (
        <details className="surface-card kt-capacity">
          <summary>
            <span><strong>{t('capacityTitle')}</strong><small>{t('capacitySummary', { due: due.length, challenges: dueChallengeCount })}</small></span>
          </summary>
          <p>{t('capacityBody')}</p>
          <ul className="list-plain" role="list">
            {active.map((enrollment) => {
              const count = due.filter((item) => item.e.enrollmentId === enrollment.enrollmentId).length;
              if (count === 0) return null;
              const title = challengeTitle(enrollment.challengeId);
              return (
                <li key={enrollment.enrollmentId} className="list-row">
                  <div>
                    <strong>{title ?? t('activeBadge')}</strong>
                    <p className="muted u-fs-13">{t('capacityPauseImpact', { count })}</p>
                  </div>
                  <Button variant="quiet" size="sm" disabled={busyEnrollment === enrollment.enrollmentId}
                    onClick={() => void onSnooze(enrollment.enrollmentId, true)}>
                    {title ? t('snoozeNamed', { title }) : t('snoozeChallenge')}
                  </Button>
                </li>
              );
            })}
          </ul>
        </details>
      )}

      {/* ADR 0443 R1 — the opt-in reminder rhythm for the hero enrollment. A
          preference arms a KickBot reminder at that daypart (consent-gated
          server-side); "off" clears it. Status is the pressed chip, labeled. */}
      {hero && (() => {
        const en = enrollments.find((e) => e.id === hero.e.enrollmentId);
        if (!en) return null;
        const current = en.schedulePreference?.daypart ?? null;
        const opts: Array<'morning' | 'afternoon' | 'evening'> = ['morning', 'afternoon', 'evening'];
        // Literal keys so check-i18n can see them (the KTUX-9 rule).
        const daypartLabel = (d: 'morning' | 'afternoon' | 'evening'): string =>
          d === 'morning' ? t('daypart_morning') : d === 'afternoon' ? t('daypart_afternoon') : t('daypart_evening');
        return (
          <section className="surface-card" aria-label={t('reminderHeading')}>
            <div className="action-bar" role="group" aria-label={t('reminderHeading')}>
              <span className="u-fs-13 muted">{t('reminderHeading')}</span>
              {opts.map((d) => (
                <button key={d} type="button" className={current === d ? 'chip chip--success' : 'chip'}
                  aria-pressed={current === d} disabled={busyEnrollment === en.id}
                  onClick={() => void onSetDaypart(en.id, current === d ? null : d)}>
                  {daypartLabel(d)}
                </button>
              ))}
              {current && (
                <Button variant="quiet" size="sm" disabled={busyEnrollment === en.id}
                  onClick={() => void onSetDaypart(en.id, null)}>
                  {t('reminderOff')}
                </Button>
              )}
            </div>
            {/* Where the reminder goes, and the one gesture that sends it outside
                the app (consent + this device's push subscription). */}
            {current && <ReminderDelivery />}
          </section>
        );
      })()}

      {others.length > 0 && (
        <section className="kt-otherdue" aria-label={t('otherDueLabel')}>
          <h2 className="u-fs-13 muted">{t('otherDueLabel')}</h2>
          <ul role="list" className="surface-card list-plain">
            {others.map(({ a }) => {
              const isDone = !!a.card?.completed;
              return (
                <li key={a.occurrence.cardId} className="list-row">
                  <div>
                    <strong className={isDone ? 'kt-struck' : undefined}>{a.card?.title ?? a.occurrence.stableActivityId}</strong>
                    {!isDone && a.card?.description && <p className="muted u-fs-13">{a.card.description}</p>}
                    {!isDone && <div className="action-bar">{substituteFor_(a)}</div>}
                  </div>
                  <ActionCompleter action={a} busy={busyOf(a)} onComplete={(c, ev) => void onComplete(c, ev)} />
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {snoozed.length > 0 && (
        <section className="kt-otherdue" aria-label={t('snoozedLabel')}>
          <h2 className="u-fs-13 muted">{t('snoozedLabel')}</h2>
          <ul role="list" className="surface-card list-plain">
            {snoozed.map((e) => (
              <li key={e.enrollmentId} className="list-row">
                <div>
                  <strong>{challengeTitle(e.challengeId) ?? t('snoozedBadge')}</strong>{' '}
                  <span className="chip chip--muted">{t('snoozedBadge')}</span>
                </div>
                <Button variant="quiet" size="sm" disabled={busyEnrollment === e.enrollmentId}
                  aria-label={`${t('resume')}: ${challengeTitle(e.challengeId) ?? e.challengeId}`}
                  onClick={() => void onSnooze(e.enrollmentId, false)}>{t('resume')}</Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Screen-polish (§4.3 "everything around it stays quiet"): recovery is
          a QUIET footer line, not another card competing with the hero; each
          snooze button names its challenge (the identical-label WCAG 2.4.6
          gap). */}
      {active.length > 0 && due.length > 0 && !capacityGuard && !recovery && (
        <section className="kt-otherdue" aria-label={t('recoveryLabel')}>
          <p className="muted u-fs-13">{t('snoozeFraming')}</p>
          <div className="action-bar">
            {active.map((e) => (
              <Button key={e.enrollmentId} variant="quiet" size="sm"
                disabled={busyEnrollment === e.enrollmentId}
                onClick={() => void onSnooze(e.enrollmentId, true)}>
                {challengeTitle(e.challengeId)
                  ? t('snoozeNamed', { title: challengeTitle(e.challengeId) })
                  : t('snoozeChallenge')}
              </Button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
