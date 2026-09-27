/**
 * EventReadState — the empty / loading / FAILED block shared by both views of a
 * run's event log (`runs/RunTimeline`, `streams/EventStreamView`).
 *
 * ── WHY IT EXISTS (ADR 0600 §1, `ISU-24`) ───────────────────────────────────
 *
 * Both views used to branch on `events.length === 0` and render "No events
 * yet." — a POSITIVE CLAIM about the run — with no knowledge of whether the
 * read that produced that array had succeeded, was still in flight, or had
 * THROWN. `RunDetailPage` mounts them unconditionally and its `pollEvents`
 * catch sets a separate `error` state while leaving `events` at `[]`, so a
 * transient backend failure told the user their run had produced nothing.
 *
 * That is the exact shape `ui/StateCard.tsx` is written against: the empty is
 * not minted by the catch, it is minted at RENDER, so no amount of care in the
 * catch prevents it. The cure is to make the read's OUTCOME a required input to
 * the claim. It lives in one component rather than two so the timeline and the
 * log cannot drift into disagreeing about what "no events" means.
 */
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button.js';
import { StateCard } from '../ui/StateCard.js';
import { AlertIcon } from '../ui/icons/index.js';

/**
 * The outcome of the caller's event read.
 *
 * Defaults to `'ready'` for callers that mount an event view only once they
 * already hold events (`RunComparePage` guards on `events.length > 0`), so
 * adding the prop does not change their behaviour.
 */
export type EventReadState = 'loading' | 'ready' | 'failed';

/**
 * CONTRACT: mount this only when the caller has NO events. Both callers already
 * branch on `events.length === 0` before rendering it.
 *
 * ── ADR 0600 §Correction 8 (`LOW-4`) ────────────────────────────────────────
 *
 * This took an `events` array purely to run `if (events.length > 0) return null`
 * — a guard NEITHER caller can reach, because both gate on the same condition
 * one frame up. That is the same decorative-guard class §1 makes a point of
 * deleting (the `prev === 'ready'` catch guard that sabotaged GREEN), shipped in
 * the component §1 introduced. The prop is gone with it: a parameter whose only
 * use was an unreachable branch is not an input, and keeping it would have left
 * the guard looking like the thing that holds the property.
 *
 * What actually holds it is the CALLERS' branch, and that is what the witness
 * names (`streams/EventStreamView`, `runs/RunTimeline`).
 */
export function EventReadStateCard({
  readState = 'ready',
  onRetry,
}: {
  readState?: EventReadState | undefined;
  /** Offered on a FAILED read only. Omit and the failure card carries no CTA. */
  onRetry?: (() => void) | undefined;
}): JSX.Element {
  const { t } = useTranslation('streams');
  const { t: tCommon } = useTranslation('common');
  if (readState === 'failed') {
    return (
      <StateCard
        announce
        icon={<AlertIcon size={22} />}
        title={t('eventsUnreadableTitle')}
        body={t('eventsUnreadableBody')}
        action={onRetry ? <Button variant="secondary" onClick={onRetry}>{tCommon('retry')}</Button> : undefined}
      />
    );
  }
  if (readState === 'loading') return <StateCard loading title={t('eventsLoadingTitle')} />;
  return <StateCard title={t('noEventsYet')} body={t('noEventsYetBody')} />;
}
