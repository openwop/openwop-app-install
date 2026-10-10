/**
 * ADR 0836 D3 (row-22 grade-ux B2/H1) — a SCHEDULED draft in the hands of
 * someone who is not an admin. Their save cancels the admin's scheduled publish,
 * so it must be a decision, never a keystroke pause: the page says so up front,
 * autosave is off, Save asks first, and the admin-only schedule controls are not
 * offered. An admin keeps autosave (their save re-pins the schedule).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReactNode } from 'react';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

vi.mock('../PublicPreviewFrame.js', () => ({
  PublicPreviewFrame: ({ children }: { children: ReactNode }) => <div data-testid="public-preview">{children}</div>,
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));
const ui = vi.hoisted(() => {
  const page = {
    pageId: 'p1', title: 'Launch post', slug: 'p', status: 'draft', version: 1, updatedAt: '2026-01-01T00:00:00Z',
    scheduledPublishAt: '2030-01-01T09:00:00.000Z', scheduledPublishVersion: 1,
    sections: [
      { sectionId: 'sec:a', type: 'richText', data: { heading: 'The story we were sold', text: 'Body A' } },
      { sectionId: 'sec:b', type: 'richText', data: { heading: 'Where it shows up', text: 'Body B' } },
    ],
  };
  return {
    page,
    confirm: vi.fn(async () => true),
    listVersions: vi.fn(async (): Promise<unknown[]> => []),
    rewriteSection: vi.fn(async (_org: string, input: { data: Record<string, unknown> }) => ({ ...input.data, text: 'Short body.' })),
    savePage: vi.fn(async (_org: string, _id: string, patch: Record<string, unknown>) => {
      // Like the server: a `new:` section gets a minted `sec:` id on save.
      const sections = Array.isArray(patch.sections)
        ? (patch.sections as Array<{ sectionId: string }>).map((x, i) => (x.sectionId.startsWith('new:') ? { ...x, sectionId: `sec:minted-${i}` } : x))
        : page.sections;
      return { ...page, ...patch, sections, version: page.version + 1 };
    }),
    transition: vi.fn(async () => page),
    scopes: ['workspace:read', 'workspace:write'] as string[],
  };
});
vi.mock('../../../ui/confirm.js', () => ({ confirm: ui.confirm }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../cmsClient.js', () => ({
  SECTION_TYPES: ['hero'],
  PAGE_STATUSES: ['draft', 'in_review', 'published', 'archived'],
  SYSTEM_SITE_ORG: 'host-site',
  assetUrl: (token: string) => `/asset/${token}`,
  cmsErrorInfo: () => null,
  CmsApiError: class extends Error {},
  listOrgs: vi.fn(async () => [{ orgId: 'o1', name: 'Org One' }]),
  listPages: vi.fn(async () => [ui.page]),
  getLanguageSettings: vi.fn(async () => ({ baseLocale: 'en', supportedLocales: [], autoTranslateOnPublish: false })),
  putLanguageSettings: vi.fn(), getPageReview: vi.fn(async () => null), getPage: vi.fn(async () => ui.page),
  createPage: vi.fn(), deletePage: vi.fn(), savePage: ui.savePage, transition: ui.transition, translateSection: vi.fn(),
  listVersions: ui.listVersions, restoreVersion: vi.fn(), rewriteSection: ui.rewriteSection,
  schedulePublish: vi.fn(), cancelSchedule: vi.fn(),
  listSharedSections: vi.fn(async () => []), createSharedSection: vi.fn(), updateSharedSection: vi.fn(),
  deleteSharedSection: vi.fn(), listSharedSectionPages: vi.fn(async () => []),
  listLocaleGrants: vi.fn(async () => []), putLocaleGrant: vi.fn(), setLocalePublish: vi.fn(), getTranslationStatus: vi.fn(async () => ({ locales: [], sections: {}, counts: {} })), confirmTranslationSource: vi.fn(),
}));
vi.mock('../../../client/accessClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listMembers: vi.fn(async () => []),
  getEffectiveAccess: vi.fn(async () => ({ roles: [], scopes: ui.scopes, basis: 'member' })),
}));
vi.mock('../../media/mediaClient.js', () => ({ listAssets: vi.fn(async () => []), uploadAsset: vi.fn(), absoluteServeUrl: (u: string) => u }));
vi.mock('../../sharing/sharingClient.js', () => ({ createLink: vi.fn(), listLinks: vi.fn(async () => []), revokeLink: vi.fn(), sharedPageUrl: (t: string) => `/shared/${t}` }));
// The Page tab reads and writes the page's search and social record.
const seoApi = vi.hoisted(() => ({
  getSeo: vi.fn(async (): Promise<Record<string, unknown> | null> => ({ metaDescription: 'Old description', noindex: false })),
  putSeo: vi.fn(async (_o: string, _p: string, seo: unknown) => seo),
}));
vi.mock('../../publishing/publishingClient.js', () => seoApi);
vi.mock('../../site/siteConfigClient.js', () => ({ getSiteConfig: vi.fn(async () => { throw new Error('forbidden'); }), putSiteConfig: vi.fn(), invalidateFrontPage: vi.fn() }));

import { CmsPage } from '../CmsPage.js';

afterEach(() => { cleanup(); ui.savePage.mockClear(); ui.confirm.mockClear(); ui.scopes = ['workspace:read', 'workspace:write']; });

function renderDetail(): void {
  render(
    <MemoryRouter initialEntries={['/cms/p/o1/p1']}>
      <Routes><Route path="/cms/p/:routeOrgId/:routePageId" element={<CmsPage />} /></Routes>
    </MemoryRouter>,
  );
}
async function edit(): Promise<void> {
  fireEvent.click(await within(await screen.findByTestId('public-preview', {}, { timeout: 3000 })).findByRole('button', { name: 'Edit “The story we were sold”' }));
  const card = screen.getByRole('group', { name: 'Editing “The story we were sold”' });
  fireEvent.change(within(card).getByDisplayValue('The story we were sold'), { target: { value: 'Editor copy' } });
}

describe('a scheduled draft, edited by a non-admin (ADR 0836 D3)', () => {
  it('says up front that saving cancels the schedule, and offers no admin-only schedule control', async () => {
    renderDetail();
    expect(await screen.findByText(/Saving changes cancels the schedule/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('tab', { name: 'Page' }, { timeout: 3000 }));
    // The schedule is SHOWN (the chip), read-only: the cancel control is admin-only.
    expect(await screen.findByText(/^Publishes /)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel schedule' })).toBeNull();
  });

  it('does not autosave; Save asks before cancelling the launch', async () => {
    renderDetail();
    await screen.findByText(/Saving changes cancels the schedule/);
    await edit();
    await new Promise((r) => setTimeout(r, 2000));
    expect(ui.savePage).not.toHaveBeenCalled();
    ui.confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(ui.confirm).toHaveBeenCalledTimes(1));
    expect((ui.confirm.mock.calls[0] as unknown as [{ title: string }])[0].title).toMatch(/cancel the scheduled publish/i);
    expect(ui.savePage).not.toHaveBeenCalled();
  });
});

describe('a scheduled draft, edited by an admin', () => {
  it('autosaves as usual (the server re-pins the schedule) and shows the cancel control', async () => {
    ui.scopes = ['workspace:read', 'workspace:write', 'host:members:manage'];
    renderDetail();
    fireEvent.click(await screen.findByRole('tab', { name: 'Page' }, { timeout: 3000 }));
    expect(await screen.findByRole('button', { name: 'Cancel schedule' })).toBeTruthy();
    expect(screen.queryByText(/Saving changes cancels the schedule/)).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Edit' }));
    await edit();
    await waitFor(() => expect(ui.savePage).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(ui.confirm).not.toHaveBeenCalled();
  });
});
