/**
 * Community (ADR 0426 P4) — the creator profile editor (draft → pending →
 * approved states as labeled chips; approval is required before anything is
 * public, and the copy says so) + the proof-gated review composer over the
 * caller's enrolled challenges (the backend enforces proof; the UI explains
 * denial rather than hiding it).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StarIcon } from '../../ui/icons/index.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { TextField, TextareaField } from '../../ui/Field.js';
import { handleRadiogroupKeyDown } from '../../ui/rovingTabs.js';
import { loadErrorMessage } from '../../client/loadErrorMessage.js';
import { listEnrollments, listChallenges, type Enrollment } from '../../client/kicktodoClient.js';
import {
  getMyProfile,
  saveProfile,
  submitMyProfile,
  getReviews,
  writeReview,
  CommunityRequestError,
  type CreatorProfile,
  type VisibleReview,
  type ReviewAggregate,
} from '../../client/kicktodoCommunityClient.js';

/** ADR 0453 P2 — the app's non-base content locales a creator may translate into.
 *  Each is labelled in its OWN language (Intl.DisplayNames), so the picker reads
 *  natively regardless of the UI locale. */
const CONTENT_LOCALES = ['es', 'fr', 'pt-BR'];
function localeName(tag: string): string {
  try { return new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag; }
  catch { return tag; }
}

function stateChip(state: CreatorProfile['state']): { key: string; cls: string } {
  switch (state) {
    case 'approved': return { key: 'stateApproved', cls: 'chip chip--success' };
    case 'pending': return { key: 'statePending', cls: 'chip' };
    case 'suspended': return { key: 'stateSuspended', cls: 'chip chip--muted' };
    default: return { key: 'stateDraft', cls: 'chip chip--muted' };
  }
}

