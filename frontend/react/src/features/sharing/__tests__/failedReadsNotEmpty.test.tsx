/**
 * Two reads, two failures, two different lies — on the page that mints PUBLIC
 * share links.
 *
 *  1. A failed WORKSPACE read rendered "No organizations — create an
 *     organization first" and left `orgId` '', so the link list never loaded.
 *
 *  2. A failed RESOURCE read left the picker holding only its placeholder, with
 *     Create `disabled={!resourceId}`. The form LOOKS operable, cannot be
 *     submitted, and says nothing about why — the resource list is a WRITE INPUT,
 *     so its failure has to be visible or the page is just inert.
 *
 * Checked and NOT a finding, recorded so nobody re-files it: `setResourceId('')`
 * when the org or type changes is correct here. It looks like the deep-link
 * stranding `-1` found in `CommentsPage`, but this page's `resourceId` is
 * `useState('')` and user-selected only — there is no `?resourceId=` link to
 * strand. A pattern-match is not a check.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

const { listOrgs, listLinks, listResources } = vi.hoisted(() => ({
  listOrgs: vi.fn(), listLinks: vi.fn(), listResources: vi.fn(),
}));
vi.mock('../sharingClient.js', async (orig) => ({
  ...(await orig<typeof import('../sharingClient.js')>()),
  listOrgs, listLinks, listResources,
}));

import { SharingPage } from '../SharingPage.js';

const ORG = { orgId: 'o1', name: 'Acme' };
const RESOURCE = { id: 'r1', label: 'Q3 deck' };

const mount = async (): Promise<void> => {
  render(<SharingPage />);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  listOrgs.mockResolvedValue([ORG]);
  listLinks.mockResolvedValue([]);
  listResources.mockResolvedValue([RESOURCE]);
});

/**
 * HG-4 — the three org states now come from `ui/OrgSelectionState`, so the copy
 * asserted here is the SHARED sentence plus this feature's own clause. Before
 * the migration this page had the branch order INVERTED (the skeleton was
 * checked ABOVE the zero-org branch), so the zero-org case pins that a
 * successful "none" renders the card and never a skeleton with no terminal
 * condition — the link read is org-gated, so it never starts to end it.
 */
describe('a failed workspace read is not "no organizations"', () => {
  it('does not tell the operator to create one', async () => {
    listOrgs.mockRejectedValue(new Error('503'));
    await mount();
    expect(screen.getByText('Could not load your organizations')).toBeTruthy();
    // EXACT: a fragment regex would match the old per-feature sentence too.
    expect(screen.getByText(
      'The share links were never requested. This is a failed read, not an empty organization list.',
    )).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // Never the zero-org claim, and never a skeleton in its place.
    expect(screen.queryByText('No organizations')).toBeNull();
    expect(screen.queryByText('Share links belong to an organization.')).toBeNull();
    expect(document.querySelector('.skeleton')).toBeNull();
    expect(listLinks).not.toHaveBeenCalled();
  });

  it('the retry re-runs it', async () => {
    listOrgs.mockRejectedValueOnce(new Error('503')).mockResolvedValue([ORG]);
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(listOrgs).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('Could not load your organizations');
  });

  it('a tenant that genuinely has none gets the zero-organization card, not a skeleton', async () => {
    listOrgs.mockResolvedValue([]);
    await mount();
    expect(screen.getByText('No organizations')).toBeTruthy();
    expect(screen.getByText('Share links belong to an organization.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Could not load your organizations');
    expect(document.querySelector('.skeleton')).toBeNull();
    expect(listLinks).not.toHaveBeenCalled();
  });

  it('positive control: with an organization the page renders AND reads', async () => {
    // Without this, both absences above would hold on a page that rendered
    // nothing at all.
    await mount();
    expect(listLinks).toHaveBeenCalledWith('o1');
    expect(screen.getByText('Active links')).toBeTruthy();
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
    expect(screen.queryByText('No organizations')).toBeNull();
  });
});

describe('a failed resource read does not leave a silently inert form', () => {
  it('says the resource list could not be read', async () => {
    listResources.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.body.textContent).toContain('Could not load resources');
  });

  it('says nothing when the resources load', async () => {
    // The failure mode of this fix: warning on every healthy page load.
    await mount();
    expect(document.body.textContent).not.toContain('Could not load resources');
    expect(document.body.textContent).toContain('Q3 deck');
  });
});
