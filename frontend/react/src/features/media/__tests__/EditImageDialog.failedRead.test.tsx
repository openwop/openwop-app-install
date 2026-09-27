/**
 * UX_UPGRADE-media R2 — MED2-B3 / MED2-R1: a failed read is not an answer.
 *
 * `EditImageDialog` opens two reads at once. It used to `Promise.all` them, so
 * ONE rejection discarded the other's success and dropped into a catch that set
 * `providers = []` — which renders "No image provider connected", a positive
 * claim about the WORKSPACE that the failed request never established. A 429
 * from the per-IP read budget (a normal state on a fanned-out page) was enough.
 * The `error` Notice the old catch set rendered inside the else-branch, so it
 * was unreachable: the honest reason existed but could never be seen.
 *
 * The two arms are asserted SEPARATELY and each with the sibling call
 * SUCCEEDING, because that is the exact discrimination `Promise.all` destroyed
 * — a test that fails both reads passes against the bug.
 *
 * MED2-R1 guards this fix's own first cut, which answered a failed LIBRARY read
 * with `source = 'missing'` → "Not a library image": one false claim swapped for
 * another, inside the fix for that family. `source` must stay `null`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const listAssets = vi.hoisted(() => vi.fn());
const listImageProviders = vi.hoisted(() => vi.fn());
vi.mock('../mediaClient.js', () => ({
  listAssets,
  listImageProviders,
  aiEditAsset: vi.fn(),
  aiUpscaleAsset: vi.fn(),
  absoluteServeUrl: (u: string) => u,
}));

import { EditImageDialog } from '../EditImageDialog.js';

const SOURCE = {
  assetId: 'a1', orgId: 'o1', name: 'hero.png', contentType: 'image/png', sizeBytes: 10,
  tags: [], usageCount: 0, serveUrl: '/host/openwop-app/assets/tok-a1', serveToken: 'tok-a1',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
const PROVIDERS = [{ provider: 'openai', ops: ['edit', 'inpaint'] }];

const open = () =>
  render(
    <EditImageDialog
      orgId="o1"
      imageUrl="/host/openwop-app/assets/tok-a1"
      onSelect={() => undefined}
      onClose={() => undefined}
    />,
  );

beforeEach(() => {
  listAssets.mockReset().mockResolvedValue([SOURCE]);
  listImageProviders.mockReset().mockResolvedValue(PROVIDERS);
});
afterEach(cleanup);

describe('MED2-B3 — a failed provider read never becomes "no provider connected"', () => {
  it('says the check did not complete, and offers a retry that re-reads', async () => {
    listImageProviders.mockRejectedValue(new Error('429 Too Many Requests'));
    open();

    await waitFor(() => expect(screen.getByText(/could not check your image providers/i)).toBeTruthy());
    // The distinguishing claim: the old copy asserted the workspace has none.
    expect(screen.queryByText(/no image provider connected/i), 'a failed read must not claim the workspace has no provider').toBeNull();
    expect(screen.getByText(/does not mean none are/i), 'the card says what is NOT known').toBeTruthy();

    // A gate with no exit is a defect — this card is the one that had no action.
    listImageProviders.mockResolvedValue(PROVIDERS);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.getByRole('group', { name: /edit operation/i })).toBeTruthy());
    expect(listImageProviders).toHaveBeenCalledTimes(2);
  });

  it('renders the real "none connected" empty state when the read SUCCEEDS with []', async () => {
    // The negative control. Without it, "never claims none" would be satisfied
    // by a dialog that can no longer report a genuinely empty workspace.
    listImageProviders.mockResolvedValue([]);
    open();
    await waitFor(() => expect(screen.getByText(/no image provider connected/i)).toBeTruthy());
    expect(screen.queryByText(/could not check your image providers/i)).toBeNull();
  });
});

describe('MED2-R1 — a failed library read never becomes "Not a library image"', () => {
  it('reports the library read, not a verdict about the image', async () => {
    // Providers SUCCEED here: under `Promise.all` this success was discarded,
    // and under the first cut of the fix it produced the wrong claim instead.
    listAssets.mockRejectedValue(new Error('500'));
    open();

    await waitFor(() => expect(screen.getByText(/could not read your media library/i)).toBeTruthy());
    expect(screen.queryByText(/not a library image/i), 'the read never established that').toBeNull();
    expect(screen.queryByText(/no image provider connected/i), 'the provider read succeeded').toBeNull();
  });

  it('still says "Not a library image" when the library read SUCCEEDS without a match', async () => {
    // The negative control for the other direction: a real, established verdict.
    listAssets.mockResolvedValue([{ ...SOURCE, serveUrl: '/host/openwop-app/assets/tok-other', serveToken: 'tok-other' }]);
    open();
    await waitFor(() => expect(screen.getByText(/not a library image/i)).toBeTruthy());
    expect(screen.queryByText(/could not read your media library/i)).toBeNull();
  });
});
