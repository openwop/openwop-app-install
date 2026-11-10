/**
 * ADR 0949 P4b — the create form: choosing Optimize creates an Optimize
 * experiment with the safe defaults; each kind's help is tied to its radio
 * (ux-review, DESIGN.md §5.1).
 *
 * Sabotage (w76 probes): changing any of the Optimize defaults, the org, the surface
 * or the arm split in the create body reds the first case; dropping either radio's
 * `aria-describedby` reds the second.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { t } from 'i18next';
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

const CREATED: EC.Experiment = {
  experimentId: 'exp:new', orgId: 'o1', name: 'Hero', hypothesis: '', surface: { kind: 'cms.page', ref: 'p1' },
  arms: [{ key: 'control', ref: null, weight: 50 }, { key: 'b', ref: 'v2', weight: 50 }],
  mode: 'optimize', status: 'draft', epochs: [], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
};
const helpOf = (radio: HTMLElement): string | null | undefined => {
  const id = radio.getAttribute('aria-describedby');
  expect(id).toBeTruthy();
  return document.getElementById(id ?? '')?.textContent;
};

beforeEach(() => {
  vi.clearAllMocks();
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
  api.listExperiments.mockResolvedValue([]);
  api.createExperiment.mockResolvedValue(CREATED);
});
afterEach(cleanup);

describe('ADR 0949 P4b — create', () => {
  it('Optimize creates an Optimize experiment with the safe defaults', async () => {
    render(<MemoryRouter><ExperimentsPage /></MemoryRouter>);
    fireEvent.change(await screen.findByLabelText(t('experiments:fieldName')), { target: { value: 'Hero' } });
    fireEvent.click(screen.getByRole('radio', { name: t('experiments:modeOptimize') }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Landing' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText(t('experiments:fieldPage')), { target: { value: 'p1' } });
    await waitFor(() => expect(screen.getByRole('option', { name: /Short hero/ })).toBeTruthy());
    // The variant label also holds its help line, so this one matches by substring.
    fireEvent.change(screen.getByLabelText(t('experiments:fieldVariantVersion'), { exact: false }), { target: { value: 'v2' } });
    fireEvent.click(screen.getByRole('button', { name: t('experiments:create') }));
    await waitFor(() => expect(api.createExperiment).toHaveBeenCalledWith('o1', {
      name: 'Hero',
      surface: { kind: 'cms.page', ref: 'p1' },
      arms: [{ key: 'control', ref: null, weight: 50 }, { key: 'b', ref: 'v2', weight: 50 }],
      mode: 'optimize',
      optimize: { rewardMetric: { kind: 'conversion', name: 'conversion' }, floorPct: 5, epochMinutes: 1440 },
    }));
  });

  it('each kind\'s help is tied to its radio', async () => {
    render(<MemoryRouter><ExperimentsPage /></MemoryRouter>);
    const optimize = await screen.findByRole('radio', { name: t('experiments:modeOptimize') });
    expect(helpOf(optimize)).toBe(t('experiments:modeOptimizeHelp'));
    expect(helpOf(screen.getByRole('radio', { name: t('experiments:modeDecide') }))).toBe(t('experiments:modeDecideHelp'));
  });
});
