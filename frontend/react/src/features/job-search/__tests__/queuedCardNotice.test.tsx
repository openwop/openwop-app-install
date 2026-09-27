/**
 * JSUX-Q-1 — the queued campaign card's DESTINATION survives the toast.
 *
 * The toast system deliberately carries no actions (string coalescing + the
 * announce contract), so the deep link rides durable state: after queueing, a
 * Notice renders with a real link to the career agent's board (the
 * Environments pendingApproval precedent). Both polarities: no notice before
 * queueing; the link targets the boardId the server returned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const listOrgs = vi.fn(async () => [{ orgId: 'org:1', name: 'Acme' }]);
const listGrants = vi.fn(async () => [{
  grantId: 'g1', campaignId: 'camp-1', submitsUsed: 0, maxSubmits: 5, preparedUsed: 0,
  maxPrepared: 5, ratePerHour: 4, tiers: ['A'], origins: ['boards.example.com'],
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(), revokedAt: null, createdAt: new Date().toISOString(),
}]);
const queueCampaign = vi.fn();
vi.mock('../jobSearchClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listOrgs: (...a: unknown[]) => listOrgs(...(a as [])),
  listGrants: (...a: unknown[]) => listGrants(...(a as [])),
  queueCampaign: (...a: unknown[]) => queueCampaign(...(a as [])),
  createGrant: vi.fn(),
  revokeGrant: vi.fn(),
}));

import { ApplyGrantPage } from '../ApplyGrantPage.js';

const renderPage = () => render(<MemoryRouter><ApplyGrantPage /></MemoryRouter>);

beforeEach(() => { vi.clearAllMocks(); queueCampaign.mockResolvedValue({ created: true, boardId: 'board:career' }); });
afterEach(cleanup);

describe('JSUX-Q-1 — queued-card notice', () => {
  it('after queueing, a durable notice links to the agent board the server named', async () => {
    renderPage();
    const btn = await screen.findByRole('button', { name: /queue a run/i });
    expect(screen.queryByText(/card on the career agent/i)).toBeNull(); // not before
    fireEvent.click(btn);
    await screen.findByText(/card on the career agent/i);
    const link = screen.getByRole('link', { name: /see the card/i });
    expect(link.getAttribute('href')).toBe('/boards/board%3Acareer');
  });
});
