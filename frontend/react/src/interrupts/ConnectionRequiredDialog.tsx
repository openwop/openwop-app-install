/**
 * ADR 0189 — connect-to-continue on the run-detail page + the cross-run HITL
 * inbox (via RenderInterrupt). A connection interrupt is `kind:'clarification'`
 * + `data.profile:'openwop-connection'`; RenderInterrupt discriminates on the
 * profile and renders THIS instead of the free-text ClarificationDialog, so a
 * connection prompt shows the same Connect/Skip UI as the chat feed (not a
 * "type your answer" box). Shares the controls with the chat card; adapts
 * resume to the RenderInterrupt `resolveByRun` + `onResolved` contract.
 */
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveByRun } from '../client/interruptsClient.js';
import { decideErrorMessage } from './decideErrorMessage.js';
import { Notice } from '../ui/index.js';
import { ConnectionRequiredControls, type ConnectionResumeValue } from './ConnectionRequiredControls.js';

interface Props {
  runId: string;
  nodeId: string;
  token: string;
  data: unknown;
  onResolved: () => void;
}

export function ConnectionRequiredDialog({ runId, nodeId, data, onResolved }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ADR 0778 (`APUX-6`, WCAG 2.1.2) — NO focus trap. This card renders INLINE
  // (the run page, `/inbox`, one per action-needed row), not as a modal: a
  // trap here held Tab inside whichever card mounted last, so a keyboard user
  // could not reach the rest of the page. DESIGN.md §11 is corrected to trap
  // only modal presentations.
  const headingId = useId();
  const inFlight = useRef(false); // `APUX-10` — a same-tick double submit

  async function resolve(value: ConnectionResumeValue): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await resolveByRun(runId, nodeId, value);
      onResolved();
    } catch (err) {
      setError(decideErrorMessage(t, err)); // ADR 0778 (`APUX-5`)
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="card" role="group" aria-labelledby={headingId}>
      <h2 id={headingId}>{t('connectionRequiredTitle')}</h2>
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      <ConnectionRequiredControls data={data} busy={submitting} onResolve={(v) => { void resolve(v); }} />
    </div>
  );
}
