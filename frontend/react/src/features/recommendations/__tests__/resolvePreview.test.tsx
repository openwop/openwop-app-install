/**
 * UX_UPGRADE-recommendations — REC-G1 / REC-G2.
 *
 *  - REC-G2: `resolveRecommendations` distinguishes three outcomes — no
 *    placement matched the slot (bare `{ products: [] }`), a matched placement
 *    put the caller in the CONTROL holdout, or a matched placement found no
 *    candidates. The page collapsed all three into one sentence, so a
 *    merchandiser debugging an empty storefront slot could not tell "you never
 *    configured this" from "it is configured and there is nothing to show" —
 *    completely different fixes. `source` was discarded outright.
 *  - REC-G1: prices rendered as a bare number plus a code, same as the sibling
 *    discovery console.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import type { ResolvePreview, RecoProduct } from '../recommendationsClient.js';

const listPlacements = vi.fn();
const resolvePreview = vi.fn();

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../recommendationsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  listPlacements: () => listPlacements(),
  resolvePreview: (...a: unknown[]) => resolvePreview(...a),
  createPlacement: vi.fn(async () => ({})),
  deletePlacement: vi.fn(async () => {}),
  updatePlacement: vi.fn(async () => ({})),
  rebuildAffinity: vi.fn(async () => 0),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The real hook returns an OBJECT. Mocking it as `true` is what HID the live bug
// (the page did `const enabled = useFeatureAccess(…)` then `if (!enabled)`, which
// is never true for an object, so the toggle-off branch was dead in production
// and this mock made the page agree). Mirror the real shape.
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }) }));

import { RecommendationsPage } from '../RecommendationsPage.js';

const product = (): RecoProduct => ({ productId: 'p1', name: 'Widget', price: 1299.5, currency: 'USD', type: 'physical' });

/**
 * The two sentences the CONTROL and NO-CANDIDATES arms must never share, spelled
 * out rather than matched by role. Both are plain `<Notice variant="info">`, and
 * `ui/Notice` puts `role="status"` on every non-assertive notice — so a
 * role-shaped assertion is satisfied by whichever of the two renders, which is
 * precisely the distinction under test.
 */
const CONTROL_COPY = 'This session is in the holdout control cohort, so it sees no recommendations (by design).';
const NO_CANDIDATES_COPY = 'No recommendations resolved for this slot yet — add orders or a placement, then rebuild affinity.';

async function runPreview(result: ResolvePreview): Promise<void> {
  resolvePreview.mockResolvedValue(result);
  render(<RecommendationsPage />);
  await act(async () => {});
  await waitFor(() => expect(listPlacements).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: /^preview$/i }));
  await waitFor(() => expect(resolvePreview).toHaveBeenCalled());
}

beforeEach(() => {
  listPlacements.mockReset(); resolvePreview.mockReset();
  listPlacements.mockResolvedValue([]);
});
afterEach(cleanup);

describe('REC-G2: the preview separates the three empty outcomes', () => {
  it('NO placement matched says the slot is unconfigured, and what to do', async () => {
    // The resolver returns a bare `{ products: [] }` in this case — no placementId.
    await runPreview({ products: [] });
    const notice = await screen.findByText(/no active placement matches/i);
    // Scoped to the notice: the placements EMPTY STATE uses the same "add a
    // placement above" phrase, so an unscoped query matches both.
    expect(notice.textContent ?? '').toMatch(/add a placement above/i);
    // And it names the slot being previewed — by its LOCALIZED label, which is
    // what the merchandiser picked in the dropdown, not the raw `pdp` code.
    expect(notice.textContent ?? '').toMatch(/product page/i);
  });

  it('a CONTROL holdout says so — it is working as designed, not broken', async () => {
    await runPreview({ products: [], placementId: 'pl-1', source: 'bought_together', variant: 'control' });
    expect(screen.queryByText(/no active placement matches/i)).toBeNull();
    // THE assertion, and it was missing. This test used to check only that the
    // UNCONFIGURED copy was absent plus `findByRole('status')` — and `ui/Notice`
    // gives EVERY non-assertive notice `role="status"`, so the no-candidates
    // sentence satisfied it just as well. Deleting the `variant === 'control'`
    // arm, so control and no-candidates both rendered `previewEmpty` — the exact
    // three-into-two collapse this file exists to prevent — left both tests
    // green. The control copy is now named in full.
    expect(await screen.findByText(CONTROL_COPY)).toBeTruthy();
    expect(screen.queryByText(NO_CANDIDATES_COPY)).toBeNull();
  });

  it('a matched placement with NO candidates is distinct from unconfigured', async () => {
    await runPreview({ products: [], placementId: 'pl-1', source: 'trending', variant: 'treatment' });
    expect(screen.queryByText(/no active placement matches/i)).toBeNull();
    // The other side of the same collapse: this arm must not borrow the
    // holdout's meaning either.
    expect(await screen.findByText(NO_CANDIDATES_COPY)).toBeTruthy();
    expect(screen.queryByText(CONTROL_COPY)).toBeNull();
  });
});

describe('REC-G2: a served preview says which source produced it', () => {
  it('names the source that actually served the results', async () => {
    await runPreview({ products: [product()], placementId: 'pl-1', source: 'bought_together', variant: 'treatment' });
    expect(await screen.findByText(/served by/i)).toBeTruthy();
    expect(screen.getByText(/treatment/i)).toBeTruthy();
  });

  it('omits the line entirely when the server sent no source', async () => {
    await runPreview({ products: [product()] });
    expect(screen.queryByText(/served by/i)).toBeNull();
    // The products still render — the missing metadata is not fatal.
    expect(screen.getByText(/Widget/)).toBeTruthy();
  });
});

describe('REC-G1: preview prices are formatted money', () => {
  it('renders locale currency, not a bare number and a code', async () => {
    await runPreview({ products: [product()], placementId: 'pl-1', source: 'trending', variant: 'treatment' });
    expect(await screen.findByText(/\$1,299\.50/)).toBeTruthy();
    expect(screen.queryByText(/1299\.5 USD/)).toBeNull();
  });
});
