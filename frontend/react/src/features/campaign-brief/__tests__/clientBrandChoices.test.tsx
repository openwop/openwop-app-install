/**
 * ADR 0891 D7 — brand generation is client-bound, so a brief or persona editor
 * must not offer another client's brand (generation would ignore it). A saved
 * binding that is unavailable for the client stays visible, with a warning, until
 * the user replaces or removes it, and removal goes on the wire as an explicit
 * empty `brandId`. The real CampaignBriefPage runs; the client is stubbed.
 *
 * Red when (sabotage-witnessed, w93): choices stop filtering by client; the
 * unavailable option or its warning disappears; the review chip calls another
 * client's brand bound; the brief or persona payload drops an empty `brandId`;
 * a NEW persona may save another client's brand; a SAVED persona with a legacy
 * binding can no longer be saved unchanged.
 */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { BrandRef, CampaignBrief, OrgRef, Persona } from '../campaignBriefClient.js';
const listBriefs = vi.fn();
const updateBrief = vi.fn();
const createPersona = vi.fn();
const listPersonas = vi.fn();
const updatePersona = vi.fn();
vi.mock('../campaignBriefClient.js', async (orig) => ({
  ...await orig<Record<string, unknown>>(),
  listBriefs: (...args: unknown[]) => listBriefs(...args),
  updateBrief: (...args: unknown[]) => updateBrief(...args),
  createPersona: (...args: unknown[]) => createPersona(...args),
  listOrgs: vi.fn(async (): Promise<OrgRef[]> => [{ orgId: 'org-a', name: 'Client A' }, { orgId: 'org-b', name: 'Client B' }]),
  listBrands: vi.fn(async (): Promise<BrandRef[]> => [{ id: 'brand-a', orgId: 'org-a', name: 'A voice' }, { id: 'brand-b', orgId: 'org-b', name: 'B voice' }]),
  listPersonas: (...args: unknown[]) => listPersonas(...args),
  updatePersona: (...args: unknown[]) => updatePersona(...args),
  findCampaignForBrief: vi.fn(async () => null),
  getPendingKernelRun: vi.fn(async () => null),
}));
// CORE-4 mounts a client knowledge picker; brand tests isolate its metadata read.
vi.mock('../../kb/kbClient.js', () => ({ listCollections: vi.fn(async () => []) }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { CampaignBriefPage } from '../CampaignBriefPage.js';
const BRIEF: CampaignBrief = {
  id: 'brief-a', tenantId: 'tenant', orgId: 'org-a', name: 'Client A campaign', objective: '',
  productName: 'A product', productDescription: '', industryVertical: '', personaIds: [], channels: [],
  messaging: { primaryValueProp: '', toneOverride: '', proofPoints: [], ctaStrategy: '' },
  status: 'draft', kernelStale: false, createdBy: 'user', createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z',
};
const SAVED_PERSONA: Persona = {
  id: 'persona-saved', tenantId: 'tenant', orgId: 'org-b', name: 'Test audience', role: '',
  buyerStage: 'problem_aware', painPoints: [], objections: [], goals: [], demographics: '',
  createdBy: 'user', createdAt: BRIEF.createdAt, updatedAt: BRIEF.updatedAt,
};
beforeEach(() => { listBriefs.mockReset().mockResolvedValue([BRIEF]); updateBrief.mockReset().mockResolvedValue(BRIEF); createPersona.mockReset().mockResolvedValue(SAVED_PERSONA); listPersonas.mockReset().mockResolvedValue([]); updatePersona.mockReset().mockResolvedValue(SAVED_PERSONA); });
afterEach(cleanup);
async function openBrief(): Promise<void> {
  render(<MemoryRouter><CampaignBriefPage /></MemoryRouter>);
  await act(async () => {});
  fireEvent.click(await screen.findByRole('button', { name: /Client A campaign/i }));
  await screen.findByRole('button', { name: /^Save$/ });
}
it('offers only this client brands and saves the chosen same-client brand', async () => {
  await openBrief();
  const select = screen.getByLabelText('Brand');
  expect(within(select).getByRole('option', { name: 'A voice' })).not.toBeNull();
  expect(within(select).queryByRole('option', { name: 'B voice' })).toBeNull();
  fireEvent.change(select, { target: { value: 'brand-a' } });
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(updateBrief).toHaveBeenCalledWith('brief-a', expect.objectContaining({ brandId: 'brand-a' })));
});
it('preserves an unavailable legacy binding with a warning until explicitly changed', async () => {
  listBriefs.mockResolvedValue([{ ...BRIEF, brandId: 'brand-b' }]);
  await openBrief();
  expect(within(screen.getByLabelText('Brand')).getByRole('option', { selected: true }).getAttribute('value')).toBe('brand-b');
  expect(screen.getByText(/not available for this client/i)).not.toBeNull();
  expect(screen.getByText('Brand unavailable for this client')).not.toBeNull(); // the review chip says so
  expect(screen.queryByText('Brand bound')).toBeNull();
  fireEvent.change(screen.getByLabelText('Product description'), { target: { value: 'An unrelated edit' } });
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(updateBrief).toHaveBeenCalledWith('brief-a', expect.objectContaining({ brandId: 'brand-b' })));
});
it('sends an explicit empty brand when the user removes an existing binding', async () => {
  listBriefs.mockResolvedValue([{ ...BRIEF, brandId: 'brand-a' }]);
  await openBrief();
  fireEvent.change(screen.getByLabelText('Brand'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(updateBrief).toHaveBeenCalledWith('brief-a', expect.objectContaining({ brandId: '' })));
});
it('updates persona brand choices with its client and permits explicit removal', async () => {
  render(<MemoryRouter><CampaignBriefPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('tab', { name: 'Personas' }));
  fireEvent.click(await screen.findByRole('button', { name: /New persona/i }));
  const dialog = await screen.findByRole('dialog');
  const brand = within(dialog).getByLabelText('Brand');
  fireEvent.change(within(dialog).getByLabelText(/^Persona name/), { target: { value: 'Test audience' } });
  await within(brand).findByRole('option', { name: 'A voice' }); // the brands read has landed
  expect(within(brand).queryByRole('option', { name: 'B voice' })).toBeNull();
  fireEvent.change(brand, { target: { value: 'brand-a' } });
  fireEvent.change(within(dialog).getByLabelText(/^Organization/), { target: { value: 'org-b' } });
  expect(within(brand).getByRole('option', { name: 'B voice' })).not.toBeNull();
  expect(within(dialog).getByText(/not available for this client/i)).not.toBeNull();
  expect(within(dialog).getByRole('button', { name: /^Save$/ }).hasAttribute('disabled')).toBe(true);
  fireEvent.change(brand, { target: { value: '' } });
  expect(within(dialog).getByRole('button', { name: /^Save$/ }).hasAttribute('disabled')).toBe(false);
  fireEvent.click(within(dialog).getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(createPersona).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-b', brandId: '' })));
});

it.each([false, true])('keeps an existing persona legacy binding unless removal is explicit: %s', async (clear) => {
  const persona: Persona = {
    id: 'persona-a', tenantId: 'tenant', orgId: 'org-a', name: 'Saved audience', role: '',
    buyerStage: 'problem_aware', painPoints: [], objections: [], goals: [], demographics: '',
    brandId: 'brand-b', createdBy: 'user', createdAt: BRIEF.createdAt, updatedAt: BRIEF.updatedAt,
  };
  listPersonas.mockResolvedValue([persona]);
  render(<MemoryRouter initialEntries={['/?tab=personas&persona=persona-a']}><CampaignBriefPage /></MemoryRouter>);
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(/not available for this client/i)).not.toBeNull();
  expect(within(dialog).getByRole('button', { name: /^Save$/ }).hasAttribute('disabled')).toBe(false);
  if (clear) fireEvent.change(within(dialog).getByLabelText('Brand'), { target: { value: '' } });
  fireEvent.click(within(dialog).getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(updatePersona).toHaveBeenCalledWith('persona-a', expect.objectContaining({ brandId: clear ? '' : 'brand-b' })));
});
