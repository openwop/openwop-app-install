/**
 * ADR 0189 — connect-to-continue on the run-detail page + the cross-run HITL
 * inbox (via RenderInterrupt). A connection interrupt is `kind:'clarification'`
 * + `data.profile:'openwop-connection'`; RenderInterrupt discriminates on the
 * profile and renders THIS instead of the free-text ClarificationDialog, so a
 * connection prompt shows the same Connect/Skip UI as the chat feed (not a
 * "type your answer" box). Shares the controls with the chat card; adapts
 * resume to the RenderInterrupt `resolveByRun` + `onResolved` contract.
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveByRun } from '../client/interruptsClient.js';
import { useFocusTrap } from '../ui/useFocusTrap.js';
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
  const headingId = useId();
  const trapRef = useFocusTrap<HTMLDivElement>(true);

  async function resolve(value: ConnectionResumeValue): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      await resolveByRun(runId, nodeId, value);
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="card" role="group" aria-labelledby={headingId} ref={trapRef}>
      <h2 id={headingId}>{t('connectionRequiredTitle')}</h2>
      {error ? <div className="alert error" role="alert">{error}</div> : null}
      <ConnectionRequiredControls data={data} busy={submitting} onResolve={(v) => { void resolve(v); }} />
    </div>
  );
}
