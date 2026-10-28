/**
 * UX-01 — a failed brand read ends in a recoverable, announced state (gap-closure
 * plan item A3; audit UX-01, section 07).
 *
 * The defect: a failed FIRST `listBrands()` left `brands` null, and the render
 * tested `brands === null` (the spinner) before `brandsFailed`, so the page spun
 * forever and the failure was never shown. Nor was there any Retry: the only way
 * back was a page reload. A failure after a good load replaced the list with the
 * same generic card, hiding data the user had just seen.
 *
 * Cases (each is something a user can cause: a backend 500, a Retry click, a
 * delete that triggers a refresh):
 *   1. first read fails → the load-failure card with Retry, announced once; no
 *      spinner, no create control; 1b. Retry fails again → the card again;
 *      1c. a failed ORGS read is retried by the same Retry;
 *   2. Retry succeeds → the list, with the failure gone;
 *   3. a later refresh fails → the last good list stays, under a warning with Retry;
 *   4. the feature is off → the not-enabled card (unchanged);
 *   5. race: a slow older read that fails AFTER a newer one succeeded does not put
 *      the warning back over the fresh list.
 *
 * Sabotage-witnessed: restoring the `brands === null` branch above the failure
 * branch reds case 1; dropping the `seq !== brandsSeq.current` guard in the catch
 * reds case 5; restoring the old `brandsFailed ?` card over a loaded list reds 3.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act, within } from '@testing-library/react';
import type { Brand } from '../brandClient.js';
import type * as C from '../brandClient.js';

const listBrands = vi.fn<typeof C.listBrands>();
const listOrgs = vi.fn<typeof C.listOrgs>();
const deleteBrand = vi.fn<typeof C.deleteBrand>();
const listBrandFonts = vi.fn<typeof C.listBrandFonts>();
const announced = vi.fn<(message: string) => void>();

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../orgs/orgMembers.js', () => ({ loadOrgMembers: vi.fn(async () => []) }));
vi.mock('../brandClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listBrands: () => listBrands(),
  listOrgs: () => listOrgs(),
  deleteBrand: (...a: Parameters<typeof C.deleteBrand>) => deleteBrand(...a),
  listBrandFonts: (...a: Parameters<typeof C.listBrandFonts>) => listBrandFonts(...a),
}));
// Count what the shared announcer is asked to speak (StateCard's `announce`).
vi.mock('../../../ui/announce.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  announce: (message: string) => announced(message),
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

const { BrandPage } = await import('../BrandPage.js');
const { FeatureDisabledError } = await import('../brandClient.js');

const brand = (over: Partial<Brand> = {}): Brand => ({
  id: 'b1', tenantId: 't1', orgId: 'org:1', name: 'Solstice', description: '', status: 'active',
  voiceProfile: { voice: 'warm', formalityLevel: 2, guidelines: '', samplePhrases: [], avoidPhrases: [], toneRegisters: [] },
  positioning: { tagline: '', elevatorPitch: '', differentiators: [], competitiveFrame: '' },
  keyPhrases: { approvedTaglines: [], bannedPhrases: [], valuePropositions: [], productDescriptors: [] },
  channelVoiceRules: [],
  governance: { lockLevel: 'none', allowedEditors: [], requireApproval: false, compliance: { blockPublish: 'critical' } },
  createdBy: 'u1', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-08T00:00:00Z',
  ...over,
});

const LOAD_FAILED = /Could not load this/i;
const STALE = /could not be refreshed\. Showing the last list that loaded/i;

/** Delete the named brand through the real confirm dialog (it triggers a refresh). */
async function deleteViaUi(name: string): Promise<void> {
  const row = screen.getByText(name).closest('li')!;
  fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
}

beforeEach(() => {
  for (const m of [listBrands, listOrgs, deleteBrand, listBrandFonts, announced]) m.mockReset();
  listOrgs.mockResolvedValue([{ orgId: 'org:1', name: 'Acme' }]);
  deleteBrand.mockResolvedValue(undefined);
  listBrandFonts.mockResolvedValue([]);
});
afterEach(cleanup);

