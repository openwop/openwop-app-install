/**
 * CMNT-1 / CMNT-UX-1 — the notification deep-link round trip, END TO END, with
 * `CommentsPanel` UNSTUBBED.
 *
 * WHAT WENT WRONG AND WHY NOTHING CAUGHT IT. `CommentsPage`'s seed was
 * `rt === 'kb_collection' ? 'kb_collection' : 'cms_page'`, so four of the six
 * commentable types were coerced to `cms_page`; `loadResources` then replaced the
 * deep-linked id with the org's FIRST CMS page. A reader clicking "View comment"
 * on a chat-message or document reply landed in a STRANGER'S POPULATED THREAD,
 * under a confident picker label, with no error and a live composer.
 *
 * The one pre-existing deep-link test passed `resourceType=cms_page` (never a
 * coerced type) and stubbed the panel, so it pinned only that the panel MOUNTS
 * carrying an id on the FAILURE branch. That is why `HV-3` in
 * `docs/steward/UX_UPGRADE-comments.md` sat checked over a broken round trip.
 *
 * So this file: (a) drives ALL SIX types through a real notification `actionUrl`
 * and asserts the panel fetched THAT (type, id) and rendered THAT thread's body;
 * (b) asserts a deep-linked id is never silently substituted by the org's first
 * resource; (c) asserts an unknown type is NAMED rather than coerced; (d) asserts
 * a SECOND link while already on `/comments` re-seeds the page (CMNT-UX-4).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';

const access = vi.hoisted(() => ({ enabled: true }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: access.enabled, status: 'on', isBeta: false, variant: null, loading: false }),
}));

const api = vi.hoisted(() => ({ listOrgs: vi.fn(), listThread: vi.fn(), postComment: vi.fn(), updateComment: vi.fn(), deleteComment: vi.fn() }));
vi.mock('../commentsClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../commentsClient.js')>();
  return { ...orig, ...api };
});

// ADR 0659 D7 (`CMNT-UX-20`) — the panel resolves the caller's org-scoped write
// access. Mocked here so these cases stay about the read/write lanes they are
// named for: the default is a member who CAN write, which is what the
// assertions below assume. `commentsPanelAccess.test.tsx` drives the other arms.
const orgAccess = vi.hoisted(() => ({ value: { roles: ['editor'], scopes: ['workspace:read', 'workspace:write'], basis: 'member' } as unknown }));
vi.mock('../../../client/useEffectiveAccess.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, useOrgEffectiveAccess: () => orgAccess.value };
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

import { CommentsPage } from '../CommentsPage.js';
import { ALL_RESOURCE_TYPES, type ResourceType } from '../commentsClient.js';

const ORG = { orgId: 'org_1', name: 'Org One' };

/**
 * The notification `actionUrl`, built exactly as the backend emitter builds it
 * (`features/comments/notifications.ts` `threadActionUrl` — a `URLSearchParams`
 * over `{orgId, resourceType, resourceId}`). `commentsNotificationActionUrl.test.ts`
 * on the backend pins that emitter to this same shape, so the two halves of the
 * round trip cannot drift apart silently.
 */
function actionUrl(orgId: string, resourceType: string, resourceId: string): string {
  return `/comments?${new URLSearchParams({ orgId, resourceType, resourceId }).toString()}`;
}

function view(search: string): void {
  render(<MemoryRouter initialEntries={[search]}><CommentsPage /></MemoryRouter>);
}

const comment = (id: string, body: string) => ({
  commentId: id, orgId: ORG.orgId, resourceType: 'cms_page', resourceId: 'x',
  body, authorId: 'user_a', status: 'open', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  access.enabled = true;
  api.listOrgs.mockResolvedValue([ORG]);
  // The org HAS CMS pages — this is the ordinary success path, the one on which
  // the old coercion silently substituted `page_first` for the linked id.
  cms.listPages.mockResolvedValue([{ pageId: 'page_first', title: 'First Page' }, { pageId: 'page_two', title: 'Second Page' }]);
  kb.listCollections.mockResolvedValue([{ collectionId: 'kb_1', name: 'Handbook' }]);
  api.listThread.mockResolvedValue([]);
});
afterEach(cleanup);

