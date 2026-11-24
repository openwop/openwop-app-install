/**
 * 2650 diagnostic: real CampaignBriefPage + Notice + GlobalLiveRegion.
 * Only read seams are controlled; only the brand catalog is deferred.
 * Always prove the final owned catalog option before asserting the recorded
 * pending-state negatives. A real native baseline may refute this hypothesis.
 * No production/module reset or global announcement clear is used.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { t } from 'i18next';
import type { BrandRef, CampaignBrief, OrgRef } from '../campaignBriefClient.js';

const reads = vi.hoisted(() => ({
  briefs: vi.fn<typeof import('../campaignBriefClient.js').listBriefs>(),
  brands: vi.fn<typeof import('../campaignBriefClient.js').listBrands>(),
}));
vi.mock('../campaignBriefClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../campaignBriefClient.js')>()),
  listBriefs: reads.briefs,
  listBrands: reads.brands,
  listOrgs: vi.fn(async (): Promise<OrgRef[]> => [{ orgId: 'org-a', name: 'Client A' }]),
  listPersonas: vi.fn(async () => []),
  findCampaignForBrief: vi.fn(async () => null),
  getPendingKernelRun: vi.fn(async () => null),
}));
// Existing clientBrandChoices seam: unrelated knowledge metadata settles now.
vi.mock('../../kb/kbClient.js', () => ({ listCollections: vi.fn(async () => []) }));
vi.unmock('../CampaignBriefPage.js');
vi.unmock('../../../ui/Notice.js');
vi.unmock('../../../ui/announce.js');

import { CampaignBriefPage } from '../CampaignBriefPage.js';
import { currentAnnouncements, GlobalLiveRegion } from '../../../ui/announce.js';

const BRIEF: CampaignBrief = {
  id: 'brief-pending-brand', tenantId: 'tenant-fixture', orgId: 'org-a',
  name: 'Saved bound brief', objective: '', productName: 'Saved product identity',
  productDescription: '', industryVertical: '', personaIds: [], channels: [],
  brandId: 'brand-a',
  messaging: { primaryValueProp: '', toneOverride: '', proofPoints: [], ctaStrategy: '' },
  status: 'draft', kernelStale: false, createdBy: 'fixture-author',
  createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z',
};
const OWNED: BrandRef = { id: 'brand-a', orgId: 'org-a', name: 'Owned A catalog voice' };
const OTHER_CLIENT: BrandRef = { id: 'brand-a', orgId: 'org-b', name: 'Other client catalog voice' };
const OWNED_ALTERNATIVE: BrandRef = { id: 'brand-alt-a', orgId: 'org-a', name: 'Owned A alternative voice' };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
let catalog: ReturnType<typeof deferred<BrandRef[]>> | undefined;
let observer: MutationObserver | undefined;
function catalogGate() {
  if (!catalog) throw new Error('brand_catalog_fixture_not_initialized');
  return catalog;
}

beforeEach(() => {
  catalog = deferred<BrandRef[]>();
  reads.briefs.mockReset().mockResolvedValue([BRIEF]);
  reads.brands.mockReset().mockReturnValue(catalog.promise);
});
afterEach(async () => {
  observer?.disconnect();
  observer = undefined;
  cleanup();
  // Release only this fixture's pending read after unmount, even on setup failure.
  // This is not a production reset and never clears shared announcement state.
  await act(async () => { catalog?.resolve([]); await catalog?.promise; });
  catalog = undefined;
});

async function openObservedBrief() {
  const warning = t('campaign-brief:brandUnavailableWarning');
  expect(warning).not.toBe('campaign-brief:brandUnavailableWarning');
  expect(warning).not.toBe('brandUnavailableWarning');
  expect(warning.trim().length).toBeGreaterThan(0);
  const host = render(<GlobalLiveRegion />);
  const polite = host.container.querySelector<HTMLDivElement>('[data-owp-live="polite"]');
  if (!polite) throw new Error('real_global_polite_region_not_mounted');
  const baseline = currentAnnouncements().polite;
  const changes: string[] = [];
  observer = new MutationObserver(() => { changes.push(polite.textContent ?? ''); });
  observer.observe(polite, { childList: true, characterData: true, subtree: true });

  const page = render(<MemoryRouter initialEntries={['/?brief=brief-pending-brand']}>
    <CampaignBriefPage />
  </MemoryRouter>);
  const form = within(page.container);
  await form.findByDisplayValue(BRIEF.productName);
  const select = await form.findByLabelText(t('campaign-brief:fieldBrand')) as HTMLSelectElement;
  expect(reads.briefs).toHaveBeenCalled();
  expect(reads.brands).toHaveBeenCalled();
  await act(async () => {});
  await waitFor(() => expect(polite.textContent ?? '').toBe(currentAnnouncements().polite));
  return { warning, polite, baseline, changes, page, form, select };
}

function sawNewUnavailable(
  observation: Awaited<ReturnType<typeof openObservedBrief>>, snapshots: string[] = [],
): boolean {
  const { warning, baseline, changes } = observation;
  const current = currentAnnouncements().polite;
  // A retained pre-test message is not a fresh announcement. Actual DOM changes
  // and changed public snapshots detect repeats, including the invisible marker.
  return changes.some((text) => text.includes(warning))
    || [...snapshots, current].some((text) => text !== baseline && text.includes(warning));
}

it('does not diagnose or announce unavailable while the actual brand catalog is pending for a valid saved binding', async () => {
  const view = await openObservedBrief();
  const pending = {
    selectedId: view.select.value,
    inlineUnavailable: view.form.queryByText(view.warning, { exact: true }) !== null,
    globalSnapshot: currentAnnouncements().polite,
  };

  await act(async () => { catalogGate().resolve([OWNED]); await catalogGate().promise; });
  const ownedOption = await within(view.select).findByRole('option', { name: OWNED.name });
  expect(ownedOption.getAttribute('value')).toBe(OWNED.id);
  expect((ownedOption as HTMLOptionElement).selected).toBe(true);
  expect(view.select.value).toBe(BRIEF.brandId);
  await act(async () => {});
  await waitFor(() => expect(view.polite.textContent ?? '').toBe(currentAnnouncements().polite));

  // These negatives occur AFTER non-vacuous saved-detail/catalog positives.
  // Capture both paths so a native failure distinguishes inline-only from a
  // real global emission; neither result is assumed from source alone.
  expect({
    pendingSelectedId: pending.selectedId,
    pendingInlineUnavailable: pending.inlineUnavailable,
    newlyAnnouncedUnavailable: sawNewUnavailable(view, [pending.globalSnapshot]),
    settledInlineUnavailable: view.form.queryByText(view.warning, { exact: true }) !== null,
  }).toEqual({
    pendingSelectedId: BRIEF.brandId,
    pendingInlineUnavailable: false,
    newlyAnnouncedUnavailable: false,
    settledInlineUnavailable: false,
  });
});

it('retains a genuine settled foreign-client binding warning and announces it through the real global region', async () => {
  // Make this positive independent of any warning emitted during a pending read.
  // The valid-binding negative above owns that timing; this case owns the settled
  // foreign binding and must produce a fresh real announcement after mount.
  catalogGate().resolve([OTHER_CLIENT, OWNED_ALTERNATIVE]);
  await catalogGate().promise;
  const view = await openObservedBrief();
  // A distinct owned row proves the real catalog result reached the Page.
  const alternative = await within(view.select).findByRole('option', { name: OWNED_ALTERNATIVE.name });
  expect(alternative.getAttribute('value')).toBe(OWNED_ALTERNATIVE.id);
  expect(view.select.value).toBe(BRIEF.brandId);
  expect(within(view.select).queryByRole('option', { name: OTHER_CLIENT.name })).toBeNull();
  expect(view.form.getByText(view.warning, { exact: true })).toBeTruthy();
  await waitFor(() => expect(view.polite.textContent ?? '').toContain(view.warning));
  expect(currentAnnouncements().polite).toContain(view.warning);
  expect(sawNewUnavailable(view)).toBe(true);
});
