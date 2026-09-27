/**
 * Both shapes on one page, which is why this trio was taken whole rather than
 * split across two sweeps.
 *
 *  1. ORG EDGE — `orgs` was declared `useState<Org[]>([])`, NON-nullable, so `[]`
 *     was the only value a failure could take. `orgId` stayed '', the load is
 *     gated on it, and the table's `empty=` slot rendered its loading skeleton
 *     forever while the selector claimed "No stores available".
 *
 *  2. ERROR-BESIDE-EMPTY (`-3`'s seam) — the rows catch set an error AND `[]`, so
 *     the page showed the error Notice and, beneath it, "No promotions yet — Add
 *     a promotion above — a cart threshold, a product discount, or a
 *     budget-capped loss-leader." The instruction is the half that reads as the
 *     answer.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

const { listOrgs, listPromotions, createPromotion, updatePromotion, deletePromotion, useFeatureAccess } = vi.hoisted(() => ({
  listOrgs: vi.fn(), listPromotions: vi.fn(),
  // The three org-scoped WRITES this page can issue (ORG-HON-2).
  createPromotion: vi.fn(), updatePromotion: vi.fn(), deletePromotion: vi.fn(),
  // The real hook returns an OBJECT — controllable here so the toggle itself can
  // be driven, which is the thing no test in this feature used to do.
  useFeatureAccess: vi.fn(() => makeFeatureAccess({ enabled: true, loading: false })),
}));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../promotionsClient.js', async (orig) => ({
  ...(await orig<typeof import('../promotionsClient.js')>()),
  listOrgs, listPromotions, createPromotion, updatePromotion, deletePromotion,
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess,
}));

import { PromotionsPage } from '../PromotionsPage.js';

const ORG = { orgId: 'o1', name: 'Acme Store' };
// COMPLETE fixture. An incomplete one throws inside render (`reward.kind`), and
// every assertion in the file then fails for a reason unrelated to the defect.
const PROMO = {
  promotionId: 'p1', orgId: 'o1', name: 'Spring sale',
  type: 'product_discount' as const,
  reward: { kind: 'percent' as const, value: 10 },
  priority: 1, stackable: false, active: true,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

let container: HTMLElement;
const mount = async (): Promise<void> => {
  container = render(<PromotionsPage />).container;
  await act(async () => {});
};

/**
 * Fill in a promotion name and submit the create form — the whole gesture, minus
 * the organization. Submitting the FORM rather than clicking the button is
 * deliberate: `disabled` is one guard and `add()`'s `if (!orgId …) return` is the
 * other, and only the second survives a refactor that restyles the button.
 */
