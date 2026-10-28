/**
 * ADR 0949 P4b — the create form: choosing Optimize creates an Optimize
 * experiment with the safe defaults; each kind's help is tied to its radio
 * (ux-review, DESIGN.md §5.1).
 *
 * Sabotage (run 2026-10-20): dropping the Optimize defaults from the create
 * body reds the first case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as EC from '../experimentsClient.js';

const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: access.useFeatureAccess }));

const api = vi.hoisted(() => ({ listExperiments: vi.fn<typeof EC.listExperiments>(), createExperiment: vi.fn<typeof EC.createExperiment>() }));
vi.mock('../experimentsClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));
const cms = vi.hoisted(() => ({
  listOrgs: vi.fn(async () => [{ orgId: 'o1', name: 'Acme' }]),
  listPages: vi.fn(async () => [{ pageId: 'p1', title: 'Landing', slug: 'landing', status: 'published', sections: [], version: 1, updatedAt: '' }]),
  listVersions: vi.fn(async () => [{ versionId: 'v2', version: 2, snapshot: { title: 'Short hero', slug: 's', sections: [] }, publishedAt: '', publishedBy: '' }]),
}));
vi.mock('../../cms/cmsClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...cms }));
vi.mock('../../funnels/funnelsClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), listFunnels: vi.fn(async () => []) }));

const { ExperimentsPage } = await import('../ExperimentsPage.js');

beforeEach(() => {
  vi.clearAllMocks();
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
  api.listExperiments.mockResolvedValue([]);
  api.createExperiment.mockResolvedValue({ experimentId: 'exp:new' } as EC.Experiment);
});
afterEach(cleanup);

describe('ADR 0949 P4b — create', () => {
  it('Optimize creates an Optimize experiment with the safe defaults', async () => {
    render(<MemoryRouter><ExperimentsPage /></MemoryRouter>);
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Hero' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Optimize' }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Landing' })).toBeTruthy());
    fireEvent.change(screen.getAllByRole('combobox')[2]!, { target: { value: 'p1' } });
    await waitFor(() => expect(screen.getByRole('option', { name: /Short hero/ })).toBeTruthy());
    fireEvent.change(screen.getAllByRole('combobox')[3]!, { target: { value: 'v2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(api.createExperiment).toHaveBeenCalled());
    expect(api.createExperiment.mock.calls[0]![1]).toMatchObject({
      mode: 'optimize', optimize: { floorPct: 5, epochMinutes: 1440, rewardMetric: { kind: 'conversion' } },
      surface: { kind: 'cms.page', ref: 'p1' }, arms: [{ key: 'control', ref: null }, { key: 'b', ref: 'v2' }],
    });
  });

  it('each kind\'s help is tied to its radio', async () => {
    render(<MemoryRouter><ExperimentsPage /></MemoryRouter>);
    const optimize = await screen.findByRole('radio', { name: 'Optimize' });
    const describedBy = optimize.getAttribute('aria-describedby');
    expect(describedBy && document.getElementById(describedBy)?.textContent).toMatch(/never declares a winner/);
  });
});
