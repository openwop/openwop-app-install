/**
 * R3 — the merge-history audit section (the R2 "deferred SAFELY" read half) over
 * the ADR 0264 merge-event record.
 * Pins: rows render pair/filled/absorbed/status; a FAILED read says failed
 * (never the empty state) and its retry re-reads; a clean zero is the designed
 * empty state.
 *
 * Sabotage-witnessed (/grade-tests w38): the filled / absorbed counts, the
 * unmerged chip, the pair cell, a failed read rendered as empty, the empty-state
 * title, and a retry that never clears the error each turn a case red.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import type { MergeEventRow, listMergeEvents as ListMergeEvents } from '../../../client/cdpClient.js';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

const listMergeEvents = vi.fn<typeof ListMergeEvents>();
vi.mock('../../../client/cdpClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  verifyAuditChain: vi.fn(async () => ({ intact: true, checked: 0 })),
  listGovernanceDecisions: vi.fn(async () => ({ decisions: [], exhaustive: true })),
  listEventSchemas: vi.fn(async () => []),
  listCollectedEvents: vi.fn(async () => []),
  listMergeEvents: (limit?: number) => listMergeEvents(limit),
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useFeatureAccess: () => makeFeatureAccess(),
}));

import { CdpConsolePage } from '../CdpConsolePage.js';

const openCompliance = async (): Promise<void> => {
  render(<CdpConsolePage />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: /compliance/i }));
  await act(async () => {});
};

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('merge-history audit section', () => {
  it('renders the pair, filled/absorbed counts, and the unmerged trail state', async () => {
    const rows: MergeEventRow[] = [
      { mergeEventId: 'm1', survivorId: 'ct-a', sourceId: 'ct-b', filledFields: { phone: '+1' }, absorbedIdentifiers: [{ type: 'email', value: 'b@x.test' }], actor: 'user:me', mergedAt: '2026-08-14T00:00:00Z' },
      { mergeEventId: 'm2', survivorId: 'ct-c', sourceId: 'ct-d', filledFields: {}, absorbedIdentifiers: [], actor: 'user:me', mergedAt: '2026-08-13T00:00:00Z', unmergedAt: '2026-08-14T01:00:00Z' },
    ];
    listMergeEvents.mockResolvedValue(rows);
    await openCompliance();
    expect(await screen.findByText('ct-b')).toBeTruthy();
    expect(screen.getByText('ct-a')).toBeTruthy(); // both sides of the pair
    expect(screen.getByText('1 field(s)')).toBeTruthy();
    expect(screen.getByText('1 identifier(s)')).toBeTruthy();
    // The unmerged row STAYS listed with its trail state (not deleted).
    expect(screen.getByText('unmerged')).toBeTruthy();
    expect(screen.getByText('merged')).toBeTruthy();
  });

  it('a FAILED read says failed-not-empty, with retry', async () => {
    listMergeEvents.mockRejectedValue(new Error('boom'));
    await openCompliance();
    expect(await screen.findByText(/merge history could not be loaded/i)).toBeTruthy();
    expect(screen.queryByText(/No merges recorded/i)).toBeNull();
    // …with retry: the retry re-reads and a clean answer replaces the error.
    listMergeEvents.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText(/No merges recorded/i)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
    expect(listMergeEvents).toHaveBeenCalledTimes(2);
  });

  it('a clean zero is the designed empty state (paired polarity)', async () => {
    listMergeEvents.mockResolvedValue([]);
    await openCompliance();
    expect(await screen.findByText(/No merges recorded/i)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });
});
