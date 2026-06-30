/**
 * Unified cold-start / error card for the AI chat surface.
 *
 * Replaces the previous two-card flow (loading → error) that flashed
 * "Spinning up your server…" → "The server is resting" as separate
 * screens. The user perceived that as a confusing arc ("you said you
 * were starting, then you gave up").
 *
 * Now: ONE card that adapts its copy over time and on error. Three
 * phases drive the same chrome:
 *
 *   Phase 1 — Loading, predict warm (recent success in localStorage):
 *     "Loading…" with subtle dots. Should resolve in <1s.
 *
 *   Phase 1 — Loading, predict cold (no recent success):
 *     "Waking up the server…" with cold-start framing in the
 *     body. Users expect 10-30s.
 *
 *   Phase 2 — Loading, elapsed ≥ 25s:
 *     "Still waking up…" — copy softens; explicit acknowledgment that
 *     this is taking longer than typical but not yet a failure.
 *
 *   Phase 3 — Error OR elapsed ≥ 40s:
 *     "The server is resting" + refresh-instruction copy. Same chrome,
 *     same card position — copy + dot animation change only.
 *
 * The shared chrome means the user sees ONE evolving card instead of
 * the previous two-card flash. The phase boundaries are tunable in
 * the constants below.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { predictWarm } from '../devtools/lastSuccess.js';
import { DEV_FALLBACK_BASE_URL } from '../client/baseUrlDefault.js';

interface Props {
  /** Truthy when the BE call has resolved with an error. The card
   *  jumps to Phase 3 ("resting") regardless of elapsed time. */
  error?: string | null;
  /** Where the back-end URL came from, surfaced inside the Technical
   *  Detail dropdown for debugging. */
  backendUrl?: string | undefined;
}

const SOFT_TIMEOUT_MS = 25 * 1000;
const HARD_TIMEOUT_MS = 40 * 1000;

type Phase = 'loading-warm' | 'loading-cold' | 'still-waking' | 'resting';

export function BackendStatusCard({ error, backendUrl }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  // Initial guess: predict cold/warm from the last-success cache. The
  // elapsed timer + error prop will override as new evidence arrives.
  const initialPhase: Phase = predictWarm() ? 'loading-warm' : 'loading-cold';
  const [phase, setPhase] = useState<Phase>(error ? 'resting' : initialPhase);

  useEffect(() => {
    if (error) {
      setPhase('resting');
      return;
    }
    // Loading: bump phase forward as time passes. The two timers are
    // independent so the card can step warm → still-waking → resting
    // without remounting (chrome stays; copy + dots adapt).
    const softTimer = setTimeout(() => setPhase('still-waking'), SOFT_TIMEOUT_MS);
    const hardTimer = setTimeout(() => setPhase('resting'), HARD_TIMEOUT_MS);
    return () => {
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
    };
  }, [error]);

  const headline =
    phase === 'loading-warm' ? t('backendLoading')
    : phase === 'loading-cold' ? t('backendWaking')
    : phase === 'still-waking' ? t('backendStillWaking')
    : t('backendResting');

  const body =
    phase === 'loading-warm'
      ? t('backendBodyWarm')
      : phase === 'loading-cold'
        ? t('backendBodyCold')
        : phase === 'still-waking'
          ? t('backendBodyColdLong')
          : t('backendBodyError');

  const showDots = phase !== 'resting';

  return (
    <div className="backend-resting-wrap">
      <div className="backend-resting-card">
        <h2 className="backend-resting-title">
          {headline}
          {showDots && (
            <span className="backend-spinup-ellipsis" aria-hidden="true">
              <span>.</span><span>.</span><span>.</span>
            </span>
          )}
        </h2>
        <p className="backend-resting-body">{body}</p>
        {(error || phase === 'resting') && (
          <details className="backend-resting-detail">
            <summary>{t('technicalDetail')}</summary>
            <p>
              {error && (
                <>
                  <code>{error}</code>
                  <br />
                </>
              )}
              {t('backendUrlLabel')}
              <code>{backendUrl ?? DEV_FALLBACK_BASE_URL}</code>
            </p>
          </details>
        )}
      </div>
    </div>
  );
}