describe('CMNT-1 — a notification actionUrl opens the thread it names, for every commentable type', () => {
  // The ids are deliberately shaped like the real ones (composite for the
  // chat/canvas/idea types) so a `#`-splitting regression is visible here.
  const CASES: ReadonlyArray<{ rt: ResourceType; id: string }> = [
    { rt: 'cms_page', id: 'page_two' },
    { rt: 'kb_collection', id: 'kb_1' },
    { rt: 'chat_message', id: 'sess_9#msg_4' },
    { rt: 'canvas_document', id: 'cnv_7#thr_2' },
    { rt: 'priority_idea', id: 'lst_3#card_8' },
    { rt: 'creative_brief', id: 'brief_5' },
  ];

  it('covers every type the backend registers (no type is silently untested)', () => {
    expect(CASES.map((c) => c.rt).sort()).toEqual([...ALL_RESOURCE_TYPES].sort());
  });

  for (const { rt, id } of CASES) {
    it(`${rt}: fetches (${rt}, <linked id>) and renders THAT thread`, async () => {
      api.listThread.mockImplementation(async (_org: string, type: string, resourceId: string) =>
        (type === rt && resourceId === id ? [comment('cmt:right', 'the thread this link names')] : [comment('cmt:wrong', 'a DIFFERENT resource’s thread')]));

      view(actionUrl(ORG.orgId, rt, id));

      // The functional assertion: the CONTENT of the correct thread is on screen.
      expect(await screen.findByText('the thread this link names')).toBeTruthy();
      expect(screen.queryByText('a DIFFERENT resource’s thread')).toBeNull();
      // And the call the panel actually made carried the linked (type, id) —
      // pinned because a coerced type used to still render *a* populated thread.
      expect(api.listThread).toHaveBeenCalledWith(ORG.orgId, rt, id);
    });
  }
});

describe('CMNT-1 — a deep-linked id is never replaced by the org’s first resource', () => {
  it('FAILURE MODE (regression): a linked page id absent from the org list survives and is NAMED', async () => {
    view(actionUrl(ORG.orgId, 'cms_page', 'page_deleted'));
    await waitFor(() => expect(api.listThread).toHaveBeenCalledWith(ORG.orgId, 'cms_page', 'page_deleted'));
    // Never the substitution the old `opts[0]?.id ?? ''` fallback performed.
    expect(api.listThread).not.toHaveBeenCalledWith(ORG.orgId, 'cms_page', 'page_first');
    // CMNT-UX-19 / ADR 0659 D2 — the hedge is now the UNIFORM sentence shared with
    // the panel's gone-state. It no longer promises "showing its thread anyway"
    // (there may be no thread to show) and no longer guesses WHICH of "deleted" /
    // "not yours to see" it was, because the read answers one status for both.
    expect((await screen.findAllByText(/isn’t available to you/i)).length).toBeGreaterThan(0);
  });

  it('CONTROL: with NO deep link, the picker still auto-selects the first resource', async () => {
    view('/comments');
    await waitFor(() => expect(api.listThread).toHaveBeenCalledWith(ORG.orgId, 'cms_page', 'page_first'));
    expect(screen.queryByText(/isn’t available to you/i)).toBeNull();
  });
});

describe('CMNT-1 — an unknown resourceType is named, not substituted', () => {
  it('FAILURE: renders the unsupported-type state and reads NO thread', async () => {
    view(actionUrl(ORG.orgId, 'not_a_type', 'whatever'));
    expect(await screen.findByText(/Unsupported resource type/i)).toBeTruthy();
    expect(api.listThread).not.toHaveBeenCalled();
  });

  it('CONTROL: a valid type does not render the unsupported-type state', async () => {
    view(actionUrl(ORG.orgId, 'kb_collection', 'kb_1'));
    await waitFor(() => expect(api.listThread).toHaveBeenCalledWith(ORG.orgId, 'kb_collection', 'kb_1'));
    expect(screen.queryByText(/Unsupported resource type/i)).toBeNull();
  });
});

describe('CMNT-UX-4 — a SECOND notification while already on /comments re-seeds the page', () => {
  it('following a second in-app link switches the thread', async () => {
    api.listThread.mockImplementation(async (_org: string, type: string, resourceId: string) =>
      [comment('cmt:x', `thread(${type},${resourceId})`)]);

    render(
      <MemoryRouter initialEntries={[actionUrl(ORG.orgId, 'chat_message', 'sess_1#msg_1')]}>
        <Routes>
          <Route path="/comments" element={(
            <>
              {/* The notification panel renders exactly this: a router <Link> to
                  another `/comments?…` address while the reader is already here. */}
              <Link to={actionUrl(ORG.orgId, 'chat_message', 'sess_2#msg_2')}>View comment</Link>
              <CommentsPage />
            </>
          )} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('thread(chat_message,sess_1#msg_1)')).toBeTruthy();
    fireEvent.click(screen.getByText('View comment'));
    // Before the fix the seed was memoized on `[]`, so this stayed on thread 1.
    expect(await screen.findByText('thread(chat_message,sess_2#msg_2)')).toBeTruthy();
    expect(screen.queryByText('thread(chat_message,sess_1#msg_1)')).toBeNull();
  });
});

