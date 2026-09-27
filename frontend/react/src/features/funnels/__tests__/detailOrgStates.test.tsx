/**
 * `FunnelDetailPage` shipped the `HG-1` defect the same commit range claims to
 * have closed on nine surfaces — in a file those commits edited.
 *
 * It did not import `useOrgSelection`. It hand-rolled the read, kept its own
 * `orgsFailed` flag, and had NO zero-organization branch at all. So with zero
 * organizations the successful read answered `[]`, `orgId` stayed `''`,
 * `reload()` returned on its `if (!orgId)` guard, `funnel` never left `null`,
 * and the render fell through to `if (!funnel)` — a skeleton with no terminal
 * condition. The server had answered "none" and the screen said "loading",
 * forever. Its failure branch offered no retry either, so the one state it DID
 * have was a dead end.
 *
 * Both polarities plus the zero-org case, because an "absent" assertion alone is
 * vacuous — a page broken for everyone would satisfy it. The copy asserted is
 * the SHARED copy (`ui/OrgSelectionState`), in full: a regex spanning both nouns
 * would be indifferent to the drift the shared component exists to end.
 *
 * The falsifiable half of each case is the READ, not the copy. `getFunnel` must
 * never be called without an organization — that is the mechanism that made the
 * skeleton permanent, and it is what a copy-only test would miss.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn(() => makeFeatureAccess({ enabled: true, loading: false })) }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: access.useFeatureAccess }));

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(),
  getFunnel: vi.fn(),
  // COMPLETE fixture — a partial one throws inside render (`stats.days.length`)
  // and every assertion then fails for a reason unrelated to the org states.
  getFunnelStats: vi.fn(async () => ({ funnelId: 'f1', steps: [], days: [], eventWindow: 30, rebuiltAt: null })),
  deleteFunnel: vi.fn(),
  updateFunnel: vi.fn(),
}));
vi.mock('../funnelsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});
const cms = vi.hoisted(() => ({ listPages: vi.fn(async () => []) }));
vi.mock('../../cms/cmsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...cms };
});

import { FunnelDetailPage } from '../FunnelDetailPage.js';

const FUNNEL = {
  funnelId: 'f1', orgId: 'o1', name: 'Summer launch', slug: 'summer-launch',
  status: 'draft' as const, steps: [],
};

/** Mounted at its REAL route so `useParams`/`useSearchParams` behave as they do live. */
const view = (search = ''): void => {
  render(
    <MemoryRouter initialEntries={[`/funnels/f1${search}`]}>
      <Routes><Route path="/funnels/:funnelId" element={<FunnelDetailPage />} /></Routes>
    </MemoryRouter>,
  );
};

const FAILED_BODY = 'This funnel was never requested. This is a failed read, not an empty organization list.';

beforeEach(() => {
  vi.clearAllMocks();
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
  api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
  api.getFunnel.mockResolvedValue(FUNNEL);
});
afterEach(cleanup);

