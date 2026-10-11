/**
 * FP-2 (docs/steward/CODEBASE-ASSESSMENT.md): the headline feature pages had no component
 * tests. Covers CmsPage's access-gate tri-state — loading → skeleton (no gate
 * copy, no content). ALWAYS-ON correction (/browser 2026-07-03): CMS's toggle
 * was retired by ADR 0027, so the page must render REGARDLESS of the
 * feature-access feed (an absent id resolves to the OFF fallback and bricked
 * fresh installs) — the old "disabled → StateCard" case is now the opposite (the
 * FE-is-never-the-authority gate, ADR 0009), and enabled → renders the page
 * header + the org's fetched pages.
 *
 * `useFeatureAccess` answers OFF (the fresh-install shape) for EVERY case, so
 * each case also re-proves "no gate". CmsPage does not read the feed at all
 * today; the absence of a gate cannot be sabotaged by a one-line edit, so the
 * always-on claim is an honest ceiling (incident witness, no anchor). The
 * feature's `cmsClient.js` is fully mocked (the single data-access seam shared
 * by CmsPage + SectionsEditor + CmsLanguageSettings), and so is every other
 * client the page reaches — no live fetch (ADR 0661).
 *
 * Sabotage-witnessed (/grade-tests w17): emptying the page list, the schedule
 * label, the history row / Restore, the site-admin check (both ways), the
 * preview's sections, the menu labels, the resolved-vs-raw menu source, and
 * the preview-links failed/empty states each turn their case red.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { Page, SharedSection } from '../cmsClient.js';
import type { ShareLink } from '../../sharing/sharingClient.js';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

// The Public-preview iframe portals React into a fresh <iframe> document — a
// real-browser pattern jsdom can't tear down cleanly. This is a CMS-logic test,
// so render its children inline (the real isolation is verified in the browser).
vi.mock('../PublicPreviewFrame.js', () => ({
  PublicPreviewFrame: ({ children }: { children: ReactNode }) => <div data-testid="public-preview">{children}</div>,
}));

vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: false, loading: false }),
}));

// The opened page + the org's shared sections. Case-local overrides are reset
// in afterEach.
const cms = vi.hoisted(() => {
  const defaultPage: Page = {
    pageId: 'p1', title: 'Landing Page', slug: 'landing', status: 'draft',
    sections: [{ sectionId: 'sec:1', type: 'hero', data: { heading: 'Hi' } }],
    version: 3, updatedAt: '2026-01-01T00:00:00Z',
  };
  return { defaultPage, page: defaultPage, shared: [] as SharedSection[] };
});

vi.mock('../cmsClient.js', () => ({
  SECTION_TYPES: ['hero', 'richText', 'image', 'cta', 'columns'],
  PAGE_STATUSES: ['draft', 'in_review', 'published', 'archived'],
  SYSTEM_SITE_ORG: 'host-site',
  assetUrl: (token: string) => `/asset/${token}`,
  listOrgs: vi.fn(async () => [{ orgId: 'o1', name: 'Org One' }]),
  listPages: vi.fn(async () => [
    { pageId: 'p1', title: 'Landing Page', slug: 'landing', status: 'draft', sections: [], version: 1, updatedAt: '2026-01-01T00:00:00Z' },
  ]),
  getLanguageSettings: vi.fn(async () => ({ baseLocale: 'en', supportedLocales: [], autoTranslateOnPublish: false })),
  putLanguageSettings: vi.fn(),
  // ADR 0593 D4 (CMSAU-5) — the editor now reads the page's latest review
  // outcome so a rejection is visible to the submitter. Enrichment: null ⇒
  // no notice, which is what every case below expects.
  getPageReview: vi.fn(async () => null),
  getPage: vi.fn(async () => cms.page), createPage: vi.fn(), deletePage: vi.fn(), savePage: vi.fn(),
  transition: vi.fn(), translateSection: vi.fn(),
  listVersions: vi.fn(async () => [
    { versionId: 'pver:1', version: 2, snapshot: { title: 'Landing Page', slug: 'landing', sections: [] }, publishedAt: '2026-01-01T00:00:00Z', publishedBy: 'u1' },
  ]), restoreVersion: vi.fn(),
  // ADR 0204 — scheduling + shared sections
  schedulePublish: vi.fn(), cancelSchedule: vi.fn(),
  listSharedSections: vi.fn(async () => cms.shared), createSharedSection: vi.fn(),
  updateSharedSection: vi.fn(), deleteSharedSection: vi.fn(),
  listSharedSectionPages: vi.fn(async () => []),
  // ADR 0205 — locale governance
  listLocaleGrants: vi.fn(async () => []), putLocaleGrant: vi.fn(),
  setLocalePublish: vi.fn(),
  getTranslationStatus: vi.fn(async () => ({ locales: [], sections: {}, counts: {} })),
  confirmTranslationSource: vi.fn(),
}));

// The org-asset list now comes from the media feature's client (ADR 0206 B4).
vi.mock('../../media/mediaClient.js', () => ({
  listAssets: vi.fn(async () => []),
  uploadAsset: vi.fn(),
  absoluteServeUrl: (u: string) => u,
}));

// Preview links ride the sharing feature (ADR 0204 C3).
const sharing = vi.hoisted(() => ({ listLinks: vi.fn(async (): Promise<ShareLink[]> => []) }));
vi.mock('../../sharing/sharingClient.js', () => ({
  createLink: vi.fn(), listLinks: sharing.listLinks, revokeLink: vi.fn(),
  sharedPageUrl: (token: string) => `/shared/${token}`,
}));

// Front-page collapse (ADR 0027): the superadmin-gated site-config probe. The
// default suite runs as a non-superadmin, so it REJECTS — the Front-page scope
// stays hidden and the org-only behavior is unchanged.
// The Page tab reads and writes the page's search and social record.
vi.mock('../../publishing/publishingClient.js', () => ({ getSeo: vi.fn(async () => null), putSeo: vi.fn(async (_o: string, _p: string, seo: unknown) => seo) }));
// ADR 0836 — the editor reads the caller's org access (admin tier): an admin here.
// `listMembers` (CmsLanguageSettings) is mocked too: left real it was a live fetch.
vi.mock('../../../client/accessClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), listMembers: vi.fn(async () => []), getEffectiveAccess: vi.fn(async () => ({ roles: ['owner'], scopes: ['workspace:read', 'workspace:write', 'host:members:manage'], basis: 'member' })) }));
vi.mock('../../site/siteConfigClient.js', () => ({
  getSiteConfig: vi.fn(async () => { throw new Error('forbidden'); }),
  putSiteConfig: vi.fn(),
  invalidateFrontPage: vi.fn(),
}));

import { CmsPage } from '../CmsPage.js';
import { getSiteConfig } from '../../site/siteConfigClient.js';

/** Land DIRECTLY on the deep link (no click through the list) — a different
 *  code path from `renderPage`, and the one a shared editor URL uses. */
