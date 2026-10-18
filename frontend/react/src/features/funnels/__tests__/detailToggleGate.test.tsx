/**
 * `FunnelDetailPage` carried the SAME dead-branch defect as its list page, twice.
 *
 * The page did `const enabled = useFeatureAccess('funnels')` and then tested
 * `if (!enabled)`. `useFeatureAccess` returns an OBJECT, so that is never true:
 * the "not enabled" card was unreachable and the funnel editor — steps, routing
 * rules, delete — rendered regardless of the toggle.
 *
 * The second instance is the one that makes this more than cosmetic. The org
 * resolver's guard was written the same way:
 *
 *     useEffect(() => { if (!enabled || orgId) return; void listOrgs()… })
 *
 * so a disabled feature still went to the network on mount, and with a `?org=`
 * in the URL the funnel read followed. A card drawn over a page that still
 * fetches is the same defect wearing a different coat, which is why the READS
 * are asserted here and not only the copy.
 *
 * The destructive-control check queries the Delete button by its REAL accessible
 * name ("Delete", `common:delete`); the positive control finds that same button on
 * an enabled page, so the absence assertion is proven able to see it. (Before wave
 * 52 it queried "Delete funnel", a name that exists nowhere in src/, so it could
 * never fail.)
 *
 * Sabotage-witnessed (wave 52): rendering past the not-enabled card, reading orgs
 * with the toggle off, dropping the effect's toggle check, and dropping the loading
 * branch each turn a case red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type * as FC from '../funnelsClient.js';
import type { Funnel, FunnelStats } from '../funnelsClient.js';
import type * as CC from '../../cms/cmsClient.js';

const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn(() => makeFeatureAccess({ enabled: true, loading: false })) }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: access.useFeatureAccess }));

const api = vi.hoisted(() => ({
  listOrgs: vi.fn<typeof FC.listOrgs>(),
  getFunnel: vi.fn<typeof FC.getFunnel>(),
  // COMPLETE fixture. A partial one throws inside render (`stats.days.length`)
  // and every assertion then fails for a reason unrelated to the toggle.
  getFunnelStats: vi.fn<typeof FC.getFunnelStats>(async (): Promise<FunnelStats> => ({ funnelId: 'f1', steps: [], days: [], eventWindow: 30, rebuiltAt: null })),
  deleteFunnel: vi.fn<typeof FC.deleteFunnel>(),
  updateFunnel: vi.fn<typeof FC.updateFunnel>(),
}));
vi.mock('../funnelsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});
const cms = vi.hoisted(() => ({ listPages: vi.fn<typeof CC.listPages>(async () => []) }));
vi.mock('../../cms/cmsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...cms };
});

import { FunnelDetailPage } from '../FunnelDetailPage.js';

const FUNNEL: Funnel = {
  funnelId: 'f1', orgId: 'o1', name: 'Summer launch', slug: 'summer-launch',
  status: 'draft', steps: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

/** Mounted at its REAL route so `useParams`/`useSearchParams` behave as they do live. */
const view = (search = ''): void => {
  render(
    <MemoryRouter initialEntries={[`/funnels/f1${search}`]}>
      <Routes><Route path="/funnels/:funnelId" element={<FunnelDetailPage />} /></Routes>
    </MemoryRouter>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` does NOT drop a `mockReturnValue`, so the toggle is re-pinned
  // per test rather than left to whatever the previous one set.
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
  api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
  api.getFunnel.mockResolvedValue(FUNNEL);
});
afterEach(cleanup);

describe('funnel detail — the feature toggle gates the page', () => {
  it('toggle OFF renders the not-enabled card and reads nothing', async () => {
    access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: false, loading: false }));
    view();
    expect(await screen.findByText('Funnels are not enabled')).toBeTruthy();
    expect(screen.getByText('Ask an administrator to turn on the Funnels feature in Admin → Feature toggles.')).toBeTruthy();
    expect(api.listOrgs).not.toHaveBeenCalled();
    expect(api.getFunnel).not.toHaveBeenCalled();
    // The editor's destructive control must not be on a disabled feature's page.
    // Its real name is "Delete" — the positive control below finds it.
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('toggle OFF with `?org=` in the URL still reads nothing — the effect guard, not just the render', async () => {
    // The sharper case: `?org=` skips the org resolver entirely, so the render
    // branch alone would not stop the FUNNEL read. This is the assertion that
    // fails if only the visible branch is fixed.
    access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: false, loading: false }));
    view('?org=o1');
    expect(await screen.findByText('Funnels are not enabled')).toBeTruthy();
    expect(api.getFunnel).not.toHaveBeenCalled();
    expect(cms.listPages).not.toHaveBeenCalled();
  });

  it('toggle UNRESOLVED is a skeleton under the real header — not a terminal card', async () => {
    // A title-only `StateCard` reads as an answer about a question nobody has
    // answered yet. Loading may only say it is loading (DESIGN.md §4.6).
    access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: false, loading: true }));
    view();
    await waitFor(() => expect(document.querySelector('.skeleton')).toBeTruthy());
    // The header survives — the whole point of not using a title-only card.
    expect(screen.getByText('← Back to Funnels')).toBeTruthy();
    expect(screen.queryByText('Funnels are not enabled')).toBeNull();
    expect(api.listOrgs).not.toHaveBeenCalled();
  });

  it('positive control: toggle ON resolves the workspace and loads the funnel', async () => {
    // Without this the assertions above would also pass if the page were broken
    // for everyone — a different bug wearing the same green.
    view();
    await waitFor(() => expect(api.getFunnel).toHaveBeenCalledWith('o1', 'f1'));
    // The same query the toggle-OFF case asserts absent finds the editor's Delete here.
    expect(await screen.findByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(screen.queryByText('Funnels are not enabled')).toBeNull();
  });
});