describe('funnel detail — the three organization states', () => {
  it('read FAILS: an announced, retryable failure — never "No organizations", never a skeleton', async () => {
    api.listOrgs.mockRejectedValue(new Error('503'));
    view();
    expect(await screen.findByText('Could not load your organizations')).toBeTruthy();
    // The feature's own clause: what the failure COST, not a second copy of the cause.
    expect(screen.getByText(FAILED_BODY)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // The other two claims must be absent — a failed read may borrow neither meaning.
    expect(screen.queryByText('No organizations')).toBeNull();
    expect(document.querySelector('.skeleton')).toBeNull();
    // THE mechanism. Without an organization the funnel read never starts, which
    // is exactly why the skeleton could never end.
    expect(api.getFunnel).not.toHaveBeenCalled();
    expect(cms.listPages).not.toHaveBeenCalled();
  });

  it('the retry re-runs the organization read — the failure is not a dead end', async () => {
    // The hand-rolled branch this replaces offered no action at all, so the only
    // way out of a transient 503 was a full page reload.
    api.listOrgs.mockRejectedValueOnce(new Error('503')).mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
    view();
    expect(await screen.findByText('Could not load your organizations')).toBeTruthy();
    expect(api.listOrgs).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(api.listOrgs).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(api.getFunnel).toHaveBeenCalledWith('o1', 'f1'));
  });

  it('read SUCCEEDS with []: the zero-organization state, not an endless skeleton (HG-1)', async () => {
    // THE defect. This page had no branch for it: the successful "none" answer
    // fell through to `if (!funnel)` and rendered a skeleton with no terminal
    // condition. DESIGN.md §4.6 — loading may only say it is loading; empty is
    // the state that may instruct.
    api.listOrgs.mockResolvedValue([]);
    view();
    expect(await screen.findByText('No organizations')).toBeTruthy();
    expect(screen.getByText('A funnel belongs to an organization.')).toBeTruthy();
    // Nothing failed, so nothing claims it did.
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
    // The a11y half: the skeleton is a `role="status"` live region labelled
    // "Loading…", so a screen-reader user was told permanently that work was in
    // progress.
    expect(document.querySelector('.skeleton')).toBeNull();
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    expect(api.getFunnel).not.toHaveBeenCalled();
  });

  it('a `?org=` deep link naming an organization that is not in the list lands on the same card', async () => {
    // The case the old code could not reach at all: with `?org=` present it
    // SKIPPED the organization read entirely, so a stale or wrong-tenant link
    // hung on the skeleton with nothing to correct it. The hook honours the deep
    // link OPTIMISTICALLY — one funnel request does go out on the first render,
    // and the server is the authority on whether that org is the caller's — but
    // the read then answers `[]`, `orgId` drops back to '', and the zero-org card
    // wins. Asserting "no request at all" here would be asserting a different
    // design; asserting the terminal state is asserting this one.
    api.listOrgs.mockResolvedValue([]);
    api.getFunnel.mockRejectedValue(new Error('404 Not Found'));
    view('?org=gone');
    expect(await screen.findByText('No organizations')).toBeTruthy();
    expect(screen.getByText('A funnel belongs to an organization.')).toBeTruthy();
    // …and the wrapper sits above the page's own not-found branch, so the
    // wrong-workspace 404 does not get to answer for the missing organization.
    expect(screen.queryByText('This funnel was deleted, or the link points at another workspace.')).toBeNull();
  });

  it('positive control: with an organization the editor loads and neither card shows', async () => {
    // Without this, the four cases above would also pass if the page were broken
    // for everyone — a different bug wearing the same green.
    view();
    await waitFor(() => expect(api.getFunnel).toHaveBeenCalledWith('o1', 'f1'));
    expect(await screen.findByText('Summer launch')).toBeTruthy();
    expect(screen.queryByText('No organizations')).toBeNull();
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
  });

  it('an organization with genuinely no funnel of that id still reads as not-found', async () => {
    // The failure mode of this fix: a real per-funnel state replaced by an org
    // claim, because the wrapper now sits above every branch of this page.
    api.getFunnel.mockRejectedValue(new Error('404 Not Found'));
    // An EXPLICIT `?org=` — with none, the copy correctly switches to the
    // guessed-workspace variant (see the next case), which would test a
    // different branch than this one is about.
    view('?org=o1');
    // `findAll`: the header and the card both name the state, by design.
    expect((await screen.findAllByText('Funnel not found')).length).toBeGreaterThan(0);
    expect(screen.getByText('This funnel was deleted, or the link points at another workspace.')).toBeTruthy();
    expect(screen.queryByText('No organizations')).toBeNull();
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
  });

  it('a link with NO ?org= names the workspace it actually looked in (CCDATA-1)', async () => {
    // Not-found has two very different meanings when the link did not name a
    // workspace: the funnel was deleted, or we looked in the wrong place. The
    // generic copy hedged between them; a multi-org tenant could not tell which
    // had happened, and the recovery differs.
    api.getFunnel.mockRejectedValue(new Error('404 Not Found'));
    view();
    expect((await screen.findAllByText('Funnel not found')).length).toBeGreaterThan(0);
    expect(screen.getByText(/looked in .*Acme.*/)).toBeTruthy();
  });
});