describe('UX-01 — the brand list read always ends somewhere a user can act', () => {
  it('1. a failed first read shows the announced failure with Retry, not an endless spinner', async () => {
    listBrands.mockRejectedValue(new Error('brands_500'));
    render(<BrandPage />);
    expect(await screen.findByText(LOAD_FAILED)).toBeTruthy();
    expect(screen.queryByText('Loading brands…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /create|new brand/i })).toBeNull();
    // Announced, and once: the failure title, not the raw error text. StateCard
    // announces from a PASSIVE effect, which React may flush in a later macrotask
    // than the commit `findByText` saw (it does whenever the commit overruns the
    // scheduler's 5 ms frame, i.e. on a loaded worker), so wait for it rather
    // than reading it synchronously. A synchronous read here was the date-bomb
    // sweep's "interference" red: `expected [] to have a length of 1`.
    await waitFor(() => expect(announced.mock.calls.filter(([m]) => /Could not load this/i.test(m))).toHaveLength(1));
    expect(announced.mock.calls.some(([m]) => m.includes('brands_500'))).toBe(false);
  });

  it('1b. a Retry that fails again ends in the failure card again, not the spinner', async () => {
    listBrands.mockRejectedValue(new Error('brands_500'));
    render(<BrandPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(listBrands).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.getByText(LOAD_FAILED)).toBeTruthy();
    expect(screen.queryByText('Loading brands…')).toBeNull();
  });

  it('1c. a failed orgs read is retried by Retry, and the real empty state follows', async () => {
    listBrands.mockResolvedValue([]);
    listOrgs.mockRejectedValueOnce(new Error('orgs_500')).mockResolvedValueOnce([{ orgId: 'org:1', name: 'Acme' }]);
    render(<BrandPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Create a brand' })).toBeTruthy();
    expect(screen.queryByText(LOAD_FAILED)).toBeNull();
    expect(listOrgs).toHaveBeenCalledTimes(2);
  });

  it('2. Retry after a failed first read loads the list and clears the failure', async () => {
    listBrands.mockRejectedValueOnce(new Error('brands_500')).mockResolvedValueOnce([brand()]);
    render(<BrandPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Solstice')).toBeTruthy();
    expect(screen.queryByText(LOAD_FAILED)).toBeNull();
    expect(screen.queryByText(STALE)).toBeNull();
    expect(listBrands).toHaveBeenCalledTimes(2);
  });

  it('3. a refresh that fails after a good load keeps the last list, under a warning with Retry', async () => {
    listBrands
      .mockResolvedValueOnce([brand(), brand({ id: 'b2', name: 'Aurora' })])
      .mockRejectedValueOnce(new Error('brands_500'))
      .mockResolvedValueOnce([brand({ id: 'b2', name: 'Aurora' })]);
    render(<BrandPage />);
    await screen.findByText('Solstice');
    await deleteViaUi('Solstice');
    expect(await screen.findByText(STALE)).toBeTruthy();
    // The last good list is still on screen, not replaced by a failure card.
    expect(screen.getByText('Solstice')).toBeTruthy();
    expect(screen.getByText('Aurora')).toBeTruthy();
    expect(screen.queryByText(LOAD_FAILED)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText('Solstice')).toBeNull());
    expect(screen.queryByText(STALE)).toBeNull();
    expect(screen.getByText('Aurora')).toBeTruthy();
  });

  it('4. a disabled feature still shows the not-enabled card', async () => {
    listBrands.mockRejectedValue(new FeatureDisabledError());
    render(<BrandPage />);
    expect(await screen.findByText('Brand & Guardrails is not enabled')).toBeTruthy();
    expect(screen.queryByText('Loading brands…')).toBeNull();
    expect(screen.queryByText(LOAD_FAILED)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('5. a slow older read that fails after a newer read succeeded does not resurface the warning', async () => {
    let rejectSlow: (e: Error) => void = () => {};
    listBrands
      .mockResolvedValueOnce([brand(), brand({ id: 'b2', name: 'Aurora' }), brand({ id: 'b3', name: 'Cobalt' })])
      .mockRejectedValueOnce(new Error('brands_500')) // refresh after delete #1 → stale warning
      .mockImplementationOnce(() => new Promise<Brand[]>((_res, rej) => { rejectSlow = rej; })) // Retry: slow
      .mockResolvedValueOnce([brand({ id: 'b3', name: 'Cobalt' })]); // refresh after delete #2: fast
    render(<BrandPage />);
    await screen.findByText('Solstice');
    await deleteViaUi('Solstice');
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await deleteViaUi('Aurora');
    await waitFor(() => expect(screen.queryByText('Aurora')).toBeNull());
    expect(screen.getByText('Cobalt')).toBeTruthy();
    await act(async () => { rejectSlow(new Error('late_500')); });
    expect(screen.queryByText(STALE)).toBeNull();
    expect(screen.getByText('Cobalt')).toBeTruthy();
  });
});