const renderDeepLink = () => render(
  <MemoryRouter initialEntries={['/cms/p/org-1/p1']}>
    <Routes>
      <Route path="/cms" element={<CmsPage />} />
      <Route path="/cms/p/:routeOrgId/:routePageId" element={<CmsPage />} />
    </Routes>
  </MemoryRouter>,
);

const renderPage = () => render(
  <MemoryRouter initialEntries={['/cms']}>
    <Routes>
      <Route path="/cms" element={<CmsPage />} />
      <Route path="/cms/p/:routeOrgId/:routePageId" element={<CmsPage />} />
    </Routes>
  </MemoryRouter>,
);

afterEach(() => { cleanup(); cms.page = cms.defaultPage; cms.shared = []; });

describe('CmsPage (always-on, ADR 0027)', () => {
  it('renders REGARDLESS of the feature-access feed (retired toggle ⇒ absent id must not gate)', async () => {
    renderPage(); // the feed answers OFF — the fresh-install shape
    await waitFor(() => expect(screen.getByText(/Page Builder/i)).toBeTruthy());
    // …and the org's pages land after the async list fetch.
    await waitFor(() => expect(screen.getByText('Landing Page')).toBeTruthy());
    expect(screen.queryByText(/CMS is not enabled/i)).toBeNull();
  });

  // CMSGAP-4 — the ADR 0206/0204/0205 editor panels render for a selected draft.
  it('opening a draft shows the History + Preview-links panels and the schedule control', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Landing Page')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Landing Page' }));

    // Detail header lands with the draft's version…
    await waitFor(() => expect(screen.getByText(/\/landing · v3/)).toBeTruthy());
    // …page-level settings live on the settings panel's Page tab…
    fireEvent.click(screen.getByRole('tab', { name: 'Page' }));
    // …the schedule control is offered for a draft (ADR 0204 C2)…
    expect(screen.getByLabelText(/publish at/i)).toBeTruthy(); // CMSUX-6 — visible label
    // …and the collapsed panels exist.
    expect(screen.getByText(/history/i)).toBeTruthy();
    expect(screen.getByText(/preview links/i)).toBeTruthy();

    // Opening History lazily loads + lists the captured version (ADR 0206 B1).
    fireEvent.click(screen.getByText(/history/i));
    await waitFor(() => expect(screen.getByText('v2')).toBeTruthy());
    expect(screen.getByRole('button', { name: /compare/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /restore/i })).toBeTruthy();
  });
});

