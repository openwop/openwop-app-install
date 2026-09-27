/**
 * Agent purchases — a FAILED org read must not be rendered as
 * "No organizations".
 *
 * `PurchasesPage` consumes the shared `ui/useOrgSelection` seam correctly, but
 * nothing failed when the seam itself was sabotaged: replacing the hook's
 * `setOrgsFailed(true)` with `setOrgs([])` — the exact idiom the hook exists to
 * kill — left the commerce-ucp-buyer suite green while the page told a buyer
 * whose read 500'd to "Create an organization first". On this
 * surface the claim is about MONEY THAT WAS SPENT: `orgId` stays `''`, the
 * purchases read never starts, and the page reports an absence it never checked.
 * This file drives the REAL page through the REAL `ucpBuyerClient.listOrgs`.
 *
 * Both polarities, because an "absent" assertion alone is vacuous — a page that
 * rendered nothing at all would satisfy it:
 *   - read FAILS   → the honest, retryable failure card; NEVER "No organizations"
 *   - read SUCCEEDS but is genuinely empty → the real "No organizations" survives
 *     and no failure card appears
 *   - positive control → with an organization the page renders AND reads
 *
 * HG-4 — the three states now come from `ui/OrgSelectionState`, so the copy
 * asserted here is the SHARED sentence plus this feature's own clause. The page
 * had the branch order INVERTED before the migration (the skeleton was checked
 * ABOVE the zero-org branch), so the zero-org case pins that a successful "none"
 * renders the card and never a skeleton with no terminal condition.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({ listOrgs: vi.fn(), listPurchases: vi.fn() }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../ucpBuyerClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, status: 'on', isBeta: false, variant: null, loading: false }),
}));

import { PurchasesPage } from '../PurchasesPage.js';

beforeEach(() => {
  vi.clearAllMocks();
  api.listPurchases.mockResolvedValue([]);
});
afterEach(cleanup);

// No `?org=` seed: a deep-linked org must not stand in for a read that failed.
const view = (): void => { render(<MemoryRouter initialEntries={['/commerce/purchases']}><PurchasesPage /></MemoryRouter>); };

describe('agent purchases — a failed org read is not an empty account', () => {
  it('read FAILS: the honest retryable card — and NEVER "No organizations"', async () => {
    api.listOrgs.mockRejectedValue(new Error('orgs_500'));
    view();
    expect(await screen.findByText('Could not load your organizations')).toBeTruthy();
    // EXACT: a fragment regex would match the old per-feature sentence too.
    expect(screen.getByText(
      'The purchase list was never requested. This is a failed read, not an empty organization list.',
    )).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText('No organizations')).toBeNull();
    expect(screen.queryByText('Agent purchases belong to an organization.')).toBeNull();
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    expect(document.querySelector('.skeleton')).toBeNull();
    // The money half: the purchases read never ran, so nothing on screen may
    // report on purchases either way.
    expect(api.listPurchases).not.toHaveBeenCalled();
    expect(screen.queryByText('No agent purchases yet')).toBeNull();
  });

  it('read SUCCEEDS with []: the zero-organization card, never an endless skeleton', async () => {
    api.listOrgs.mockResolvedValue([]);
    view();
    expect(await screen.findByText('No organizations')).toBeTruthy();
    expect(screen.getByText('Agent purchases belong to an organization.')).toBeTruthy();
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    expect(document.querySelector('.skeleton')).toBeNull();
    expect(api.listPurchases).not.toHaveBeenCalled();
  });

  it('positive control: with an organization the page renders AND reads', async () => {
    // Without this, both absences above would hold on a page that rendered
    // nothing at all and never read anything.
    api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
    view();
    await waitFor(() => expect(api.listPurchases).toHaveBeenCalledWith('o1'));
    expect(screen.getByText('No agent purchases yet')).toBeTruthy();
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
    expect(screen.queryByText('No organizations')).toBeNull();
  });
});
