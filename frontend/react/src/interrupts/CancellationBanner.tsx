import { Button } from '../ui/Button.js';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveByRun } from '../client/interruptsClient.js';
import { decideErrorMessage } from './decideErrorMessage.js';
import { Notice } from '../ui/index.js';

interface Props {
  runId: string;
  nodeId: string;
  token: string;
  data: unknown;
  onResolved: () => void;
}

export function CancellationBanner({ runId, nodeId, data, onResolved }: Props) {
  const { t } = useTranslation('interrupts');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false); // ADR 0778 (`APUX-10`) — a same-tick double submit
  const reason = ((data as { reason?: string })?.reason) ?? t('cancellationDefaultReason');

  async function ack(confirm: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await resolveByRun(runId, nodeId, { acknowledged: true, confirm });
      onResolved();
    } catch (err) {
      setError(decideErrorMessage(t, err)); // ADR 0778 (`APUX-5`)
      inFlight.current = false;
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <h2>{t('cancellationRequested')}</h2>
      <div className="alert warning">{reason}</div>
      {error && <Notice variant="error" announce={error}>{error}</Notice>}
      <div className="button-row">
        <Button variant="primary" onClick={() => ack(true)} disabled={submitting}>{t('confirmCancel')}</Button>
        <Button variant="secondary" onClick={() => ack(false)} disabled={submitting}>{t('declineCancel')}</Button>
      </div>
    </div>
  );
}
