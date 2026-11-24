/**
 * Catalog settlement is separate from absence. Real Page/Notice, controlled
 * client boundaries; the existing two-case producer fixture owns global output.
 * No global announcement clear/reset and no existing test changes.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { t } from 'i18next';
import type { BrandRef, CampaignBrief, OrgRef, Persona } from '../campaignBriefClient.js';
const reads = vi.hoisted(() => ({
  brands: vi.fn<typeof import('../campaignBriefClient.js').listBrands>(),
  briefs: vi.fn<typeof import('../campaignBriefClient.js').listBriefs>(),
  personas: vi.fn<typeof import('../campaignBriefClient.js').listPersonas>(),
  updateBrief: vi.fn<typeof import('../campaignBriefClient.js').updateBrief>(),
  updatePersona: vi.fn<typeof import('../campaignBriefClient.js').updatePersona>(),
}));
vi.mock('../campaignBriefClient.js', async (original) => ({
  ...await original<typeof import('../campaignBriefClient.js')>(),
  listBrands: reads.brands, listBriefs: reads.briefs, listPersonas: reads.personas,
  updateBrief: reads.updateBrief, updatePersona: reads.updatePersona,
  listOrgs: vi.fn(async (): Promise<OrgRef[]> => [{ orgId: 'org-a', name: 'Client A' }]),
  findCampaignForBrief: vi.fn(async () => null), getPendingKernelRun: vi.fn(async () => null),
}));
vi.mock('../../kb/kbClient.js', () => ({ listCollections: vi.fn(async () => []) }));
vi.unmock('../CampaignBriefPage.js');
vi.unmock('../../../ui/Notice.js');
vi.unmock('../../../ui/announce.js');
import { CampaignBriefPage } from '../CampaignBriefPage.js';

const BRIEF: CampaignBrief = {
  id: 'brief-a', tenantId: 'tenant', orgId: 'org-a', name: 'Saved brief', objective: '',
  productName: 'Saved product', productDescription: '', industryVertical: '', personaIds: [], channels: [],
  brandId: 'brand-a', messaging: { primaryValueProp: '', toneOverride: '', proofPoints: [], ctaStrategy: '' },
  status: 'draft', kernelStale: false, createdBy: 'user',
  createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z',
};
const PERSONA: Persona = {
  id: 'persona-a', tenantId: 'tenant', orgId: 'org-a', name: 'Saved audience', role: '',
  buyerStage: 'problem_aware', painPoints: [], objections: [], goals: [], demographics: '',
  brandId: 'brand-a', createdBy: 'user', createdAt: BRIEF.createdAt, updatedAt: BRIEF.updatedAt,
};
const OWNED: BrandRef = { id: 'brand-a', orgId: 'org-a', name: 'A voice' };
const FOREIGN: BrandRef = { id: 'brand-b', orgId: 'org-b', name: 'B voice' };
function deferred() {
  let yes: ((value: BrandRef[]) => void) | undefined;
  let no: ((reason: Error) => void) | undefined;
  const promise = new Promise<BrandRef[]>((resolve, reject) => { yes = resolve; no = reject; });
  return {
    promise,
    resolve(value: BrandRef[]) { if (!yes) throw new Error('fixture_not_initialized'); yes(value); },
    reject(error: Error) { if (!no) throw new Error('fixture_not_initialized'); no(error); },
  };
}
let catalog: ReturnType<typeof deferred> | undefined;
function gate() { if (!catalog) throw new Error('fixture_not_initialized'); return catalog; }
beforeEach(() => {
  catalog = deferred();
  reads.brands.mockReset().mockReturnValue(catalog.promise);
  reads.briefs.mockReset().mockResolvedValue([BRIEF]);
  reads.personas.mockReset().mockResolvedValue([PERSONA]);
  reads.updateBrief.mockReset().mockResolvedValue(BRIEF);
  reads.updatePersona.mockReset().mockResolvedValue(PERSONA);
});
afterEach(async () => {
  cleanup();
  // Settle only this fixture's read after unmount, including intended rejection.
  await act(async () => { catalog?.resolve([]); await catalog?.promise.catch(() => undefined); });
  catalog = undefined;
});
function selectIn(container: HTMLElement): HTMLSelectElement {
  const select = within(container).getByLabelText(t('campaign-brief:fieldBrand'));
  if (!(select instanceof HTMLSelectElement)) throw new Error('brand_select_missing');
  return select;
}
async function brief() {
  const view = render(<MemoryRouter initialEntries={['/?brief=brief-a']}><CampaignBriefPage /></MemoryRouter>);
  await within(view.container).findByDisplayValue(BRIEF.productName);
  expect(reads.brands).toHaveBeenCalled();
  return { ...view, select: selectIn(view.container) };
}
function review() {
  const section = screen.getByRole('heading', { name: t('campaign-brief:secReview') }).closest('section');
  if (!section) throw new Error('review_section_missing');
  return within(section);
}
async function settle() { await act(async () => { gate().resolve([OWNED, FOREIGN]); await gate().promise; }); }
function ownedSelected(select: HTMLSelectElement) {
  const option = within(select).getByRole('option', { name: OWNED.name });
  if (!(option instanceof HTMLOptionElement)) throw new Error('owned_option_missing');
  expect(option.selected).toBe(true);
  expect(select.value).toBe(OWNED.id);
  expect(within(select).queryByRole('option', { name: FOREIGN.name })).toBeNull();
}

it('keeps a pending saved brief binding and review chip unclassified until owned catalog commits', async () => {
  const v = await brief();
  const pending = {
    value: v.select.value,
    label: within(v.select).getByRole('option', { selected: true }).textContent,
    warning: within(v.container).queryByText(t('campaign-brief:brandUnavailableWarning'), { exact: true }) !== null,
    loading: review().queryByText(t('common:loading'), { exact: true }) !== null,
  };
  await settle();
  ownedSelected(v.select);
  expect(review().getByText(t('campaign-brief:reviewBrandBound'))).toBeTruthy();
  expect(pending).toEqual({ value: 'brand-a', label: t('common:loading'), warning: false, loading: true });
  expect(reads.updateBrief).not.toHaveBeenCalled();
});
it('keeps failed reads unknown and preserves explicit clearing on the save payload', async () => {
  const v = await brief();
  expect(v.select.value).toBe(BRIEF.brandId);
  await act(async () => { gate().reject(new Error('controlled catalog failure')); await gate().promise.catch(() => undefined); });
  // This positive admits the actual failure branch before the new negatives.
  await waitFor(() => expect(review().getByText(t('campaign-brief:reviewBrandUnknown'))).toBeTruthy());
  expect(within(v.select).getByRole('option', { selected: true }).textContent).toBe(t('campaign-brief:reviewBrandUnknown'));
  expect(v.select.value).toBe(BRIEF.brandId);
  expect(within(v.container).queryByText(t('campaign-brief:brandUnavailableWarning'), { exact: true })).toBeNull();
  expect(reads.updateBrief).not.toHaveBeenCalled();
  fireEvent.change(v.select, { target: { value: '' } });
  fireEvent.click(within(v.container).getByRole('button', { name: t('common:save') }));
  await waitFor(() => expect(reads.updateBrief).toHaveBeenCalledWith(BRIEF.id, expect.objectContaining({ brandId: '' })));
});
it('shares the pending selection rule with a saved persona and still allows removal', async () => {
  render(<MemoryRouter initialEntries={['/?tab=personas&persona=persona-a']}><CampaignBriefPage /></MemoryRouter>);
  const dialog = await screen.findByRole('dialog');
  const select = selectIn(dialog);
  const pending = {
    value: select.value,
    warning: within(dialog).queryByText(t('campaign-brief:brandUnavailableWarning'), { exact: true }) !== null,
  };
  await settle();
  ownedSelected(select);
  expect(pending).toEqual({ value: 'brand-a', warning: false });
  fireEvent.change(select, { target: { value: '' } });
  fireEvent.click(within(dialog).getByRole('button', { name: t('common:save') }));
  await waitFor(() => expect(reads.updatePersona).toHaveBeenCalledWith(PERSONA.id, expect.objectContaining({ brandId: '' })));
});
it('still reports a genuinely missing binding after a successful empty catalog', async () => {
  reads.brands.mockResolvedValue([]);
  const v = await brief();
  await waitFor(() => expect(review().getByText(t('campaign-brief:reviewBrandUnavailable'))).toBeTruthy());
  expect(v.select.value).toBe(BRIEF.brandId);
  expect(within(v.select).getByRole('option', { selected: true }).textContent).toBe(t('campaign-brief:brandUnavailableOption'));
  expect(within(v.container).getByText(t('campaign-brief:brandUnavailableWarning'), { exact: true })).toBeTruthy();
  expect(reads.updateBrief).not.toHaveBeenCalled();
});
