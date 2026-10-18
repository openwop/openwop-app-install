/**
 * Territories — a failed org read must not be rendered as "No organizations".
 *
 * `TerritoriesPage` consumes `ui/useOrgSelection`'s `orgsFailed` correctly, but
 * nothing failed when the seam itself was sabotaged (`setOrgsFailed(true)` →
 * `setOrgs([])`): the page silently swapped its honest failure card for the
 * "Create an organization first" instruction, and the
 * suite stayed green. This file is the guard that measurement said was missing.
 *
 * It renders the REAL `TerritoriesPage` and forces the failure through the REAL
 * client function the page calls (`territoriesClient.listOrgs`, itself a
 * re-export of `crm/crmOrgClient.listOrgs`) — never the hook, never a replica.
 *
 * Both polarities, because an "absent" assertion alone is vacuous — a broken
 * render would satisfy it:
 *   - read FAILS  → the announced, retryable failure card; NEVER "No organizations"
 *   - read SUCCEEDS but is genuinely empty → the real "No organizations" survives
 *   - positive control → with an organization the page renders AND reads
 *
 * HG-4 — the three states now come from `ui/OrgSelectionState`, so the copy
 * asserted here is the SHARED sentence plus this feature's own clause. The page
 * had the branch order INVERTED before the migration (the skeleton was checked
 * ABOVE the zero-org branch), so the zero-org case pins that a successful "none"
 * renders the card and never a skeleton with no terminal condition — and that
 * `listModels` is never called for the territory models of NO organization.
 *
 * Sabotage-witnessed (w52 /grade-tests, w52g2-to-*): the page dropping its
 * `failedBody` clause, the hook turning a failure into `[]`, the workspace mounting
 * without an `orgId`, `OrgSelectionState` skipping its zero-org branch, and the
 * card's retry wired to nothing each turn a case red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type TerrApi = typeof import('../territoriesClient.js');
const api = vi.hoisted(() => ({
  listOrgs: vi.fn<TerrApi['listOrgs']>(),
  listModels: vi.fn<TerrApi['listModels']>(),
}));
vi.mock('../territoriesClient.js', async (importOriginal) => {
  const orig = await importOriginal<TerrApi>();
  return { ...orig, ...api };
});

import { TerritoriesPage } from '../TerritoriesPage.js';

beforeEach(() => {
  // reset (not clear): no queued `...Once` value may leak into the next case.
  api.listOrgs.mockReset();
  api.listModels.mockReset();
  api.listModels.mockResolvedValue({ models: [], activeModelId: null });
});
afterEach(cleanup);

const view = (): void => { render(<MemoryRouter><TerritoriesPage /></MemoryRouter>); };

describe('territories — failed org read is not an empty account', () => {
  it('read FAILS: the honest, retryable card — and NEVER "No organizations"', async () => {
    api.listOrgs.mockRejectedValueOnce(new Error('boom')).mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
    view();
    await waitFor(() => expect(screen.getByText('Could not load your organizations')).toBeTruthy());
    // EXACT: a fragment regex would match the old per-feature sentence too.
    expect(screen.getByText(
      'The territory models were never requested. This is a failed read, not an empty organization list.',
    )).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // The false claim must be absent — title AND its clause.
    expect(screen.queryByText('No organizations')).toBeNull();
    expect(screen.queryByText('Sales territories belong to an organization.')).toBeNull();
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    expect(document.querySelector('.skeleton')).toBeNull();
    expect(api.listModels).not.toHaveBeenCalled();
    // RETRYABLE, not just a button: the retry re-runs the org read and the
    // workspace then reads for the org it loaded — and for no other.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.listModels).toHaveBeenCalledWith('o1'));
    expect(api.listOrgs).toHaveBeenCalledTimes(2);
    expect(api.listModels.mock.calls).toEqual([['o1']]);
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
  });

  it('read SUCCEEDS with []: the zero-organization card, never an endless skeleton', async () => {
    api.listOrgs.mockResolvedValue([]);
    view();
    await waitFor(() => expect(screen.getByText('No organizations')).toBeTruthy());
    expect(screen.getByText('Sales territories belong to an organization.')).toBeTruthy();
    // …and no failure disclosure, because nothing failed.
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    expect(document.querySelector('.skeleton')).toBeNull();
    // The workspace must not mount against an empty `orgId` and ask for the
    // territory models of no organization.
    expect(api.listModels).not.toHaveBeenCalled();
  });

  it('positive control: with an organization the workspace renders AND reads', async () => {
    // Without this, both absences above would hold on a page that rendered
    // nothing at all and never read anything.
    api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
    view();
    await waitFor(() => expect(api.listModels).toHaveBeenCalledWith('o1'));
    expect(screen.getByText('Models')).toBeTruthy();
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
    expect(screen.queryByText('No organizations')).toBeNull();
  });
});
