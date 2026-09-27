/**
 * Product discovery — a failed store read must not be rendered as "No stores
 * available".
 *
 * `DiscoveryPage` consumes `ui/useOrgSelection`'s `orgsFailed` correctly, but
 * nothing failed when the seam itself was sabotaged (`setOrgsFailed(true)` →
 * `setOrgs([])`): the failure Notice disappeared and the store picker asserted
 * "No stores available" — a claim about the catalogue, made by a request that
 * never came back — and the suite stayed green. This file is the guard that
 * measurement said was missing.
 *
 * It renders the REAL `DiscoveryPage` and forces the failure through the REAL
 * client function the page calls (`discoveryClient.listOrgs`) — never the hook,
 * never a replica.
 *
 * Both polarities, because an "absent" assertion alone is vacuous — a broken
 * render would satisfy it:
 *   - read FAILS  → the retryable failure card; NEVER "No organizations"
 *   - read SUCCEEDS but is genuinely empty → the real "No organizations" survives
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, act, fireEvent } from '@testing-library/react';

// The real hook returns an OBJECT (`{ enabled, loading, … }`) — mirrored in full
// here, `loading` included, because the page branches on it too.
const access = vi.hoisted(() => ({
  useFeatureAccess: vi.fn(() => makeFeatureAccess({ enabled: true, loading: false, status: 'on', isBeta: false, variant: null })),
}));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: access.useFeatureAccess }));

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(),
  listCollections: vi.fn(async () => []),
  listRules: vi.fn(async () => []),
  // The four org-scoped WRITES this page can issue (ORG-HON-2), plus `search`,
  // which is a read but is dispatched from a form that also sits above the
  // org-state chain.
  createCollection: vi.fn(), deleteCollection: vi.fn(),
  createRule: vi.fn(), deleteRule: vi.fn(),
  search: vi.fn(),
}));
vi.mock('../discoveryClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});

import { DiscoveryPage } from '../DiscoveryPage.js';

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` does NOT drop a `mockReturnValue`, so the toggle is re-pinned
  // per test rather than left to whatever the previous one set.
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false, status: 'on', isBeta: false, variant: null }));
});
afterEach(cleanup);

/**
 * HG-4 — the copy is the SHARED one now (`ui/OrgSelectionState`). Asserted in
 * full, both halves, not as a regex spanning the old "stores" wording and the
 * new one: a test that accepted either noun would be indifferent to exactly the
 * drift this migration exists to remove.
 */
const FAIL_TITLE = 'Could not load your organizations';
const FAIL_BODY = 'The collections and merchandising rules were never requested. This is a failed read, not an empty organization list.';

