/**
 * Admin home (UX ADM) — decisions first. The health card never reports Ready from a
 * failed read (it says "unavailable"), the approvals card never claims zero before the
 * shared inbox has hydrated, and the settings directory searches label + hint + group
 * with a recovery action when nothing matches.
 *
 * Sabotage that turns it red: map every health summary to Ready; map a failed read to
 * Ready; drop the `!reviewsInitialized` guard; search labels only; a no-op Clear search;
 * a wrong pending count; point "Open operations" anywhere but the operations path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ActivityIcon, SettingsIcon } from '../../ui/icons/index.js';
import type { HealthSummary } from '../../client/operationsClient.js';
import type { ReviewRequest } from '../../chat/reviews/reviewClient.js';

type OpsClient = typeof import('../../client/operationsClient.js');

const review = (reviewId: string): ReviewRequest => ({
  reviewId, source: 'approval', kind: 'approval', status: 'pending', tenantId: 't1', requestedAt: '2026-09-01T10:00:00.000Z',
  actions: [], provenanceRefs: [],
});
const testState = vi.hoisted(() => ({
  reviews: [] as ReviewRequest[],
  loading: false,
  error: null as string | null,
  initialized: true,
  health: vi.fn<OpsClient['getHealthSummary']>(),
}));

const DEGRADED: HealthSummary = {
  status: 'degraded',
  version: '1.0.0',
  checks: { config: { ok: true }, storage: { ok: false, error: 'disk' } },
  sse: { totalStreams: 0, keys: 0, max: 0, top: [] },
  rateLimits: { ipReqsPerMin: 60, ipReadReqsPerMin: 600, sessionRunsPerMin: 10, sessionRunsPerDay: 100, sessionConcurrent: 2, ipRunsPerDay: 100, mcpPrincipalReqsPerMin: 60 },
  daemon: {},
  perInstance: true,
  fetchedAt: '2026-09-01T10:00:00.000Z',
};

vi.mock('../../chrome/navConfig/NavConfigProvider.js', () => ({
  useResolvedNav: () => ({
    workspace: [], site: [], degraded: false,
    admin: [
      { id: 'Admin', label: 'Admin', items: [{ to: '/admin', label: 'Overview', hint: 'Admin home', icon: SettingsIcon }] },
      { id: 'System operations', label: 'System operations', items: [{ to: '/operations', label: 'Ops Console', hint: 'System health and queues', icon: ActivityIcon }] },
      { id: 'Developer', label: 'Developer', items: [{ to: '/cli', label: 'CLI', hint: 'Command-line tools', icon: SettingsIcon }] },
    ],
  }),
}));
vi.mock('../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureBadge: () => () => null,
  useFeatureLocked: () => () => false,
}));
vi.mock('../../chat/reviews/reviewStatusStore.js', () => ({
  useReviewList: () => testState.reviews,
  useReviewStatusStore: (selector: (state: { loading: boolean; error: string | null; initialized: boolean }) => unknown) => selector(testState),
}));
// The REAL OperationsRequestError (the page branches on its `status`); only the read is stubbed.
vi.mock('../../client/operationsClient.js', async (orig) => ({
  ...(await orig<OpsClient>()),
  getHealthSummary: testState.health,
}));

import { AdminOverviewPage } from '../AdminOverviewPage.js';

beforeEach(() => {
  localStorage.clear();
  testState.reviews = [review('approval:1'), review('approval:2')];
  testState.loading = false;
  testState.error = null;
  testState.initialized = true;
  testState.health.mockReset().mockResolvedValue(DEGRADED);
});
afterEach(cleanup);

describe('AdminOverviewPage operator dashboard', () => {
  it('surfaces pending decisions and an honest degraded health result', async () => {
    render(<MemoryRouter><AdminOverviewPage /></MemoryRouter>);

    expect(screen.getByText('2 approvals are waiting')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Degraded — investigate now')).toBeTruthy());
    expect(screen.getByRole('link', { name: 'Open operations' }).getAttribute('href')).toBe('/operations');
  });

  it('searches the effective directory and provides a clear recovery action', async () => {
    render(<MemoryRouter><AdminOverviewPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Degraded — investigate now')).toBeTruthy());
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'command-line' } });

    expect(screen.getByRole('link', { name: /CLI/ })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Ops Console/ })).toBeNull();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'no-such-setting' } });
    expect(screen.getByText('No settings match')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('link', { name: /Ops Console/ })).toBeTruthy();
  });

  it('does not report ready when the health read fails', async () => {
    testState.health.mockRejectedValue(new Error('offline'));
    render(<MemoryRouter><AdminOverviewPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Health status is unavailable')).toBeTruthy());
    expect(screen.queryByText('Ready')).toBeNull();
  });

  it('does not claim zero approvals before the shared inbox has hydrated', async () => {
    testState.reviews = [];
    testState.initialized = false;
    render(<MemoryRouter><AdminOverviewPage /></MemoryRouter>);
    expect(screen.getByText('Checking pending approvals…')).toBeTruthy();
    expect(screen.queryByText('No approvals are waiting')).toBeNull();
    await waitFor(() => expect(screen.getByText('Degraded — investigate now')).toBeTruthy());
  });
});
