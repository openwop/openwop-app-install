/**
 * UX_UPGRADE-environments `HV-4`, converted from prose into a ratchet.
 *
 * The tracker recorded this as a human-verify item — "stop the backend, load
 * /environments, expect 'Could not load your environments'". That was the wrong
 * call. It is the regression surface for a defect class this repo has now fixed
 * roughly twenty times, and prose in a markdown file does not survive a
 * refactor: a shared `useOrgSelection` hook already landed once and silently
 * changed which pages were covered.
 *
 * What makes THIS page the sharpest instance of the class is that its empty
 * state is not merely instructive, it is a WRITE. `emptyTitle` reads "Set up
 * your environment chain" over a button that creates a dev → staging → prod
 * chain. Rendering it on a failed read offers a mutation on the strength of an
 * answer the server never gave — and asserts "you have no environments" to a
 * workspace that may well have three.
 *
 * `EnvironmentsPage.tsx:186` states that guarantee in a comment ("Do NOT fall
 * back to `[]`"), and `:401` restates it at the render. Peer session
 * openwop-app-3's rule is that a comment asserting a user-visible guarantee is
 * a test case; this file is that test case.
 *
 * BOTH ARMS, ALWAYS. Every describe pins the failure AND the genuinely-empty
 * answer. Without the second arm the fix degrades into "always show the error"
 * and the suite stays green while the empty state becomes unreachable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GlobalLiveRegion } from '../../../ui/announce.js';

const access = vi.hoisted(() => ({ enabled: true }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: access.enabled, status: 'on', isBeta: false, variant: null, loading: false }),
}));

const api = vi.hoisted(() => ({
  listEnvironments: vi.fn(),
  listSnapshots: vi.fn(),
  listPromotions: vi.fn(),
  ensureChain: vi.fn(),
}));
vi.mock('../environmentsClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../environmentsClient.js')>();
  return { ...orig, ...api };
});

import { EnvironmentsPage } from '../EnvironmentsPage.js';
import { messages as en } from '../i18n/en.js';

function view(): void {
  // The REAL ADR 0363 live region, exactly as App.tsx mounts it. Rendering it
  // here is what makes the announcement assertions below test behaviour rather
  // than markup — the region must pre-exist the message, which is the entire
  // reason StateCard delegates to it instead of rendering its own.
  render(
    <MemoryRouter initialEntries={['/environments']}>
      <GlobalLiveRegion />
      <div data-testid="page"><EnvironmentsPage /></div>
    </MemoryRouter>,
  );
}

/**
 * Page-scoped queries. Once the failure title is ALSO pushed into the live
 * region, a bare `screen.findByText(title)` matches twice — so every page
 * assertion scopes to the page subtree, and the announcement assertions look at
 * the region. Keeping them separate is the point: one proves what is rendered,
 * the other proves what is spoken.
 */
function page(): ReturnType<typeof within> {
  return within(screen.getByTestId('page'));
}

/** The polite half of the app-shell live region. */
function politeRegion(): HTMLElement {
  const el = document.querySelector('[aria-live="polite"]');
  if (!el) throw new Error('GlobalLiveRegion polite node missing — the harness is wrong, not the code');
  return el as HTMLElement;
}

const ENV = {
  environmentId: 'env_1',
  name: 'dev',
  order: 0,
  protection: 'open' as const,
  currentSnapshot: 'abc123def456789',
  drift: { drifted: false },
};

beforeEach(() => {
  vi.clearAllMocks();
  access.enabled = true;
  api.listEnvironments.mockResolvedValue({ environments: [], appVersion: null, domains: [] });
  api.listSnapshots.mockResolvedValue([]);
  api.listPromotions.mockResolvedValue([]);
});
afterEach(cleanup);

