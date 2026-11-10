/** ADR 1024 (grade-ux H2) — a warehouse-load approval is a load of customer rows into a
 * named table, not an agent's workflow run. Before, it fell into the run catch-all: an
 * empty Agent cell, "Approve & run", and an empty-persona "is running it now" toast on a
 * row where nothing runs until the sync is run again.
 *
 * Red when (sabotage-witnessed): the `isWarehouseLoad` group is removed (the row returns to
 * the run table); the toast branch is removed (the empty-persona toast returns); the
 * structured sentence is replaced by the raw proposal.
 */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { t } from 'i18next';
import type { PendingApproval } from '../../agents/approvalsClient.js';

const { listApprovals, listApprovalsByKind, claimApproval, rejectApproval } = vi.hoisted(() => ({
  listApprovals: vi.fn(), listApprovalsByKind: vi.fn(), claimApproval: vi.fn(), rejectApproval: vi.fn(),
}));
vi.mock('../../agents/approvalsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../agents/approvalsClient.js')>()), listApprovals, listApprovalsByKind, claimApproval, rejectApproval,
}));
const { loadAgentViews } = vi.hoisted(() => ({ loadAgentViews: vi.fn() }));
vi.mock('../../agents/agentViewModel.js', async (orig) => ({ ...(await orig<typeof import('../../agents/agentViewModel.js')>()), loadAgentViews }));
const { success } = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock('../../ui/toast.js', () => ({ toast: { success, error: vi.fn(), info: vi.fn() } }));
import { ApprovalsInbox } from '../ApprovalsInbox.js';

const ROW: PendingApproval = {
  approvalId: 'appr:wh-1', rosterId: '', persona: '', workflowId: '',
  kind: 'warehouse-load', status: 'pending', createdAt: '2026-11-02T00:00:00Z',
  proposal: 'Load 3 row(s) into BigQuery crm.contacts (reverse-ETL warehouse write)',
  dataset: 'crm', table: 'contacts', rowCount: 3,
};
beforeEach(() => {
  vi.clearAllMocks(); listApprovals.mockResolvedValue([ROW]); listApprovalsByKind.mockResolvedValue([]);
  loadAgentViews.mockResolvedValue([]); claimApproval.mockResolvedValue({});
});
afterEach(cleanup);

describe('warehouse-load decision card', () => {
  it('names the rows and the table, offers a plain Approve, and says what happens next', async () => {
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    expect(await screen.findByText(t('notifications:approvalsWarehouseLoadGroup'))).toBeTruthy();
    expect(screen.getByText(t('notifications:approvalsWarehouseLoadAsk', { count: 3, dataset: 'crm', table: 'contacts' }))).toBeTruthy();
    expect(screen.queryByText(/Approve & run/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('notifications:approveLabel') }));
    await waitFor(() => expect(claimApproval).toHaveBeenCalledWith(ROW.approvalId, undefined, undefined));
    await waitFor(() => expect(success).toHaveBeenCalledWith(t('notifications:toastApprovedWarehouseLoad')));
  });

  it('falls back to the server sentence when the structured fields are missing', async () => {
    listApprovals.mockResolvedValue([{ ...ROW, dataset: undefined, table: undefined, rowCount: undefined }]);
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    expect(await screen.findByText(ROW.proposal)).toBeTruthy();
  });
});
