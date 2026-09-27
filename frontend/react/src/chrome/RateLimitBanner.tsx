/**
 * ADR 0640 — the ONE place the UI says "you are being rate-limited".
 *
 * Renders only while `rateLimitSignal` holds a live deadline, counts it down,
 * and disappears on its own. Twelve red surfaces used to be the only symptom.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { InfoIcon } from '../ui/icons/index.js';
import { getRateLimitState, subscribeRateLimited, type RateLimitState } from '../client/rateLimitSignal.js';

export function RateLimitBanner() {
  const { t } = useTranslation('chrome');
  const [state, setState] = useState<RateLimitState | null>(() => getRateLimitState());
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => subscribeRateLimited((s) => { setState(s); setNow(Date.now()); }), []);
  useEffect(() => {
    if (!state) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [state]);

  if (!state || state.untilMs <= now) return null;
  const seconds = Math.max(1, Math.ceil((state.untilMs - now) / 1_000));
  return (
    <div className="demo-host-banner" role="status" aria-live="polite" data-testid="rate-limit-banner">
      <span className="demo-host-banner-icon" aria-hidden><InfoIcon size={16} /></span>
      <span className="demo-host-banner-text">{t('rateLimitedBanner', { seconds })}</span>
    </div>
  );
}
