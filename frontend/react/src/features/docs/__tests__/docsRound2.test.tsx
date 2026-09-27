/**
 * UX_UPGRADE-docs ROUND 2 (R2-D1/D2/D4/D5/D6/D9) — behaviour pins:
 * - the FrontPage embed canonicalizes a renamed slug INSIDE docs and its
 *   404/empty fallback points at /docs (never the marketing home) — the two
 *   defects #3041 introduced;
 * - the collection guard 404s a non-doc slug ONLY when the nav has loaded
 *   (fails open on nav error — never 404 a real doc over a failed nav read);
 * - a failed nav read announces (role=alert inserts on failure) and its Retry
 *   actually refetches;
 * - the index rows render the freshness stamp the payload carries.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { DocsNavItem } from '../docsClient.js';
import type { PublicPage, PublicPageResult } from '../../site/siteClient.js';

const getDocsNav = vi.fn<() => Promise<DocsNavItem[] | null>>();
vi.mock('../docsClient.js', () => ({ getDocsNav: () => getDocsNav() }));

// These cases exercise the REAL FrontPage embed, so mock only the wire.
const pageResult = vi.fn<() => Promise<PublicPageResult>>();
vi.mock('../../site/siteClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPublicPageResult: () => pageResult(),
  fetchPublicPage: async () => {
    const r = await pageResult();
    return r.status === 'ok' ? r.page : null;
  },
}));
vi.mock('../../site/visitorBeacon.js', () => ({ getVisitorKey: () => null, sendExperimentPageview: () => {} }));
vi.mock('../../site/webVitalsBeacon.js', () => ({ reportWebVitals: () => {} }));
vi.mock('../../../client/useDemoMode.js', () => ({ useDemoMode: () => false }));

const { DocsPublicPage } = await import('../DocsPublicPage.js');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const mk = (slug: string, title: string, order: string): DocsNavItem =>
  ({ slug, title, order, updatedAt: '2026-07-20T10:00:00.000Z' });
const NAV = [mk('install', 'Install', 'getting-started/10'), mk('agents', 'Agents', 'guides/10')];

function page(slug: string): PublicPage {
  return {
    slug, title: `Doc ${slug}`, sections: [{ sectionId: 's1', type: 'richText', data: { text: `Body of ${slug}` } }],
    updatedAt: '2026-08-01T00:00:00.000Z',
    seo: { title: slug, description: '', canonicalUrl: '', ogTitle: slug, ogDescription: '', noindex: false },
  };
}

function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

const renderDocs = (slug: string | null, initialPath = `/docs/${slug ?? ''}`) =>
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <LocationProbe />
      <DocsPublicPage orgId="org-1" slug={slug} />
    </MemoryRouter>,
  );

describe('R2-D1/D2 — the docs embed stays inside docs', () => {
  it('canonicalizes a renamed doc slug to /docs/<new>, never /p/', async () => {
    getDocsNav.mockResolvedValue(NAV);
    pageResult.mockResolvedValue({ status: 'ok', page: page('agents') });
    renderDocs('old-agents');
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/docs/agents'));
  });

  it('the 404 state inside docs offers "Back to docs", not the marketing home', async () => {
    getDocsNav.mockResolvedValue([]); // empty nav ⇒ the collection guard steps aside
    pageResult.mockResolvedValue({ status: 'notFound' });
    renderDocs('gone');
    await screen.findByRole('heading', { name: 'Page not found' });
    const back = screen.getByRole('link', { name: 'Back to docs' });
    expect(back.getAttribute('href')).toBe('/docs');
    expect(screen.queryByRole('link', { name: /home page/i })).toBeNull();
  });
});

describe('R2-D4 — the collection guard', () => {
  it('a page that exists but is NOT a doc renders not-found with a way back', async () => {
    getDocsNav.mockResolvedValue(NAV);
    pageResult.mockResolvedValue({ status: 'ok', page: page('pricing-faq') }); // a real page — but not a doc
    renderDocs('pricing-faq');
    await screen.findByText('Page not found');
    expect(screen.getByRole('link', { name: 'Back to docs' })).toBeTruthy();
    expect(screen.queryByText('Body of pricing-faq')).toBeNull();
  });

  it('the guard NEVER 404s a renamed doc — canonicalization runs first (the key interaction)', async () => {
    // nav holds only the NEW slug; the reader arrives on the OLD one. The
    // guard must let the fetch resolve and the redirect fire — a pre-render
    // "slug not in nav" check here would have re-broken R2-D1.
    getDocsNav.mockResolvedValue(NAV);
    pageResult.mockResolvedValue({ status: 'ok', page: page('agents') });
    renderDocs('old-agents');
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/docs/agents'));
    expect(screen.queryByText('Page not found')).toBeNull();
  });

  it('a slug IN the nav renders its body (the positive case)', async () => {
    getDocsNav.mockResolvedValue(NAV);
    pageResult.mockResolvedValue({ status: 'ok', page: page('agents') });
    renderDocs('agents');
    await screen.findByText('Body of agents');
  });

  it('fails OPEN on a nav error — a real doc must never 404 over a failed nav read', async () => {
    getDocsNav.mockResolvedValue(null);
    pageResult.mockResolvedValue({ status: 'ok', page: page('agents') });
    renderDocs('agents');
    await screen.findByText('Body of agents');
  });
});

describe('R2-D5/D6 — nav failure announces and retries', () => {
  it('renders role=alert with a Retry that actually refetches', async () => {
    getDocsNav.mockResolvedValueOnce(null);
    pageResult.mockResolvedValue({ status: 'ok', page: page('agents') });
    renderDocs('agents');
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/couldn’t load the navigation/i)).toBeTruthy();

    getDocsNav.mockResolvedValueOnce(NAV);
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await screen.findByRole('link', { name: 'Install' });
    expect(getDocsNav).toHaveBeenCalledTimes(2);
  });
});

describe('R2-D9 — index rows carry the freshness stamp', () => {
  it('each index row renders the payload updatedAt as a <time>', async () => {
    getDocsNav.mockResolvedValue(NAV);
    renderDocs(null, '/docs');
    // Both the sidebar and the index list an "Install" link — the stamp lives
    // on the INDEX row (.docs-index-item).
    const rows = await screen.findAllByRole('link', { name: /Install/ });
    const row = rows.find((r) => r.classList.contains('docs-index-item'))!;
    expect(row).toBeTruthy();
    const time = row.querySelector('time');
    expect(time?.getAttribute('dateTime')).toBe('2026-07-20T10:00:00.000Z');
    expect(time?.textContent?.length).toBeGreaterThan(0);
  });
});
