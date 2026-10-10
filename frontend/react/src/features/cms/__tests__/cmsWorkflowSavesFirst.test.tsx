/**
 * A workflow action acts on what the editor shows. `transition` publishes the
 * SAVED page and its reply replaced the editor state, so Publish with unsaved
 * edits published the old content and silently dropped the edits. The editor
 * now saves first, and a failed save stops the transition.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReactNode } from 'react';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

vi.mock('../PublicPreviewFrame.js', () => ({
  PublicPreviewFrame: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));
const ui = vi.hoisted(() => {
  const page = { pageId: 'p1', title: 'Old title', slug: 'p', status: 'draft', sections: [], version: 1, updatedAt: '2026-01-01T00:00:00Z' };
  return {
    page,
    savePage: vi.fn(async (_org: string, _id: string, patch: { title?: string }) => ({ ...page, title: patch.title ?? page.title, version: 2 })),
    transition: vi.fn(async () => ({ ...page, title: 'New title', status: 'published', version: 2 })),
  };
});
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(async () => true) }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
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
  listVersions: vi.fn(async () => []), restoreVersion: vi.fn(),
  schedulePublish: vi.fn(), cancelSchedule: vi.fn(),
  listSharedSections: vi.fn(async () => []), createSharedSection: vi.fn(), updateSharedSection: vi.fn(),
  deleteSharedSection: vi.fn(), listSharedSectionPages: vi.fn(async () => []),
  listLocaleGrants: vi.fn(async () => []), putLocaleGrant: vi.fn(), setLocalePublish: vi.fn(), getTranslationStatus: vi.fn(async () => ({ locales: [], sections: {}, counts: {} })), confirmTranslationSource: vi.fn(),
}));
// ADR 0836 — the editor reads the caller's org access (admin tier): an admin here.
vi.mock('../../../client/accessClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), listMembers: vi.fn(async () => []), getEffectiveAccess: vi.fn(async () => ({ roles: ['owner'], scopes: ['workspace:read', 'workspace:write', 'host:members:manage'], basis: 'member' })) }));
vi.mock('../../media/mediaClient.js', () => ({ listAssets: vi.fn(async () => []), uploadAsset: vi.fn(), absoluteServeUrl: (u: string) => u }));
vi.mock('../../sharing/sharingClient.js', () => ({ createLink: vi.fn(), listLinks: vi.fn(async () => []), revokeLink: vi.fn(), sharedPageUrl: (t: string) => `/shared/${t}` }));
// The Page tab reads and writes the page's search and social record.
vi.mock('../../publishing/publishingClient.js', () => ({ getSeo: vi.fn(async () => null), putSeo: vi.fn(async (_o: string, _p: string, seo: unknown) => seo) }));
vi.mock('../../site/siteConfigClient.js', () => ({ getSiteConfig: vi.fn(async () => { throw new Error('forbidden'); }), putSiteConfig: vi.fn(), invalidateFrontPage: vi.fn() }));

import { CmsPage } from '../CmsPage.js';

afterEach(() => { cleanup(); ui.savePage.mockClear(); ui.transition.mockClear(); });

async function editTitleThenPublish(): Promise<void> {
  render(
    <MemoryRouter initialEntries={['/cms/p/o1/p1']}>
      <Routes><Route path="/cms/p/:routeOrgId/:routePageId" element={<CmsPage />} /></Routes>
    </MemoryRouter>,
  );
  // Generous waits: this suite runs inside a full gate on a shared machine.
  fireEvent.click(await screen.findByRole('tab', { name: 'Page' }, { timeout: 3000 }));
  const title = await screen.findByDisplayValue('Old title', {}, { timeout: 3000 });
  fireEvent.change(title, { target: { value: 'New title' } });
  fireEvent.click(screen.getByRole('button', { name: /^Publish$/ }));
  // Publish opens the review checklist first (ADR 0828 phase 3); confirm it.
  const dialog = await screen.findByRole('dialog', { name: 'Review before you go on' }, { timeout: 3000 });
  fireEvent.click(within(dialog).getByRole('button', { name: /^Publish$/ }));
}

describe('a workflow action saves unsaved edits first', () => {
  it('Publish with an edited title saves it, then publishes', async () => {
    await editTitleThenPublish();
    // Save then publish is two round trips; allow for a loaded test runner.
    await waitFor(() => expect(ui.transition).toHaveBeenCalled(), { timeout: 3000 });
    expect(ui.savePage).toHaveBeenCalledTimes(1);
    expect(ui.savePage.mock.calls[0]![2]).toMatchObject({ title: 'New title', expectedVersion: 1 });
    expect(ui.savePage.mock.invocationCallOrder[0]!).toBeLessThan(ui.transition.mock.invocationCallOrder[0]!);
  });

  it('a failed save stops the publish', async () => {
    ui.savePage.mockRejectedValueOnce(new Error('validation failed'));
    await editTitleThenPublish();
    await waitFor(() => expect(ui.savePage).toHaveBeenCalled(), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 30));
    expect(ui.transition).not.toHaveBeenCalled();
  });

  it('a to-do left in the text blocks Publish in the checklist, and Show me selects that section', async () => {
    ui.page.sections = [{ sectionId: 'sec:t', type: 'richText', data: { heading: 'Examples', text: '[TODO: an example]' } }] as never;
    try {
      render(
        <MemoryRouter initialEntries={['/cms/p/o1/p1']}>
          <Routes><Route path="/cms/p/:routeOrgId/:routePageId" element={<CmsPage />} /></Routes>
        </MemoryRouter>,
      );
      fireEvent.click(await screen.findByRole('button', { name: /^Publish$/ }, { timeout: 3000 }));
      const dialog = await screen.findByRole('dialog', { name: 'Review before you go on' });
      const confirmBtn = within(dialog).getByRole('button', { name: 'Fix 1 first' }) as HTMLButtonElement;
      expect(confirmBtn.disabled).toBe(true);
      expect(within(dialog).getByText(/A to-do is left in .Examples./)).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('button', { name: /^Show me: A to-do is left in .Examples./ }));
      expect(screen.queryByRole('dialog', { name: 'Review before you go on' })).toBeNull();
      expect(ui.transition).not.toHaveBeenCalled();
    } finally {
      ui.page.sections = [] as never;
    }
  });
});
