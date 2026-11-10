/** ADR 0948 P1b — both inboxes must say that this decision publishes a funnel,
 * never that it starts a workflow. An unbound row (no org, or no pinned digest) cannot
 * offer approval, and can still be rejected.
 *
 * Sabotage (w76 probes): the kind falling into the run table reds the `detailed` case and
 * the `full` rows; a run toast or a lost label, help line or decision branch reds the
 * inbox that lost it; dropping either half of the bound check, or the disabled state,
 * reds the matching unbound rows.
 */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { t } from 'i18next';
import type { PendingApproval } from '../../agents/approvalsClient.js';

const { listApprovals, listApprovalsByKind, claimApproval, rejectApproval } = vi.hoisted(() => ({
  listApprovals: vi.fn<typeof import('../../agents/approvalsClient.js').listApprovals>(),
  listApprovalsByKind: vi.fn<typeof import('../../agents/approvalsClient.js').listApprovalsByKind>(),
  claimApproval: vi.fn<typeof import('../../agents/approvalsClient.js').claimApproval>(),
  rejectApproval: vi.fn<typeof import('../../agents/approvalsClient.js').rejectApproval>(),
}));
vi.mock('../../agents/approvalsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../agents/approvalsClient.js')>()), listApprovals, listApprovalsByKind, claimApproval, rejectApproval,
}));
const { loadAgentViews } = vi.hoisted(() => ({ loadAgentViews: vi.fn<typeof import('../../agents/agentViewModel.js').loadAgentViews>() }));
vi.mock('../../agents/agentViewModel.js', async (orig) => ({ ...(await orig<typeof import('../../agents/agentViewModel.js')>()), loadAgentViews }));
const { success } = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock('../../ui/toast.js', () => ({ toast: { success, error: vi.fn(), info: vi.fn() } }));
import { ApprovalsInbox } from '../ApprovalsInbox.js';
import { NeedsYouInbox } from '../NeedsYouInbox.js';

const UNBOUND: PendingApproval = {
  approvalId: 'funnel-review', rosterId: '', persona: '', workflowId: '',
  kind: 'funnel-publish', status: 'pending', createdAt: '2026-10-20T00:00:00Z',
  proposal: 'Publish the funnel "Autumn" at /autumn (2 steps). Publishing makes it public and its offers chargeable.',
};
const PINNED: NonNullable<PendingApproval['funnelPublish']> = { funnelId: 'funnel:autumn', funnelName: 'Autumn', slug: 'autumn', digest: 'a'.repeat(64), stepCount: 2 };
const ROW: PendingApproval = { ...UNBOUND, orgId: 'org:client', funnelPublish: PINNED };
const NO_DIGEST: PendingApproval = { ...UNBOUND, orgId: 'org:client' };
const NO_ORG: PendingApproval = { ...UNBOUND, funnelPublish: PINNED };

beforeEach(() => {
  vi.clearAllMocks(); listApprovals.mockResolvedValue([ROW]); listApprovalsByKind.mockResolvedValue([]);
  loadAgentViews.mockResolvedValue([]); claimApproval.mockResolvedValue({});
});
afterEach(cleanup);

describe('funnel-publish decision cards', () => {
  it.each([{ name: 'detailed', Component: ApprovalsInbox }, { name: 'needs-you', Component: NeedsYouInbox }])(
    '$name: approving describes a public publish, not a workflow launch', async ({ Component }) => {
      render(<MemoryRouter><Component /></MemoryRouter>);
      expect(await screen.findByText(t('notifications:approvalsFunnelPublishGroup'))).toBeTruthy();
      expect(screen.getByText(ROW.proposal)).toBeTruthy();
      expect(await screen.findByText(t('notifications:approvalsFunnelPublishHelp'))).toBeTruthy();
      expect(screen.queryByText(/Approve & run/)).toBeNull();
      fireEvent.click(await screen.findByRole('button', { name: t('notifications:approvalsFunnelPublishApprove') }));
      await waitFor(() => expect(claimApproval).toHaveBeenCalledWith(ROW.approvalId, undefined, undefined));
      await waitFor(() => expect(success).toHaveBeenCalledWith(t('notifications:toastApprovedFunnelPublish')));
    },
  );
  it.each([
    { name: 'full, no digest', Component: ApprovalsInbox, row: NO_DIGEST },
    { name: 'full, no org', Component: ApprovalsInbox, row: NO_ORG },
    { name: 'compact, no digest', Component: NeedsYouInbox, row: NO_DIGEST },
    { name: 'compact, no org', Component: NeedsYouInbox, row: NO_ORG },
  ])('keeps approval disabled for an unbound row while allowing rejection: $name', async ({ Component, row }) => {
    listApprovals.mockResolvedValue([row]);
    render(<MemoryRouter><Component /></MemoryRouter>);
    const approve = await screen.findByRole('button', { name: t('notifications:approvalsFunnelPublishApprove') });
    expect(approve).toBeDisabled();
    expect(screen.getByRole('button', { name: t('notifications:rejectLabel') })).not.toBeDisabled();
    fireEvent.click(approve); expect(claimApproval).not.toHaveBeenCalled();
  });
});
