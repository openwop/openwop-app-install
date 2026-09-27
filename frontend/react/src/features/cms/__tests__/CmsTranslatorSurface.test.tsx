/**
 * ADR 0592 §2 (CMSLU-1) — the workspace-tier TRANSLATOR surface. The ADR 0205
 * D1 grantee could never reach the admin-tier editor; these pin the narrowed
 * mode both directions:
 *   - no grant  → an honest ACCESS empty state (no page list, no editor);
 *   - a grant   → the page list + a detail editor narrowed to granted-locale
 *     overlays: base read-only, no structure/workflow/create/delete controls,
 *     locale tabs limited to base + granted∩configured;
 *   - the save PATCH carries the optimistic-concurrency pin (ADR 0592 §1 —
 *     the CMSL-9 "nothing pins what the PATCH carries" hole, closed here).
 * A failed grant probe renders its own state, never "no access"
 * (absence-is-a-claim).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
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
  myGrant: null as null | { subject: string; locales: string[]; updatedAt: string },
  myGrantRejects: false,
  savedBodies: [] as Array<Record<string, unknown>>,
}));

vi.mock('../cmsClient.js', () => {
  class CmsApiError extends Error {
    constructor(message: string, public readonly code: string | null, public readonly status: number, public readonly details?: Record<string, unknown>) {
      super(message);
    }
  }
  const page = {
    pageId: 'p1', title: 'Landing Page', slug: 'landing', status: 'draft' as const,
    sections: [{ sectionId: 'sec:1', type: 'hero' as const, data: { heading: 'Hi' }, localizations: { es: { heading: 'Hola' } } }],
    version: 3, updatedAt: '2026-01-01T00:00:00Z',
  };
  return {
    CmsApiError,
    SECTION_TYPES: ['hero', 'richText', 'image', 'cta', 'columns'],
    PAGE_STATUSES: ['draft', 'in_review', 'published', 'archived'],
    SYSTEM_SITE_ORG: 'host-site',
    assetUrl: (token: string) => `/asset/${token}`,
    listOrgs: vi.fn(async () => [{ orgId: 'o1', name: 'Org One' }]),
    listPages: vi.fn(async () => [page]),
    getLanguageSettings: vi.fn(async () => ({ baseLocale: 'en', supportedLocales: ['es', 'fr'], autoTranslateOnPublish: false })),
    putLanguageSettings: vi.fn(),
    // ADR 0593 D4 (CMSAU-5) — the editor now reads the page's latest review
    // outcome so a rejection is visible to the submitter. Enrichment: null ⇒
    // no notice, which is what every case below expects.
    getPageReview: vi.fn(async () => null),
    getPage: vi.fn(async () => page),
    getMyLocaleGrant: vi.fn(async () => {
      if (seams.myGrantRejects) throw new Error('boom');
      return seams.myGrant;
    }),
    createPage: vi.fn(), deletePage: vi.fn(),
    savePage: vi.fn(async (_orgId: string, _pageId: string, body: Record<string, unknown>) => {
      seams.savedBodies.push(body);
      return { ...page, version: page.version + 1 };
    }),
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
  listAssets: vi.fn(async () => []),
  uploadAsset: vi.fn(),
  absoluteServeUrl: (u: string) => u,
}));
vi.mock('../../sharing/sharingClient.js', () => ({
  createLink: vi.fn(), listLinks: vi.fn(async () => []), revokeLink: vi.fn(),
  sharedPageUrl: (token: string) => `/shared/${token}`,
}));
vi.mock('../../site/siteConfigClient.js', () => ({
  getSiteConfig: vi.fn(async () => { throw new Error('forbidden'); }),
  putSiteConfig: vi.fn(),
  invalidateFrontPage: vi.fn(),
}));

import { CmsPage } from '../CmsPage.js';
import { savePage } from '../cmsClient.js';

const renderTranslator = (entry = '/cms/translate') => render(
  <MemoryRouter initialEntries={[entry]}>
    <Routes>
      <Route path="/cms/translate" element={<CmsPage translatorSurface />} />
      <Route path="/cms/translate/:routeOrgId/:routePageId" element={<CmsPage translatorSurface />} />
    </Routes>
  </MemoryRouter>,
);

afterEach(() => {
  cleanup();
  seams.myGrant = null;
  seams.myGrantRejects = false;
  seams.savedBodies = [];
  vi.mocked(savePage).mockClear();
});

describe('translator surface — no grant (fail-closed presentation)', () => {
  it('renders the honest access empty state and none of the editor', async () => {
    seams.myGrant = null;
    renderTranslator();
    await waitFor(() => expect(screen.getByText(/No translator access/i)).toBeTruthy());
    // No page list, no create control.
    expect(screen.queryByText('Landing Page')).toBeNull();
    expect(screen.queryByPlaceholderText(/new page title/i)).toBeNull();
  });

  it('a FAILED grant probe renders its own state, never "no access" (absence-is-a-claim)', async () => {
    seams.myGrantRejects = true;
    renderTranslator();
    await waitFor(() => expect(screen.getByText(/Could not check your translation access/i)).toBeTruthy());
    expect(screen.queryByText(/No translator access/i)).toBeNull();
  });
});

describe('translator surface — granted (narrowed editor)', () => {
  it('lists pages without admin menus/create; the detail hides workflow + structure and narrows the locale tabs to the grant', async () => {
    seams.myGrant = { subject: 'u2', locales: ['es'], updatedAt: '2026-01-01T00:00:00Z' };
    renderTranslator();
    await waitFor(() => expect(screen.getByText('Landing Page')).toBeTruthy());
    // No create bar, no per-page overflow menu on the index.
    expect(screen.queryByPlaceholderText(/new page title/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /actions for/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Landing Page' }));
    await waitFor(() => expect(screen.getByText(/\/landing · v3/)).toBeTruthy());

    // The "your translation access" line names the granted locales.
    expect(screen.getByText(/you can translate/i)).toBeTruthy();

    // NO workflow transition buttons (submit/publish are editor/admin verbs).
    expect(screen.queryByRole('button', { name: /^submit$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^publish$/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Editor' }));
    // Locale tabs: base + the GRANTED locale only — fr is configured for the
    // org but outside the grant, so it must not render as a tab.
    await waitFor(() => expect(screen.getByRole('tab', { name: /english.*base/i })).toBeTruthy());
    expect(screen.getByRole('tab', { name: /español/i })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /français/i })).toBeNull();

    // Base content is read-only: the disclosure renders and the heading input
    // is disabled (fieldset-disabled).
    expect(screen.getByText(/base content is read-only/i)).toBeTruthy();
    const heading = screen.getByDisplayValue('Hi') as HTMLInputElement;
    // Fieldset-disabled: the input's own `disabled` attribute stays false, but
    // the ancestor fieldset disables everything inside it (HTML semantics).
    expect((heading.closest('fieldset') as HTMLFieldSetElement | null)?.disabled).toBe(true);

    // No section-structure controls, no add-section, no history/schedule panels.
    expect(screen.queryByRole('button', { name: /move up/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove section/i })).toBeNull();
    expect(screen.queryByLabelText(/add section/i)).toBeNull();
    expect(screen.queryByText(/history/i)).toBeNull();
    expect(screen.queryByLabelText(/publish at/i)).toBeNull();
  });

  it('the save PATCH carries the expectedVersion pin (ADR 0592 §1)', async () => {
    seams.myGrant = { subject: 'u2', locales: ['es'], updatedAt: '2026-01-01T00:00:00Z' };
    renderTranslator('/cms/translate/o1/p1');
    await waitFor(() => expect(screen.getByText(/\/landing · v3/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Editor' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(seams.savedBodies.length).toBe(1));
    // The pin is the LOADED version — the silent-clobber closer.
    expect(seams.savedBodies[0]?.expectedVersion).toBe(3);
    expect(seams.savedBodies[0]?.sections).toBeTruthy();
    // Review F1 (ADR 0592 §Corrections) — the translator payload must OMIT
    // title/tags entirely: the D1 guard 403s a grant-holder on PRESENCE of
    // those fields, so the old {title, sections, tags, pin} echo meant every
    // translator Save was refused by the real route (the mechanism-vs-wiring
    // blind spot: this mock never composed with the guard).
    expect('title' in (seams.savedBodies[0] ?? {})).toBe(false);
    expect('tags' in (seams.savedBodies[0] ?? {})).toBe(false);
  });

  it('renders NO title or tags editors in translator mode (capability ≠ permission — they could only 403)', async () => {
    seams.myGrant = { subject: 'u2', locales: ['es'], updatedAt: '2026-01-01T00:00:00Z' };
    renderTranslator('/cms/translate/o1/p1');
    await waitFor(() => expect(screen.getByText(/\/landing · v3/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Editor' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeTruthy());
    // The page TITLE input (value 'Landing Page') and the tags input must not render.
    expect(screen.queryByDisplayValue('Landing Page')).toBeNull();
    expect(screen.queryByPlaceholderText(/add tag/i)).toBeNull();
  });
});
