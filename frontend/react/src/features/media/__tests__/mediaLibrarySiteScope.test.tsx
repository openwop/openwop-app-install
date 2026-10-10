/**
 * ADR 0817 — the Media Library offers the public site's library
 * ("Front page (public site)") to a site admin, and only to a site admin.
 *
 * Sabotage: offer the scope to everyone → case 3; never recognise a site admin
 * → cases 1 and 2; drop the `host-site` keep in `loadOrgs` → case 2; drop the
 * non-admin fallback → case 3.
 *
 * Note: a `?org=host-site` link reads `host-site` ON MOUNT, before the
 * site-admin probe answers, so "was called with host-site" alone is true for
 * everyone; and a controlled <select> whose value matches no option shows the
 * first option, so its `.value` cannot witness the fallback. Both cases assert
 * the TERMINAL read instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as Client from '../mediaClient.js';
import type * as SiteClient from '../../site/siteConfigClient.js';
import type { SiteConfig } from '../../site/siteConfigClient.js';

const { listOrgs, listCollections, listAssets, getSiteConfig } = vi.hoisted(() => ({
  listOrgs: vi.fn<typeof Client.listOrgs>(),
  listCollections: vi.fn<typeof Client.listCollections>(),
  listAssets: vi.fn<typeof Client.listAssets>(),
  getSiteConfig: vi.fn<typeof SiteClient.getSiteConfig>(),
}));
const SITE: SiteConfig = { id: 'site', enabled: true, updatedBy: 'x', updatedAt: '2026-10-04T00:00:00Z' };
vi.mock('../mediaClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs, listCollections, listAssets,
}));
vi.mock('../../site/siteConfigClient.js', () => ({ getSiteConfig }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { MediaLibraryPage } from '../MediaLibraryPage.js';

const mount = async (path = '/media'): Promise<void> => {
  render(<MemoryRouter initialEntries={[path]}><MediaLibraryPage /></MemoryRouter>);
  await act(async () => {});
};
const scopeOptions = (): string[] =>
  Array.from(screen.getByRole<HTMLSelectElement>('combobox', { name: /organization/i }).options).map((o) => o.value);

beforeEach(() => {
  vi.resetAllMocks();
  listOrgs.mockResolvedValue([{ orgId: 'org1', name: 'Org One' }]);
  listCollections.mockResolvedValue([]);
  listAssets.mockResolvedValue([]);
});
afterEach(cleanup);

describe('ADR 0817 — the public site scope in the Media Library', () => {
  it('a site admin gets the scope ahead of their own orgs', async () => {
    getSiteConfig.mockResolvedValue(SITE);
    await mount();
    await waitFor(() => expect(scopeOptions()).toEqual(['host-site', 'org1']));
    expect(screen.getByRole('option', { name: 'Front page (public site)' })).toBeTruthy();
  });

  it('a site admin\'s ?org=host-site deep link reads the system site\'s library', async () => {
    getSiteConfig.mockResolvedValue(SITE);
    await mount('/media?org=host-site');
    await waitFor(() => expect(scopeOptions()).toEqual(['host-site', 'org1'])); // probe settled
    expect(listAssets).toHaveBeenLastCalledWith('host-site', {});
    // The deep link HELD: an admin's host-site link never fell through to their own org.
    expect(listAssets).not.toHaveBeenCalledWith('org1', expect.anything());
  });

  it('anyone else gets only their orgs, and a host-site deep link falls back', async () => {
    getSiteConfig.mockRejectedValue(new Error('403'));
    await mount('/media?org=host-site');
    await waitFor(() => expect(scopeOptions()).toEqual(['org1']));
    // The fallback actually happened: org1's library is what was read last.
    await waitFor(() => expect(listAssets).toHaveBeenLastCalledWith('org1', {}));
  });
});
