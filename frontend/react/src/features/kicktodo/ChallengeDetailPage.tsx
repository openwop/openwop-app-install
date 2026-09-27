/**
 * KickTodo challenge detail (ADR 0436 §5.4). The commitment preview a participant
 * sees BEFORE enrolling — the recommendation's rule is "do not enroll directly from
 * a catalog card without a plan/commitment preview." The challenge summary IS that
 * preview: outcome, what you'll do (week preview), daily rhythm, and the evidence
 * you'll be asked for. Enroll lives HERE, not on the card. Sections with no backend
 * data yet (price/creator/reviews/cohort) are honestly omitted, never faked.
 *
 * ADR 0684 phase 4 — a SIGNED-OUT visitor gets the same preview from the public
 * catalog (read-only acquisition surface) and a sign-in prompt where the enrol
 * CTA would be; nothing tenant-scoped is requested for them. Signing in from
 * the shell flips `user`, the effect re-runs on the authenticated path, and the
 * enrol CTA appears in place — no redirect dance.
 */
import { Button } from '../../ui/Button.js';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { enroll, mintInvite, getChallengeForLocale, getChallengePrice, getReferralCode, listEnrollments, publicChallengeForLocale, type ChallengeActivity, type ChallengePrice, type Enrollment, type NegotiatedChallenge } from '../../client/kicktodoClient.js';
import { useAuth } from '../../auth/useAuth.js';
import { SignInButton } from '../../auth/SignInButton.js';
import { formatDate, formatCurrency } from '../../i18n/format.js';

/** ADR 0443 R2 — localized short weekday label for 0=Sun..6=Sat via the shared
 *  format helper (2023-01-01 was a Sunday; +d days = weekday d). */
function weekdayLabel(d: number): string {
  return formatDate(Date.UTC(2023, 0, 1 + d), { weekday: 'short', timeZone: 'UTC' });
}

const CONTENT_LOCALE_KEY = 'kicktodo.contentLocale';

/** The rhythm, compressed to its true shape: consecutive days with identical
 *  activities collapse into one RUN ("Days 1–6"); the days that break the
 *  pattern (a synthesis, a rest-day check-in) stand alone as milestones. Every
 *  day is still accounted for — as a dot in the run's strip — so the preview
 *  stays honest while a 14-row wall becomes a 4-row rhythm.
 *  The signature deliberately covers ONLY the fields this page renders
 *  (title/minutes) plus evidencePolicy; `instructions` are excluded — if this
 *  page ever renders instructions, add them to the signature.
 *  Exported for the unit test that pins the collapse invariants (the
 *  `spineStatus` precedent). */
export function computeRuns(byDay: ReadonlyArray<readonly [number, ChallengeActivity[]]>): { from: number; to: number; acts: ChallengeActivity[] }[] {
  const sig = (acts: ChallengeActivity[]) =>
    JSON.stringify(acts.map((a) => [a.title, a.estimatedMinutes ?? 0, a.evidencePolicy]));
  const out: { from: number; to: number; acts: ChallengeActivity[] }[] = [];
  for (const [day, acts] of byDay) {
    const prev = out[out.length - 1];
    if (prev && day === prev.to + 1 && sig(acts) === sig(prev.acts)) prev.to = day;
    else out.push({ from: day, to: day, acts });
  }
  return out;
}

function localeLabel(tag: string, uiLocale: string): string {
  try { return new Intl.DisplayNames([uiLocale], { type: 'language' }).of(tag) ?? tag; }
  catch { return tag; }
}

