/**
 * UX_UPGRADE-site ROUND 3 — the reader-chrome batch (R3-G1..G4), each item
 * citing the tracker's 2026-08-07 catalog rows (premium-Ghost reader baseline;
 * Ghost ⌘K search).
 *
 * Behaviour pins, not markup pins: the ToC appears only when the RENDERED body
 * has enough headings and its links target the real heading ids; the share row
 * is REAL links whose hrefs carry the current URL; ⌘K focuses search but
 * YIELDS when the user is typing elsewhere (the negative control is the
 * guard's whole point); the progress bar is decorative and tracks scroll.
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
  fetchPublicPageResult: async () => {
    const p = await fetchPublicPage();
    return p ? { status: 'ok', page: p } : { status: 'notFound' };
  },
}));

const { BlogPage } = await import('../BlogPage.js');
const { BlogPostPage } = await import('../BlogPostPage.js');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const post = (slug: string): BlogPost => ({
  pageId: `page:${slug}`, slug, title: `T ${slug}`, excerpt: 'x',
  category: 'engineering', tags: [], publishedAt: '2026-07-20T00:00:00.000Z', readingMinutes: 3,
});

/** A page whose sections render THREE headings (deriveToc's own gate is ≥2). */
const richPage = {
  slug: 'post-a', title: 'Post A',
  sections: [
    { sectionId: 's1', type: 'richText', data: { heading: 'Alpha', text: 'one' } },
    { sectionId: 's2', type: 'richText', data: { heading: 'Beta', text: 'two' } },
    { sectionId: 's3', type: 'richText', data: { heading: 'Gamma', text: 'three' } },
  ],
  seo: {},
};
const flatPage = { ...richPage, sections: [{ sectionId: 's1', type: 'richText', data: { text: 'no headings here' } }] };

const renderPost = () =>
  render(<MemoryRouter initialEntries={['/blog/post-a']}><BlogPostPage orgId="org-1" slug="post-a" /></MemoryRouter>);

describe('R3-G2 — table of contents from the rendered body', () => {
  it('lists each heading as a fragment link when the body has enough of them', async () => {
    fetchBlog.mockResolvedValue([post('post-a')]);
    fetchPublicPage.mockResolvedValue(richPage);
    renderPost();
    await screen.findByRole('heading', { name: 'Alpha' });

    const toc = await screen.findByText(/on this page/i);
    expect(toc).toBeTruthy();
    // The links target the ids the renderer actually stamped — the shared
    // headingSlug algorithm, not a parallel one.
    const alpha = screen.getByRole('link', { name: 'Alpha' });
    expect(alpha.getAttribute('href')).toBe('#alpha');
    expect(document.getElementById('alpha'), 'the target exists in the body').toBeTruthy();
    expect(screen.getByRole('link', { name: 'Gamma' }).getAttribute('href')).toBe('#gamma');
  });

  it('grows NO ToC on a post without headings (the noise gate)', async () => {
    fetchBlog.mockResolvedValue([post('post-a')]);
    fetchPublicPage.mockResolvedValue(flatPage);
    renderPost();
    await screen.findByText('no headings here');
    expect(screen.queryByText(/on this page/i), 'a short post never grows chrome').toBeNull();
  });
});

describe('R3-G4 — the share row is REAL links carrying the current URL', () => {
  it('renders X / LinkedIn / email as anchors with the platform intent URLs', async () => {
    fetchBlog.mockResolvedValue([post('post-a')]);
    fetchPublicPage.mockResolvedValue(richPage);
    renderPost();
    await screen.findByRole('heading', { name: 'Alpha' });

    const x = screen.getByRole('link', { name: /share on x/i });
    const li = screen.getByRole('link', { name: /share on linkedin/i });
    const mail = screen.getByRole('link', { name: /email/i });

    // Real links — middle-click and copy-address must work, so NO js-only
    // pseudo-anchors: a genuine external href with a safe rel.
    expect(x.getAttribute('href')).toContain('x.com/intent/post');
    expect(x.getAttribute('rel')).toContain('noopener');
    expect(x.getAttribute('target')).toBe('_blank');
    expect(li.getAttribute('href')).toContain('linkedin.com/sharing/share-offsite');
    expect(mail.getAttribute('href')).toMatch(/^mailto:\?/);
    // The URL being shared is the page's own.
    expect(decodeURIComponent(x.getAttribute('href') ?? '')).toContain(window.location.origin);
  });
});

