/**
 * UX_UPGRADE-comments P1 — this page's empty states make FACTUAL CLAIMS about the
 * org ("No organizations", "No CMS pages in this org"), so feeding a rejected read
 * into them doesn't just look wrong, it asserts something false.
 *
 * UX-CMT-1: `listOrgs()` rejecting did `setOrgs([])` → "Create an organization
 * first" — the same shape already fixed in `/documents` and, before that, found by
 * peer session openwop-app-2 in `production`.
 *
 * UX-CMT-2 is the worse one and is FUNCTIONAL, not cosmetic. A failed
 * `listPages()`/`listCollections()` did `setResources([]); setResourceId('')`,
 * which (a) claimed the org had no pages, and (b) DISCARDED the deep-linked
 * resourceId. The notification actionUrl lands on this page with `?resourceId=`,
 * and `CommentsPanel` fetches its thread by that id independently of this picker —
 * so clearing it stranded a user who arrived from a notification on a screen
 * telling them their org was empty. Keeping the id keeps the thread reachable.
 *
 * Every describe carries BOTH arms — the failure renders the failure AND a real
 * empty answer still renders the real empty state — because a one-armed suite lets
 * the fix rot into "always show the error" while staying green.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const access = vi.hoisted(() => ({ enabled: true }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: access.enabled, status: 'on', isBeta: false, variant: null, loading: false }),
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

// The thread panel does its own fetch; stub it so these tests stay about the page.
vi.mock('../CommentsPanel.js', () => ({
  CommentsPanel: ({ resourceId }: { resourceId: string }) => <div data-testid="thread">thread:{resourceId}</div>,
}));

import { CommentsPage } from '../CommentsPage.js';

const ORG = { orgId: 'org_1', name: 'Org One' };

function view(search = ''): void {
  window.history.replaceState({}, '', `/comments${search}`);
  render(<MemoryRouter initialEntries={[`/comments${search}`]}><CommentsPage /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  access.enabled = true;
  api.listOrgs.mockResolvedValue([ORG]);
  cms.listPages.mockResolvedValue([{ pageId: 'p1', title: 'Page One' }]);
  kb.listCollections.mockResolvedValue([]);
});
afterEach(cleanup);

/*
 * UX-CMT-1 (the failed-orgs read) was REMOVED from this file: `origin/main`
 * replaced the per-page orgs state with a shared `useOrgSelection` hook that
 * fixes the class once for every page, and owns its own copy + coverage. My
 * page-level duplicate asserted my old wording and is not worth re-pointing at
 * theirs — testing their hook from here would just be a second, weaker copy.
 * What remains below is UX-CMT-2, which the shared hook does not cover.
 */
describe('UX-CMT-2 — a failed resource read never claims the org is empty', () => {
  it('FAILURE: says the list may be incomplete, NOT "No CMS pages in this org"', async () => {
    cms.listPages.mockRejectedValue(new Error('pages_500'));
    view();
    expect(await screen.findByText(/list may be incomplete/i)).toBeTruthy();
    expect(screen.queryByText(/No CMS pages in this org/i)).toBeNull();
  });

  it('EMPTY: an org that genuinely has no pages still says so', async () => {
    cms.listPages.mockResolvedValue([]);
    view();
    expect(await screen.findByText(/No CMS pages in this org/i)).toBeTruthy();
    expect(screen.queryByText(/list may be incomplete/i)).toBeNull();
  });

  it('FAILURE + deep link: the linked resourceId SURVIVES so the thread stays reachable', async () => {
    // The functional half. Before the fix this rendered an empty picker and no
    // thread — a notification link landed the user nowhere.
    cms.listPages.mockRejectedValue(new Error('pages_500'));
    view('?orgId=org_1&resourceType=cms_page&resourceId=page_from_notification');
    expect(await screen.findByTestId('thread')).toBeTruthy();
    expect(screen.getByTestId('thread').textContent).toContain('page_from_notification');
  });

  /*
   * The tripwire for the `noticeSweepTranche` exemption (CMNT-1, 2026-08-19).
   *
   * That sweep allows this page TWO `announce`d Notices, on the stated ground
   * that `resourcesFailed` and `linkedResourceMissing` are mutually exclusive
   * BY CONSTRUCTION — `linkedMissing`'s predicate carries `&& !resourcesFailed`
   * (`CommentsPage.tsx:200-202`). `announce()` has a single polite slot, so if
   * both could render, the second would REPLACE the first and the page would
   * announce less, unpredictably.
   *
   * MEASURED: deleting that guard left all 51 comments + sweep tests green. The
   * exemption's justification was a promise with no mechanism — the class this
   * repo keeps re-finding. This test is the mechanism: it fails the moment the
   * guard goes, so the exemption cannot outlive the fact it rests on.
   *
   * It also asserts the substantive bug: reporting "this org does not have that
   * resource" when the LIST READ FAILED is a false diagnosis about the org.
   */
  it('FAILURE + deep link: does NOT also claim the linked resource is missing (single polite slot)', async () => {
    cms.listPages.mockRejectedValue(new Error('pages_500'));
    view('?orgId=org_1&resourceType=cms_page&resourceId=page_from_notification');
    // The read-failure disclosure is the one that renders and announces.
    expect(await screen.findByText(/list may be incomplete/i)).toBeTruthy();
    // The missing-link disclosure must NOT: the list failed, so we do not know
    // whether the org has this resource, and claiming it does not is a lie.
    expect(screen.queryByText(/no longer in this org|not in this org|resource.*missing/i)).toBeNull();
  });
});
