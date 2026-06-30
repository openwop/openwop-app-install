/**
 * FP-2 (CODEBASE-ASSESSMENT.md): the headline feature pages had no component
 * tests. Covers CmsPage's access-gate tri-state — loading → skeleton (no gate
 * copy, no content), disabled → the "CMS is not enabled" StateCard (the
 * FE-is-never-the-authority gate, ADR 0009), and enabled → renders the page
 * header + the org's fetched pages.
 *
 * Mocking mirrors CrmPage.test.tsx: `useFeatureAccess` is a hoisted mutable
 * stub, and the feature's `cmsClient.js` is fully mocked (it is the single
 * data-access seam shared by CmsPage + SectionsEditor + CmsLanguageSettings).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const access = vi.hoisted(() => ({ value: { enabled: false, loading: false, variant: undefined as string | undefined } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => access.value,
}));

vi.mock('../cmsClient.js', () => ({
  SECTION_TYPES: ['hero', 'richText', 'image', 'cta', 'columns'],
  assetUrl: (token: string) => `/asset/${token}`,
  listOrgs: vi.fn(async () => [{ orgId: 'o1', name: 'Org One' }]),
  listPages: vi.fn(async () => [
    { pageId: 'p1', title: 'Landing Page', slug: 'landing', status: 'draft', sections: [], version: 1, updatedAt: '2026-01-01T00:00:00Z' },
  ]),
  listMediaAssets: vi.fn(async () => []),
  getLanguageSettings: vi.fn(async () => ({ baseLocale: 'en', supportedLocales: [], autoTranslateOnPublish: false })),
  putLanguageSettings: vi.fn(),
  getPage: vi.fn(), createPage: vi.fn(), deletePage: vi.fn(), savePage: vi.fn(),
  transition: vi.fn(), translateSection: vi.fn(),
}));

import { CmsPage } from '../CmsPage.js';

const renderPage = () => render(<MemoryRouter><CmsPage /></MemoryRouter>);

beforeEach(() => { access.value = { enabled: false, loading: false, variant: undefined }; });
afterEach(cleanup);

describe('CmsPage access gate (FP-2)', () => {
  it('renders a skeleton while access is loading (neither gate copy nor content)', () => {
    access.value = { enabled: false, loading: true, variant: undefined };
    renderPage();
    expect(screen.queryByText(/not enabled/i)).toBeNull();
    expect(screen.queryByText(/Page Builder/i)).toBeNull();
  });

  it('shows the "CMS is not enabled" StateCard when the feature is off (server-gated)', () => {
    access.value = { enabled: false, loading: false, variant: undefined };
    renderPage();
    expect(screen.getByText(/CMS is not enabled/i)).toBeTruthy();
    // The page chrome (header) must NOT render behind the gate.
    expect(screen.queryByText(/Page Builder/i)).toBeNull();
  });

  it('renders the page header + fetched pages when enabled', async () => {
    access.value = { enabled: true, loading: false, variant: undefined };
    renderPage();
    // The header renders once orgs resolve…
    await waitFor(() => expect(screen.getByText(/Page Builder/i)).toBeTruthy());
    // …and the org's pages land after the async list fetch.
    await waitFor(() => expect(screen.getByText('Landing Page')).toBeTruthy());
    // The gate copy is absent in the enabled state.
    expect(screen.queryByText(/CMS is not enabled/i)).toBeNull();
  });
});
