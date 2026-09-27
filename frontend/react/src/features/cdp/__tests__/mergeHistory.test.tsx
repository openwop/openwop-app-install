/**
 * R3 — the merge-history audit section (the R2 "deferred SAFELY" read half).
 * Pins: rows render pair/filled/absorbed/status; a FAILED read says failed
 * (never the empty state); a clean zero is the designed empty state.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

const listMergeEvents = vi.fn();
vi.mock('../../../client/cdpClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  verifyAuditChain: vi.fn(async () => ({ intact: true, checked: 0 })),
  listGovernanceDecisions: vi.fn(async () => ({ decisions: [], exhaustive: true })),
  listEventSchemas: vi.fn(async () => []),
  listCollectedEvents: vi.fn(async () => []),
  listMergeEvents: (...a: unknown[]) => listMergeEvents(...a),
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled: true, locked: false, loading: false, status: 'on' as const, isBeta: false, variant: null, entitled: true, resolutionFailed: false }),
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
    listMergeEvents.mockResolvedValue([
      { mergeEventId: 'm1', survivorId: 'ct-a', sourceId: 'ct-b', filledFields: { phone: '+1' }, absorbedIdentifiers: [{ type: 'email', value: 'b@x.test' }], actor: 'user:me', mergedAt: '2026-08-14T00:00:00Z' },
      { mergeEventId: 'm2', survivorId: 'ct-c', sourceId: 'ct-d', filledFields: {}, absorbedIdentifiers: [], actor: 'user:me', mergedAt: '2026-08-13T00:00:00Z', unmergedAt: '2026-08-14T01:00:00Z' },
    ]);
    await openCompliance();
    expect(await screen.findByText('ct-b')).toBeTruthy();
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
  });

  it('a clean zero is the designed empty state (paired polarity)', async () => {
    listMergeEvents.mockResolvedValue([]);
    await openCompliance();
    expect(await screen.findByText(/No merges recorded/i)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });
});
