/**
 * ADR 1023 — what the funnel editor tells the person in front of it:
 *  1. A Viewer (no `workspace:write`) is told the page is read-only and is NOT
 *     offered Delete or a live Save (each could only end in a 403); an editor is.
 *  2. A save refused because someone saved first (409 `funnel_changed`, D8) shows
 *     the localized sentence, not the server's English, and reloads the funnel so
 *     the person sees the newer version.
 *  3. Completions no tracked visitor viewed (`unattributed`, D5) are reported as
 *     their own count beside the table, never folded into a rate.
 *
 * Sabotage-witnessed: dropping `!orgAccess.canWrite` from `locked` (1), dropping
 * the `isStaleEdit` reload (2), and removing the unattributed note (3) each turn
 * their case red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type * as FC from '../funnelsClient.js';
import type { Funnel, FunnelStats } from '../funnelsClient.js';
import type * as CC from '../../cms/cmsClient.js';
import type { Page } from '../../cms/cmsClient.js';

const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: access.useFeatureAccess }));

const who = vi.hoisted(() => ({ scopes: ['workspace:read', 'workspace:write'] as string[] }));
vi.mock('../../../client/accessClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, getEffectiveAccess: vi.fn(async () => ({ roles: ['member'], scopes: who.scopes, basis: 'member' as const })) };
});

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('../../../ui/toast.js', () => ({ toast: toasts }));

const EMPTY_STATS: FunnelStats = { funnelId: 'f1', steps: [], days: [], eventWindow: 30, rebuiltAt: null };
const api = vi.hoisted(() => ({
  listOrgs: vi.fn<typeof FC.listOrgs>(),
  getFunnel: vi.fn<typeof FC.getFunnel>(),
  getFunnelStats: vi.fn<typeof FC.getFunnelStats>(),
  deleteFunnel: vi.fn<typeof FC.deleteFunnel>(),
  updateFunnel: vi.fn<typeof FC.updateFunnel>(),
  listFunnels: vi.fn<typeof FC.listFunnels>(),
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
vi.mock('../../custom-domains/domainsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listDomains: vi.fn(async () => []) };
});

vi.mock('../FunnelArchitectPanel.js', () => ({ FunnelArchitectPocket: () => <div data-testid="architect-pocket" /> }));

const { FunnelDetailPage } = await import('../FunnelDetailPage.js');
const { FunnelsError } = await import('../funnelsClient.js');
const { FunnelsPage } = await import('../FunnelsPage.js');

const FUNNEL: Funnel = {
  funnelId: 'f1', orgId: 'o1', name: 'Summer launch', slug: 'summer-launch', status: 'draft',
  steps: [{ stepId: 's1', kind: 'landing', pageId: 'p1', name: 'Welcome' }],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
const LANDING: Page = { pageId: 'p1', title: 'Landing', slug: 'landing', status: 'published', sections: [], version: 1, updatedAt: '2026-01-01T00:00:00.000Z' };

const view = (): void => {
  render(
    <MemoryRouter initialEntries={['/funnels/f1']}>
      <Routes><Route path="/funnels/:funnelId" element={<FunnelDetailPage />} /></Routes>
    </MemoryRouter>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  who.scopes = ['workspace:read', 'workspace:write'];
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
  api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
  api.getFunnel.mockResolvedValue(FUNNEL);
  api.getFunnelStats.mockResolvedValue(EMPTY_STATS);
  api.updateFunnel.mockResolvedValue(FUNNEL);
  cms.listPages.mockResolvedValue([LANDING]);
  api.listFunnels.mockResolvedValue([FUNNEL]);
});
afterEach(cleanup);

describe('ADR 1023 — the funnel editor', () => {
  it('a Viewer is told the page is read-only and gets no Delete and no live Save', async () => {
    who.scopes = ['workspace:read'];
    view();
    expect(await screen.findByText(/funnels are read-only for you/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
    expect((screen.getByRole('button', { name: /save steps/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('an editor gets Delete and a live Save, and no read-only notice (positive control)', async () => {
    view();
    expect(await screen.findByRole('button', { name: /^delete$/i })).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: /save steps/i }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(/funnels are read-only for you/i)).toBeNull();
  });

  it('a save that lost to a newer one says so in words and reloads the newer version', async () => {
    api.updateFunnel.mockRejectedValueOnce(new FunnelsError('This funnel was changed somewhere else after you opened it.', 409, 'funnel_changed'));
    view();
    const save = await screen.findByRole('button', { name: /save steps/i });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    const readsBefore = api.getFunnel.mock.calls.length;
    fireEvent.click(save);
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(String(toasts.error.mock.calls[0]![0])).toMatch(/someone saved this funnel after you opened it/i);
    await waitFor(() => expect(api.getFunnel.mock.calls.length).toBeGreaterThan(readsBefore));
  });

  it('reports unattributed completions as their own count, outside the rates', async () => {
    api.getFunnelStats.mockResolvedValue({
      ...EMPTY_STATS,
      steps: [{ stepId: 's1', kind: 'landing', name: 'Welcome', views: 4, completions: 1, unattributed: 3, revenue: 0, orders: 0, conversion: 0.25 }],
    });
    view();
    expect(await screen.findByText(/3 completions had no tracked view/i)).toBeTruthy();
  });

  it('one unattributed completion reads in the singular (grade-ux FN72UX-12)', async () => {
    api.getFunnelStats.mockResolvedValue({
      ...EMPTY_STATS,
      steps: [{ stepId: 's1', kind: 'landing', name: 'Welcome', views: 4, completions: 1, unattributed: 1, revenue: 0, orders: 0, conversion: 0.25 }],
    });
    view();
    expect(await screen.findByText(/^1 completion had no tracked view/i)).toBeTruthy();
  });

  // grade-ux FN72UX-13 — a REFUSED read is answered with a way out, never a Retry
  // that can only be refused again. Sabotage-witnessed: always rendering Retry
  // turns this red.
  it('a refused read offers the way back, not a Retry', async () => {
    api.getFunnel.mockRejectedValue(new FunnelsError('Missing required scope: workspace:read', 403));
    view();
    expect(await screen.findByText(/you don.t have access to funnels in this workspace/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});

// grade-ux FN72UX-4/-11 — the LIST page: a Viewer gets no add, no lifecycle
// actions and no Funnel Architect (whose every suggestion is a draft write).
// Sabotage-witnessed: dropping `orgAccess.canWrite` from the actions column, or
// from the Architect pocket's condition, turns the first case red.
describe('ADR 1023 — the funnels list', () => {
  const list = (): void => {
    render(<MemoryRouter initialEntries={['/funnels']}><Routes><Route path="/funnels" element={<FunnelsPage />} /></Routes></MemoryRouter>);
  };
  it('a Viewer sees the funnels but no Publish/Archive, a disabled Add, and the read-only notice', async () => {
    who.scopes = ['workspace:read'];
    list();
    expect(await screen.findByRole('link', { name: 'Summer launch' })).toBeTruthy();
    expect(await screen.findByText(/funnels are read-only for you/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^publish$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^archive$/i })).toBeNull();
    expect((screen.getByRole('button', { name: /create funnel/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('architect-pocket')).toBeNull();
  });
  it('an editor gets Publish and Archive (positive control)', async () => {
    list();
    expect(await screen.findByRole('button', { name: /^publish$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^archive$/i })).toBeTruthy();
    expect(screen.getByTestId('architect-pocket')).toBeTruthy();
  });
});
