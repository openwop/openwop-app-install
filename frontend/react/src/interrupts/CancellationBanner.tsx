import { Button } from '../ui/Button.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveByRun } from '../client/interruptsClient.js';

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
  const reason = ((data as { reason?: string })?.reason) ?? t('cancellationDefaultReason');

  async function ack(confirm: boolean) {
    setSubmitting(true);
    setError(null);
    try {
      await resolveByRun(runId, nodeId, { acknowledged: true, confirm });
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <h2>{t('cancellationRequested')}</h2>
      <div className="alert warning">{reason}</div>
      {error && <div role="alert" className="alert error">{error}</div>}
      <div className="button-row">
        <Button variant="primary" onClick={() => ack(true)} disabled={submitting}>{t('confirmCancel')}</Button>
        <Button variant="secondary" onClick={() => ack(false)} disabled={submitting}>{t('declineCancel')}</Button>
      </div>
    </div>
  );
}