describe('HV-4 — an unreachable environments endpoint never offers to create a chain', () => {
  it('FAILURE: says the read failed, and offers RETRY rather than a write', async () => {
    api.listEnvironments.mockRejectedValue(new Error('environments_500'));
    view();

    expect(await page().findByText(en.loadFailedTitle)).toBeTruthy();
    // The server's own words survive to the user — a bare "something went wrong"
    // gives an operator nothing to act on.
    expect(screen.getByText(new RegExp('environments_500'))).toBeTruthy();
    expect(screen.getByRole('button', { name: en.retry })).toBeTruthy();

    // The claim a failed read cannot make, and the write it must not offer.
    expect(screen.queryByText(en.emptyTitle)).toBeNull();
    expect(screen.queryByRole('button', { name: en.seedChain })).toBeNull();
  });

  it('ANNOUNCES the failure — a screen reader is not left with silence', async () => {
    // Found by /grade-ux. `StateCard` had no role/aria-live at all, so the swap
    // from skeleton to failure card was silent: a sighted user sees "Could not
    // load your environments" and a screen-reader user hears nothing, whose most
    // natural reading is "there was nothing to announce" — the exact false
    // conclusion this whole effort exists to prevent.
    api.listEnvironments.mockRejectedValue(new Error('environments_500'));
    view();

    // Assert on the CARD, not on "some role=status somewhere" — the app mounts a
    // toast container that is also role=status, and an empty one at that, so
    // `findByRole('status')` matched it and would have passed for any card at
    // all. Walk up from the failure title to the live region that contains it.
    await page().findByText(en.loadFailedTitle);

    // The ANNOUNCEMENT, not the attribute. The first cut of this test asserted
    // the card sat inside `[role=status]` — which passed while announcing
    // nothing, because a live region mounted with its text already inside is not
    // reliably read by assistive tech. Assert the text reached the region that
    // was already on the page.
    await waitFor(() => expect(politeRegion().textContent).toContain(en.loadFailedTitle));
  });

  it('does NOT announce the genuinely-empty state — only failures interrupt', async () => {
    // The other direction. Announcing every StateCard would make the empty state
    // shout on a perfectly normal first visit, which is how live regions get
    // switched off by the people who need them.
    view();

    await screen.findByText(en.emptyTitle);
    expect(politeRegion().textContent).not.toContain(en.emptyTitle);
  });

  it('GENUINELY EMPTY: a real "you have none" answer still offers to create the chain', async () => {
    // The other arm. If this ever goes red the fix has collapsed into "always
    // show the error", and a workspace that truly has no chain can no longer
    // make one.
    view();

    expect(await screen.findByText(en.emptyTitle)).toBeTruthy();
    expect(screen.getByRole('button', { name: en.seedChain })).toBeTruthy();
    expect(page().queryByText(en.loadFailedTitle)).toBeNull();
  });

  it('HEALTHY: real environments render, and neither designed state appears', async () => {
    api.listEnvironments.mockResolvedValue({ environments: [ENV], appVersion: null, domains: [] });
    view();

    // Match the snapshot hash, not the env name — "dev" also appears in the
    // promotion source/target selects, so `findByText('dev')` matches three
    // nodes and throws for a reason unrelated to what this test is about.
    expect(await screen.findByText(ENV.currentSnapshot.slice(0, 12))).toBeTruthy();
    expect(page().queryByText(en.loadFailedTitle)).toBeNull();
    expect(screen.queryByText(en.emptyTitle)).toBeNull();
  });
});

/**
 * NOT COVERED HERE, deliberately — the stale-after-refresh arm.
 *
 * `EnvironmentsPage.tsx:432` renders a `staleAfterRefresh` warning when a
 * refresh fails after a good first load, so the cards on screen are marked "last
 * known" rather than passing for live. That branch is real and it matters, but
 * the only way to reach `refresh()` a second time is through a mutation
 * (`run()` calls it on success), which would make this a mutation test wearing a
 * read test's clothes. Left to `HV-3` — an honest gap, not a silent one.
 */
