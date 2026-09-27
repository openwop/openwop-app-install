/**
 * ADR 0545 D2/P2 — the setup wizard.
 *
 * D2 is the highest-leverage decision in the vertical, and the reason is a claim
 * about attention rather than about data: answering ~20 questions once, at a
 * moment the user chose, is not toil. Being asked one question unpredictably,
 * forty times, is. So this screen's job is to be finishable — and, just as
 * important, to be ABANDONABLE without penalty.
 *
 * ## Progress is stated in coverage, not in questions
 *
 * "3 of 10 answered" measures effort. "Your answers cover 67% of required
 * fields" measures the thing the user actually wants, and it is the number ADR
 * 0545 P2 says to ship — computed by the backend from the same fixtures the
 * coverage test prints, never a figure typed into the UI. Both are shown,
 * because the count is what makes the coverage number legible.
 *
 * ## Leading with the core six is a promise the ordering has to keep
 *
 * The bank is ordered by leverage so that a user who stops after six questions
 * already has most of the benefit. The skip note says so plainly rather than
 * nagging: an unanswered question parks ONE application (ADR 0545 D3), it does
 * not stall a campaign, and saying that is what makes stopping a real option
 * instead of a guilt trip.
 *
 * ## The EEO notice is here even though nothing on this page collects it
 *
 * The bank refuses to store voluntary self-identification answers at all
 * (`answerBank.ts`), so none of those questions appear. The notice explains what
 * happens instead — applications decline to self-identify — because a user who
 * knows those forms will otherwise wonder whether we answered for them, and
 * silence on that point reads worse than the truth.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Panel } from '../../ui/layout.js';
import { Button } from '../../ui/Button.js';
import { TextField } from '../../ui/Field.js';
import { Notice } from '../../ui/Notice.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { StateCard } from '../../ui/StateCard.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { ShieldIcon } from '../../ui/icons/index.js';
import {
  getAnswerBank, saveAnswer, type AnswerBankView, type StandardQuestion,
} from './jobSearchClient.js';

export function AnswerBankPage(): JSX.Element {
  const { t } = useTranslation('job-search');
  const [view, setView] = useState<AnswerBankView | null>(null);
  const [failed, setFailed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setFailed(false);
      setView(await getAnswerBank());
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const answered = useMemo(
    () => new Map((view?.answers ?? []).map((a) => [a.questionKey, a.value])),
    [view],
  );

  const onSave = useCallback(async (q: StandardQuestion, value: string) => {
    setSaveError(null);
    const res = await saveAnswer(q.prompt, value);
    if (res.kind === 'saved') { await load(); return; }
    // A refusal carries the server's own explanation; a transport failure does
    // not, and conflating them would tell the user their answer was rejected
    // when the request never arrived.
    setSaveError(res.kind === 'refused' ? res.message : t('bankSaveFailed'));
  }, [load, t]);

  if (failed) {
    return (
      <div className="u-flex-col u-gap-4" data-walkthrough="job-search.answers">
        <PageHeader eyebrow={t('eyebrow')} title={t('bankTitle')} lede={t('bankLede')} />
        <StateCard
          announce
          icon={<ShieldIcon size={20} />}
          title={t('appsLoadFailed')}
          action={<Button variant="secondary" size="sm" onClick={() => { void load(); }}>{t('appsRetry')}</Button>}
        />
      </div>
    );
  }

  const core = (view?.questions ?? []).filter((q) => q.core);
  const rest = (view?.questions ?? []).filter((q) => !q.core);
  const pct = Math.round((view?.coverage.ratio ?? 0) * 100);

  return (
    <div className="u-flex-col u-gap-4" data-walkthrough="job-search.answers">
      <PageHeader eyebrow={t('eyebrow')} title={t('bankTitle')} lede={t('bankLede')} />

      <Panel>
        {view === null ? (
          <div role="status" aria-busy="true" aria-label={t('bankTitle')} className="u-flex u-flex-col u-gap-2">
            {['70%', '90%', '85%'].map((w, i) => <Skeleton key={i} width={w} height={18} />)}
          </div>
        ) : (
          <>
            <p>{t('bankProgress', { answered: answered.size, total: view.questions.length })}</p>
            {/* JSUX-AUTO-1 — the wizard has an explicit DONE state: at full
                coverage the "you can stop any time" copy (which assumes
                unfinished work) gives way to an acknowledged completion. */}
            {view.questions.length > 0 && answered.size === view.questions.length ? (
              <Notice variant="success" announce={t('bankAllDone')}>{t('bankAllDone')}</Notice>
            ) : (
              <>
                <p className="muted u-mt-1">
                  {answered.size === 0 ? t('bankCoverageNone') : t('bankCoverage', { pct })}
                </p>
                <p className="muted u-text-sm u-mt-2">{t('bankSkipNote')}</p>
              </>
            )}
          </>
        )}
      </Panel>

      {saveError ? <Notice variant="warning" announce={saveError}>{saveError}</Notice> : null}

      {view ? (
        <>
          <Panel title={t('bankCoreHeading')}>
            {core.map((q) => (
              <QuestionRow key={q.key} question={q} current={answered.get(q.key)} onSave={onSave} />
            ))}
          </Panel>
          <Panel title={t('bankMoreHeading')}>
            {rest.map((q) => (
              <QuestionRow key={q.key} question={q} current={answered.get(q.key)} onSave={onSave} />
            ))}
          </Panel>
          <Panel title={t('bankEeoTitle')}>
            <p className="muted">{t('bankEeoBody')}</p>
          </Panel>
        </>
      ) : null}
    </div>
  );
}