export function ChallengeDetailPage() {
  const { t, i18n } = useTranslation('kicktodo');
  const navigate = useNavigate();
  const { challengeId = '' } = useParams();
  // Anonymous only when sign-in EXISTS and nobody is signed in. An unconfigured
  // deployment (local dev, most unit tests) has backend sessions without
  // Firebase, and its "no user" must keep taking the authenticated path.
  const { user, isConfigured } = useAuth();
  const anonymous = isConfigured && !user;
  // ADR 0444 I1 — the ?invite= token frames the landing and rides the enroll
  // call for server-side attribution. It grants nothing else.
  const [searchParams] = useSearchParams();
  const inviteToken = searchParams.get('invite');
  const [inviteCopied, setInviteCopied] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  // grade-ux: an invite-mint failure is NOT an enroll failure; and a clipboard
  // refusal (non-secure context) must still hand the user their link.
  const onInviteFriend = async () => {
    setError(null);
    let url: string;
    try {
      const token = await mintInvite(challengeId);
      // ADR 0451 P2b — for a PAID challenge, carry the inviter's referral code so
      // a referred purchase accrues them commission (free challenges: no code).
      const ref = neg?.challenge ? await getReferralCode(challengeId, neg.challenge.version) : null;
      url = `${window.location.origin}/discover/${encodeURIComponent(challengeId)}?invite=${encodeURIComponent(token)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`;
      setInviteUrl(url);
    } catch { setError('invite'); return; }
    try { await navigator.clipboard.writeText(url); setInviteCopied(true); }
    catch { setInviteCopied(false); /* the visible link below is the fallback */ }
  };
  const [neg, setNeg] = useState<NegotiatedChallenge | null | undefined>(undefined); // undefined = loading, null = not found
  const [error, setError] = useState<'load' | 'enroll' | 'invite' | null>(null);
  const [busy, setBusy] = useState(false);
  const [enrolled, setEnrolled] = useState(false);
  const [alreadyEnrolled, setAlreadyEnrolled] = useState(false); // KTUX-11 — pre-existing enrollment
  // KT-G1 — the enrolment read FAILED, so neither "enrolled" nor "not enrolled"
  // can be claimed. Distinct from `alreadyEnrolled === false`, which asserts.
  const [enrollmentUnknown, setEnrollmentUnknown] = useState(false);
  const [price, setPrice] = useState<ChallengePrice | null>(null); // ADR 0455 P2 — null = free

  const contentLocale = (typeof localStorage !== 'undefined' && localStorage.getItem(CONTENT_LOCALE_KEY)) || i18n.language || 'en';
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC', []);

  useEffect(() => {
    void (async () => {
      try {
        setError(null);
        // ADR 0684 phase 4 — the stranger's preview: the public catalog, no
        // enrolment read (there is nothing of theirs), no price read (authed;
        // the CTA is sign-in regardless). See publicChallengeForLocale.
        if (anonymous) {
          setNeg(await publicChallengeForLocale(challengeId, contentLocale));
          setEnrollmentUnknown(false);
          setAlreadyEnrolled(false);
          return;
        }
        // KTUX-11 (grade-ux): reflect an existing enrollment so a returning
        // participant sees "Go to Today", not a re-enroll CTA.
        // KT-G1 — this read decides whether the ENROL CTA shows. Swallowing it
        // to `[]` meant a failed read rendered "not enrolled", so a returning
        // participant was offered enrolment again — defeating the very
        // invariant the comment above states. We cannot tell them they are
        // enrolled, but we must not tell them they are NOT.
        const [c, mine] = await Promise.all([
          getChallengeForLocale(challengeId, contentLocale),
          listEnrollments().then((es) => ({ ok: true as const, es })).catch(() => ({ ok: false as const, es: [] as Enrollment[] })),
        ]);
        setNeg(c);
        setEnrollmentUnknown(!mine.ok);
        setAlreadyEnrolled(mine.ok && mine.es.some((e) => e.challengeId === challengeId));
        // ADR 0455 P2 — surface the price (null = free). Additive; a failure
        // never breaks the preview (the client swallows it to null).
        if (c) setPrice(await getChallengePrice(challengeId, c.challenge.version));
      } catch { setError('load'); }
    })();
  }, [challengeId, contentLocale, anonymous]);

  const c = neg?.challenge;
  const byDay = useMemo(() => {
    const map = new Map<number, ChallengeActivity[]>();
    for (const a of c?.activities ?? []) { const g = map.get(a.day) ?? []; g.push(a); map.set(a.day, g); }
    return [...map.entries()].sort(([x], [y]) => x - y);
  }, [c]);
  const runs = useMemo(() => computeRuns(byDay), [byDay]);
  const planPhases = useMemo(() => {
    if (!c) return [];
    return Array.from({ length: Math.ceil(c.durationDays / 7) }, (_, index) => {
      const from = index * 7 + 1;
      const to = Math.min(c.durationDays, from + 6);
      return { from, to, runs: computeRuns(byDay.filter(([day]) => day >= from && day <= to)) };
    }).filter((phase) => phase.runs.length > 0);
  }, [byDay, c]);
  // A single-day row only reads as punctuation when there ARE multi-day runs.
  const hasRuns = runs.some((r) => r.to > r.from);
  const totalMinutes = useMemo(() => (c?.activities ?? []).reduce((s, a) => s + (a.estimatedMinutes ?? 0), 0), [c]);
  const dailyMinutes = c && c.durationDays > 0 ? Math.round(totalMinutes / c.durationDays) : 0;
  // ADR 0443 R4 — literal keys so check-i18n sees them (the KTUX-9 rule).
  const depthLabel = (d: 'beginner' | 'intermediate' | 'advanced'): string =>
    d === 'beginner' ? t('depth_beginner') : d === 'intermediate' ? t('depth_intermediate') : t('depth_advanced');
  const evidenceKinds = useMemo(() => [...new Set((c?.activities ?? []).map((a) => a.evidencePolicy).filter((p) => p !== ''))], [c]);
  // An activity with NO policy (a public list served by a backend that predates
  // the 2026-09-16 projection correction) must not read as "just check in":
  // absence is "shown after sign-in", never the weakest policy. Measured on
  // kicktodo.com at `302a534` — the signed-out preview said "just check in"
  // under a sentence promising it was exactly what the visitor would commit to.
  const evidencePending = (c?.activities ?? []).some((a) => a.evidencePolicy === '');
  const evLabel = (p: string) =>
    p === 'measurement' ? t('evidenceMeasurementLabel')
      : p === 'photo' ? t('evidencePhotoLabel')
      : p === 'note' ? t('evidenceNoteLabel')
      : t('evidenceAttestationLabel');

  // ADR 0443 R2 — enroll-time-only allowed weekdays. Empty = every day (default);
  // frozen after enroll (a mid-flight change is a KickBot re-plan).
  const [days, setDays] = useState<number[]>([]);
  const toggleDay = (d: number) =>
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort((a, b) => a - b)));

  const onEnroll = async () => {
    if (!c) return;
    setBusy(true); setError(null);
    try {
      const enrollment = await enroll(c.id, c.version, timezone, days.length ? days : undefined, inviteToken ?? undefined);
      setEnrolled(true);
      // First-use onboarding should end in useful work, not a confirmation
      // cul-de-sac. Carry an ephemeral, non-authoritative welcome hint to Today;
      // Today verifies the enrollment against its own fresh read before showing
      // it, then puts the participant's first real action directly underneath.
      navigate('/today', {
        state: { kicktodoWelcome: { enrollmentId: enrollment.id, challengeTitle: c.title } },
      });
    }
    catch { setError('enroll'); }
    finally { setBusy(false); }
  };

  const renderRhythm = (rhythmRuns: typeof runs): JSX.Element => (
    <ol role="list" className="kt-rhythm">
      {rhythmRuns.map((r) => {
        const milestone = hasRuns && r.from === r.to;
        return (
          <li key={r.from} className="kt-rhythm__row">
            <div>
              <span className="kt-rhythm__range">
                {r.from === r.to ? t('dayLabelN', { day: r.from }) : t('dayRangeLabel', { from: r.from, to: r.to })}
              </span>
              <span className="kt-rhythm__dots" aria-hidden>
                {Array.from({ length: r.to - r.from + 1 }, (_, i) => (
                  <span key={i} className={milestone ? 'kt-rhythm__dot kt-rhythm__dot--milestone' : 'kt-rhythm__dot'} />
                ))}
              </span>
            </div>
            <ul role="list" className="kt-rhythm__acts">
              {r.acts.map((a) => (
                <li key={a.stableActivityId}>
                  {a.title}
                  {a.estimatedMinutes ? <span className="muted u-fs-13"> · {t('minutesLabel', { count: a.estimatedMinutes })}</span> : null}
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ol>
  );

  return (
    <div className="page" data-walkthrough="kicktodo-discover.page">
      <div className="action-bar">
        <Link className="btn-ghost btn-sm" to="/discover">{t('backToDiscover')}</Link>
      </div>

      {error === 'load' && <Notice variant="error">{t('loadChallengesError')}</Notice>}
      {neg === undefined && !error && <StateCard loading title={t('discoverTitle')} />}
      {neg === null && !error && <StateCard title={t('challengeNotFoundTitle')} body={t('challengeNotFoundBody')}
        action={<Link className="btn-accent-solid" to="/discover">{t('backToDiscover')}</Link>} />}

      {c && (
        <>
          {/* One column child — the bare flex page-header would otherwise flow
              title / lede / chips side-by-side (the floating-lede bug). */}
          <header className="page-header">
            <div>
              <h1 className="page-header__title">{c.title}</h1>
              <p className="page-header__lede">{c.summary}</p>
              <div className="action-bar kt-commit__meta">
                <span className="chip">{t('daysLabel', { count: c.durationDays })}</span>
                {dailyMinutes > 0 && <span className="chip">{t('dailyMinutesLabel', { count: dailyMinutes })}</span>}
                {/* ADR 0455 P2 — a paid challenge shows its price; free ones show nothing. */}
                {price && <span className="chip chip--accent">{formatCurrency(price.price, price.currency.toUpperCase())}</span>}
                {c.depthLevel && (
                  <span className="chip chip--muted">
                    {/* The 9-square depth strip (deck lineage — parity with the
                        Discover card that led here), tokens only. */}
                    <span className={`kt-depth kt-depth--${c.depthLevel}`} aria-hidden>
                      {Array.from({ length: 9 }, (_, i) => (
                        <span key={i} className={i < (c.depthLevel === 'beginner' ? 3 : c.depthLevel === 'intermediate' ? 6 : 9) ? 'kt-depth__sq kt-depth__sq--on' : 'kt-depth__sq'} />
                      ))}
                    </span>
                    {depthLabel(c.depthLevel)}
                  </span>
                )}
                {neg && !neg.exactLocale && (
                  <span className="chip chip--muted">{t('shownInLocale', { locale: localeLabel(neg.servedLocale, i18n.language) })}</span>
                )}
              </div>
            </div>
          </header>

          {/* The commitment ledger (ADR 0436 §5.4): the promise + the rhythm on
              the reading column; the decision — terms, evidence, schedule, CTA —
              on a sticky rail that keeps commit above the fold. The rail is
              FIRST in the DOM (grade-pass CD-1): on mobile it paints first
              without a CSS `order` hack, so focus/reading order matches the
              visual order; desktop places it in column 2 via explicit grid
              placement. */}
          <div className="kt-commit">
            <aside className="kt-commit__rail">
              <section className="surface-card kt-commit-card" aria-label={t('commitRailTitle')}>
                <h2 className="kt-eyebrow">{t('commitRailTitle')}</h2>
                <p className="kt-commit-card__pace">
                  <strong>{t('daysLabel', { count: c.durationDays })}</strong>
                  {dailyMinutes > 0 && <span className="muted"> · {t('dailyMinutesLabel', { count: dailyMinutes })}</span>}
                </p>
                <p className="muted u-fs-13 kt-commit-card__totals">
                  {t('activitiesLabel', { count: c.activities.length })}
                  {totalMinutes > 0 && <> · {t('totalMinutesLabel', { count: totalMinutes })}</>}
                </p>

                <h3 className="kt-eyebrow">{t('evidenceHeading')}</h3>
                <div className="action-bar">
                  {evidenceKinds.map((k) => <span key={k} className="chip">{evLabel(k)}</span>)}
                  {evidencePending && <span className="chip chip--muted">{t('evidencePendingLabel')}</span>}
                </div>
                <p className="muted u-fs-13">{t('evidencePrivacyNote')}</p>

                {/* ADR 0443 R2 — the enroll-time schedule choice (§ commitment
                    preview: the participant decides the rhythm BEFORE committing).
                    Empty = daily. */}
                {!anonymous && !(enrolled || alreadyEnrolled) && (
                  <>
                    <h3 className="kt-eyebrow" id="kt-schedule-days">{t('scheduleDaysHeading')}</h3>
                    <div className="action-bar" role="group" aria-labelledby="kt-schedule-days">
                      {/* Selection = SOFT ACCENT, not a status color (DESIGN.md
                          §4.5 rule 4 — grade-pass CD-6; success stays reserved
                          for verified run-state). */}
                      {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                        <button key={d} type="button" className={days.includes(d) ? 'chip chip--accent' : 'chip'}
                          aria-pressed={days.includes(d)} onClick={() => toggleDay(d)}>
                          {weekdayLabel(d)}
                        </button>
                      ))}
                    </div>
                    <p className="muted u-fs-13">{days.length ? t('scheduleDaysStretchNote') : t('scheduleDaysDailyNote')}</p>
                  </>
                )}

                {/* ADR 0444 I1 — the invited landing framing: the commitment
                    preview is never skipped; the invite only warms the welcome. */}
                {inviteToken && !(enrolled || alreadyEnrolled) && (
                  <Notice variant="info">{t('invitedFraming')}</Notice>
                )}

                <div className="kt-commit-card__actions">
                  {anonymous ? (
                    /* ADR 0684 phase 4 — the acquisition surface ends in a sign-in
                       prompt, not a dead enrol button: enrolling needs a tenant to
                       enrol INTO (enrollmentService.ts:175), and the shell's sign-in
                       control is the one entry point. After sign-in this page
                       re-renders on the authenticated path with the real CTA. */
                    <>
                      <Notice variant="info" announce={t('signInToStart')}>{t('signInToStart')}</Notice>
                      <SignInButton />
                    </>
                  ) : enrollmentUnknown && !enrolled ? (
                    /* KT-G1 — we could not read the enrolment list, so neither
                       CTA is honest: "Enrol" invites a duplicate for someone
                       already in, and an enrolled badge would be invented. Say
                       what we know and offer the one safe route. */
                    <>
                      <Notice variant="warning">{t('enrollmentUnknown')}</Notice>
                      <Link className="btn-accent-solid" to="/today">{t('goToToday')}</Link>
                      <Button variant="quiet" size="sm" onClick={() => window.location.reload()}>{t('enrollmentRecheck')}</Button>
                    </>
                  ) : enrolled || alreadyEnrolled ? (
                    <>
                      <span className="chip chip--success">{t('enrolledBadge')}</span>
                      <Link className="btn-accent-solid" to="/today">{t('goToToday')}</Link>
                      {/* Invite a friend — mints the caller's link + copies it. */}
                      <Button variant="quiet" size="sm" onClick={() => void onInviteFriend()}>
                        {inviteCopied ? t('inviteCopied') : t('inviteFriendCta')}
                      </Button>
                    </>
                  ) : price && !price.active ? (
                    // ADR 0455 P2 — sold but not currently buyable → honest, no dead CTA.
                    <Notice variant="info">{t('challengeUnavailable')}</Notice>
                  ) : price ? (
                    // ADR 0455 P2 — a paid challenge: Buy is the primary path (the
                    // storefront owns the checkout); "already purchased?" attempts the
                    // enroll, which the backend guard allows only for an entitled buyer.
                    <>
                      <Link className="btn-accent-solid"
                        to={`/store/${encodeURIComponent(price.orgId)}${searchParams.get('ref') ? `?ref=${encodeURIComponent(searchParams.get('ref')!)}` : ''}`}>
                        {t('buyToEnroll', { price: formatCurrency(price.price, price.currency.toUpperCase()) })}
                      </Link>
                      <Button variant="quiet" size="sm" disabled={busy}
                        onClick={() => void onEnroll()}
                        aria-label={busy ? t('enrolling') : `${t('alreadyPurchasedStart')}: ${c.title}`}>
                        {busy ? t('enrolling') : t('alreadyPurchasedStart')}
                      </Button>
                    </>
                  ) : (
                    <Button variant="accent-solid" disabled={busy}
                      onClick={() => void onEnroll()}
                      aria-label={busy ? t('enrolling') : `${t('previewAndStart')}: ${c.title}`}>
                      {busy ? t('enrolling') : t('previewAndStart')}
                    </Button>
                  )}
                  {error === 'enroll' && <Notice variant="error">{t('enrollError')}</Notice>}
                  {error === 'invite' && <Notice variant="error">{t('inviteError')}</Notice>}
                  {inviteUrl && !inviteCopied && (
                    <Notice variant="info">{t('inviteLinkFallback')} <code>{inviteUrl}</code></Notice>
                  )}
                </div>
              </section>
            </aside>

            <div className="kt-commit__main">
              <section className="surface-card">
                <h2 className="kt-eyebrow">{t('outcomeHeading')}</h2>
                {/* The transformation promise — the page's one serif (human) moment. */}
                <p className="kt-outcome">{c.outcome}</p>
              </section>

              <section className="surface-card">
                <h2 className="kt-eyebrow">{t('whatYouWillDo')}</h2>
                {c.durationDays > 7 ? (
                  <>
                    <h3 className="kt-rhythm-preview__heading">{t('challengeFirstWeekHeading')}</h3>
                    <p className="muted kt-rhythm-preview__lede">{t('challengeFirstWeekBody')}</p>
                    {renderRhythm(planPhases[0]?.runs ?? [])}
                    <details className="kt-rhythm-disclosure">
                      <summary>{t('challengeFullPlanSummary', { count: c.durationDays })}</summary>
                      <div className="kt-rhythm-phases">
                        {planPhases.map((phase) => (
                          <details key={phase.from} className="kt-rhythm-phase">
                            <summary>{t('challengePhaseLabel', { from: phase.from, to: phase.to })}</summary>
                            {renderRhythm(phase.runs)}
                          </details>
                        ))}
                      </div>
                    </details>
                  </>
                ) : renderRhythm(runs)}
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
