/**
 * Funnels — a failed workspace read must not be rendered as "No workspaces".
 *
 * Found by triaging the failed-read-sentinel gate's remaining population rather
 * than by opening the page: `FunnelsPage` was the LAST surface still rolling the
 * raw `.catch(() => setOrgs([]))` idiom in code, while 17 other pages had moved
 * to the shared `ui/useOrgSelection`. `[]` collapses "this tenant has no
 * workspaces" into "we could not read them", and the select then asserted the
 * first as `noOrgs` ("No workspaces") when only the second was true.
 *
 * Both polarities, because an "absent" assertion alone is vacuous — a broken
 * render would satisfy it:
 *   - read FAILS  → an announced, retryable failure notice; NEVER "No organizations"
 *   - read SUCCEEDS but is genuinely empty → the real "No organizations" survives
 *
 * HG-4 UPDATE — the copy is now the SHARED one (`ui/OrgSelectionState`), which is
 * the point: this page used to say "No workspaces" in the select and "No
 * organizations" in the card, five lines apart in one catalog. The strings below
 * are asserted in full, not as a regex spanning both forms — a test that accepted
 * either noun would be indifferent to the drift it exists to stop.
 *
 * TWO DOUBLE GUARDS, named so a green single-guard probe is not read as a gap:
 *  - The funnel READ: the effect's `if (orgId)` AND `load()`'s `if (!org) return`.
 *    Removing either alone leaves `listFunnels` uncalled; the wave-52 re-probe drops
 *    both in one edit.
 *  - The create WRITE (ORG-HON-2): `OrgSelectionState` replaces the form in both org
 *    states, so `add()`'s own `if (!orgId …)` is a second copy that no UI gesture can
 *    reach today (there is no form to submit). The cases assert the form is GONE —
 *    that is the guard that holds — and keep the `createFunnel` not-called check for
 *    the day the wrapper stops covering it. Honest ceiling: `add()`'s copy is not
 *    witnessable through the page.
 *
 * Sabotage-witnessed (wave 52): the failed-read clause, the zero-org branch, the
 * wrapper rendering the form for zero organizations, both read guards together, the
 * retry wiring, the toggle card, the toggle-gated org read, the loading branch, and
 * creating under the wrong org each turn a case red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as FC from '../funnelsClient.js';
import type { Funnel } from '../funnelsClient.js';

const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn(() => makeFeatureAccess({ enabled: true, loading: false })) }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: access.useFeatureAccess }));

const api = vi.hoisted(() => ({
  listOrgs: vi.fn<typeof FC.listOrgs>(), listFunnels: vi.fn<typeof FC.listFunnels>(async () => []),
  // The org-scoped WRITES this page can issue (ORG-HON-2). `createFunnel` is the
  // one with a control in the zero-organization state; the three lifecycle
  // writes hang off table rows that only exist once the read has answered.
  createFunnel: vi.fn<typeof FC.createFunnel>(), publishFunnel: vi.fn<typeof FC.publishFunnel>(),
  unpublishFunnel: vi.fn<typeof FC.unpublishFunnel>(), archiveFunnel: vi.fn<typeof FC.archiveFunnel>(),
}));
vi.mock('../funnelsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});

import { FunnelsPage } from '../FunnelsPage.js';

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` keeps queued `…Once` values — reset the read whose cases queue them.
  api.listOrgs.mockReset();
  // `clearAllMocks` does NOT drop a `mockReturnValue`, so the toggle is re-pinned
  // per test rather than left to whatever the previous one set.
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
});
afterEach(cleanup);

const view = (): HTMLElement => {
  const { container } = render(<MemoryRouter><FunnelsPage /></MemoryRouter>);
  return container;
};

/**
 * Fill in a funnel name and submit the create form — the whole gesture, minus
 * the organization. Submitting the FORM rather than clicking the button is
 * deliberate: it bypasses `disabled` and reaches `add()`'s `if (!orgId …) return`
 * whenever a form exists. In both org states there is NO form (see header), so the
 * gesture is a no-op there and the cases assert the form's absence first.
 */
