/**
 * UX_UPGRADE-site ROUND 2 (R2-G1/G2/G3) — failure honesty on the public surfaces.
 *
 * The invariants pinned here are CLAIMS, not markup:
 * - a dead `/p/:slug` never renders the home page under the wrong URL (R2-G1),
 *   and a FAILED read never claims "not found" (they are different facts);
 * - the root '/' keeps the ADR 0027 never-blank fallback for BOTH (positive case
 *   — without it, the fix degrades into an error page on the front door);
 * - the blog post distinguishes 404 from failure, and a failed LIST read
 *   degrades the chrome WITH a note instead of silently shedding it;
 * - a renamed slug canonicalizes the address bar from the payload's `slug`;
 * - the pricing page keeps its live tier grid on a failed wrapper read and says
 *   the wrapper is missing instead of silently swapping to the bare fallback;
 * - the default fallback page only advertises openwop.dev in DEMO mode
 *   (ADR 0196 Gate A — SITE-R2-5).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { PublicPage, PublicPageResult } from '../siteClient.js';
import type { Section } from '../../cms/cmsClient.js';
import type { BlogPost } from '../blogClient.js';
import { messages as en } from '../i18n/en.js';

const pageResult = vi.fn<() => Promise<PublicPageResult>>();
const fetchBlog = vi.fn<() => Promise<BlogPost[] | null>>();
let demoMode = false;

vi.mock('../siteClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPublicPageResult: () => pageResult(),
  fetchPublicPage: async () => {
    const r = await pageResult();
    return r.status === 'ok' ? r.page : null;
  },
}));
vi.mock('../blogClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchBlog: () => fetchBlog(),
  blogFeedUrl: () => 'https://example.test/feed.xml',
}));
vi.mock('../visitorBeacon.js', () => ({
  getVisitorKey: () => null,
  sendExperimentPageview: () => {},
}));
vi.mock('../webVitalsBeacon.js', () => ({ reportWebVitals: () => {} }));
vi.mock('../../../client/useDemoMode.js', () => ({ useDemoMode: () => demoMode }));

const { FrontPage } = await import('../FrontPage.js');
const { BlogPostPage } = await import('../BlogPostPage.js');
const { PricingPage } = await import('../PricingPage.js');

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); demoMode = false; });

function page(slug: string, sections: Section[] = [{ sectionId: 's1', type: 'richText', data: { heading: 'Authored heading', text: 'Authored body' } }]): PublicPage {
  return {
    slug, title: `Title of ${slug}`, sections, updatedAt: '2026-08-01T00:00:00.000Z',
    seo: { title: slug, description: '', canonicalUrl: '', ogTitle: slug, ogDescription: '', noindex: false },
  };
}

const LARGE_CARD_CATALOG: Section[] = Array.from({ length: 4 }, (_, index) => ({
  sectionId: `cards-${index}`,
  type: 'columns',
  data: {
    layout: 'cards',
    heading: `Group ${index + 1}`,
    columns: [{ title: `Capability ${index + 1}`, text: 'Useful capability' }],
  },
}));

/**
 * The default fallback page's hero heading, read from its SSoT (site:heroHeading, en).
 * It was a copied regex literal: f77522292 (SITE-1) realigned the copy and three
 * positive assertions went red — and, worse, the four `queryByText(...).toBeNull()`
 * assertions below went VACUOUS, passing for any render because nothing emitted the
 * old string. Deriving it keeps both halves honest across future copy changes.
 */
const DEFAULT_HERO = en.heroHeading;

function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

