/**
 * ADR 0748 correction (2026-09-27) — deleting a LIVE page is admin tier on the
 * server (like unpublish). The editor offers Delete to everyone (authority is
 * enforced server-side, as for publish/unpublish), so it must SAY what is at stake
 * before, and explain the remedy after an editor's 403. A generic "no permission"
 * toast leaves the editor with no next step.
 *
 * The caller is an EDITOR (no `host:members:manage`) and the 403 is the real
 * `CmsApiError` envelope shape. Sabotage-witnessed (/grade-tests w17): the plain
 * confirm body for a live page reds case 1; treating every page as live reds
 * case 2; dropping the live-403 remedy copy reds case 1.
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
  status: 'published' as string,
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: ui.confirm }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: ui.toastError } }));
vi.mock('../cmsClient.js', async (orig) => {
  const real = await orig<typeof import('../cmsClient.js')>();
  return {
  SECTION_TYPES: ['hero'],
  PAGE_STATUSES: ['draft', 'in_review', 'published', 'archived'],
  SYSTEM_SITE_ORG: 'host-site',
  assetUrl: (token: string) => `/asset/${token}`,
  cmsErrorInfo: real.cmsErrorInfo,
  CmsApiError: real.CmsApiError,
  listOrgs: vi.fn(async () => [{ orgId: 'o1', name: 'Org One' }]),
  listPages: vi.fn(async () => [
    { pageId: 'p1', title: 'Live Page', slug: 'live', status: ui.status, sections: [], version: 1, updatedAt: '2026-01-01T00:00:00Z' },
  ]),
  getLanguageSettings: vi.fn(async () => ({ baseLocale: 'en', supportedLocales: [], autoTranslateOnPublish: false })),
  putLanguageSettings: vi.fn(), getPageReview: vi.fn(async () => null), getPage: vi.fn(),
  createPage: vi.fn(),
  // What the server answers an editor deleting a live page (admin tier).
  deletePage: vi.fn(async () => { throw new real.CmsApiError('Missing required scope: host:members:manage', 'forbidden_scope', 403, { requiredScope: 'host:members:manage' }); }), savePage: vi.fn(), transition: vi.fn(), translateSection: vi.fn(),
  listVersions: vi.fn(async () => []), restoreVersion: vi.fn(),
  schedulePublish: vi.fn(), cancelSchedule: vi.fn(),
  listSharedSections: vi.fn(async () => []), createSharedSection: vi.fn(), updateSharedSection: vi.fn(),
  deleteSharedSection: vi.fn(), listSharedSectionPages: vi.fn(async () => []),
  listLocaleGrants: vi.fn(async () => []), putLocaleGrant: vi.fn(), setLocalePublish: vi.fn(), getTranslationStatus: vi.fn(async () => ({ locales: [], sections: {}, counts: {} })), confirmTranslationSource: vi.fn(),
  };
});
// ADR 0836 — the editor reads the caller's org access: an EDITOR here (no admin
// tier), the caller the server 403s on a live delete.
vi.mock('../../../client/accessClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), listMembers: vi.fn(async () => []), getEffectiveAccess: vi.fn(async () => ({ roles: ['editor'], scopes: ['workspace:read', 'workspace:write'], basis: 'member' })) }));
vi.mock('../../media/mediaClient.js', () => ({ listAssets: vi.fn(async () => []), uploadAsset: vi.fn(), absoluteServeUrl: (u: string) => u }));
vi.mock('../../sharing/sharingClient.js', () => ({ createLink: vi.fn(), listLinks: vi.fn(async () => []), revokeLink: vi.fn(), sharedPageUrl: (t: string) => `/shared/${t}` }));
// The Page tab reads and writes the page's search and social record.
vi.mock('../../publishing/publishingClient.js', () => ({ getSeo: vi.fn(async () => null), putSeo: vi.fn(async (_o: string, _p: string, seo: unknown) => seo) }));
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
    expect(ui.confirm.mock.calls[0]![0].body).toMatch(/cannot be undone/i);
    expect(ui.confirm.mock.calls[0]![0].body).not.toMatch(/live/i);
  });
});
