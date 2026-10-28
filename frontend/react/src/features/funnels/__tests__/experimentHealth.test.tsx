/**
 * ADR 0949 P0 — the funnel step A/B result says when its verdict cannot be
 * trusted: an SRM warning when the split is broken, and the standing
 * fixed-horizon note. The harness mirrors stepRename.test.tsx.
 *
 * Sabotage (run 2026-10-20): dropping the SRM Notice reds the first case;
 * dropping the stop-early line reds both. ADR 0949 P1b adds the coverage
 * notice (retention deleted events from the test's life); dropping it reds the
 * third case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type * as FC from '../funnelsClient.js';
import type { ExperimentResults, Funnel, FunnelStats } from '../funnelsClient.js';
import type * as CC from '../../cms/cmsClient.js';
import type { Page } from '../../cms/cmsClient.js';

const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: access.useFeatureAccess }));

const api = vi.hoisted(() => ({
  listOrgs: vi.fn<typeof FC.listOrgs>(),
  getFunnel: vi.fn<typeof FC.getFunnel>(),
  getFunnelStats: vi.fn<typeof FC.getFunnelStats>(async (): Promise<FunnelStats> => ({ funnelId: 'f1', steps: [], days: [], eventWindow: 30, rebuiltAt: null })),
  deleteFunnel: vi.fn<typeof FC.deleteFunnel>(),
  updateFunnel: vi.fn<typeof FC.updateFunnel>(),
  getExperimentResults: vi.fn<typeof FC.getExperimentResults>(),
}));
vi.mock('../funnelsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});
const cms = vi.hoisted(() => ({ listPages: vi.fn<typeof CC.listPages>() }));
vi.mock('../../cms/cmsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...cms };
});
// ADR 0948 P6a — the page reads the org's custom domains for the primary-domain
// picker; none here (the section then stays hidden).
vi.mock('../../custom-domains/domainsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listDomains: vi.fn(async () => []) };
});

const { FunnelDetailPage } = await import('../FunnelDetailPage.js');

const FUNNEL: Funnel = {
  funnelId: 'f1', orgId: 'o1', name: 'Summer launch', slug: 'summer-launch',
  status: 'draft',
  steps: [
    { stepId: 's1', kind: 'landing', pageId: 'p1', name: 'Warm welcome', experiment: { experimentId: 'x1', status: 'running', createdAt: '2026-01-01T00:00:00.000Z', variants: [{ key: 'control', pageId: null, weight: 50 }, { key: 'b', pageId: 'p1', weight: 50 }] } },
    { stepId: 's2', kind: 'thankyou', pageId: 'p1' },
  ],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
const LANDING: Page = {
  pageId: 'p1', title: 'Landing', slug: 'landing', status: 'published', sections: [],
  version: 1, updatedAt: '2026-01-01T00:00:00.000Z',
};

const view = (): void => {
  render(
    <MemoryRouter initialEntries={['/funnels/f1']}>
      <Routes><Route path="/funnels/:funnelId" element={<FunnelDetailPage />} /></Routes>
    </MemoryRouter>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
  api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
  api.getFunnel.mockResolvedValue(FUNNEL);
  api.updateFunnel.mockResolvedValue(FUNNEL);
  cms.listPages.mockResolvedValue([LANDING]);
});
afterEach(cleanup);

const RESULT = (over: Partial<ExperimentResults>): ExperimentResults => ({
  experimentId: 'x1', status: 'running', baselineKey: 'control', minSessionsPerVariant: 30,
  variants: [
    { key: 'control', pageId: null, weight: 50, sessions: 300, conversions: 30, conversionRate: 0.1, zScore: null, significant: null, insufficientSample: false },
    { key: 'b', pageId: 'p1', weight: 50, sessions: 100, conversions: 40, conversionRate: 0.4, zScore: 6, significant: null, insufficientSample: false },
  ],
  health: { srm: { chiSquare: 100, pValue: 1e-23, mismatch: true, alpha: 0.001 }, stopEarly: 'fixed_horizon_do_not_stop_early' },
  ...over,
});

async function pickStep(): Promise<void> {
  view();
  const select = await screen.findByLabelText(/^Step$/);
  fireEvent.change(select, { target: { value: 's1' } });
  await waitFor(() => expect(api.getExperimentResults).toHaveBeenCalled());
}

describe('ADR 0949 P0 — funnel step result honesty', () => {
  it('a broken split shows the SRM warning and the stop-early note', async () => {
    api.getExperimentResults.mockResolvedValue(RESULT({ significanceWithheld: 'srm' }));
    await pickStep();
    expect(await screen.findByText(/does not match the weights you set/)).toBeTruthy();
    expect(screen.getByText(/assumes you read it once, at the end/)).toBeTruthy();
  });
  it('a healthy split shows only the stop-early note', async () => {
    api.getExperimentResults.mockResolvedValue(RESULT({ health: { srm: { chiSquare: 0, pValue: 1, mismatch: false, alpha: 0.001 }, stopEarly: 'fixed_horizon_do_not_stop_early' } }));
    await pickStep();
    expect(await screen.findByText(/assumes you read it once, at the end/)).toBeTruthy();
    expect(screen.queryByText(/does not match the weights you set/)).toBeNull();
    expect(screen.queryByText(/data retention policy/)).toBeNull();
  });
  it('a result whose events were partly purged shows the coverage warning, not the SRM one', async () => {
    api.getExperimentResults.mockResolvedValue(RESULT({
      health: { srm: { chiSquare: 0, pValue: 1, mismatch: false, alpha: 0.001 }, stopEarly: 'fixed_horizon_do_not_stop_early' },
      significanceWithheld: 'coverage', coverage: { status: 'partial', retainedSince: '2026-09-01T00:00:00.000Z', rebuiltAt: '2026-10-20T00:00:00.000Z' },
    }));
    await pickStep();
    expect(await screen.findByText(/data retention policy/)).toBeTruthy();
    expect(screen.queryByText(/does not match the weights you set/)).toBeNull();
  });
});
