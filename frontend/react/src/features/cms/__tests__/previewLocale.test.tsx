/**
 * ADR 0592 §5 (CMSLU-5) — preview-in-locale. Unit-pins the client-side mirror
 * of the normative exact→family→base merge (a divergent preview is a preview
 * LIE), and component-pins the editor lane: choosing a preview locale renders
 * the draft overlay content in the Public preview with the honesty badge
 * naming how many sections fall back. The public reader is untouched by this
 * feature (client-side resolution only — the delivery lanes keep their
 * negotiation tests).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReactNode } from 'react';
import { resolvePreviewSection, resolvePreviewSections } from '../resolvePreviewLocale.js';
import type { Section } from '../cmsClient.js';

vi.mock('../PublicPreviewFrame.js', () => ({
  PublicPreviewFrame: ({ children }: { children: ReactNode }) => <div data-testid="public-preview">{children}</div>,
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  const { makeFeatureAccess } = await import('../../../featureToggles/__testing__/makeFeatureAccess.js');
  return { ...orig, useFeatureAccess: () => makeFeatureAccess() };
});
vi.mock('../cmsClient.js', () => ({
  SECTION_TYPES: ['hero', 'richText'],
  PAGE_STATUSES: ['draft', 'in_review', 'published', 'archived'],
  SYSTEM_SITE_ORG: 'host-site',
  assetUrl: (token: string) => `/asset/${token}`,
  listOrgs: vi.fn(async () => [{ orgId: 'o1', name: 'Org One' }]),
  listPages: vi.fn(async () => []),
  getLanguageSettings: vi.fn(async () => ({ baseLocale: 'en', supportedLocales: ['es', 'fr'], autoTranslateOnPublish: false })),
  putLanguageSettings: vi.fn(),
  // ADR 0593 D4 (CMSAU-5) — the editor now reads the page's latest review
  // outcome so a rejection is visible to the submitter. Enrichment: null ⇒
  // no notice, which is what every case below expects.
  getPageReview: vi.fn(async () => null),
  getPage: vi.fn(async () => ({
    pageId: 'p1', title: 'Landing', slug: 'landing', status: 'draft',
    sections: [
      { sectionId: 'sec:1', type: 'hero', data: { heading: 'Hello' }, localizations: { es: { heading: 'Hola' }, fr: { heading: 'Bonjour' } } },
      { sectionId: 'sec:2', type: 'hero', data: { heading: 'Untranslated' } },
    ],
    localePublishState: { fr: 'draft' },
    version: 1, updatedAt: '2026-01-01T00:00:00Z',
  })),
  createPage: vi.fn(), deletePage: vi.fn(), savePage: vi.fn(),
  transition: vi.fn(), translateSection: vi.fn(),
  listVersions: vi.fn(async () => []), restoreVersion: vi.fn(),
  schedulePublish: vi.fn(), cancelSchedule: vi.fn(),
  scheduleUnpublish: vi.fn(), cancelScheduleUnpublish: vi.fn(),
  listSharedSections: vi.fn(async () => []), createSharedSection: vi.fn(),
  updateSharedSection: vi.fn(), deleteSharedSection: vi.fn(),
  listSharedSectionPages: vi.fn(async () => []),
  listLocaleGrants: vi.fn(async () => []), putLocaleGrant: vi.fn(),
  getMyLocaleGrant: vi.fn(async () => null),
  setLocalePublish: vi.fn(),
}));
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

afterEach(cleanup);

const sec = (over: Partial<Section>): Section => ({ sectionId: 's1', type: 'hero', data: { heading: 'Base' }, ...over });

describe('resolvePreviewSection — the normative merge, mirrored', () => {
  it('base locale → base data verbatim', () => {
    const r = resolvePreviewSection(sec({ localizations: { es: { heading: 'Hola' } } }), 'en', 'en');
    expect(r.data.heading).toBe('Base');
    expect(r.fellBack).toBe(false);
  });
  it('exact-locale overlay wins (shallow field replace)', () => {
    const r = resolvePreviewSection(sec({ data: { heading: 'Base', sub: 'S' }, localizations: { es: { heading: 'Hola' } } }), 'es', 'en');
    expect(r.data).toEqual({ heading: 'Hola', sub: 'S' });
    expect(r.fellBack).toBe(false);
  });
  it('language-family fallback (pt-BR → pt)', () => {
    const r = resolvePreviewSection(sec({ localizations: { pt: { heading: 'Olá' } } }), 'pt-BR', 'en');
    expect(r.data.heading).toBe('Olá');
    expect(r.fellBack).toBe(false);
  });
  it('no overlay → base, marked as fallen back (never throws, never invents)', () => {
    const r = resolvePreviewSection(sec({}), 'fr', 'en');
    expect(r.data.heading).toBe('Base');
    expect(r.fellBack).toBe(true);
  });
  it('review F5 — a WITHHELD locale resolves as delivery serves it: overlay stripped pre-merge, counted as fallback', () => {
    const out = resolvePreviewSections(
      [sec({ sectionId: 'a', localizations: { es: { heading: 'Hola' } } })],
      'es', 'en',
      { withheld: ['es'] },
    );
    expect(out.sections[0]?.data.heading).toBe('Base'); // NOT the withheld overlay
    expect(out.fallbackCount).toBe(1);
    // Family fallback cannot resurrect a withheld locale either (pt withheld,
    // previewing pt-BR → base, mirroring localizePage's strip-before-resolve).
    const fam = resolvePreviewSections(
      [sec({ sectionId: 'b', localizations: { pt: { heading: 'Olá' } } })],
      'pt-BR', 'en',
      { withheld: ['pt'] },
    );
    expect(fam.sections[0]?.data.heading).toBe('Base');
  });

  it('counts the fallback sections + strips localizations from the resolved shape', () => {
    const out = resolvePreviewSections(
      [sec({ sectionId: 'a', localizations: { es: { heading: 'Hola' } } }), sec({ sectionId: 'b' })],
      'es', 'en',
    );
    expect(out.fallbackCount).toBe(1);
    expect(out.sections[0]?.data.heading).toBe('Hola');
    expect(out.sections[0]?.localizations).toBeUndefined();
  });
});

describe('CmsPage — the preview locale selector (CMSLU-5)', () => {
  const renderDetail = () => render(
    <MemoryRouter initialEntries={['/cms/p/o1/p1']}>
      <Routes>
        <Route path="/cms" element={<CmsPage />} />
        <Route path="/cms/p/:routeOrgId/:routePageId" element={<CmsPage />} />
      </Routes>
    </MemoryRouter>,
  );

  it('defaults to base (no badge), and switching to es renders the overlay + the fallback badge', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByTestId('public-preview')).toBeTruthy());
    // Base preview: base content, no locale badge.
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.queryByText(/previewing/i)).toBeNull();

    // Switch the preview locale to es.
    fireEvent.change(screen.getByLabelText(/preview locale/i), { target: { value: 'es' } });
    // The overlayed section renders Spanish; the untranslated one stays base…
    await waitFor(() => expect(screen.getByText('Hola')).toBeTruthy());
    expect(screen.getByText('Untranslated')).toBeTruthy();
    // …and the honesty badge names the locale + the fallback count.
    expect(screen.getByText(/previewing es/i)).toBeTruthy();
    expect(screen.getByText(/1 of 2 sections falls back to en/i)).toBeTruthy();
  });

  it('review F5 — previewing a WITHHELD locale shows what delivery serves (base) + the withheld badge, never "complete"', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByTestId('public-preview')).toBeTruthy());
    // fr is withheld (localePublishState fr:'draft'): the selector marks it…
    expect(screen.getByRole('option', { name: /fr \(withheld\)/i })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/preview locale/i), { target: { value: 'fr' } });
    // …the preview shows BASE content (the fr overlay is stripped, as delivery strips it)…
    await waitFor(() => expect(screen.getByText(/is withheld from delivery/i)).toBeTruthy());
    expect(screen.queryByText('Bonjour')).toBeNull();
    expect(screen.getByText('Hello')).toBeTruthy();
    // …and the badge never claims completeness.
    expect(screen.queryByText(/every section has content/i)).toBeNull();
  });
});
