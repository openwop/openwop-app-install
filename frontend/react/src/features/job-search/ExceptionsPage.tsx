/**
 * ADR 0545 D3/P5 — the batched exceptions card.
 *
 * This screen is the ENTIRE interruption budget of a campaign, and its design
 * follows from the sentence in D3 that names the prior art's defect: "Prior art
 * parks first and asks immediately, which is why one novel question stops the
 * loop. Here the campaign continues and the human is interrupted in batches, on
 * their schedule."
 *
 * So:
 *
 *  - **One row per QUESTION, never per application.** The backend already
 *    aggregates, and this page shows the count of applications waiting on each
 *    one. Six applications blocked by the same unanswered question is one chore;
 *    rendering it as six would recreate the interruption cost the batching
 *    exists to remove.
 *  - **The empty state is the SUCCESS state.** "Nothing waiting" means autopilot
 *    is doing what it promised, so it says that rather than apologising for
 *    having no content.
 *  - **Answering says what it unblocked.** The reward for the interruption is
 *    the applications that go out because of it, and stating the number is what
 *    makes the trade visible.
 *
 * P5's verification is that the happy path shows zero per-application
 * interactions. Nothing here is per-application: the user answers questions, and
 * applications are the consequence.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Panel } from '../../ui/layout.js';
import { Button } from '../../ui/Button.js';
import { TextField } from '../../ui/Field.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { Notice } from '../../ui/Notice.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { toast } from '../../ui/toast.js';
import { ShieldIcon } from '../../ui/icons/index.js';
import { listExceptions, answerException, type CampaignException } from './jobSearchClient.js';

export function ExceptionsPage(): JSX.Element {
  const { t } = useTranslation('job-search');
  const [rows, setRows] = useState<CampaignException[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setFailed(false);
      setRows(await listExceptions());
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onAnswer = useCallback(async (row: CampaignException, value: string) => {
    setError(null);
    try {
      await answerException(row.questionText, value);
      // The count is the point of the interruption, so it is what the
      // confirmation reports.
      toast.success(t('excSaved', { count: row.blockedCount }));
      await load();
    } catch {
      setError(t('excFailed'));
    }
  }, [load, t]);

  return (
    <div className="u-flex-col u-gap-4" data-walkthrough="job-search.exceptions">
      <PageHeader eyebrow={t('eyebrow')} title={t('excTitle')} lede={t('excLede')} />

      {error ? <Notice variant="warning" announce={error}>{error}</Notice> : null}

      <Panel>
        {failed ? (
          <StateCard
            announce
            icon={<ShieldIcon size={20} />}
            title={t('appsLoadFailed')}
            action={<Button variant="secondary" size="sm" onClick={() => { void load(); }}>{t('appsRetry')}</Button>}
          />
        ) : rows === null ? (
          <div role="status" aria-busy="true" aria-label={t('excTitle')} className="u-flex u-flex-col u-gap-2">
            {['80%', '70%'].map((w, i) => <Skeleton key={i} width={w} height={18} />)}
          </div>
        ) : rows.length === 0 ? (
          // The success state, phrased as one.
          <StateCard icon={<ShieldIcon size={20} />} title={t('excEmptyTitle')} body={t('excEmptyBody')} />
        ) : (
          rows.map((row) => <ExceptionRow key={row.questionKey} row={row} onAnswer={onAnswer} />)
        )}
      </Panel>
    </div>
  );
}

function ExceptionRow({
  row, onAnswer,
}: {
  row: CampaignException;
  onAnswer: (row: CampaignException, value: string) => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation('job-search');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const commit = useCallback(async () => {
    if (!draft.trim()) return;
    setBusy(true);
    try { await onAnswer(row, draft); } finally { setBusy(false); }
  }, [draft, onAnswer, row]);

  return (
    <div className="surface-card u-p-3 u-mb-2">
      <div className="u-flex u-gap-2 u-items-center">
        <span className="u-flex-1"><strong>{row.questionText}</strong></span>
        {/* The count is the stake: it says what answering buys. */}
        <StatusBadge status="info" label={t('excBlocked', { count: row.blockedCount })} />
      </div>
      <div className="u-mt-2 u-flex u-gap-2 u-items-center">
        {/* NOT the question text: it is already the heading above, and a field
            whose accessible name repeats it makes a screen reader read the
            question twice. */}
        <TextField
          label={t('excYourAnswer')}
          // The VISIBLE label stays short, but the accessible name must be
          // unique per row: with several exceptions on screen a screen-reader
          // user would otherwise tab through three fields all called "Your
          // answer" with nothing to tell them apart. `aria-label` wins over the
          // <label> for the accessible name, so the question travels with the
          // field while the layout stays compact.
          aria-label={`${t('excYourAnswer')} — ${row.questionText}`}
          value={draft}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
        />
        <Button size="sm" disabled={busy || !draft.trim()} onClick={() => { void commit(); }}>
          {t('excAnswer')}
        </Button>
      </div>
    </div>
  );
}
