import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(),
  listPages: vi.fn(),
  listMediaAssets: vi.fn(),
  getSeo: vi.fn(),
  getSiteConfig: vi.fn(),
}));

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
  api.listPages.mockImplementation(async (orgId: string) => orgId === 'host-site'
    ? [{ pageId: 'page:host-site-home', title: 'Home', slug: 'home', status: 'published' }]
    : []);
  api.listMediaAssets.mockResolvedValue([]);
  api.getSeo.mockResolvedValue(null);
  api.getSiteConfig.mockRejectedValue(new Error('forbidden'));
});

afterEach(cleanup);

describe('PublishingPage system-site scope', () => {
  it('does not expose the reserved scope to a non-superadmin', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Org One' })).toBeTruthy());
    expect(screen.queryByRole('option', { name: /Front page \(public site\)/i })).toBeNull();
  });

  it('offers the public-site scope and honors its deep link for a superadmin', async () => {
    api.getSiteConfig.mockResolvedValue({
      id: 'site', enabled: true, updatedBy: 'admin', updatedAt: '2026-09-19T00:00:00Z',
    });
    renderPage('/publishing?org=host-site&page=page%3Ahost-site-home');

    await waitFor(() => expect(screen.getByRole('option', { name: /Front page \(public site\)/i })).toBeTruthy());
    await waitFor(() => expect(api.listPages).toHaveBeenCalledWith('host-site'));
    expect((screen.getByRole('combobox', { name: /organization/i }) as HTMLSelectElement).value).toBe('host-site');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Home' })).toBeTruthy());
    expect(api.getSeo).toHaveBeenCalledWith('host-site', 'page:host-site-home');
  });
});