export function CommunityPage() {
  const { t } = useTranslation('kicktodo-community');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  // KTUX-10 — the classified page-load failure, so the top-level Notice tells
  // the user what actually went wrong (rate-limit vs. session vs. outage)
  // instead of one undifferentiated 'could not load'.
  const [loadErr, setLoadErr] = useState<unknown>(null);
  // KTUX-3: a FAILED LOAD must hide the editor — otherwise the form renders with
  // blank fields over a profile that was never fetched, and Save silently
  // overwrites the real one with empty strings. A failed ACTION must NOT hide it
  // (that would discard what the user just typed), so the two are tracked apart.
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  // Screen-polish: composers are COLLAPSED by default — a list where every row
  // is a permanently-open form read as a wall.
  const [writeOpen, setWriteOpen] = useState<Record<string, boolean>>({});
  const [profile, setProfile] = useState<CreatorProfile | null>(null);
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [loc, setLoc] = useState<Record<string, { displayName?: string; bio?: string }>>({}); // ADR 0453 P2 overlays
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [reviewsByChallenge, setReviewsByChallenge] = useState<Record<string, { reviews: VisibleReview[]; aggregate: ReviewAggregate }>>({});
  // KTUX-11 — challenges whose review fetch FAILED (a 429/500/offline), kept
  // distinct from challenges that genuinely have no reviews. Collapsing the two
  // rendered a transport failure as a confident 'no reviews yet' — a designed
  // empty state asserting something false, the same class as KTUX-2.
  const [reviewLoadFailed, setReviewLoadFailed] = useState<Set<string>>(new Set());
  const [rating, setRating] = useState<Record<string, number>>({});
  const [reviewBody, setReviewBody] = useState<Record<string, string>>({});
  const [reviewDenied, setReviewDenied] = useState<Record<string, boolean>>({});
  const [titles, setTitles] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    try {
      setError(false);
      setLoadFailed(false);
      const [p, es, cs] = await Promise.all([getMyProfile(), listEnrollments(), listChallenges().catch(() => [])]);
      setTitles(Object.fromEntries(cs.map((c) => [c.id, c.title])));
      setProfile(p);
      if (p) {
        setHandle(p.handle);
        setDisplayName(p.displayName);
        setBio(p.bio);
        setLoc(p.localizations ?? {});
      }
      setEnrollments(es);
      const byChallenge: Record<string, { reviews: VisibleReview[]; aggregate: ReviewAggregate }> = {};
      const failed = new Set<string>();
      await Promise.all([...new Set(es.map((e) => e.challengeId))].map(async (id) => {
        try {
          byChallenge[id] = await getReviews(id);
        } catch {
          // Record the failure; do NOT fabricate an empty aggregate that the
          // UI would then render as 'no reviews yet'.
          failed.add(id);
        }
      }));
      setReviewsByChallenge(byChallenge);
      setReviewLoadFailed(failed);
    } catch (e) {
      setError(true);
      setLoadFailed(true);
      setLoadErr(e);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onSave = async (submit: boolean) => {
    if (!handle.trim() || !displayName.trim()) return;
    setBusy(true);
    try {
      // ADR 0453 P2 — send only non-empty per-locale overlays (the backend also cleans).
      const cleanLoc: Record<string, { displayName?: string; bio?: string }> = {};
      for (const [lc, o] of Object.entries(loc)) {
        const overlay: { displayName?: string; bio?: string } = {};
        if (o.displayName?.trim()) overlay.displayName = o.displayName;
        if (o.bio?.trim()) overlay.bio = o.bio;
        if (Object.keys(overlay).length > 0) cleanLoc[lc] = overlay;
      }
      await saveProfile({ handle, displayName, bio, ...(Object.keys(cleanLoc).length > 0 ? { localizations: cleanLoc } : {}) });
      if (submit) await submitMyProfile();
      await reload();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const onReview = async (challengeId: string, challengeVersion: number) => {
    const stars = rating[challengeId] ?? 0;
    if (stars < 1) return;
    setBusy(true);
    try {
      const body = reviewBody[challengeId];
      await writeReview({ challengeId, challengeVersion, rating: stars, ...(body ? { body } : {}) });
      setReviewDenied((s) => ({ ...s, [challengeId]: false }));
      await reload();
    } catch (err) {
      // KTUX-2: ONLY a 403 is the proof gate. Reporting a 429/500/offline as
      // "you have not proven participation" tells the user something untrue
      // about their own record — surface those as the transport failure they are.
      if (err instanceof CommunityRequestError && err.status === 403) {
        setReviewDenied((s) => ({ ...s, [challengeId]: true }));
      } else {
        setError(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const chip = profile ? stateChip(profile.state) : null;

  return (
    <div className="page" data-walkthrough="kicktodo-community.page">
      <header className="page-header">
        <h1 className="page-header__title">{t('title')}</h1>
        <p className="page-header__lede">{t('lede')}</p>
      </header>

      {error && <Notice variant="error">{loadErr ? loadErrorMessage(t, loadErr) : t('loadError')}</Notice>}
      {!loaded && !error && <StateCard loading title={t('title')} />}

      {loaded && !loadFailed && enrollments.length === 0 && (
        <StateCard
          icon={<StarIcon aria-hidden />}
          title={t('noReviewsTitle')}
          body={t('noReviewsBody')}
        />
      )}

      {loaded && !loadFailed && enrollments.length > 0 && (
        <section className="surface-card" aria-label={t('reviewsHeading')}>
          <h2>{t('reviewsHeading')}</h2>
          <p className="muted">{t('reviewsProofNote')}</p>
          <ul role="list" className="list-plain">
            {enrollments.map((e) => {
              const agg = reviewsByChallenge[e.challengeId]?.aggregate;
              return (
                <li key={e.id} className="list-row">
                  <div>
                    <strong>{titles[e.challengeId] ?? e.challengeId}</strong>
                    <span className="muted">
                      {' '}{reviewLoadFailed.has(e.challengeId)
                        ? t('common:loadFailed')
                        : agg && agg.average !== null
                          ? t('aggregate', { average: agg.average, count: agg.count })
                          : t('aggregateFloor')}
                    </span>
                    {reviewDenied[e.challengeId] && <Notice variant="info">{t('proofDenied')}</Notice>}
                    <div className="action-bar">
                      <Button variant="quiet" size="sm"
                        aria-expanded={!!writeOpen[e.challengeId]}
                        onClick={() => setWriteOpen((w) => ({ ...w, [e.challengeId]: !w[e.challengeId] }))}>
                        {t('writeReviewCta')}
                      </Button>
                    </div>
                    {writeOpen[e.challengeId] && (<>
                    {/* KTUX-4: a rating is SINGLE-select, so it is a radiogroup —
                        not five independent toggles. The old `aria-pressed={>= n}`
                        announced a 3-star rating as three separate pressed buttons;
                        `aria-checked={=== n}` announces the one selected value. The
                        composer is a SEPARATE .action-bar because that primitive is
                        specced as a button cluster (DESIGN.md §5.1) — mixing the
                        radios, a text input and the submit button into one row
                        wrapped badly at ≤760px. */}
                    {/* KTUX-8: a radiogroup is arrow-key operable with
                        selection-follows-focus and a roving tabIndex, so it is
                        ONE tab stop — not five. The shared handler moves focus
                        and selects together. */}
                    <div className="action-bar" role="radiogroup" aria-label={t('ratingLabel')}
                      onKeyDown={handleRadiogroupKeyDown}>
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button
                          key={n}
                          type="button"
                          role="radio"
                          className={(rating[e.challengeId] ?? 0) >= n ? 'chip chip--accent' : 'chip'}
                          aria-checked={(rating[e.challengeId] ?? 0) === n}
                          tabIndex={(rating[e.challengeId] ?? 0) === n || ((rating[e.challengeId] ?? 0) === 0 && n === 1) ? 0 : -1}
                          aria-label={t('starAria', { n })}
                          onClick={() => setRating((s) => ({ ...s, [e.challengeId]: n }))}
                        >
                          <StarIcon size={14} aria-hidden />
                        </button>
                      ))}
                    </div>
                    <div className="action-bar">
                      <TextField
                        label={t('reviewBodyLabel')}
                        value={reviewBody[e.challengeId] ?? ''}
                        maxLength={2000}
                        placeholder={t('reviewBodyPlaceholder')}
                        onChange={(ev) => setReviewBody((s) => ({ ...s, [e.challengeId]: ev.target.value }))}
                      />
                      <Button
                        variant="primary"
                        disabled={busy || (rating[e.challengeId] ?? 0) < 1}
                        aria-busy={busy}
                        onClick={() => void onReview(e.challengeId, e.challengeVersion)}
                      >
                        {t('submitReviewCta')}
                      </Button>
                    </div>
                    </>)}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Screen-polish: the CREATOR-register profile editor sits BELOW the
          participant content (reviews) — it headlined the page before (an
          altitude inversion; ADR 0437's domain visiting a participant page). */}
      {loaded && !loadFailed && (
        <section className="surface-card" aria-label={t('profileHeading')}>
          <div className="action-bar">
            <h2>{t('profileHeading')}</h2>
            {chip && <span className={chip.cls}>{t(chip.key)}</span>}
          </div>
          <p className="muted">{t('profileDisclosure')}</p>
          {/* KTUX-7 — visible labels via the shared Field primitive. These
              were named only by their placeholder (WCAG 2.2 §3.3.2: the label
              vanishes the moment the user types). Field owns the id↔label
              wiring the whole app was hand-rolling wrong. */}
          <div className="action-bar">
            <TextField label={t('handleLabel')} value={handle} maxLength={30} placeholder={t('handlePlaceholder')}
              onChange={(e) => setHandle(e.target.value)} />
            <TextField label={t('displayNameLabel')} value={displayName} maxLength={80}
              onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <TextareaField label={t('bioLabel')} value={bio} maxLength={1000}
            onChange={(e) => setBio(e.target.value)} rows={3} />
          {/* ADR 0453 P2 — optional per-locale overlays. Collapsed by default; the
              base displayName/bio above stay the fallback for any untranslated locale. */}
          <details>
            <summary className="u-fs-13 muted">{t('translationsHeading')}</summary>
            <p className="u-fs-13 muted">{t('translationsHint')}</p>
            {/* Residue-batch UX-T3: fieldset/legend groups each locale ONCE —
                the visible labels stay short (no tripled locale text) while the
                per-locale interpolated label keeps every field's ACCESSIBLE
                name unique (the KTUX-7 invariant) via aria-label. */}
            {CONTENT_LOCALES.map((lc) => (
              <fieldset key={lc} className="u-grid u-gap-2 u-mb-3 u-border-0 u-p-0">
                <legend className="u-fs-13"><strong>{localeName(lc)}</strong></legend>
                <TextField label={t('displayNameLabel')}
                  aria-label={t('translatedFieldLabel', { field: t('displayNameLabel'), locale: localeName(lc) })}
                  value={loc[lc]?.displayName ?? ''} maxLength={80}
                  onChange={(e) => setLoc((cur) => ({ ...cur, [lc]: { ...cur[lc], displayName: e.target.value } }))} />
                <TextareaField label={t('bioLabel')}
                  aria-label={t('translatedFieldLabel', { field: t('bioLabel'), locale: localeName(lc) })}
                  value={loc[lc]?.bio ?? ''} maxLength={1000} rows={2}
                  onChange={(e) => setLoc((cur) => ({ ...cur, [lc]: { ...cur[lc], bio: e.target.value } }))} />
              </fieldset>
            ))}
          </details>
          <div className="action-bar">
            <Button variant="quiet" disabled={busy || !handle.trim() || !displayName.trim()} aria-busy={busy} onClick={() => void onSave(false)}>
              {t('saveDraftCta')}
            </Button>
            <Button variant="primary" disabled={busy || !handle.trim() || !displayName.trim()} aria-busy={busy} onClick={() => void onSave(true)}>
              {t('submitCta')}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
