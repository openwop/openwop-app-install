/**
 * UX_UPGRADE-site — the blog index + post upgrades (G1/G3/G4/G6).
 *
 * These pin BEHAVIOUR, not markup: the filter actually narrows the rendered
 * list, "show more" actually reveals the next batch, the pager points at the
 * chronologically adjacent posts, and the related rail is honest — it only
 * calls posts "related" when they truly share a facet, and never lists the
 * post you're already reading.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { BlogPost } from '../blogClient.js';

const fetchBlog = vi.fn<() => Promise<BlogPost[] | null>>();
const fetchPublicPage = vi.fn<() => Promise<unknown>>();

vi.mock('../blogClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchBlog: () => fetchBlog(),
  blogFeedUrl: () => 'https://example.test/feed.xml',
}));
vi.mock('../siteClient.js', () => ({
  fetchPublicPage: () => fetchPublicPage(),
  // The page consumers now read the discriminated result (R2-G2); derive it from
  // the same stub so both shapes stay in lockstep.
  fetchPublicPageResult: async () => {
    const p = await fetchPublicPage();
    return p ? { status: 'ok', page: p } : { status: 'notFound' };
  },
}));

const { BlogPage } = await import('../BlogPage.js');
const { BlogPostPage } = await import('../BlogPostPage.js');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

/** N posts, newest-first, alternating category so relatedness is testable. */
function posts(n: number): BlogPost[] {
  return Array.from({ length: n }, (_, i) => ({
    pageId: `page:${i}`,
    slug: `post-${i}`,
    title: `Post ${i}`,
    excerpt: i === 0 ? 'A unicorn appears' : `Body of post ${i}`,
    category: i % 2 === 0 ? 'engineering' : 'product',
    tags: [],
    publishedAt: `2026-07-${String(20 - i).padStart(2, '0')}T00:00:00.000Z`,
    readingMinutes: i + 1,
  }));
}

describe('blog index — filter (G1) + show more (G3)', () => {
  it('turns an empty index into useful next steps, not a dead end', async () => {
    fetchBlog.mockResolvedValue([]);
    render(<MemoryRouter><BlogPage orgId="org-1" route={{ kind: 'index' }} /></MemoryRouter>);
    await screen.findByRole('heading', { level: 2, name: /no articles have been published/i });
    expect(screen.getByRole('link', { name: /read the quickstart/i }).getAttribute('href')).toBe('/docs/quickstart');
    expect(screen.getByRole('link', { name: /explore features/i }).getAttribute('href')).toBe('/p/features');
  });

  it('filters the rendered list by title/excerpt and offers a way back', async () => {
    fetchBlog.mockResolvedValue(posts(6));
    render(<MemoryRouter><BlogPage orgId="org-1" route={{ kind: 'index' }} /></MemoryRouter>);
    await screen.findByText('Post 0');
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(6);

    fireEvent.change(screen.getByRole('textbox', { name: /filter posts/i }), { target: { value: 'unicorn' } });
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1));
    expect(screen.getByText('Post 0')).toBeTruthy();

    // A query that matches nothing lands on the designed empty state, not a blank list.
    fireEvent.change(screen.getByRole('textbox', { name: /filter posts/i }), { target: { value: 'zzzz' } });
    await screen.findByText(/No posts match/);
    fireEvent.click(screen.getByRole('button', { name: /show all posts/i }));
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(6));
  });

  it('shows the first batch only, then reveals the next on "show more"', async () => {
    fetchBlog.mockResolvedValue(posts(14));
    render(<MemoryRouter><BlogPage orgId="org-1" route={{ kind: 'index' }} /></MemoryRouter>);
    await screen.findByText('Post 0');
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(10);
    expect(screen.queryByText('Post 10')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /show 4 more/i }));
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(14));
    // Exhausted ⇒ the control disappears rather than sitting there inert.
    expect(screen.queryByRole('button', { name: /show .* more/i })).toBeNull();
  });

  it('hides the filter band for a short list (it would be noise)', async () => {
    fetchBlog.mockResolvedValue(posts(3));
    render(<MemoryRouter><BlogPage orgId="org-1" route={{ kind: 'index' }} /></MemoryRouter>);
    await screen.findByText('Post 0');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('renders the server reading estimate on a card (G2)', async () => {
    fetchBlog.mockResolvedValue(posts(3));
    render(<MemoryRouter><BlogPage orgId="org-1" route={{ kind: 'index' }} /></MemoryRouter>);
    expect(await screen.findByText('1 min read')).toBeTruthy();
  });
});

