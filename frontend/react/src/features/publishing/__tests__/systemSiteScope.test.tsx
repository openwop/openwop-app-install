/**
 * PublishingPage system-site scope (#4807, fix e6df3114e) — the reserved
 * `host-site` scope (the deployment's public site, `cms/siteOrg.ts`) exists in
 * the picker ONLY for a caller the superadmin probe (`getSiteConfig`) confirms;
 * a `?org=host-site` deep link is honoured for that caller; and a page's SEO is
 * NEVER read under a scope it was not listed in.
 *
 * The last is a REAL incident, not a flake: the gate measured
 * `getSeo('org:one', 'page:host-site-home')` — the deep-linked scope's pages
 * landed, the org read fell back to the first workspace, and on that render the
 * previous scope's list was still in state. Case 3 forces that ordering with
 * held promises.
 *
 * Sabotage-witnessed (/grade-tests w52): dropping the `loadedPages.orgId ===
 * orgId` scope filter, offering the scope without the probe (or on a FAILED
 * probe), not restoring the deep link, and reading SEO under another scope each
 * turn a case red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { CmsPageRef, MediaAssetRef, Org, PageSeo } from '../publishingClient.js';
import type { SiteConfig } from '../../site/siteConfigClient.js';

const api = vi.hoisted(() => ({
  listOrgs: vi.fn<() => Promise<Org[]>>(),
  listPages: vi.fn<(orgId: string) => Promise<CmsPageRef[]>>(),
  listMediaAssets: vi.fn<(orgId: string) => Promise<MediaAssetRef[]>>(),
  getSeo: vi.fn<(orgId: string, pageId: string) => Promise<PageSeo | null>>(),
  getSiteConfig: vi.fn<() => Promise<SiteConfig>>(),
}));

const SITE: SiteConfig = { id: 'site', enabled: true, updatedBy: 'admin', updatedAt: '2026-09-19T00:00:00Z' };
const HOME: CmsPageRef = { pageId: 'page:host-site-home', title: 'Home', slug: 'home', status: 'published' };

vi.mock('../publishingClient.js', () => ({
  listOrgs: api.listOrgs,
  listPages: api.listPages,
  listMediaAssets: api.listMediaAssets,
  getSeo: api.getSeo,
  putSeo: vi.fn(),
  feedUrl: (orgId: string) => `/feed/${orgId}`,
  sitemapUrl: (orgId: string) => `/sitemap/${orgId}`,
  publicPageUrl: (orgId: string, slug: string) => `/public/${orgId}/${slug}`,
}));

vi.mock('../../site/siteConfigClient.js', () => ({
  getSiteConfig: api.getSiteConfig,
}));

import { PublishingPage } from '../PublishingPage.js';

function renderPage(entry = '/publishing'): void {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes><Route path="/publishing" element={<PublishingPage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listOrgs.mockResolvedValue([{ orgId: 'org:one', name: 'Org One' }]);
  api.listPages.mockImplementation(async (orgId: string) => orgId === 'host-site' ? [HOME] : []);
  api.listMediaAssets.mockResolvedValue([]);
  api.getSeo.mockResolvedValue(null);
  api.getSiteConfig.mockRejectedValue(new Error('forbidden'));
});

afterEach(cleanup);

describe('PublishingPage system-site scope', () => {
  it('does not expose the reserved scope to a non-superadmin', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Org One' })).toBeTruthy());
    // The probe has SETTLED (refused) before the absence is read — not still loading.
    await waitFor(() => expect(api.getSiteConfig).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('option', { name: /Front page \(public site\)/i })).toBeNull();
    const picker = screen.getByRole('combobox', { name: /organization/i }) as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.value)).toEqual(['org:one']);
    expect(api.listPages).not.toHaveBeenCalledWith('host-site');
  });

  it('offers the public-site scope and honors its deep link for a superadmin', async () => {
    api.getSiteConfig.mockResolvedValue(SITE);
    renderPage('/publishing?org=host-site&page=page%3Ahost-site-home');

    await waitFor(() => expect(screen.getByRole('option', { name: /Front page \(public site\)/i })).toBeTruthy());
    await waitFor(() => expect(api.listPages).toHaveBeenCalledWith('host-site'));
    expect((screen.getByRole('combobox', { name: /organization/i }) as HTMLSelectElement).value).toBe('host-site');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Home' })).toBeTruthy());
    await waitFor(() => expect(api.getSeo).toHaveBeenCalledWith('host-site', 'page:host-site-home'));
    expect(api.getSeo).not.toHaveBeenCalledWith('org:one', expect.anything());
  });

  // The order that went red in a loaded gate, forced: the deep-linked scope's
  // pages land first, the org read then falls back to the first workspace, and
  // the superadmin probe restores the scope last. The fallback render must not
  // read the deep-linked page's SEO under the workspace's id.
  it('never reads a page under a scope it was not listed in', async () => {
    let releaseOrgs!: () => void;
    let releaseSite!: () => void;
    api.listOrgs.mockReturnValue(new Promise((r) => { releaseOrgs = () => r([{ orgId: 'org:one', name: 'Org One' }]); }));
    api.getSiteConfig.mockReturnValue(new Promise((r) => { releaseSite = () => r(SITE); }));
    renderPage('/publishing?org=host-site&page=page%3Ahost-site-home');

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Home' })).toBeTruthy());
    await act(async () => { releaseOrgs(); });
    await waitFor(() => expect(api.listPages).toHaveBeenCalledWith('org:one'));
    await act(async () => { releaseSite(); });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Home' })).toBeTruthy());

    expect(api.getSeo).not.toHaveBeenCalledWith('org:one', expect.anything());
    expect(api.getSeo).toHaveBeenLastCalledWith('host-site', 'page:host-site-home');
  });
});
