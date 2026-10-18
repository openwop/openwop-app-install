/**
 * Grade-pass fixes (2026-07-16) — regression tests for the dashboard audit:
 *  S3 sharedRead (key scoping), S7b mergeForPersist (toggled-off
 *  preference preservation), and a representative tile component contract
 *  (ApprovalsInboxTile: rows → empty → error, never throws; ADR 0593 CMSAU-15).
 *
 * /grade-tests w50: sharedRead's "joins concurrent readers" and "a rejection
 * clears the slot" cases were cut — `src/client/__tests__/requestCache.test.ts`
 * ("collapses concurrent identical calls…", "does not cache a rejected load…")
 * and `runTilesScope.test.tsx` ("…shares within one paint") go red under the
 * same sabotages (probes w50g1-gf-coalesce-cover/-cover2, w50g1-gf-reject-cover).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { sharedRead, __resetSharedReads } from '../sharedRead.js';
import { mergeForPersist } from '../resolveTiles.js';

type ApprovalsClient = typeof import('../../../agents/approvalsClient.js');
const listApprovals = vi.fn<ApprovalsClient['listApprovals']>();
vi.mock('../../../agents/approvalsClient.js', () => ({ listApprovals: (...a: Parameters<ApprovalsClient['listApprovals']>) => listApprovals(...a) }));

import ApprovalsInboxTile from '../tiles/ApprovalsInboxTile.js';

beforeEach(() => { __resetSharedReads(); listApprovals.mockReset(); });

describe('sharedRead (S3 — key scoping)', () => {
  it('different keys fetch independently', async () => {
    const x = vi.fn().mockResolvedValue('x-value');
    const y = vi.fn().mockResolvedValue('y-value');
    expect(await Promise.all([sharedRead('x', x), sharedRead('y', y)])).toEqual(['x-value', 'y-value']);
    expect(x).toHaveBeenCalledTimes(1);
    expect(y).toHaveBeenCalledTimes(1);
  });
});

describe('mergeForPersist (S7b — toggled-off preferences survive a save)', () => {
  const registryIds = new Set(['a', 'b', 'gone-from-registry']);

  it('preserves saved rows for registered-but-unavailable tiles', () => {
    const saved = [
      { id: 'a', order: 0, size: 'half', enabled: true },
      { id: 'b', order: 10, size: 'full', enabled: true }, // toggle currently off → not in working
    ] as const;
    const working = [{ id: 'a', order: 5, size: 'half' as const, enabled: false }];
    const out = mergeForPersist([...saved], working, registryIds);
    // EXACT: the edited 'a' wins and the stale saved 'a' is gone (a toContainEqual
    // passed with both present — w50g1-gf-merge-edited); 'b' is preserved.
    expect(out).toEqual([
      { id: 'a', order: 5, size: 'half', enabled: false },
      { id: 'b', order: 10, size: 'full', enabled: true },
    ]);
  });

  it('drops saved rows for tiles no longer in the registry (self-healing)', () => {
    const saved = [{ id: 'retired', order: 0, size: 'half' as const, enabled: true }];
    const out = mergeForPersist(saved, [], new Set(['a']));
    expect(out).toHaveLength(0);
  });

  it('null saved layout passes working through unchanged', () => {
    const working = [{ id: 'a', order: 0, size: 'half' as const, enabled: true }];
    expect(mergeForPersist(null, working, registryIds)).toEqual(working);
  });
});

describe('ApprovalsInboxTile (representative tile contract)', () => {
  const renderTile = () => render(<MemoryRouter><ApprovalsInboxTile compact /></MemoryRouter>);

  // ADR 0593 (CMSAU-15) — this test PINNED THE DEFECT. `/agents` is the agents
  // ROSTER; no approval surface is mounted there (the inbox lives on `/profile`,
  // the decide list on `/inbox`), so every row on the one tile that reads
  // `pageTitle` sent the reviewer somewhere they could not decide.
  it('renders rows linking to a surface that can actually act on them', async () => {
    listApprovals.mockResolvedValue([
      { approvalId: 'ap1', proposal: 'Publish the launch page', status: 'pending', createdAt: new Date().toISOString(), rosterId: 'r', persona: 'Iris', workflowId: 'wf' },
    ]);
    const { getByText, container } = renderTile();
    await waitFor(() => expect(getByText('Publish the launch page')).toBeTruthy());
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/inbox');
  });

  it('deep-links a content-publish row to the page it is about (CMSAU-15)', async () => {
    listApprovals.mockResolvedValue([
      { approvalId: 'ap2', kind: 'content-publish', orgId: 'org-7', pageId: 'page-42', pageTitle: 'Pricing 2026', proposal: 'Publish CMS page', status: 'pending', createdAt: new Date().toISOString(), rosterId: '', persona: '', workflowId: '' },
    ]);
    const { getByText, container } = renderTile();
    await waitFor(() => expect(getByText('Pricing 2026')).toBeTruthy());
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/cms/p/org-7/page-42');
  });

  it('renders the designed empty state on zero approvals', async () => {
    listApprovals.mockResolvedValue([]);
    const { findByText } = renderTile();
    expect(await findByText('Nothing waiting for approval.')).toBeTruthy();
  });

  it('renders the designed error state (never throws to the grid)', async () => {
    listApprovals.mockRejectedValue(new Error('500'));
    const { findByText, queryByText } = renderTile();
    // The error COPY, not just the state class (the empty state carries it too).
    expect(await findByText(/could not load/i)).toBeTruthy();
    expect(queryByText(/nothing waiting for approval/i)).toBeNull();
  });
});
