/**
 * RunFeedback — RFC 0056 quality-signal affordance (thumbs up/down + flag)
 * for a run. Strictly gated: renders nothing unless the host advertises
 * `capabilities.feedback.supported` (RFC 0056, Active), so it's inert against
 * a host that doesn't implement feedback and lights up against one that does
 * with zero further app changes. `onRecorded` lets the parent refresh derived
 * views (e.g. the §C2 quality analytics panel). See app-ux-enhancements §C1.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getFeedbackCapability,
  recordAnnotation,
  type AnnotationSignal,
  type FeedbackCapability,
} from '../client/feedbackClient.js';
import { ThumbsUpIcon, ThumbsDownIcon, FlagIcon } from '../ui/icons/index.js';

export function RunFeedback({ runId, onRecorded }: { runId: string; onRecorded?: () => void }) {
  const { t } = useTranslation('runs');
  const [cap, setCap] = useState<FeedbackCapability | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getFeedbackCapability().then((c) => { if (!cancelled) setCap(c); });
    return () => { cancelled = true; };
  }, []);

  // Inert until a host advertises host.feedback (RFC 0056, Draft).
  if (!cap) return null;

  async function send(signal: AnnotationSignal, label: string) {
    setPending(true);
    setError(null);
    try {
      await recordAnnotation(runId, { target: { runId }, signal });
      setSent(label);
      onRecorded?.(); // §C2 — refresh the analytics panel's quality signals

    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="card">
      <h2 className="u-mt-0">{t('feedbackHeading')}</h2>
      {sent ? (
        <p className="muted u-m-0">{t('feedbackRecorded', { label: sent })}</p>
      ) : (
        <div className="button-row" role="group" aria-label={t('rateThisRun')}>
          <button type="button" className="secondary" disabled={pending} onClick={() => send({ kind: 'rating', rating: 5 }, t('feedbackGood'))} aria-label={t('feedbackGood')}><ThumbsUpIcon size={14} /> {t('feedbackGood')}</button>
          <button type="button" className="secondary" disabled={pending} onClick={() => send({ kind: 'rating', rating: 1 }, t('feedbackBad'))} aria-label={t('feedbackBad')}><ThumbsDownIcon size={14} /> {t('feedbackBad')}</button>
          <button type="button" className="secondary" disabled={pending} onClick={() => send({ kind: 'flag' }, t('feedbackFlagged'))} aria-label={t('flagForReview')}><FlagIcon size={14} /> {t('flagForReview')}</button>
        </div>
      )}
      {error && <div className="alert error u-mt-2">{error}</div>}
    </div>
  );
}
