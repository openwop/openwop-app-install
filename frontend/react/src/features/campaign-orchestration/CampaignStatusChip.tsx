/** The campaign status chip, shared by the campaigns list and the detail page. */
import type { useTranslation } from 'react-i18next';
import type { CampaignStatus } from './campaignStudioClient.js';

type TFn = ReturnType<typeof useTranslation>['t'];

export function StatusChip({ status, t }: { status: CampaignStatus; t: TFn }): JSX.Element {
  // `completed` is a TERMINAL state (grade-ux): the clay accent (chip--accent)
  // reads as active/flow — a finished campaign should read settled, so → muted.
  const cls = status === 'active' ? 'chip--success' : status === 'completed' ? 'chip--muted' : status === 'paused' ? 'chip--warning' : 'chip--muted';
  return <span className={`chip ${cls}`}>{t(`status_${status}`)}</span>;
}
