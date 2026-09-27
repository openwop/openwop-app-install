/**
 * Adversarial-review F4 — the cadence editor mapped EVERY 404 to "moderator no
 * longer in the roster", but the PATCH has two distinct 404 arms:
 *   - the ROSTER arm (`getRosterEntry` miss) — details carries `moderatorRosterId`;
 *   - the PROJECT arm (`getProject` miss: deleted, or access revoked) — details
 *     carries only `id`.
 * Telling a user whose project was deleted to go fix their moderator sends them
 * hunting the wrong object. The client discriminates on
 * `body.details.moderatorRosterId`, which rides ONLY the roster arm.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const updateChatCadence = vi.fn();
const listRoster = vi.fn();

vi.mock('../projectsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  updateChatCadence: (id: string, patch: unknown) => updateChatCadence(id, patch),
  ensureProjectChat: vi.fn(async () => ({ sessionId: 's1' })),
}));
vi.mock('../../../agents/rosterClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listRoster: () => listRoster(),
}));

import { ProjectChatTab } from '../ProjectChatTab.js';

const PROJECT = {
  id: 'p1', tenantId: 't', orgId: 'org-1', name: 'Atlas', workflows: [],
  members: [{ ref: 'agent:bot-1', role: 'observer', addedAt: 't1' }],
} as never;

/** The wire shape `projectsClient.asJson` throws — status + the parsed envelope. */
const httpError = (status: number, details?: Record<string, unknown>): Error =>
  Object.assign(new Error(`updateChatCadence failed (${status})`), {
    status,
    body: { error: 'not_found', message: 'nope', ...(details ? { details } : {}) },
  });

const settle = async (): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

beforeEach(() => {
  updateChatCadence.mockReset();
  listRoster.mockReset();
  listRoster.mockResolvedValue([{ rosterId: 'bot-1', persona: 'Bot One' }]);
});
afterEach(cleanup);

async function saveCadence(): Promise<void> {
  render(<MemoryRouter><ProjectChatTab project={PROJECT} canWrite onSaved={() => {}} /></MemoryRouter>);
  await settle();
  fireEvent.click(screen.getByRole('button', { name: /save cadence/i }));
  await settle();
}

describe('F4 — the two 404 arms read differently', () => {
  it('a 404 carrying `details.moderatorRosterId` (the roster arm) names the moderator', async () => {
    updateChatCadence.mockRejectedValue(httpError(404, { moderatorRosterId: 'bot-1' }));
    await saveCadence();
    expect(await screen.findByText(/no longer in this workspace/i)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });

  it('a bare 404 (the project arm — deleted / access revoked) does NOT blame the moderator', async () => {
    updateChatCadence.mockRejectedValue(httpError(404, { id: 'p1' }));
    await saveCadence();
    expect(await screen.findByText(/may have been deleted, or your access/i)).toBeTruthy();
    expect(screen.queryByText(/no longer in this workspace/i)).toBeNull();
  });
});
