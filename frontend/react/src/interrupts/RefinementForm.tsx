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

export function RefinementForm({ runId, nodeId, data, onResolved }: Props) {
  const { t } = useTranslation('interrupts');
  const seed = ((data as { current?: unknown })?.current) ?? '';
  const [draft, setDraft] = useState(typeof seed === 'string' ? seed : JSON.stringify(seed, null, 2));
  const [submitting, setSubmitting] = useState(false);
  // HITL a11y (GAP-ANALYSIS E6, DESIGN §11): trap focus into the response form
  // on render (the hook focuses the first focusable — the draft field — and
  // cycles within the card), releasing only on submit / dismiss. The draft
  // field stays label-associated.
  const headingId = useId();
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(true);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      let parsed: unknown = draft;
      try {
        parsed = JSON.parse(draft);
      } catch {
        // Tolerate non-JSON refinements — submit as raw string.
      }
      await resolveByRun(runId, nodeId, { refinement: parsed });
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card" role="group" aria-labelledby={headingId} ref={trapRef}>
      <h2 id={headingId}>{t('refinementRequested')}</h2>
      <p className="muted">{t('refinementHelp')}</p>
      <TextareaField label={t('draftLabel')} ref={draftRef} rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
      {error && <div className="alert error">{error}</div>}
      <div className="button-row">
        <button onClick={submit} disabled={submitting}>
          {submitting ? t('submitting') : t('submitRefinement')}
        </button>
      </div>
    </div>
  );
}
