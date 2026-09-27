import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const getExceptionAudit = vi.hoisted(() => vi.fn());
vi.mock('../../../client/kicktodoExceptionsClient.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getExceptionAudit,
}));

import { ExceptionLedgerRow } from '../ExceptionLedgerRow.js';

afterEach(cleanup);

describe('ExceptionLedgerRow audit state', () => {
  it('terminates a failed audit read with an announced Retry path', async () => {
    getExceptionAudit.mockReset()
      .mockRejectedValueOnce(new Error('audit down'))
      .mockResolvedValueOnce([]);
    render(
      <MemoryRouter>
        <ul>
          <ExceptionLedgerRow row={{
            id: 'approval:a1', source: 'approvals', severity: 'attention', label: 'Review approval',
            owner: { kind: 'user', ref: 'u1', label: 'Dana' },
            action: { labelKey: 'exceptionActionReview', href: '/reviews' },
            audit: { detectedAt: '2026-09-20T12:00:00Z', tenantId: 't1' },
          }} />
        </ul>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('Audit'));
    const error = await screen.findByText(/decision chain couldn’t be read/i);
    fireEvent.click(error.closest('.alert')!.querySelector('button')!);
    await waitFor(() => expect(screen.getByText(/no decision recorded yet/i)).toBeTruthy());
    expect(getExceptionAudit).toHaveBeenCalledTimes(2);
  });
});