/**
 * One question.
 *
 * A boolean renders as two labelled buttons rather than a checkbox: "Yes/No" to
 * "Will you need visa sponsorship?" is a real answer either way, and an unticked
 * checkbox cannot distinguish "no" from "not answered" — which is precisely the
 * distinction the bank depends on.
 */
function QuestionRow({
  question, current, onSave,
}: {
  question: StandardQuestion;
  current: string | undefined;
  onSave: (q: StandardQuestion, value: string) => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation('job-search');
  const [draft, setDraft] = useState(current ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => { setDraft(current ?? ''); }, [current]);

  const commit = useCallback(async (value: string) => {
    if (!value.trim()) return;
    setBusy(true);
    try { await onSave(question, value); } finally { setBusy(false); }
  }, [onSave, question]);

  const isChoice = question.kind === 'boolean' || question.kind === 'choice';

  return (
    <div className="surface-card u-p-3 u-mb-2">
      {/* For a typed answer the FIELD's own label is the question — rendering the
          prompt again above it would duplicate the accessible name and read
          twice to a screen reader. Choice kinds have no labelled control to
          carry it, so there the prompt is the heading. */}
      {isChoice ? (
        <div className="u-flex u-gap-2 u-items-start">
          <span className="u-flex-1">
            <strong>{question.prompt}</strong>
            <span className="muted u-text-sm"> {question.why}</span>
          </span>
          {current ? <StatusBadge status="success" label={t('bankAnswered')} /> : null}
        </div>
      ) : null}

      <div className="u-mt-2 u-flex u-gap-2 u-items-center">
        {question.kind === 'boolean' ? (
          <>
            {/* JSUX-A11Y-2 (R3) — selection was signalled by button VARIANT only
                (colour+weight, unconfirmed in dark mode). aria-pressed carries it
                non-visually; the variant stays the visual channel. */}
            <Button aria-pressed={current === 'Yes'} variant={current === 'Yes' ? 'primary' : 'secondary'} size="sm" disabled={busy} onClick={() => { void commit('Yes'); }}>
              {t('bankYes')}
            </Button>
            <Button aria-pressed={current === 'No'} variant={current === 'No' ? 'primary' : 'secondary'} size="sm" disabled={busy} onClick={() => { void commit('No'); }}>
              {t('bankNo')}
            </Button>
          </>
        ) : question.kind === 'choice' ? (
          (question.options ?? []).map((opt) => (
            <Button key={opt} aria-pressed={current === opt} variant={current === opt ? 'primary' : 'secondary'} size="sm" disabled={busy} onClick={() => { void commit(opt); }}>
              {opt}
            </Button>
          ))
        ) : (
          <>
            <TextField
              label={question.prompt}
              help={question.why}
              value={draft}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
              type={question.kind === 'date' ? 'date' : question.kind === 'number' ? 'number' : 'text'}
            />
            <Button size="sm" disabled={busy || !draft.trim() || draft === current} onClick={() => { void commit(draft); }}>
              {t('bankSave')}
            </Button>
            {current ? <StatusBadge status="success" label={t('bankAnswered')} /> : null}
          </>
        )}
      </div>
    </div>
  );
}