describe('FrontPage surface="slug" — an honest deep link (R2-G1)', () => {
  it('adds catalog search to a large child-page catalog', async () => {
    pageResult.mockResolvedValue({ status: 'ok', page: page('features', LARGE_CARD_CATALOG) });
    render(<MemoryRouter><FrontPage orgId="org-1" slug="features" surface="slug" /></MemoryRouter>);
    expect(await screen.findByRole('search')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Find a feature' })).toBeTruthy();
  });

  it('renders a designed "page not found" — NEVER the default home page', async () => {
    pageResult.mockResolvedValue({ status: 'notFound' });
    render(<MemoryRouter><FrontPage orgId="org-1" slug="nope" surface="slug" /></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Page not found' });
    expect(screen.getByRole('link', { name: /home page/i })).toBeTruthy();
    expect(screen.queryByText(DEFAULT_HERO)).toBeNull();
  });

  it('renders a designed error state with a WORKING retry — never "not found"', async () => {
    pageResult.mockResolvedValueOnce({ status: 'error' });
    render(<MemoryRouter><FrontPage orgId="org-1" slug="real-page" surface="slug" /></MemoryRouter>);
    await screen.findByRole('heading', { name: /couldn’t load this page/i });
    expect(screen.queryByText('Page not found')).toBeNull();
    expect(screen.queryByText(DEFAULT_HERO)).toBeNull();

    pageResult.mockResolvedValueOnce({ status: 'ok', page: page('real-page') });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Authored body');
    expect(pageResult).toHaveBeenCalledTimes(2);
  });

  it('canonicalizes a renamed slug to the payload’s current address', async () => {
    pageResult.mockResolvedValue({ status: 'ok', page: page('new-name') });
    render(
      <MemoryRouter initialEntries={['/p/old-name']}>
        <LocationProbe />
        <FrontPage orgId="org-1" slug="old-name" surface="slug" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/p/new-name'));
  });

  it('a published-but-empty page renders its own title, not the home content', async () => {
    pageResult.mockResolvedValue({ status: 'ok', page: page('empty-page', []) });
    render(<MemoryRouter><FrontPage orgId="org-1" slug="empty-page" surface="slug" /></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Title of empty-page' });
    expect(screen.queryByText(DEFAULT_HERO)).toBeNull();
  });
});

describe('FrontPage surface="root" — ADR 0027 never blank (the positive case)', () => {
  it('never mistakes a card-rich home page for a searchable feature catalog', async () => {
    pageResult.mockResolvedValue({ status: 'ok', page: page('home', LARGE_CARD_CATALOG) });
    render(<MemoryRouter><FrontPage orgId="org-1" slug="home" surface="root" /></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Group 1' });
    expect(screen.queryByRole('search')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Find a feature' })).toBeNull();
  });

  it('falls back to the default page when nothing is published', async () => {
    pageResult.mockResolvedValue({ status: 'notFound' });
    render(<MemoryRouter><FrontPage orgId="org-1" slug="home" surface="root" /></MemoryRouter>);
    await screen.findByText(DEFAULT_HERO);
    expect(screen.queryByText('Page not found')).toBeNull();
  });

  it('falls back to the default page when the read FAILS (root is never an error page)', async () => {
    pageResult.mockResolvedValue({ status: 'error' });
    render(<MemoryRouter><FrontPage orgId="org-1" slug="home" surface="root" /></MemoryRouter>);
    await screen.findByText(DEFAULT_HERO);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('demo-gates the openwop.dev CTA and the paper link on the fallback page (SITE-R2-5 / ADR 0196)', async () => {
    // Asserted by DESTINATION, not label: the gate is about where a white-label
    // visitor can be sent, and a copy edit must not silently void this test.
    const showcaseLinks = (): Element[] => [...document.querySelectorAll('a[href^="https://openwop.dev"], a[href*="zenodo"]')];
    pageResult.mockResolvedValue({ status: 'notFound' });
    demoMode = false;
    const first = render(<MemoryRouter><FrontPage orgId="org-1" slug="home" surface="root" /></MemoryRouter>);
    await screen.findByText(DEFAULT_HERO);
    expect(showcaseLinks()).toHaveLength(0);
    first.unmount();

    demoMode = true;
    render(<MemoryRouter><FrontPage orgId="org-1" slug="home" surface="root" /></MemoryRouter>);
    await screen.findByText(DEFAULT_HERO);
    expect(screen.getByRole('link', { name: /read the protocol/i }).getAttribute('href')).toBe('https://openwop.dev');
    expect(screen.getByRole('link', { name: /the paper/i }).getAttribute('href')).toContain('zenodo');
  });
});

describe('BlogPostPage — 404 vs failure (R2-BLOG-1/2/4)', () => {
  it('a FAILED read says so with a retry — it does not claim the post was unpublished', async () => {
    pageResult.mockResolvedValue({ status: 'error' });
    fetchBlog.mockResolvedValue([]);
    render(<MemoryRouter><BlogPostPage orgId="org-1" slug="p1" /></MemoryRouter>);
    await screen.findByRole('heading', { name: /couldn’t load this post/i });
    expect(screen.queryByText('Post not found')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('a genuine 404 keeps the designed "post not found" state (the positive case)', async () => {
    pageResult.mockResolvedValue({ status: 'notFound' });
    fetchBlog.mockResolvedValue([]);
    render(<MemoryRouter><BlogPostPage orgId="org-1" slug="p1" /></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Post not found' });
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('a failed LIST read degrades the chrome WITH a note — and an ok list shows none', async () => {
    pageResult.mockResolvedValue({ status: 'ok', page: page('p1') });
    fetchBlog.mockResolvedValue(null);
    const first = render(<MemoryRouter><BlogPostPage orgId="org-1" slug="p1" /></MemoryRouter>);
    await screen.findByText('Authored body'); // the post body still renders
    expect(screen.getByText(/couldn’t be loaded right now/i)).toBeTruthy();
    first.unmount();

    fetchBlog.mockResolvedValue([{ pageId: 'pg1', slug: 'p1', title: 'Title of p1', excerpt: '', tags: [], publishedAt: '2026-08-01T00:00:00.000Z' }]);
    render(<MemoryRouter><BlogPostPage orgId="org-1" slug="p1" /></MemoryRouter>);
    await screen.findByText('Authored body');
    expect(screen.queryByText(/couldn’t be loaded right now/i)).toBeNull();
  });

  it('a renamed slug replaces the address with the canonical one (R2-BLOG-4)', async () => {
    pageResult.mockResolvedValue({ status: 'ok', page: page('post-2') });
    fetchBlog.mockResolvedValue([]);
    render(
      <MemoryRouter initialEntries={['/blog/old-slug']}>
        <LocationProbe />
        <BlogPostPage orgId="org-1" slug="old-slug" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/blog/post-2'));
  });
});

describe('PricingPage — a failed wrapper read is not "no wrapper authored" (READ-2)', () => {
  /** PricingSection inside the fallback fetches the live tier grid — stub it. */
  function stubPricingReads(): void {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/public/pricing')) return { ok: true, status: 200, json: async () => ({ tiers: [{ tier: 'free', name: 'Free', features: [] }] }) } as Response;
      return { ok: true, status: 200, json: async () => ({ bundles: [] }) } as Response;
    }));
  }

  it('keeps the live tier grid and adds a note + retry on a FAILED read', async () => {
    stubPricingReads();
    pageResult.mockResolvedValueOnce({ status: 'error' });
    render(<MemoryRouter><PricingPage /></MemoryRouter>);
    await screen.findByText(/part of this page couldn’t be loaded/i);
    await screen.findByText('Free'); // the tier grid still renders
    pageResult.mockResolvedValueOnce({ status: 'ok', page: page('pricing') });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Authored body');
    expect(screen.queryByText(/part of this page couldn’t be loaded/i)).toBeNull();
  });

  it('an unauthored wrapper (404) renders the bare fallback with NO degradation note', async () => {
    stubPricingReads();
    pageResult.mockResolvedValue({ status: 'notFound' });
    render(<MemoryRouter><PricingPage /></MemoryRouter>);
    await screen.findByText('Free');
    expect(screen.getByRole('heading', { level: 1, name: 'Pricing' })).toBeTruthy();
    expect(screen.queryByText(/part of this page couldn’t be loaded/i)).toBeNull();
  });

  it('keeps exactly one h1 when the authored wrapper already supplies a hero', async () => {
    stubPricingReads();
    pageResult.mockResolvedValue({
      status: 'ok',
      page: page('pricing', [{ sectionId: 'hero', type: 'hero', data: { heading: 'Plans for steady progress' } }]),
    });
    render(<MemoryRouter><PricingPage /></MemoryRouter>);
    await screen.findByRole('heading', { level: 1, name: 'Plans for steady progress' });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});