const attemptCreateFunnel = async (container: HTMLElement): Promise<void> => {
  // `query`, not `get`: in the org-state branches the form is not merely
  // disabled, it is GONE — `OrgSelectionState` wraps it now — and a hard `get`
  // would fail the test for the reason the fix exists.
  const name = screen.queryByLabelText('Funnel name');
  if (name) fireEvent.change(name, { target: { value: 'Summer launch' } });
  const form = container.querySelector('form');
  if (form) await act(async () => { fireEvent.submit(form); });
};

describe('funnels — failed workspace read is not an empty account', () => {
  it('read FAILS: an honest, retryable notice — and NEVER "No organizations"', async () => {
    api.listOrgs.mockRejectedValue(new Error('boom'));
    view();
    await waitFor(() => expect(screen.getByText('Could not load your organizations')).toBeTruthy());
    expect(screen.getByText(
      'Funnels were never requested. This is a failed read, not an empty organization list.',
    )).toBeTruthy();
    // The false claim must be absent everywhere on the page, select included —
    // and the select is where the OTHER noun used to live.
    expect(screen.queryByText('No organizations')).toBeNull();
    expect(screen.queryByText('No workspaces')).toBeNull();
    // "Retryable" means the button re-reads and a success then loads the page.
    api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    await waitFor(() => expect(api.listFunnels).toHaveBeenCalledWith('o1'));
    expect(api.listOrgs).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
  });

  it('read SUCCEEDS and is genuinely empty: "No organizations" shows and no failure is claimed', async () => {
    // TWIN: the HG-1 case below runs the same fixture and asserts a superset (the
    // body copy, no skeleton, no funnel read). Kept, not cut — this file is
    // protected — as the plain polarity statement the header promises.
    api.listOrgs.mockResolvedValue([]);
    view();
    await waitFor(() => expect(screen.getByText('No organizations')).toBeTruthy());
    // …and no failure notice, because nothing failed.
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
  });

  it('read SUCCEEDS with []: the zero-org state, never an endless skeleton (HG-1)', async () => {
    // The THIRD state of a successful read, and the half of this fix that did not
    // land the first time. `orgId` stays '', `load()` returns on `if (!org)`,
    // `rows` never leaves `null` — so the loading branch had no terminal
    // condition and the only zero-orgs signal was an <option> inside a select the
    // user may never open. The server answered "none" and the screen said
    // "loading", which DESIGN.md §4.6 forbids: loading may only say it is
    // loading; empty is the state that may instruct.
    api.listOrgs.mockResolvedValue([]);
    view();
    expect(await screen.findByText('No organizations')).toBeTruthy();
    expect(screen.getByText('A funnel belongs to an organization.')).toBeTruthy();
    // Nothing failed, so nothing claims it did.
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
    // The a11y half of the defect: `SkeletonRows` is a `role="status"` live region
    // labelled "Loading…" whose children are aria-hidden, so a screen-reader user
    // was told permanently that work was in progress.
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    // THE falsifiable assertion. The new branch is orgId-INDEPENDENT, so a
    // copy-only test would stay green with the branch deleted; this pins the
    // mechanism — the funnel read never started, which is why the skeleton could
    // never end.
    expect(api.listFunnels).not.toHaveBeenCalled();
  });
});

/**
 * ORG-HON-2 — the WRITE half. The guard above pins the dependent READ
 * (`listFunnels` was never called); nothing pinned the half that would mint a
 * real data defect — `createFunnel('', { name })`, a funnel row keyed on no
 * organization.
 */