// Front-page collapse (ADR 0027): a super admin sees the reserved "Front page"
// scope in the workspace picker; a non-superadmin never does.
describe('CmsPage — Front-page scope (ADR 0027 collapse)', () => {
  it('hides the Front-page scope when the site-config probe 403s (non-superadmin)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/Page Builder/i)).toBeTruthy());
    // getSiteConfig rejects (default mock) ⇒ no System optgroup / Front-page option.
    expect(screen.queryByText(/Front page \(public site\)/i)).toBeNull();
  });

  it('offers the Front-page scope + the "show at /" switch to a super admin', async () => {
    vi.mocked(getSiteConfig).mockResolvedValueOnce({
      id: 'site', enabled: true, updatedBy: 'admin', updatedAt: '2026-01-01T00:00:00Z',
    });
    renderPage();
    // The reserved scope appears as a picker option…
    await waitFor(() => expect(screen.getByRole('option', { name: /Front page \(public site\)/i })).toBeTruthy());
    // …and selecting it surfaces the on/off switch for the public homepage.
    fireEvent.change(screen.getByLabelText(/organization/i), { target: { value: 'host-site' } });
    await waitFor(() => expect(screen.getByLabelText(/show the front page at/i)).toBeTruthy());
  });
});

/**
 * Deep-link render (2026-08-03). A local browser pass on a freshly created page
 * showed the Public preview AND the Outline both blank, and the cause was left
 * "unknown" — an unsatisfying place to stop, because a deep-linked editor that
 * renders no sections is a real defect if it is one. These pin the deep-link
 * path end to end: the sections a page HAS must reach the preview and the
 * outline, so a regression here fails here instead of in someone's browser.
 */
describe('CmsPage — deep link renders the page\'s sections', () => {
  it('landing on /cms/p/:org/:pageId renders the section content in the Public preview', async () => {
    renderDeepLink();
    // The detail header proves the page loaded…
    await waitFor(() => expect(screen.getByText(/\/landing · v3/)).toBeTruthy());
    // …and the preview must actually contain the section's content, not an
    // empty stage (the mocked PublicPreviewFrame renders children inline).
    await waitFor(() => expect(screen.getByTestId('public-preview')).toBeTruthy());
    expect(within(screen.getByTestId('public-preview')).getByText('Hi')).toBeTruthy();
  });

  it('the Sections menu names the sections too (the resolved, not the raw, list)', async () => {
    // A by-reference block (ADR 0204 C4): its own data is empty, so only the
    // RESOLVED list can name it after the shared section's heading.
    cms.page = { ...cms.defaultPage, sections: [...cms.defaultPage.sections, { sectionId: 'sec:2', type: 'richText', data: {}, ref: { sharedSectionId: 'ss1' } }] };
    cms.shared = [{ sharedSectionId: 'ss1', name: 'Footer', type: 'richText', data: { heading: 'Shared heading' }, version: 1, updatedAt: '2026-01-01T00:00:00Z' }];
    renderDeepLink();
    await waitFor(() => expect(screen.getByText(/\/landing · v3/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Jump to a section' }));
    expect(await screen.findByRole('menuitem', { name: /Hi/ })).toBeTruthy();
    expect(await screen.findByRole('menuitem', { name: /Shared heading/ })).toBeTruthy();
  });
});

/**
 * A failed share-link read must not read as "No active preview links."
 * (sentinel triage, 2026-08-03). An author seeing that could conclude a live
 * preview link had been revoked — a claim we cannot make when the request
 * never returned. Both polarities, because the "absent" arm alone is vacuous.
 */
describe('CmsPage — preview links: failed read vs genuinely none', () => {
  const openPanel = async (): Promise<void> => {
    renderDeepLink();
    await waitFor(() => expect(screen.getByText(/\/landing · v3/)).toBeTruthy());
    // The panels live on the settings panel's Page tab.
    fireEvent.click(screen.getByRole('tab', { name: 'Page' }));
    fireEvent.click(screen.getByText(/preview links/i)); // <details> lazy-loads on toggle
  };

  it('read FAILS: says so, and never claims there are none', async () => {
    sharing.listLinks.mockRejectedValueOnce(new Error('boom'));
    await openPanel();
    await waitFor(() => expect(screen.getByText(/failed read/i)).toBeTruthy());
    expect(screen.queryByText('No active preview links.')).toBeNull();
  });

  it('read SUCCEEDS with none: the real "No active preview links." survives', async () => {
    sharing.listLinks.mockResolvedValueOnce([]);
    await openPanel();
    await waitFor(() => expect(screen.getByText('No active preview links.')).toBeTruthy());
    expect(screen.queryByText(/failed read/i)).toBeNull();
  });
});
