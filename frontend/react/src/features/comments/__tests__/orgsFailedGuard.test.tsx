/**
 * Comments — a FAILED workspace read must not be rendered as "No organizations".
 *
 * `commentsFailedReads.test.tsx` deliberately DROPPED its UX-CMT-1 org case when
 * the page moved to the shared `ui/useOrgSelection` hook, on the reasoning that
 * the hook owns its own coverage. Sabotaging the seam proved the gap that left:
 * replacing the hook's `setOrgsFailed(true)` with `setOrgs([])` — the exact idiom
 * the hook exists to kill — leaves the whole comments suite green while the page
 * tells a user whose read 500'd to "Create an organization first". A hook unit
 * test cannot see that; only rendering the REAL page against the REAL
 * `commentsClient.listOrgs` can.
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
 * renders the card and never a skeleton: the resource read is org-gated, so
 * nothing would ever come back to end it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, status: 'on', isBeta: false, variant: null, loading: false }),
}));

const api = vi.hoisted(() => ({ listOrgs: vi.fn() }));
vi.mock('../commentsClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../commentsClient.js')>();
  return { ...orig, listOrgs: api.listOrgs };
});

const cms = vi.hoisted(() => ({ listPages: vi.fn() }));
vi.mock('../../cms/cmsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listPages: cms.listPages };
});
const kb = vi.hoisted(() => ({ listCollections: vi.fn() }));
vi.mock('../../kb/kbClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listCollections: kb.listCollections };
});
// The thread panel does its own fetch; stub it so this file stays about the page.
vi.mock('../CommentsPanel.js', () => ({
  CommentsPanel: ({ resourceId }: { resourceId: string }) => <div data-testid="thread">thread:{resourceId}</div>,
}));

import { CommentsPage } from '../CommentsPage.js';

beforeEach(() => {
  vi.clearAllMocks();
  // No deep-link params: the seed org must not stand in for a read that failed.
  window.history.replaceState({}, '', '/comments');
  cms.listPages.mockResolvedValue([]);
  kb.listCollections.mockResolvedValue([]);
});
afterEach(cleanup);

const view = (): void => { render(<MemoryRouter initialEntries={['/comments']}><CommentsPage /></MemoryRouter>); };

describe('comments — a failed workspace read is not an empty account', () => {
  it('read FAILS: the honest retryable card — and NEVER "No organizations"', async () => {
    api.listOrgs.mockRejectedValue(new Error('orgs_500'));
    view();
    expect(await screen.findByText('Could not load your organizations')).toBeTruthy();
    // EXACT: a fragment regex would match the old per-feature sentence too.
    expect(screen.getByText(
      'The resource list was never requested. This is a failed read, not an empty organization list.',
    )).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText('No organizations')).toBeNull();
    expect(screen.queryByText('Comments belong to an organization’s resources.')).toBeNull();
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    expect(document.querySelector('.skeleton')).toBeNull();
    expect(cms.listPages).not.toHaveBeenCalled();
    expect(kb.listCollections).not.toHaveBeenCalled();
  });

  it('read SUCCEEDS with []: the zero-organization card, never an endless skeleton', async () => {
    api.listOrgs.mockResolvedValue([]);
    view();
    expect(await screen.findByText('No organizations')).toBeTruthy();
    expect(screen.getByText('Comments belong to an organization’s resources.')).toBeTruthy();
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    expect(document.querySelector('.skeleton')).toBeNull();
    expect(cms.listPages).not.toHaveBeenCalled();
    expect(kb.listCollections).not.toHaveBeenCalled();
  });

  it('positive control: with an organization the page renders AND reads', async () => {
    // Without this, both absences above would hold on a page that rendered
    // nothing at all and never read anything.
    api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
    cms.listPages.mockResolvedValue([{ pageId: 'p1', title: 'Launch note' }]);
    view();
    expect(await screen.findByTestId('thread')).toBeTruthy();
    expect(cms.listPages).toHaveBeenCalledWith('o1');
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
    expect(screen.queryByText('No organizations')).toBeNull();
  });
});
