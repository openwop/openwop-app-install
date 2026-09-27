/**
 * ADR 0592 §6 — the FE honesty batch:
 *   CMSLU-2 — in-app exits confirm before discarding unsaved edits (the
 *             browser-level beforeunload was the only guard; "Back to pages"
 *             silently discarded a page of hand-authored overlays);
 *   CMSLU-6 — a FAILED language-settings read renders a warning notice
 *             instead of silently collapsing the editor to monolingual;
 *   CMSLU-7 — backend error CODES map to localized copy (`cmsErrorInfo`);
 *             the `/not enabled/i` English regex is dead — the toggle-off 404
 *             is matched on `code` + `details.feature`, and the translator
 *             grant denial is rebuilt from `details.grantedLocales`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReactNode } from 'react';

vi.mock('../PublicPreviewFrame.js', () => ({
  PublicPreviewFrame: ({ children }: { children: ReactNode }) => <div data-testid="public-preview">{children}</div>,
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  const { makeFeatureAccess } = await import('../../../featureToggles/__testing__/makeFeatureAccess.js');
  return { ...orig, useFeatureAccess: () => makeFeatureAccess() };
});

const seams = vi.hoisted(() => ({
  settingsRejects: false,
  putSettingsError: null as null | Error,
}));

vi.mock('../cmsClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cmsClient.js')>();
  return {
    // REAL error machinery (CmsApiError + cmsErrorInfo) — the thing under test.
    CmsApiError: actual.CmsApiError,
    cmsErrorInfo: actual.cmsErrorInfo,
    SECTION_TYPES: ['hero', 'richText'],
    PAGE_STATUSES: ['draft', 'in_review', 'published', 'archived'],
    SYSTEM_SITE_ORG: 'host-site',
    assetUrl: (token: string) => `/asset/${token}`,
    listOrgs: vi.fn(async () => [{ orgId: 'o1', name: 'Org One' }]),
    listPages: vi.fn(async () => []),
    getLanguageSettings: vi.fn(async () => {
      if (seams.settingsRejects) throw new Error('boom');
      return { baseLocale: 'en', supportedLocales: ['es'], autoTranslateOnPublish: false };
    }),
    putLanguageSettings: vi.fn(async () => {
      if (seams.putSettingsError) throw seams.putSettingsError;
      return { baseLocale: 'en', supportedLocales: ['es'], autoTranslateOnPublish: false };
    }),
    // ADR 0593 D4 (CMSAU-5) — the editor now reads the page's latest review
    // outcome so a rejection is visible to the submitter. Enrichment: null ⇒
    // no notice, which is what every case below expects.
    getPageReview: vi.fn(async () => null),
    getPage: vi.fn(async () => ({
      pageId: 'p1', title: 'Landing Page', slug: 'landing', status: 'draft',
      sections: [{ sectionId: 'sec:1', type: 'hero', data: { heading: 'Hi' }, localizations: { es: { heading: 'Hola' } } }],
      version: 3, updatedAt: '2026-01-01T00:00:00Z',
    })),
    getMyLocaleGrant: vi.fn(async () => null),
    createPage: vi.fn(), deletePage: vi.fn(), savePage: vi.fn(),
    transition: vi.fn(), translateSection: vi.fn(),
    listVersions: vi.fn(async () => []), restoreVersion: vi.fn(),
    schedulePublish: vi.fn(), cancelSchedule: vi.fn(),
    scheduleUnpublish: vi.fn(), cancelScheduleUnpublish: vi.fn(),
    listSharedSections: vi.fn(async () => []), createSharedSection: vi.fn(),
    updateSharedSection: vi.fn(), deleteSharedSection: vi.fn(),
    listSharedSectionPages: vi.fn(async () => []),
    listLocaleGrants: vi.fn(async () => []), putLocaleGrant: vi.fn(),
    setLocalePublish: vi.fn(),
  };
});
vi.mock('../../media/mediaClient.js', () => ({
  listAssets: vi.fn(async () => []), uploadAsset: vi.fn(), absoluteServeUrl: (u: string) => u,
}));
vi.mock('../../sharing/sharingClient.js', () => ({
  createLink: vi.fn(), listLinks: vi.fn(async () => []), revokeLink: vi.fn(),
  sharedPageUrl: (token: string) => `/shared/${token}`,
}));
vi.mock('../../site/siteConfigClient.js', () => ({
  getSiteConfig: vi.fn(async () => { throw new Error('forbidden'); }),
  putSiteConfig: vi.fn(), invalidateFrontPage: vi.fn(),
}));

import { CmsPage } from '../CmsPage.js';
import { CmsLanguageSettings } from '../CmsLanguageSettings.js';
import { CmsApiError, cmsErrorInfo } from '../cmsClient.js';

const renderDetail = () => render(
  <MemoryRouter initialEntries={['/cms/p/o1/p1']}>
    <Routes>
      <Route path="/cms" element={<CmsPage />} />
      <Route path="/cms/p/:routeOrgId/:routePageId" element={<CmsPage />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => { seams.settingsRejects = false; seams.putSettingsError = null; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('cmsErrorInfo — code-mapped error copy (CMSLU-7)', () => {
  it('maps the toggle-off 404 by code + details.feature (no English regex)', () => {
    const e = new CmsApiError('Contenido no habilitado.', 'not_found', 404, { feature: 'cms-localization' });
    expect(cmsErrorInfo(e)).toEqual({ key: 'langNotEnabled' });
  });
  it('rebuilds the translator-grant specificity from details.grantedLocales', () => {
    const e = new CmsApiError('flattened by the envelope localizer', 'forbidden_scope', 403, { grantedLocales: ['pt-BR', 'es'] });
    expect(cmsErrorInfo(e)).toEqual({ key: 'errTranslatorScope', options: { locales: 'pt-BR, es' } });
  });
  it('keeps load-bearing raw messages: unmapped codes return null', () => {
    expect(cmsErrorInfo(new CmsApiError('Publishing is gated on approval…', 'conflict', 409, {}))).toBeNull();
    expect(cmsErrorInfo(new CmsApiError('sections must be an array', 'validation_error', 400, {}))).toBeNull();
    expect(cmsErrorInfo(new Error('plain'))).toBeNull();
  });
});

describe('failed language-settings read (CMSLU-6)', () => {
  it('renders the warning notice instead of silently collapsing to monolingual', async () => {
    seams.settingsRejects = true;
    renderDetail();
    await waitFor(() => expect(screen.getByText(/\/landing · v3/)).toBeTruthy());
    expect(screen.getByText(/language settings could not be read/i)).toBeTruthy();
    // Tabs stay hidden (we don't invent locales) — but the claim is "unknown",
    // never "monolingual".
    fireEvent.click(screen.getByRole('button', { name: 'Editor' }));
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('renders NO notice when the read succeeds (the notice is failure-scoped)', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByText(/\/landing · v3/)).toBeTruthy());
    expect(screen.queryByText(/language settings could not be read/i)).toBeNull();
  });
});

describe('in-app dirty guard (CMSLU-2)', () => {
  it('"Back to pages" confirms before discarding; declining stays on the editor', async () => {
    // The confirm-dialog host is not mounted in this harness, so `confirm()`
    // falls back to window.confirm — a deterministic seam.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderDetail();
    await waitFor(() => expect(screen.getByText(/\/landing · v3/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Editor' }));
    // Dirty the page (title edit).
    fireEvent.change(screen.getByDisplayValue('Landing Page'), { target: { value: 'Landing Page!' } });
    fireEvent.click(screen.getByRole('button', { name: /back to pages/i }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    // Declined → the editor is still open.
    expect(screen.getByText(/\/landing · v3/)).toBeTruthy();

    // Accept → the exit proceeds.
    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: /back to pages/i }));
    await waitFor(() => expect(screen.queryByText(/\/landing · v3/)).toBeNull());
  });

  it('a CLEAN page exits without any prompt', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderDetail();
    await waitFor(() => expect(screen.getByText(/\/landing · v3/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /back to pages/i }));
    await waitFor(() => expect(screen.queryByText(/\/landing · v3/)).toBeNull());
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

describe('CmsLanguageSettings — code-mapped save errors (CMSLU-7)', () => {
  it('a toggle-off 404 renders the localized explanation, not the raw server prose', async () => {
    seams.putSettingsError = new CmsApiError('Content localization is not enabled for this tenant.', 'not_found', 404, { feature: 'cms-localization' });
    render(<CmsLanguageSettings orgId="o1" />);
    await waitFor(() => expect(screen.getByLabelText(/new locale/i)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/new locale/i), { target: { value: 'fr' } });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));
    await waitFor(() => expect(screen.getByText(/ask an administrator to turn on/i)).toBeTruthy());
  });
});
