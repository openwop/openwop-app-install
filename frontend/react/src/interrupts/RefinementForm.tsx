import { Button } from '../ui/Button.js';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveByRun } from '../client/interruptsClient.js';
import { TextareaField } from '../ui/Field.js';
import { decideErrorMessage } from './decideErrorMessage.js';
import { Notice } from '../ui/index.js';

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
  // ADR 0778 (`APUX-6`, WCAG 2.1.2) — NO focus trap. This card renders INLINE
  // (the run page, `/inbox`, one per action-needed row), not as a modal: a
  // trap here held Tab inside whichever card mounted last, so a keyboard user
  // could not reach the rest of the page. DESIGN.md §11 is corrected to trap
  // only modal presentations.
  const headingId = useId();
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false); // `APUX-10` — a same-tick double submit
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (inFlight.current) return;
    inFlight.current = true;
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
      setError(decideErrorMessage(t, err)); // ADR 0778 (`APUX-5`)
      inFlight.current = false;
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card" role="group" aria-labelledby={headingId}>
      <h2 id={headingId}>{t('refinementRequested')}</h2>
      <p className="muted">{t('refinementHelp')}</p>
      <TextareaField label={t('draftLabel')} ref={draftRef} rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
      {error && <Notice variant="error" announce={error}>{error}</Notice>}
      <div className="button-row">
        <Button variant="primary" onClick={submit} disabled={submitting}>
          {submitting ? t('submitting') : t('submitRefinement')}
        </Button>
      </div>
    </div>
  );
}