describe('funnels — no organization, no write (ORG-HON-2)', () => {
  it('zero organizations: the create form is GONE and no funnel is written', async () => {
    api.listOrgs.mockResolvedValue([]);
    const container = view();
    expect(await screen.findByText('No organizations')).toBeTruthy();

    // Guard one, strengthened: the form used to sit ABOVE the org-state card,
    // so the picker rendered as a labelled combobox with zero options and a
    // disabled submit. `OrgSelectionState` wraps it now, so the whole control
    // is replaced by the card that says why — there is nothing to disable.
    expect(screen.queryByRole('button', { name: 'Create funnel' })).toBeNull();
    expect(screen.queryByLabelText('Organization')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
    // `add()`'s own guard is a second copy no gesture can reach while the form is
    // gone (header: honest ceiling); the gesture and the no-write check stay for the
    // day the wrapper stops covering it.
    await attemptCreateFunnel(container);
    expect(api.createFunnel).not.toHaveBeenCalled();
    // The lifecycle writes are row-scoped and there is no table — same
    // `(orgId, funnelId)` shape, pinned for the same reason.
    expect(api.publishFunnel).not.toHaveBeenCalled();
    expect(api.unpublishFunnel).not.toHaveBeenCalled();
    expect(api.archiveFunnel).not.toHaveBeenCalled();
  });

  it('read FAILS: no write either — `orgId` is empty in that state too', async () => {
    api.listOrgs.mockRejectedValue(new Error('boom'));
    const container = view();
    await waitFor(() => expect(screen.getByText('Could not load your organizations')).toBeTruthy());
    // Same shape: the failure card replaces the form, so the empty combobox a
    // failed read used to leave behind is gone too.
    expect(screen.queryByLabelText('Organization')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
    await attemptCreateFunnel(container);
    expect(api.createFunnel).not.toHaveBeenCalled();
  });

  it('positive control: with an organization the same gesture DOES create a funnel', async () => {
    // Without this, the assertions above would also pass if the form were broken
    // for everyone — a different bug wearing the same green.
    api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
    const created: Funnel = {
      funnelId: 'f1', orgId: 'o1', name: 'Summer launch', slug: 'summer-launch', status: 'draft', steps: [],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    api.createFunnel.mockResolvedValue(created);
    const container = view();
    await waitFor(() => expect(api.listFunnels).toHaveBeenCalledWith('o1'));
    // The form exists here — the absence asserted in the org-state cases is real.
    expect(container.querySelector('form')).not.toBeNull();
    await attemptCreateFunnel(container);
    expect(api.createFunnel).toHaveBeenCalledTimes(1);
    expect(api.createFunnel.mock.calls[0]?.[0]).toBe('o1');
  });
});

/**
 * THE TOGGLE ACTUALLY GATES NOW. It did not: the page assigned the whole
 * `useFeatureAccess` OBJECT to `enabled` and then tested `if (!enabled)`, which is
 * never true, so the "not enabled" card was unreachable and Funnels rendered — and
 * issued its reads — regardless of the toggle. The object-ness was visible a few
 * lines down (`useOrgSelection(listOrgs, enabled.enabled, …)`). Both halves are
 * asserted: the CARD and the READ — a card drawn over a page that still fetched is
 * the same defect wearing a different coat.
 */
describe('funnels — the feature toggle gates the page', () => {
  it('toggle OFF renders the not-enabled card and reads nothing', async () => {
    access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: false, loading: false }));
    api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
    view();
    expect(await screen.findByText('Funnels are not enabled')).toBeTruthy();
    expect(screen.getByText('Ask an administrator to turn on the Funnels feature in Admin → Feature toggles.')).toBeTruthy();
    expect(api.listOrgs).not.toHaveBeenCalled();
    expect(api.listFunnels).not.toHaveBeenCalled();
    // Nor the create affordance, which is what would write to a disabled feature.
    expect(screen.queryByRole('button', { name: 'Create funnel' })).toBeNull();
  });

  it('toggle UNRESOLVED is a skeleton under the real header — not a terminal card', async () => {
    // A `<StateCard title loading />` whose only text is the page title reads as
    // an answer and unmounts `PageHeader`. Loading may only say it is loading.
    access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: false, loading: true }));
    view();
    expect(await screen.findByRole('status', { name: 'Loading…' })).toBeTruthy();
    expect(screen.queryByText('Funnels are not enabled')).toBeNull();
    expect(api.listOrgs).not.toHaveBeenCalled();
  });

  it('positive control: toggle ON renders the page and does read', async () => {
    // Without this the two assertions above would also pass if the page were
    // broken for everyone — a different bug wearing the same green.
    api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
    view();
    await waitFor(() => expect(api.listFunnels).toHaveBeenCalledWith('o1'));
    expect(screen.queryByText('Funnels are not enabled')).toBeNull();
  });
});
