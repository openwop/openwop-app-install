/** ADR 0948 P1b — both inboxes describe the same public publishing decision. */
import { useTranslation } from 'react-i18next';
import type { PendingApproval } from '../agents/approvalsClient.js';
import { ApprovalDecideBar } from './ContentReviewContext.js';

export default function FunnelPublishDecision({ approval, busy, onApprove, onReject }: {
  approval: PendingApproval;
  busy: boolean;
  onApprove: () => void;
  onReject: (note?: string) => void | boolean | Promise<void | boolean>;
}): JSX.Element {
  const { t } = useTranslation('notifications');
  return <div className="u-grid u-gap-2">
    <p className="muted u-fs-12 u-m-0">{t('approvalsFunnelPublishHelp')}</p>
    <ApprovalDecideBar busy={busy} approveDisabled={!approval.orgId || !approval.funnelPublish?.digest}
      approveLabel={t('approvalsFunnelPublishApprove')} onApprove={onApprove} onReject={onReject} />
  </div>;
}
