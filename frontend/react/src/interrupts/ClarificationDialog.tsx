import { Button } from '../ui/Button.js';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveByRun } from '../client/interruptsClient.js';
import { TextareaField } from '../ui/Field.js';
import { decideErrorMessage } from './decideErrorMessage.js';
import { Notice } from '../ui/index.js';
import { ClarificationQuestions } from './ClarificationQuestions.js';
import { CLARIFICATION_SKIP, buildClarificationAnswers, parseAgentClarification, type AgentClarification, type ClarifyValues } from './clarificationModel.js';

interface Props {
  runId: string;
  nodeId: string;
  token: string;
  data: unknown;
  onResolved: () => void;
}

export function ClarificationDialog(props: Props) {
  // ADR 1001 D8 — an agent's multi-question ask (`data.questions[]`) renders the
  // shared field group; the single-`question` shape is unchanged. Hook-free
  // dispatcher so both branches obey rules-of-hooks.
  const ask = parseAgentClarification(props.data);
  return ask ? <AgentClarificationDialog {...props} ask={ask} /> : <SingleQuestionDialog {...props} />;
}

function AgentClarificationDialog({ runId, nodeId, onResolved, ask }: Props & { ask: AgentClarification }) {
  const { t } = useTranslation('interrupts');
  const [values, setValues] = useState<ClarifyValues>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  const skipHelpId = useId();
  const inFlight = useRef(false); // `APUX-10` — a same-tick double submit
  const answers = buildClarificationAnswers(ask.questions, values);

  async function send(value: unknown) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await resolveByRun(runId, nodeId, value);
      onResolved();
    } catch (err) {
      setError(decideErrorMessage(t, err));
      inFlight.current = false;
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card" role="group" aria-labelledby={headingId}>
      <h2 id={headingId}>{ask.askedBy ? t('clarifyAgentNeedsAnswer', { name: ask.askedBy }) : t('clarifyNeedsAnswer')}</h2>
      <p className="u-fs-13 muted">{t('clarifySafety')}</p>
      <ClarificationQuestions
        questions={ask.questions}
        values={values}
        disabled={submitting}
        onChange={(id, v) => setValues((s) => ({ ...s, [id]: v }))}
      />
      {error && <Notice variant="error" announce={error}>{error}</Notice>}
      <div className="button-row">
        <Button variant="primary" onClick={() => { if (answers) void send(answers); }} disabled={submitting || !answers}>
          {submitting ? t('submitting') : t('submitAnswer')}
        </Button>
        <Button variant="secondary" onClick={() => { void send(CLARIFICATION_SKIP); }} disabled={submitting} aria-describedby={skipHelpId}>
          {t('clarifySkip')}
        </Button>
      </div>
      <p id={skipHelpId} className="u-fs-12 muted">{t('clarifySkipHelp')}</p>
    </div>
  );
}

function SingleQuestionDialog({ runId, nodeId, data, onResolved }: Props) {
  const { t } = useTranslation('interrupts');
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ADR 0778 (`APUX-6`, WCAG 2.1.2) — NO focus trap. This card renders INLINE
  // (the run page, `/inbox`, one per action-needed row), not as a modal: a
  // trap here held Tab inside whichever card mounted last, so a keyboard user
  // could not reach the rest of the page. DESIGN.md §11 is corrected to trap
  // only modal presentations.
  const headingId = useId();
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false); // `APUX-10` — a same-tick double submit

  const { question: single, questions } = (data ?? {}) as { question?: string; questions?: Array<{ question?: string }> };
  const question = single ?? questions?.[0]?.question ?? t('clarificationDefaultQuestion');

  async function submit() {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await resolveByRun(runId, nodeId, { answer });
      onResolved();
    } catch (err) {
      setError(decideErrorMessage(t, err)); // ADR 0778 (`APUX-5`)
      inFlight.current = false;
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card" role="group" aria-labelledby={headingId}>
      <h2 id={headingId}>{t('clarificationNeeded')}</h2>
      <p>{question}</p>
      <TextareaField
        label={t('answerLabel')}
        ref={answerRef}
        rows={3}
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
      />
      {error && <Notice variant="error" announce={error}>{error}</Notice>}
      <div className="button-row">
        <Button variant="primary" onClick={submit} disabled={submitting || !answer.trim()}>
          {submitting ? t('submitting') : t('submitAnswer')}
        </Button>
      </div>
    </div>
  );
}