describe('product discovery — failed store read is not an empty catalogue', () => {
  it('read FAILS: the honest, retryable notice — and NEVER the empty-org claim', async () => {
    api.listOrgs.mockRejectedValue(new Error('boom'));
    render(<DiscoveryPage />);
    await waitFor(() => expect(screen.getByText(FAIL_TITLE)).toBeTruthy());
    expect(screen.getByText(FAIL_BODY)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // The false claim must be absent everywhere on the page, the picker included
    // — and the picker is where the OTHER noun ("No stores available") lived.
    expect(screen.queryByText('No organizations')).toBeNull();
    expect(screen.queryByText('No stores available')).toBeNull();
    // …and the rows read was never even attempted, so nothing below may claim emptiness.
    expect(api.listCollections).not.toHaveBeenCalled();
  });

  it('read SUCCEEDS and is genuinely empty: the real "No organizations" still shows', async () => {
    api.listOrgs.mockResolvedValue([]);
    render(<DiscoveryPage />);
    await waitFor(() => expect(screen.getByText('No organizations')).toBeTruthy());
    // …and no failure disclosure, because nothing failed.
    expect(screen.queryByText(FAIL_TITLE)).toBeNull();
  });

  it('read SUCCEEDS with []: the zero-org state, never an endless skeleton (HG-1)', async () => {
    // The THIRD state of a successful read, and the half of this fix that did not
    // land the first time. `orgId` stays '', `load()` returns on `if (!org)`, and
    // BOTH tables' rows stay `null` — so both loading branches had no terminal
    // condition and the only zero-orgs signal was an <option> inside a select the
    // user may never open. The server answered "none" and the screen said
    // "loading", which DESIGN.md §4.6 forbids: loading may only say it is
    // loading; empty is the state that may instruct.
    api.listOrgs.mockResolvedValue([]);
    render(<DiscoveryPage />);
    expect(await screen.findByText('No organizations')).toBeTruthy();
    expect(screen.getByText(
      'Collections and merchandising rules belong to an organization.',
    )).toBeTruthy();
    // Nothing failed, so nothing claims it did.
    expect(screen.queryByText(FAIL_TITLE)).toBeNull();
    expect(screen.queryByText('Could not load collections')).toBeNull();
    // The a11y half of the defect: `SkeletonRows` is a `role="status"` live region
    // labelled "Loading…" whose children are aria-hidden, so a screen-reader user
    // was told permanently that work was in progress.
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    // THE falsifiable assertion. The new branch is orgId-INDEPENDENT, so a
    // copy-only test would stay green with the branch deleted; this pins the
    // mechanism — neither read ever started, which is why the skeletons could
    // never end.
    expect(api.listCollections).not.toHaveBeenCalled();
    expect(api.listRules).not.toHaveBeenCalled();
  });
});

/**
 * ORG-HON-2 — the WRITE half. The guard above pins the dependent READS
 * (`listCollections` / `listRules` were never called); nothing pinned the half
 * that would mint a real data defect — `createCollection('', …)`, a collection
 * row keyed on no store.
 *
 * The two forms USED to be in different positions, and that asymmetry was the
 * defect: the collection form sat ABOVE the org-state branch, so it rendered in
 * the zero-organization state — org picker included, a labelled combobox with
 * zero options — while the rule form sat inside and did not. Both are inside
 * now. `addCollection`'s own `!orgId` early return is still asserted, because
 * "not rendered" is a fact about today's branch order and "the write never
 * fired" is the property.
 */
describe('product discovery — no organization, no write (ORG-HON-2)', () => {
  const attemptCreateCollection = async (_container: HTMLElement): Promise<void> => {
    // `query`, not `get`: in the org-state branches the form is GONE, and a hard
    // `get` would fail the test for the reason the fix exists.
    //
    // And the form is reached through its OWN field rather than
    // `container.querySelector('form')`. That shortcut used to be harmless
    // because the collection form was the first on the page; now that the
    // org-state card replaces it, "the first form" is the SEARCH form, and
    // submitting that fired `search('')` — a different org-less call, counted
    // against the assertion for this one.
    const name = screen.queryByLabelText(/Collection name/);
    if (!name) return;
    fireEvent.change(name, { target: { value: 'Summer picks' } });
    const form = name.closest('form');
    if (form) await act(async () => { fireEvent.submit(form); });
  };

  it('zero organizations: BOTH forms are absent and nothing is written', async () => {
    api.listOrgs.mockResolvedValue([]);
    const { container } = render(<DiscoveryPage />);
    expect(await screen.findByText('No organizations')).toBeTruthy();

    // Guard one, strengthened: the collection form is replaced by the org-state
    // card rather than merely disabled — and with it the org `<select>`, which in
    // this state was a labelled combobox holding nothing ("Organization, combo
    // box, 0 items"). A control with no options is not a control.
    expect(screen.queryByLabelText('Organization')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add collection' })).toBeNull();
    // Guard two, the property: `addCollection`'s `if (!orgId …) return` still
    // holds even if the branch above it were removed.
    await attemptCreateCollection(container);
    expect(api.createCollection).not.toHaveBeenCalled();

    // The rule form lives inside the org-state branch, so it is not on the page —
    // a merchandising rule HIDES products from shoppers, and one filed under an
    // empty store id would be a hide-rule belonging to nothing.
    expect(screen.queryByRole('button', { name: 'Add rule' })).toBeNull();
    expect(api.createRule).not.toHaveBeenCalled();
    // Both deletes are row actions on tables that were never read.
    expect(api.deleteCollection).not.toHaveBeenCalled();
    expect(api.deleteRule).not.toHaveBeenCalled();
    // CORRECTION — this used to assert that the search console stayed OUTSIDE
    // the org-state branch and was merely DISABLED, on the reasoning that it
    // carries no org picker of its own so it is not the empty-combobox defect.
    // That reasoning answers the wrong question: `children` stops content
    // rendering ABOVE the guard, but a sibling BELOW it escapes the branch order
    // just as completely. A search box you can type into, under a card saying
    // there are no organizations, with a button that can never answer, is a
    // dead control — and `runSearch` has NO `!orgId` early return, so the
    // disabled attribute was the entire defence. It is a child now.
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
    expect(api.search).not.toHaveBeenCalled();
  });

  it('read FAILS: no write either — `orgId` is empty in that state too', async () => {
    api.listOrgs.mockRejectedValue(new Error('boom'));
    const { container } = render(<DiscoveryPage />);
    await waitFor(() => expect(screen.getByText(FAIL_TITLE)).toBeTruthy());
    // Same shape: the failure card replaces the form, so the empty combobox a
    // failed read used to leave behind is gone too.
    expect(screen.queryByLabelText('Organization')).toBeNull();
    await attemptCreateCollection(container);
    expect(api.createCollection).not.toHaveBeenCalled();
    // …and the search console with it. This is the state the sibling-below-the-
    // wrapper defect was actually VISIBLE in: over a failed organization read the
    // whole preview form rendered, accepted a query, and answered nothing.
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
    expect(api.search).not.toHaveBeenCalled();
  });

  it('positive control: with a store the same gesture DOES create a collection', async () => {
    // Without this, the assertions above would also pass if the form were broken
    // for everyone — a different bug wearing the same green.
    api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme Store' }]);
    api.createCollection.mockResolvedValue({ collectionId: 'c1', name: 'Summer picks', type: 'dynamic' });
    const { container } = render(<DiscoveryPage />);
    await waitFor(() => expect(api.listCollections).toHaveBeenCalledWith('o1'));
    await attemptCreateCollection(container);
    expect(api.createCollection).toHaveBeenCalledTimes(1);
    expect(api.createCollection.mock.calls[0]?.[0]).toBe('o1');
  });
});

/**
 * THE TOGGLE ACTUALLY GATES NOW. It did not: the page assigned the whole
 * `useFeatureAccess` OBJECT to `enabled` and then tested `if (!enabled)`, which is
 * never true, so the "not enabled" card was unreachable and Discovery rendered —
 * and issued its reads — regardless of the toggle. The object-ness was visible a
 * few lines down (`useOrgSelection(listOrgs, enabled.enabled)`); what hid it was
 * the sibling `discoveryPreview` test's `useFeatureAccess: () => true` mock, which
 * made the suite agree with the bug. Both halves are asserted: the CARD and the
 * READ — a card drawn over a page that still fetched is the same defect.
 */
describe('product discovery — the feature toggle gates the page', () => {
  it('toggle OFF renders the not-enabled card and reads nothing', async () => {
    access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: false, loading: false, status: 'off', isBeta: false, variant: null }));
    api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme Store' }]);
    render(<DiscoveryPage />);
    expect(await screen.findByText('Discovery is not enabled')).toBeTruthy();
    expect(screen.getByText('Ask an administrator to turn on the Discovery feature in Admin → Feature toggles.')).toBeTruthy();
    expect(api.listOrgs).not.toHaveBeenCalled();
    expect(api.listCollections).not.toHaveBeenCalled();
    expect(api.listRules).not.toHaveBeenCalled();
    // Nor the create affordance, which is what would write to a disabled feature.
    expect(screen.queryByRole('button', { name: 'Add collection' })).toBeNull();
  });

  it('toggle UNRESOLVED is a skeleton under the real header — not a terminal card', async () => {
    // A `<StateCard title loading />` whose only text is the page title reads as
    // an answer and unmounts `PageHeader`. Loading may only say it is loading.
    access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: false, loading: true, status: 'off', isBeta: false, variant: null }));
    render(<DiscoveryPage />);
    expect(await screen.findByRole('status', { name: 'Loading…' })).toBeTruthy();
    expect(screen.queryByText('Discovery is not enabled')).toBeNull();
    expect(api.listOrgs).not.toHaveBeenCalled();
  });

  it('positive control: toggle ON renders the page and does read', async () => {
    // Without this the two assertions above would also pass if the page were
    // broken for everyone — a different bug wearing the same green.
    api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme Store' }]);
    render(<DiscoveryPage />);
    await waitFor(() => expect(api.listCollections).toHaveBeenCalledWith('o1'));
    expect(screen.queryByText('Discovery is not enabled')).toBeNull();
  });
});