const attemptCreatePromotion = async (): Promise<void> => {
  // `query`, not `get`: in the org-state branches the form is not merely
  // disabled, it is GONE — `OrgSelectionState` wraps it now — and a hard `get`
  // would fail the test for the reason the fix exists.
  const name = screen.queryByLabelText(/Promotion name/);
  if (name) fireEvent.change(name, { target: { value: 'Summer sale' } });
  const form = container.querySelector('form');
  if (form) await act(async () => { fireEvent.submit(form); });
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` does NOT drop a `mockReturnValue`, so the toggle is re-pinned
  // per test rather than left to whatever the previous one set.
  useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
  listOrgs.mockResolvedValue([ORG]);
  listPromotions.mockResolvedValue({ promotions: [PROMO], usage: {} });
});

describe('a failed store read is not an empty store list', () => {
  it('says so instead of claiming there are no organizations', async () => {
    listOrgs.mockRejectedValue(new Error('503'));
    await mount();
    // HG-4 — the SHARED copy (`ui/OrgSelectionState`), asserted in full. This
    // page used to say "stores" in the picker and "organizations" in the card.
    expect(document.body.textContent).toContain('Could not load your organizations');
    expect(document.body.textContent).toContain(
      'The promotion list was never requested. This is a failed read, not an empty organization list.',
    );
    expect(document.body.textContent).not.toContain('No organizations');
    expect(document.body.textContent).not.toContain('No stores available');
  });

  it('never requested the promotions — the mechanism, not the symptom', async () => {
    listOrgs.mockRejectedValue(new Error('503'));
    await mount();
    expect(listPromotions).not.toHaveBeenCalled();
  });

  it('read SUCCEEDS with []: the zero-org state, never an endless skeleton (HG-1)', async () => {
    // The THIRD state of a successful read, and the half of this fix that did not
    // land the first time (the header comment claimed both). `orgId` stays '',
    // `load()` returns on `if (!org)`, `rows` never leaves `null` — so the
    // `empty=` slot's loading branch had no terminal condition and the only
    // zero-orgs signal was an <option> inside a select the user may never open.
    // The server answered "none" and the screen said "loading", which DESIGN.md
    // §4.6 forbids: loading may only say it is loading; empty is the state that
    // may instruct.
    listOrgs.mockResolvedValue([]);
    await mount();
    expect(screen.getByText('No organizations')).toBeTruthy();
    expect(screen.getByText('Promotions belong to an organization.')).toBeTruthy();
    // Nothing failed, so nothing claims it did.
    expect(document.body.textContent).not.toContain('Could not load your organizations');
    expect(document.body.textContent).not.toContain('Could not load promotions');
    // The a11y half of the defect: `SkeletonRows` is a `role="status"` live region
    // labelled "Loading…" whose children are aria-hidden, so a screen-reader user
    // was told permanently that work was in progress.
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    // THE falsifiable assertion. The new branch is orgId-INDEPENDENT, so a
    // copy-only test would stay green with the branch deleted; this pins the
    // mechanism — the promotions read never started, which is why the skeleton
    // could never end.
    expect(listPromotions).not.toHaveBeenCalled();
  });

  it('the retry re-runs the store read', async () => {
    listOrgs.mockRejectedValueOnce(new Error('503')).mockResolvedValue([ORG]);
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(listOrgs).toHaveBeenCalledTimes(2);
  });
});

describe('a failed promotions read does not instruct beside its own error', () => {
  it('stops telling the operator to add a promotion', async () => {
    listPromotions.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.body.textContent).toContain('Could not load promotions');
    expect(document.body.textContent).not.toContain('No promotions yet');
    expect(document.body.textContent).not.toContain('Add a promotion above');
  });

  it('a store that genuinely has none still gets the instruction', async () => {
    // The failure mode of this fix: a real empty store with no way to learn what
    // a promotion even is.
    listPromotions.mockResolvedValue({ promotions: [], usage: {} });
    await mount();
    expect(document.body.textContent).toContain('No promotions yet');
    expect(document.body.textContent).not.toContain('Could not load promotions');
  });

  it('a successful read still lists them', async () => {
    await mount();
    expect(document.body.textContent).toContain('Spring sale');
  });
});

/**
 * ORG-HON-2 — the WRITE half. The guards above pin the dependent READ
 * (`listPromotions` was never called); nothing pinned the half that would mint a
 * real data defect — `createPromotion('', draft)`, a promotion row keyed on no
 * organization, in a feature where a row decides what money comes off a cart.
 */
describe('promotions — no organization, no write (ORG-HON-2)', () => {
  it('zero organizations: the create form is GONE and no promotion is written', async () => {
    listOrgs.mockResolvedValue([]);
    await mount();
    expect(screen.getByText('No organizations')).toBeTruthy();

    // Guard one, strengthened: the form used to sit ABOVE the org-state card, so
    // the picker rendered as a labelled combobox with zero options and a disabled
    // submit. `OrgSelectionState` wraps it now, so the whole control is replaced
    // by the card that says why — there is nothing left to disable.
    expect(screen.queryByRole('button', { name: 'Add promotion' })).toBeNull();
    expect(screen.queryByLabelText('Organization')).toBeNull();
    // Guard two, the one that matters: the handler says no as well.
    await attemptCreatePromotion();
    expect(createPromotion).not.toHaveBeenCalled();
    // Pause/activate and delete are row-scoped and there is no table — the org
    // branch stands in for it. Same `(orgId, promotionId)` shape, same pin.
    expect(updatePromotion).not.toHaveBeenCalled();
    expect(deletePromotion).not.toHaveBeenCalled();
  });

  it('read FAILS: no write either — `orgId` is empty in that state too', async () => {
    listOrgs.mockRejectedValue(new Error('503'));
    await mount();
    // Same shape: the failure card replaces the form, so the empty combobox a
    // failed read used to leave behind is gone too.
    expect(screen.queryByLabelText('Organization')).toBeNull();
    await attemptCreatePromotion();
    expect(createPromotion).not.toHaveBeenCalled();
  });

  it('positive control: with a store the same gesture DOES create a promotion', async () => {
    // Without this, the assertions above would also pass if the form were broken
    // for everyone — a different bug wearing the same green.
    listPromotions.mockResolvedValue({ promotions: [], usage: {} });
    createPromotion.mockResolvedValue(PROMO);
    await mount();
    await attemptCreatePromotion();
    expect(createPromotion).toHaveBeenCalledTimes(1);
    expect(createPromotion.mock.calls[0]?.[0]).toBe('o1');
  });
});

/**
 * THE TOGGLE ACTUALLY GATES NOW. It did not: the page assigned the whole
 * `useFeatureAccess` OBJECT to `enabled` and then tested `if (!enabled)`, which is
 * never true, so the "not enabled" card was unreachable and Promotions rendered —
 * and issued its reads — regardless of the toggle. The object-ness was visible one
 * line down (`useOrgSelection(listOrgs, enabled.enabled)`); what hid it was the
 * sibling test's `useFeatureAccess: () => true` mock, which made the suite agree
 * with the bug. Both halves are asserted: the CARD (what the user sees) and the
 * READ (the mechanism — a card drawn over a page that still fetched would be the
 * same defect wearing a different coat).
 */
describe('promotions — the feature toggle gates the page', () => {
  it('toggle OFF renders the not-enabled card and reads nothing', async () => {
    useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: false, loading: false }));
    await mount();
    expect(screen.getByText('Promotions are not enabled')).toBeTruthy();
    expect(document.body.textContent).toContain('Ask an administrator to turn on the Promotions feature');
    expect(listOrgs).not.toHaveBeenCalled();
    expect(listPromotions).not.toHaveBeenCalled();
    // Nor the create affordance, which is what would write to a disabled feature.
    expect(screen.queryByRole('button', { name: 'Add promotion' })).toBeNull();
  });

  it('toggle UNRESOLVED is a skeleton under the real header — not a terminal card', async () => {
    // A `<StateCard title loading />` whose only text is the page title reads as
    // an answer ("Promotions." — about what?) and unmounts `PageHeader`. Loading
    // may only say it is loading (DESIGN.md §4.6).
    useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: false, loading: true }));
    await mount();
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeTruthy();
    expect(screen.queryByText('Promotions are not enabled')).toBeNull();
    expect(listOrgs).not.toHaveBeenCalled();
  });

  it('positive control: toggle ON renders the page and does read', async () => {
    // Without this the two assertions above would also pass if the page were
    // broken for everyone — a different bug wearing the same green.
    await mount();
    expect(screen.queryByText('Promotions are not enabled')).toBeNull();
    expect(listOrgs).toHaveBeenCalledTimes(1);
  });
});
