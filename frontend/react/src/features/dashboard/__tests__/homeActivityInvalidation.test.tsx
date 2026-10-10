/**
 * Issue 4511 (finding 5) — the home drops its cached activity reads when it
 * mounts, BEFORE any tile reads them. A run, chat or connection is created on
 * another page; without this, coming straight back showed the pre-create
 * answer for the rest of the 30 s TTL. `runTilesScope.test.tsx` pins what
 * `invalidateHomeActivity` drops; this pins that the page calls it, and in
 * time: tiles mount only after the layout read settles.
 */
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

const order: string[] = [];
vi.mock('../sharedRead.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  invalidateHomeActivity: () => { order.push('invalidate'); },
}));
vi.mock('../dashboardClient.js', () => ({
  getLayout: () => { order.push('layout'); return Promise.resolve(null); },
  putLayout: () => Promise.resolve({}),
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn() }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureVisible: () => () => true,
  useFeatureLocked: () => () => false,
  useAllFeatureAccess: () => ({ loading: false }),
  useFeatureAccess: () => makeFeatureAccess({ enabled: true }),
}));
vi.mock('../../../client/useEffectiveAccess.js', () => ({
  useEffectiveAccessState: () => ({ access: {}, resolved: true }),
  isAdminCaller: () => false,
}));

const { DashboardPage } = await import('../DashboardPage.js');

describe('home mount drops the cached activity reads', () => {
  it('invalidates once, before the layout read that gates the tiles', async () => {
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    await screen.findByRole('button', { name: /customize/i });
    expect(order.slice(0, 2)).toEqual(['invalidate', 'layout']);
    expect(order.filter((o) => o === 'invalidate')).toHaveLength(1);
  });
});
