/** ADR 1136 P3b — a session status as the shared status badge, in host words. */
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { StatusBadge } from '../../ui/StatusBadge.js';
import type { SessionStatus } from './computerUseClient.js';

/** The shared badge's tone for each session status. */
const TONE: Record<SessionStatus, string> = {
  starting: 'running',
  running: 'running',
  awaiting_approval: 'waiting-approval',
  awaiting_takeover: 'waiting-approval',
  completed: 'completed',
  failed: 'failed',
  denied: 'cancelled',
  aborted: 'cancelled',
};

export function SessionStatusBadge({ status }: { status: SessionStatus }): JSX.Element {
  const { t } = useTranslation('computer-use');
  return <StatusBadge status={TONE[status] ?? ''} label={t(`status_${status}`, { defaultValue: status })} />;
}
