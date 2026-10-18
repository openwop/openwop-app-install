/**
 * JSUX-Q-1 (ADR 0541, WF-JS-1) — the queued campaign card's DESTINATION survives the toast.
 *
 * The toast system deliberately carries no actions (string coalescing + the
 * announce contract), so the deep link rides durable state: after queueing, a
 * Notice renders with a real link to the career agent's board (the
 * Environments pendingApproval precedent). Both polarities: no notice before
 * queueing; the link targets the boardId the server returned.
 *
 * Sabotage-witnessed (w52): the boardId not kept (`setQueuedBoardId(null)`), and
 * the id not URL-encoded into the link.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type Client = typeof import('../jobSearchClient.js');
const { listOrgs, listGrants, queueCampaign } = vi.hoisted(() => ({
  listOrgs: vi.fn<Client['listOrgs']>(),
  listGrants: vi.fn<Client['listGrants']>(),
  queueCampaign: vi.fn<Client['queueCampaign']>(),
}));
vi.mock('../jobSearchClient.js', async (importOriginal) => ({
  ...(await importOriginal<Client>()),
  listOrgs, listGrants, queueCampaign,
  createGrant: vi.fn(),
  revokeGrant: vi.fn(),
}));

/** An ACTIVE grant (expiry relative to now, so it stays active under the clock-shift lane). */
const activeGrant = (): ApplyGrantView => ({
  grantId: 'g1', subjectId: 'u1', grantedBy: 'u1', campaignId: 'camp-1', submitsUsed: 0, maxSubmits: 5, preparedUsed: 0,
  maxPrepared: 5, ratePerHour: 4, tiers: ['A'], origins: ['boards.example.com'],
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(), revokedAt: null, createdAt: new Date().toISOString(),
});

import { ApplyGrantPage } from '../ApplyGrantPage.js';
import type { ApplyGrantView } from '../jobSearchClient.js';

const renderPage = () => render(<MemoryRouter><ApplyGrantPage /></MemoryRouter>);

beforeEach(() => {
  vi.resetAllMocks();
  listOrgs.mockResolvedValue([{ orgId: 'org:1', name: 'Acme' }]);
  listGrants.mockImplementation(async () => [activeGrant()]);
  queueCampaign.mockResolvedValue({ created: true, boardId: 'board:career' });
});
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
