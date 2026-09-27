/**
 * UX_UPGRADE-kicktodo-suite KT2-G1 — an org report that failed to load is not an
 * org with no outcomes.
 *
 * `getOrgReport(id).catch(() => [])` rendered "No circle outcomes yet" — a claim
 * about the organisation's programmes — whenever the read failed. This is a
 * MANAGEMENT view: the empty state is what an admin would act on.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

const { listOrgs, listChallenges, getOrgLibrary, getOrgReport } = vi.hoisted(() => ({
  listOrgs: vi.fn(), listChallenges: vi.fn(), getOrgLibrary: vi.fn(), getOrgReport: vi.fn(),
}));
vi.mock('../../../client/kicktodoOrgClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/kicktodoOrgClient.js')>()),
  getOrgLibrary, getOrgReport,
}));
vi.mock('../../../client/kicktodoClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/kicktodoClient.js')>()),
  listChallenges,
}));
vi.mock('../../../client/accessClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/accessClient.js')>()),
  listOrgs,
}));

import { OrgProgramsPage } from '../OrgProgramsPage.js';

const mount = async (): Promise<void> => {
  render(<OrgProgramsPage />);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
  listChallenges.mockResolvedValue([]);
  // The real OrgLibraryView — an incomplete fixture throws in render and every
  // assertion below then fails for the wrong reason.
  getOrgLibrary.mockResolvedValue({ library: { entries: [] }, catalog: { curated: false, challenges: [] } });
  getOrgReport.mockResolvedValue([]);
});

describe('KT2-G1 — a failed report is not an empty report', () => {
  it('does not claim there are no outcomes when the read failed', async () => {
    getOrgReport.mockRejectedValue(new Error('503'));
    await mount();
    expect(screen.queryByText('No circle outcomes yet')).toBeNull();
    expect(screen.getByText('Could not load circle outcomes')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('a genuinely empty report STILL says so', async () => {
    // The failure mode of this fix is costing the real empty state its meaning.
    await mount();
    expect(screen.getByText('No circle outcomes yet')).toBeTruthy();
    expect(screen.queryByText('Could not load circle outcomes')).toBeNull();
  });

  it('the retry recovers and clears the failed state', async () => {
    getOrgReport.mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce([]);
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(screen.getByText('No circle outcomes yet')).toBeTruthy();
    expect(screen.queryByText('Could not load circle outcomes')).toBeNull();
  });
});
