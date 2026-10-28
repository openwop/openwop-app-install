/**
 * ADR 0941 P3 — the campaign detail page's new sections.
 *
 *   - a missing campaign says "not found" (the route's uniform 404), not "failed";
 *   - Products: commerce off says so; a failed links read is a failure, never
 *     "no products"; the picker reads the CAMPAIGN org's catalog, refuses two
 *     primaries before any write, and saves the refs it shows;
 *   - Attention: the flag renders and "Mark as reviewed" clears it (attention: []);
 *   - Linked work: a section that failed reads "Couldn't load", a feature that is
 *     off reads "Feature off", neither as "0 linked".
 *
 * Sabotage: mapping a failed links read to empty sections reds "a failed links
 * read…"; reading `listProducts` with another org reds the picker case; removing
 * either `primaries > 1` guard (the disabled button, the submit check) reds the
 * picker case; rendering an
 * `unavailable` section as a count reds the linked-work case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('../CampaignLedgerSection.js', () => ({ CampaignLedgerSection: () => null })); // own tests: campaignLedgerSection.test.tsx
vi.mock('../autonomy/AutonomyPolicyPanel.js', () => ({ default: () => null })); // own tests: autonomyPolicyPanel.test.tsx
vi.mock('../autonomy/VetoWindowsSection.js', () => ({ default: () => null })); // own tests: vetoWindowsSection.test.tsx
import { act, render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import type { CampaignLinks, MarketingCampaign } from '../campaignStudioClient.js';

const h = vi.hoisted(() => ({
  getCampaign: vi.fn(),
  getCampaignLinks: vi.fn(),
  updateCampaign: vi.fn(),
  listProducts: vi.fn(),
  listOrgs: vi.fn(),
  getCommand: vi.fn(),
}));
vi.mock('../campaignStudioClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCampaign: h.getCampaign,
  getCampaignLinks: h.getCampaignLinks,
  updateCampaign: h.updateCampaign,
  listOrgs: h.listOrgs,
  listDispatches: vi.fn(async () => []),
  getCommand: h.getCommand,
}));
vi.mock('../../commerce/commerceClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), listProducts: h.listProducts }));

import { CampaignDetailPage } from '../CampaignDetailPage.js';

const CAMPAIGN: MarketingCampaign = {
  id: 'cmp_a', tenantId: 't1', orgId: 'org-a', briefId: 'b1', name: 'Spring push', status: 'draft',
  channels: [], objective: 'Grow trials', personaIds: [], createdBy: 'u1',
  createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-02T08:00:00.000Z',
};
const OK = { status: 'ok' as const, items: [] };
const LINKS: CampaignLinks = {
  products: OK, project: OK, assets: OK, runs: OK, emailSends: OK, adDispatches: OK, plans: OK, opsAssets: OK, assetTotal: 0,
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function open(): void {
  render(
    <MemoryRouter initialEntries={['/campaign-studio/campaigns/cmp_a']}>
      <Link to="/campaign-studio/campaigns/cmp_b">Next campaign</Link>
      <Routes><Route path="/campaign-studio/campaigns/:campaignId" element={<CampaignDetailPage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.getCampaign.mockResolvedValue(CAMPAIGN);
  h.getCampaignLinks.mockResolvedValue(LINKS);
  h.updateCampaign.mockImplementation(async (_id: string, patch: Partial<MarketingCampaign>) => ({ ...CAMPAIGN, ...patch, attention: patch.attention ? undefined : CAMPAIGN.attention }));
  h.listProducts.mockResolvedValue([{ productId: 'p1', name: 'Course' }, { productId: 'p2', name: 'Workbook' }]);
  h.listOrgs.mockResolvedValue([{ orgId: 'org-a', name: 'Acme' }]);
  // The detail now mounts the real command section. Its own suite exercises
  // run/gate behavior; this page fixture still supplies its actual read boundary.
  h.getCommand.mockImplementation(async (id: string) => ({ campaign: { id, orgId: 'org-a', name: 'Spring push', status: 'draft' }, runs: [], nodes: [], gates: [], runsTruncated: false, nodesTruncated: false, gatesTruncated: false, unavailable: {}, generatedAt: '2026-10-20T00:00:00Z' }));
});
afterEach(cleanup);

describe('ADR 0941 P3 — campaign detail', () => {
  it('an organization-name failure is disclosed and retryable while campaign details remain available', async () => {
    h.listOrgs.mockRejectedValueOnce(new Error('unavailable'));
    open();
    expect(await screen.findByRole('heading', { name: 'Spring push' })).toBeTruthy();
    expect(await screen.findByText("The organization name couldn't be loaded. Campaign details are available.")).toBeTruthy();
    expect(screen.queryByText(/\bOrg Acme\b/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/\bOrg Acme\b/)).toBeTruthy();
    expect(screen.queryByText("The organization name couldn't be loaded. Campaign details are available.")).toBeNull();
    expect(h.getCampaign).toHaveBeenCalledTimes(1);
  });

  it('a late response from the previous route cannot replace the current campaign', async () => {
    const old = deferred<MarketingCampaign>();
    const next = { ...CAMPAIGN, id: 'cmp_b', name: 'Autumn launch', orgId: 'org-b' };
    h.getCampaign.mockImplementation((id: string) => id === 'cmp_a' ? old.promise : Promise.resolve(next));
    open();
    await waitFor(() => expect(h.getCampaign).toHaveBeenCalledWith('cmp_a'));
    fireEvent.click(screen.getByRole('link', { name: 'Next campaign' }));
    expect(await screen.findByRole('heading', { name: 'Autumn launch' })).toBeTruthy();
    await act(async () => { old.resolve(CAMPAIGN); await old.promise; });
    expect(screen.getByRole('heading', { name: 'Autumn launch' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Spring push' })).toBeNull();
  });

  it('navigation clears the previous parent and ignores its late linked-product response', async () => {
    const oldLinks = deferred<CampaignLinks>();
    h.getCampaign.mockImplementation((id: string) => Promise.resolve(id === 'cmp_a'
      ? { ...CAMPAIGN, parentCampaignId: 'parent-a' }
      : id === 'parent-a' ? { ...CAMPAIGN, id, name: 'Previous parent' }
      : { ...CAMPAIGN, id: 'cmp_b', name: 'Autumn launch' }));
    h.getCampaignLinks.mockImplementation((id: string) => id === 'cmp_a' ? oldLinks.promise : Promise.resolve(LINKS));
    open();
    expect(await screen.findByText(/Previous parent/)).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Next campaign' }));
    expect(await screen.findByRole('heading', { name: 'Autumn launch' })).toBeTruthy();
    await act(async () => { oldLinks.resolve({ ...LINKS, products: { status: 'ok', items: [{ productId: 'old-product', role: 'primary', state: 'linked', name: 'Previous product' }] } }); await oldLinks.promise; });
    expect(screen.queryByText(/Previous parent/)).toBeNull();
    expect(screen.queryByText('Previous product')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Autumn launch' })).toBeTruthy();
  });

  it('a missing campaign says not found', async () => {
    h.getCampaign.mockRejectedValue(new Error('Campaign not found.'));
    open();
    expect(await screen.findByText('Campaign not found')).toBeTruthy();
  });

  it('commerce off says so instead of offering a picker', async () => {
    h.getCampaignLinks.mockResolvedValue({ ...LINKS, products: { status: 'unavailable', reason: 'feature_off' } });
    open();
    expect(await screen.findByText(/Commerce is off/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Choose products' })).toBeNull();
  });

  it('a failed links read is a failure, never "no products" or "0 linked"', async () => {
    h.getCampaignLinks.mockRejectedValue(new Error('boom'));
    open();
    expect(await screen.findByText(/Couldn't load the linked products/)).toBeTruthy();
    expect(screen.getByText(/Couldn't load this campaign's linked work/)).toBeTruthy();
    expect(screen.queryByText(/No catalog products are linked yet/)).toBeNull();
    expect(screen.queryByText(/0 linked/)).toBeNull();
  });

  it('the picker reads the campaign org\'s catalog, refuses two primaries, and saves the refs', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Choose products' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(h.listProducts).toHaveBeenCalledWith('org-a'));
    fireEvent.change(await within(dialog).findByLabelText('Role for Course'), { target: { value: 'primary' } });
    fireEvent.change(within(dialog).getByLabelText('Role for Workbook'), { target: { value: 'primary' } });
    expect(within(dialog).getByRole('alert').textContent).toMatch(/only one primary/);
    expect((within(dialog).getByRole('button', { name: 'Save products' }) as HTMLButtonElement).disabled).toBe(true);
    // A form submit (Enter) cannot get past the guard either: nothing is written.
    fireEvent.submit(within(dialog).getByRole('button', { name: 'Save products' }).closest('form') as HTMLFormElement);
    expect(h.updateCampaign).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Role for Workbook'), { target: { value: 'secondary' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save products' }));
    await waitFor(() => expect(h.updateCampaign).toHaveBeenCalledWith('cmp_a', {
      productRefs: [{ productId: 'p1', role: 'primary' }, { productId: 'p2', role: 'secondary' }],
    }));
  });

  it('an attention flag renders and "Mark as reviewed" clears it', async () => {
    h.getCampaign.mockResolvedValue({ ...CAMPAIGN, attention: [{ reason: 'product_deleted', productId: 'p9', at: '2026-10-03T08:00:00.000Z' }] });
    open();
    expect(await screen.findByText(/A linked product \(p9\) was deleted/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mark as reviewed' }));
    await waitFor(() => expect(h.updateCampaign).toHaveBeenCalledWith('cmp_a', { attention: [] }));
    await waitFor(() => expect(screen.queryByText(/A linked product \(p9\) was deleted/)).toBeNull());
  });

  it('linked work: a failed section and a feature that is off are never a count', async () => {
    h.getCampaignLinks.mockResolvedValue({
      ...LINKS,
      emailSends: { status: 'failed', error: 'read_failed' },
      plans: { status: 'unavailable', reason: 'feature_off' },
      funnels: { status: 'ok', items: [{ funnelId: 'f1', state: 'linked', name: 'Lead magnet' }] },
    });
    open();
    const region = await screen.findByRole('region', { name: 'Linked work' });
    const row = (label: string): HTMLElement => within(region).getByText(label).closest('li') as HTMLElement;
    await waitFor(() => expect(row('Email sends').textContent).toMatch(/Couldn't load/));
    expect(row('Plans').textContent).toMatch(/Feature off/);
    expect(row('Plans').textContent).not.toMatch(/linked/);
    expect(row('Funnels').textContent).toMatch(/1 linked/);
    expect(row('Funnels').textContent).toMatch(/Lead magnet/);
  });

  it('no funnels row until the host sends that section (ADR 0948 owns the edge)', async () => {
    open();
    const region = await screen.findByRole('region', { name: 'Linked work' });
    await waitFor(() => expect(within(region).getByText('Plans')).toBeTruthy());
    expect(within(region).queryByText('Funnels')).toBeNull();
  });
});
