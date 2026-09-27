/**
 * Grade-pass fixes (2026-07-16) — regression tests for the dashboard audit:
 *  S3 sharedRead (duplicate-fetch dedup), S7b mergeForPersist (toggled-off
 *  preference preservation), and a representative tile component contract
 *  (ApprovalsInboxTile: loading → rows → empty → error, never throws).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { sharedRead, __resetSharedReads } from '../sharedRead.js';
import { mergeForPersist } from '../resolveTiles.js';

const listApprovals = vi.fn();
vi.mock('../../../agents/approvalsClient.js', () => ({ listApprovals: (s?: string) => listApprovals(s) }));

import ApprovalsInboxTile from '../tiles/ApprovalsInboxTile.js';

beforeEach(() => { __resetSharedReads(); listApprovals.mockReset(); });

describe('sharedRead (S3 — duplicate-fetch dedup)', () => {
  it('joins concurrent readers of the same key onto ONE request', async () => {
    const fetcher = vi.fn().mockResolvedValue(42);
    const [a, b] = await Promise.all([sharedRead('k', fetcher), sharedRead('k', fetcher)]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('different keys fetch independently', async () => {
    const fetcher = vi.fn().mockResolvedValue(1);
    await Promise.all([sharedRead('x', fetcher), sharedRead('y', fetcher)]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('a rejection clears the slot so the next read retries', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(7);
    await expect(sharedRead('k', fetcher)).rejects.toThrow('boom');
    await expect(sharedRead('k', fetcher)).resolves.toBe(7);
    expect(fetcher).toHaveBeenCalledTimes(2);
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
    expect(out).toContainEqual({ id: 'a', order: 5, size: 'half', enabled: false }); // edited wins
    expect(out).toContainEqual({ id: 'b', order: 10, size: 'full', enabled: true }); // preserved
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
    const { getByText } = renderTile();
    await waitFor(() => expect(getByText(/approval/i)).toBeTruthy());
  });

  it('renders the designed error state (never throws to the grid)', async () => {
    listApprovals.mockRejectedValue(new Error('500'));
    const { container } = renderTile();
    await waitFor(() => expect(container.querySelector('.dash-tile__state')).toBeTruthy());
  });
});