describe('R3-G1 — the reading-progress bar', () => {
  it('is decorative (aria-hidden) and tracks scroll into the article', async () => {
    fetchBlog.mockResolvedValue([post('post-a')]);
    fetchPublicPage.mockResolvedValue(richPage);
    renderPost();
    await screen.findByRole('heading', { name: 'Alpha' });

    const wrap = screen.getByTestId('reading-progress');
    expect(wrap.getAttribute('aria-hidden'), 'a live percentage is SR noise, not information').toBe('true');

    // Drive the measurement: the article "extends" 1000px and the viewport
    // bottom has advanced 250px into it → scaleX(0.25).
    const bar = wrap.firstElementChild as HTMLElement;
    // The measured element is the body wrapper the page hands to the bar (the
    // unclassed div wrapping RenderSections).
    const bodyEl = (document.querySelector('.fp-post > div:not(.fp-shell):not(.fp-post__progress)') ?? document.body) as HTMLElement;
    vi.spyOn(bodyEl, 'getBoundingClientRect').mockReturnValue({
      top: window.innerHeight - 250, height: 1000, bottom: 0, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    fireEvent.scroll(window);
    await waitFor(() => expect(bar.style.transform).toBe('scaleX(0.25)'));
  });

  it('sits at the sticky shell header\'s bottom edge, never over it', async () => {
    // grade-ux R3 — .public-shell-header is sticky top:0 z-20; a viewport-top
    // fixed bar painted OVER its top edge. The bar must track the header's
    // bottom (and fall back to 0 on a header-less white-label shell).
    fetchBlog.mockResolvedValue([post('post-a')]);
    fetchPublicPage.mockResolvedValue(richPage);
    const header = document.createElement('header');
    header.className = 'public-shell-header';
    document.body.prepend(header);
    vi.spyOn(header, 'getBoundingClientRect').mockReturnValue({
      top: 0, height: 56, bottom: 56, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    try {
      renderPost();
      await screen.findByRole('heading', { name: 'Alpha' });
      fireEvent.scroll(window);
      await waitFor(() => expect(screen.getByTestId('reading-progress').style.top).toBe('56px'));
    } finally {
      header.remove();
    }
  });
});

describe('R3-G3 — Cmd/Ctrl-K focuses blog search, and YIELDS while typing elsewhere', () => {
  it('focuses and selects the search input on Ctrl-K', async () => {
    fetchBlog.mockResolvedValue(Array.from({ length: 6 }, (_, i) => post(`p-${i}`))); // the search band gates on FILTER_MIN_POSTS
    render(<MemoryRouter><BlogPage orgId="org-1" route={{ kind: 'index' }} /></MemoryRouter>);
    const input = await screen.findByRole('textbox', { name: /filter posts/i });
    expect(document.activeElement).not.toBe(input);

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(document.activeElement, 'Ctrl-K lands in search (the Ghost ⌘K row)').toBe(input);
    expect(input.getAttribute('aria-keyshortcuts')).toBe('Meta+K Control+K');
  });

  it('does NOT hijack Ctrl-K while the user is typing in ANOTHER field', async () => {
    // The negative control is the guard's whole point: other inputs keep their
    // meaning; the shortcut yields rather than steals.
    fetchBlog.mockResolvedValue(Array.from({ length: 6 }, (_, i) => post(`p-${i}`))); // the search band gates on FILTER_MIN_POSTS
    const { container } = render(
      <MemoryRouter>
        <div>
          <input aria-label="other field" />
          <BlogPage orgId="org-1" route={{ kind: 'index' }} />
        </div>
      </MemoryRouter>,
    );
    await screen.findByRole('textbox', { name: /filter posts/i });
    const other = container.querySelector('input[aria-label="other field"]') as HTMLInputElement;
    other.focus();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(document.activeElement, 'typing contexts are never hijacked').toBe(other);
  });
});
