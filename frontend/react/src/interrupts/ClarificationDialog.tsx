import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveByRun } from '../client/interruptsClient.js';
import { TextareaField } from '../ui/Field.js';
import { useFocusTrap } from '../ui/useFocusTrap.js';

interface Props {
  runId: string;
  nodeId: string;
  token: string;
  data: unknown;
  onResolved: () => void;
}

export function ClarificationDialog({ runId, nodeId, data, onResolved }: Props) {
  const { t } = useTranslation('interrupts');
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // HITL a11y (GAP-ANALYSIS E6, DESIGN §11): trap focus into the response form
  // on render (the hook focuses the first focusable — the answer field — and
  // cycles within the card), releasing only on submit / dismiss. The answer
  // field stays label-associated.
  const headingId = useId();
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(true);

  const question = ((data as { question?: string })?.question) ?? t('clarificationDefaultQuestion');

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await resolveByRun(runId, nodeId, { answer });
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card" role="group" aria-labelledby={headingId} ref={trapRef}>
      <h2 id={headingId}>{t('clarificationNeeded')}</h2>
      <p>{question}</p>
      <TextareaField
        label={t('answerLabel')}
        ref={answerRef}
        rows={3}
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
      />
      {error && <div className="alert error">{error}</div>}
      <div className="button-row">
        <button onClick={submit} disabled={submitting || !answer.trim()}>
          {submitting ? t('submitting') : t('submitAnswer')}
        </button>
      </div>
    </div>
  );
}
