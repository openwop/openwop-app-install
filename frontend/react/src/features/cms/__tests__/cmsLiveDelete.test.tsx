/**
 * ADR 0748 correction (2026-09-27) — deleting a LIVE page is admin tier on the
 * server (like unpublish). The editor offers Delete to everyone (authority is
 * enforced server-side, as for publish/unpublish), so it must SAY what is at stake
 * before, and explain the remedy after an editor's 403. A generic "no permission"
 * toast leaves the editor with no next step.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReactNode } from 'react';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

vi.mock('../PublicPreviewFrame.js', () => ({
  PublicPreviewFrame: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));
const ui = vi.hoisted(() => ({
  confirm: vi.fn(async (_opts: { title: string; body?: string }) => true),
  toastError: vi.fn(),
  deletePage: vi.fn(async () => { throw Object.assign(new Error('Missing required scope: host:members:manage'), { code: 'forbidden_scope' }); }),
  status: 'published' as string,
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: ui.confirm }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: ui.toastError } }));
vi.mock('../cmsClient.js', () => ({
  SECTION_TYPES: ['hero'],
  PAGE_STATUSES: ['draft', 'in_review', 'published', 'archived'],
  SYSTEM_SITE_ORG: 'host-site',
  assetUrl: (token: string) => `/asset/${token}`,
  cmsErrorInfo: () => null,
  listOrgs: vi.fn(async () => [{ orgId: 'o1', name: 'Org One' }]),
  listPages: vi.fn(async () => [
    { pageId: 'p1', title: 'Live Page', slug: 'live', status: ui.status, sections: [], version: 1, updatedAt: '2026-01-01T00:00:00Z' },
  ]),
  getLanguageSettings: vi.fn(async () => ({ baseLocale: 'en', supportedLocales: [], autoTranslateOnPublish: false })),
  putLanguageSettings: vi.fn(), getPageReview: vi.fn(async () => null), getPage: vi.fn(),
  createPage: vi.fn(), deletePage: ui.deletePage, savePage: vi.fn(), transition: vi.fn(), translateSection: vi.fn(),
  listVersions: vi.fn(async () => []), restoreVersion: vi.fn(),
  schedulePublish: vi.fn(), cancelSchedule: vi.fn(),
  listSharedSections: vi.fn(async () => []), createSharedSection: vi.fn(), updateSharedSection: vi.fn(),
  deleteSharedSection: vi.fn(), listSharedSectionPages: vi.fn(async () => []),
  listLocaleGrants: vi.fn(async () => []), putLocaleGrant: vi.fn(), setLocalePublish: vi.fn(),
}));
vi.mock('../../../client/accessClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), listMembers: vi.fn(async () => []) }));
vi.mock('../../media/mediaClient.js', () => ({ listAssets: vi.fn(async () => []), uploadAsset: vi.fn(), absoluteServeUrl: (u: string) => u }));
vi.mock('../../sharing/sharingClient.js', () => ({ createLink: vi.fn(), listLinks: vi.fn(async () => []), revokeLink: vi.fn(), sharedPageUrl: (t: string) => `/shared/${t}` }));
vi.mock('../../site/siteConfigClient.js', () => ({ getSiteConfig: vi.fn(async () => { throw new Error('forbidden'); }), putSiteConfig: vi.fn(), invalidateFrontPage: vi.fn() }));

import { CmsPage } from '../CmsPage.js';

afterEach(() => { cleanup(); ui.confirm.mockClear(); ui.toastError.mockClear(); });

async function deleteFromMenu(): Promise<void> {
  render(
    <MemoryRouter initialEntries={['/cms']}>
      <Routes><Route path="/cms" element={<CmsPage />} /></Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText('Live Page')).toBeTruthy());
  fireEvent.click(screen.getAllByRole('button', { name: /Live Page/ }).find((b) => b.getAttribute('aria-haspopup'))!);
  fireEvent.click(await screen.findByRole('menuitem', { name: /Delete/ }));
  await waitFor(() => expect(ui.confirm).toHaveBeenCalled());
}

describe('CMS delete of a live page (ADR 0748 correction)', () => {
  it('the confirm says the page is live and that only an admin can delete it; an editor 403 explains the remedy', async () => {
    ui.status = 'published';
    await deleteFromMenu();
    expect(ui.confirm.mock.calls[0]![0].body).toMatch(/live/i);
    expect(ui.confirm.mock.calls[0]![0].body).toMatch(/admin/i);
    await waitFor(() => expect(ui.toastError).toHaveBeenCalled());
    expect(String(ui.toastError.mock.calls[0]![0])).toMatch(/Unpublish it first, or ask an admin/);
  });

  it('a draft keeps the plain "cannot be undone" confirm', async () => {
    ui.status = 'draft';
    await deleteFromMenu();
    expect(ui.confirm.mock.calls[0]![0].body).not.toMatch(/live/i);
  });
});
