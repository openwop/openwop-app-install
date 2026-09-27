/**
 * ADR 0501 step 4 — "what happens if I accept this?", on the coach-proposal card.
 *
 * Three states, kept distinct on purpose, because collapsing any two of them recreates
 * the defect this ADR exists to remove (`proposalApplied: 'Applied'` — a confident answer
 * the system did not earn):
 *
 *   changes       the real dry run. Zero writes; the backend shares the authority
 *                 predicate, the closed-world validator AND the move-lane guards with
 *                 apply, so this can never show what accept would refuse.
 *   advice-only   the proposal carries prose and nothing executable. Accept will REFUSE
 *                 it. This is NOT "no changes" — rendering it as an empty diff would tell
 *                 the participant their plan is already correct.
 *   failed        we could not compute it. Also NOT "no changes". A failed read that
 *                 renders as an empty state is the house defect
 *                 (`absence-is-a-claim`); say so and leave the decision available.
 *
 * Fetched at render rather than projected onto the card: the plan can move between the
 * coach's proposal and the participant's decision, so a stored diff would be a snapshot
 * that quietly stops being true. Re-validation AT ACCEPT is what actually protects the
 * participant — this is an aid to the decision, never a guarantee about it.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';
import { fetchProposalPreview, type ProposalPreview } from './reviewClient.js';

type State = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; preview: ProposalPreview };

export function PlanProposalPreview({ enrollmentId, proposalId }: { enrollmentId: string; proposalId: string }): JSX.Element | null {
  const { t } = useTranslation('chat');
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void fetchProposalPreview(enrollmentId, proposalId)
      .then((preview) => { if (!cancelled) setState({ status: 'ready', preview }); })
      // The failure is CARRIED, not swallowed to an empty list. A `.catch(() => [])` here
      // would render "no changes" for a plan we never managed to read.
      .catch(() => { if (!cancelled) setState({ status: 'failed' }); });
    return () => { cancelled = true; };
  }, [enrollmentId, proposalId]);

  if (state.status === 'loading') {
    return <p className="muted u-fs-12 u-m-0">{t('planPreviewLoading')}</p>;
  }
  if (state.status === 'failed') {
    // Deliberately does not block the decision: the participant may still accept or
    // dismiss, and accept re-validates server-side regardless of what this showed.
    return <Notice variant="warning">{t('planPreviewFailed')}</Notice>;
  }
  if (state.preview.kind === 'advice-only') {
    return <p className="muted u-fs-12 u-m-0">{t('planPreviewAdviceOnly')}</p>;
  }
  return (
    <div className="u-flex u-flex-col u-gap-1">
      <span className="proj-eyebrow">{t('planPreviewHeading', { count: state.preview.changes.length })}</span>
      <ul className="u-list-none u-m-0 u-p-0 u-flex u-flex-col u-gap-1">
        {state.preview.changes.map((c, i) => (
          <li key={`${c.lane}-${i}`} className="u-fs-13">{c.line}</li>
        ))}
      </ul>
    </div>
  );
}