describe('CMNT-UX-4 — re-clicking the SAME notification re-seeds it too', () => {
  /**
   * The gap the first fix left. Keying the re-seed effect on `location.search`
   * catches a link to a DIFFERENT address and misses a re-click of the same one:
   * land on `?resourceId=page_two`, change the picker to `page_first`, click that
   * same notification again — the search string is byte-identical, the effect
   * early-returns, and the reader stays on `page_first` while the notification
   * claims `page_two`. Same "URL says A, page shows B" shape, different route in.
   *
   * `location.key` is minted fresh on every push, so it discriminates a genuine
   * re-navigation from a re-render.
   */
  it('picker moved away, SAME link re-clicked → returns to the linked resource', async () => {
    api.listThread.mockImplementation(async (_org: string, type: string, resourceId: string) =>
      [comment('cmt:x', `thread(${type},${resourceId})`)]);

    const same = actionUrl(ORG.orgId, 'cms_page', 'page_two');
    render(
      <MemoryRouter initialEntries={[same]}>
        <Routes>
          <Route path="/comments" element={(<><Link to={same}>View comment</Link><CommentsPage /></>)} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('thread(cms_page,page_two)')).toBeTruthy();

    // The reader browses away from the linked resource using the page's own picker.
    fireEvent.change(await screen.findByLabelText('Resource'), { target: { value: 'page_first' } });
    expect(await screen.findByText('thread(cms_page,page_first)')).toBeTruthy();

    // Re-clicking the SAME notification must bring them back.
    fireEvent.click(screen.getByText('View comment'));
    expect(await screen.findByText('thread(cms_page,page_two)')).toBeTruthy();
    expect(screen.queryByText('thread(cms_page,page_first)')).toBeNull();
  });

  it('CONTROL: the picker still wins when the reader is NOT re-navigating', async () => {
    // The risk of keying on `location.key` would be stomping ordinary
    // interaction. Changing the picker does not navigate, so no re-seed fires and
    // the reader's own selection stands.
    api.listThread.mockImplementation(async (_org: string, type: string, resourceId: string) =>
      [comment('cmt:x', `thread(${type},${resourceId})`)]);

    view(actionUrl(ORG.orgId, 'cms_page', 'page_two'));
    expect(await screen.findByText('thread(cms_page,page_two)')).toBeTruthy();
    fireEvent.change(await screen.findByLabelText('Resource'), { target: { value: 'page_first' } });
    expect(await screen.findByText('thread(cms_page,page_first)')).toBeTruthy();
    // Still on the reader's choice after the re-render settles.
    await waitFor(() => expect(screen.queryByText('thread(cms_page,page_two)')).toBeNull());
  });
});

describe('CMNT-1 — the unsupported-type refusal has a way FORWARD', () => {
  /**
   * Every other refusal in this feature offers an exit; this one returned a bare
   * card. A stale or typo'd link (`?resourceType=cms-page`) stranded the reader,
   * and the query string is the very thing holding them there — so "reload" could
   * not help. A gate with no exit is a defect.
   */
  it('offers an action that clears the bad query and lands on a working page', async () => {
    view(actionUrl(ORG.orgId, 'cms-page', 'whatever'));
    expect(await screen.findByText(/Unsupported resource type/i)).toBeTruthy();

    const exit = screen.getByRole('button', { name: /browse comments/i });
    fireEvent.click(exit);

    // The refusal is gone and the ordinary picker flow is running.
    await waitFor(() => expect(api.listThread).toHaveBeenCalledWith(ORG.orgId, 'cms_page', 'page_first'));
    expect(screen.queryByText(/Unsupported resource type/i)).toBeNull();
  });

  it('the body no longer promises a picker that is not rendered', async () => {
    // The copy said "pick a resource below" while nothing was below it.
    view(actionUrl(ORG.orgId, 'cms-page', 'whatever'));
    const body = await screen.findByText(/Nothing was substituted/i);
    expect(body.textContent ?? '').not.toMatch(/below/i);
  });
});
