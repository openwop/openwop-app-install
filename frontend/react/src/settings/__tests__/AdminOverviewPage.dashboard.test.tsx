import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ActivityIcon, SettingsIcon } from '../../ui/icons/index.js';

const testState = vi.hoisted(() => ({
  reviews: [{ reviewId: 'approval:1' }, { reviewId: 'approval:2' }],
  loading: false,
  error: null as string | null,
  initialized: true,
  health: vi.fn(),
}));

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
vi.mock('../../client/operationsClient.js', () => ({
  OperationsRequestError: class OperationsRequestError extends Error {},
  getHealthSummary: testState.health,
}));

import { AdminOverviewPage } from '../AdminOverviewPage.js';

beforeEach(() => {
  localStorage.clear();
  testState.reviews = [{ reviewId: 'approval:1' }, { reviewId: 'approval:2' }];
  testState.loading = false;
  testState.error = null;
  testState.initialized = true;
  testState.health.mockReset().mockResolvedValue({ status: 'degraded' });
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