describe('blog post — pager + related rail (G4)', () => {
  const page = { slug: 'post-2', title: 'Post 2', sections: [], updatedAt: '2026-07-18T00:00:00.000Z', seo: { title: 'Post 2', description: '', canonicalUrl: '', ogTitle: 'Post 2', ogDescription: '', noindex: false } };

  it('links the chronologically adjacent posts and never the current one', async () => {
    fetchPublicPage.mockResolvedValue(page);
    fetchBlog.mockResolvedValue(posts(6));
    render(<MemoryRouter><BlogPostPage orgId="org-1" slug="post-2" /></MemoryRouter>);
    await screen.findByRole('heading', { level: 1, name: 'Post 2' });

    const pager = screen.getByRole('navigation', { name: /nearby posts/i });
    // The list is newest-first: index 1 is NEWER than 2, index 3 is OLDER.
    expect(pager.textContent).toContain('Post 1');
    expect(pager.textContent).toContain('Post 3');

    const related = screen.getByRole('heading', { name: /related reading/i }).closest('section')!;
    expect(related.textContent).not.toContain('Post 2');
  });

  it('falls back to a NEUTRAL heading when nothing shares a facet', async () => {
    fetchPublicPage.mockResolvedValue(page);
    // Every post in its own category, no tags ⇒ zero relatedness.
    fetchBlog.mockResolvedValue(posts(4).map((p, i) => ({ ...p, category: `cat-${i}` })));
    render(<MemoryRouter><BlogPostPage orgId="org-1" slug="post-2" /></MemoryRouter>);
    await screen.findByRole('heading', { level: 1, name: 'Post 2' });
    expect(screen.queryByRole('heading', { name: /related reading/i })).toBeNull();
    expect(screen.getByRole('heading', { name: /more posts/i })).toBeTruthy();
  });

  it('a single-post blog shows neither pager nor rail', async () => {
    fetchPublicPage.mockResolvedValue({ ...page, slug: 'post-0', title: 'Post 0' });
    fetchBlog.mockResolvedValue(posts(1));
    render(<MemoryRouter><BlogPostPage orgId="org-1" slug="post-0" /></MemoryRouter>);
    await screen.findByRole('heading', { level: 1, name: 'Post 0' });
    expect(screen.queryByRole('navigation', { name: /nearby posts/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: /related reading|more posts/i })).toBeNull();
  });
});

describe('blog post — copy link (G6)', () => {
  it('copies the URL and confirms, and is ABSENT when the browser has no clipboard', async () => {
    fetchPublicPage.mockResolvedValue({ slug: 'post-0', title: 'Post 0', sections: [], updatedAt: '', seo: { title: '', description: '', canonicalUrl: '', ogTitle: '', ogDescription: '', noindex: false } });
    fetchBlog.mockResolvedValue(posts(2));

    const writeText = vi.fn<(s: string) => Promise<void>>().mockResolvedValue();
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<MemoryRouter><BlogPostPage orgId="org-1" slug="post-0" /></MemoryRouter>);
    const btn = await screen.findByRole('button', { name: /copy link/i });
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText('Copied')).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith(window.location.href);

    cleanup();
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    render(<MemoryRouter><BlogPostPage orgId="org-1" slug="post-0" /></MemoryRouter>);
    await screen.findByRole('heading', { level: 1, name: 'Post 0' });
    expect(screen.queryByRole('button', { name: /copy link/i })).toBeNull();
    if (original) Object.defineProperty(navigator, 'clipboard', original);
  });
});
