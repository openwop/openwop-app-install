/**
 * ADR 0460 Phase 2 + ADR 0301 — an approval-backed ledger row reads its decision
 * chain ON EXPAND, by the bare approval id. A failed read must end in an
 * ANNOUNCED error (an error Notice speaks assertively) with a Retry that re-reads
 * and recovers, never a spinner that never resolves.
 *
 * Sabotage witnesses (w40 probes): mapping the failure to an empty chain, a no-op
 * Retry, passing the prefixed row id instead of the approval id, or dropping the
 * Notice's `announce` each turn this red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { announce, currentAnnouncements } from '../../../ui/announce.js';
import type { ExceptionAuditEntry, ExceptionRow } from '../../../client/kicktodoExceptionsClient.js';

const getExceptionAudit = vi.hoisted(() => vi.fn<(approvalId: string) => Promise<ExceptionAuditEntry[] | null>>());
vi.mock('../../../client/kicktodoExceptionsClient.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getExceptionAudit,
}));

import { ExceptionLedgerRow } from '../ExceptionLedgerRow.js';

beforeEach(() => { announce('', { assertive: true }); });
afterEach(cleanup);

const ROW: ExceptionRow = {
  id: 'approval:a1', source: 'approvals', severity: 'attention', label: 'Review approval',
  owner: { kind: 'user', ref: 'u1', label: 'Dana' },
  action: { labelKey: 'exceptionActionReview', href: '/reviews' },
  audit: { detectedAt: '2026-09-20T12:00:00Z', tenantId: 't1' },
};

describe('ExceptionLedgerRow audit state', () => {
  it('terminates a failed audit read with an announced Retry path', async () => {
    // The REAL client never rejects: `getExceptionAudit()` maps a failed read to
    // `null` ("render a failure line"). Fixture it the way production delivers it.
    getExceptionAudit.mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([]);
    render(
      <MemoryRouter>
        <ul>
          <ExceptionLedgerRow row={ROW} />
        </ul>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('Audit'));
    const error = await screen.findByText(/decision chain couldn’t be read/i);
    // `Notice` announces from an effect, which runs AFTER the commit that put the
    // text in the DOM, so reading the store the instant the text appears raced it
    // in a loaded gate (slot 77: received ''). The announcement is still required.
    await waitFor(() => expect(currentAnnouncements().assertive).toContain('The decision chain couldn’t be read. Reopen to retry.'));
    fireEvent.click(within(error.closest('.alert') as HTMLElement).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText(/no decision recorded yet/i)).toBeTruthy());
    expect(getExceptionAudit).toHaveBeenCalledTimes(2);
    // The chain is keyed by the BARE approval id, not the ledger row id.
    expect(getExceptionAudit).toHaveBeenNthCalledWith(1, 'a1');
    expect(getExceptionAudit).toHaveBeenNthCalledWith(2, 'a1');
  });
});
