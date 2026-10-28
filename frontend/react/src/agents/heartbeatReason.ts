/**
 * The reasons the server names when a heartbeat picks nothing
 * (`HeartbeatResult.reason`, ADR 0534 D6 / ADR 0963 D3), as a person reads them.
 *
 * Before this the Check-now notice interpolated the raw code ("found no eligible
 * To Do tasks (no_working_lane)"). Each key is a literal so the per-key i18n
 * tracking sees it; an unknown or absent code falls back to the caller's text.
 */
import type { TFunction } from 'i18next';

export function heartbeatReasonText(t: TFunction, reason: string | undefined, fallback: string): string {
  switch (reason) {
    case 'paused': return t('agents:heartbeatReason_paused');
    case 'no_boards': return t('agents:heartbeatReason_no_boards');
    case 'empty_board': return t('agents:heartbeatReason_empty_board');
    case 'no_runnable_workflow': return t('agents:heartbeatReason_no_runnable_workflow');
    case 'policy_denied': return t('agents:heartbeatReason_policy_denied');
    case 'awaiting_approval': return t('agents:heartbeatReason_awaiting_approval');
    case 'held': return t('agents:heartbeatReason_held');
    case 'mock_archive': return t('agents:heartbeatReason_mock_archive');
    case 'no_working_lane': return t('agents:heartbeatReason_no_working_lane');
    case 'no_eligible_tasks': return t('agents:heartbeatReason_no_eligible_tasks');
    default: return fallback;
  }
}
