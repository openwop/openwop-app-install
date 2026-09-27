/**
 * UX_UPGRADE-docs — the sidebar + article upgrades (D-G1/D-G2/D-G3/D-G5/D-G6).
 *
 * These pin BEHAVIOUR: the sidebar really groups (and by the SAME rule the index
 * uses), the filter really narrows it without ever stranding the reader on the
 * page they're on, `/` and ⌘K really focus it, and prev/next really point at the
 * `docsNav`-adjacent docs.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { DocsNavItem } from '../docsClient.js';

const getDocsNav = vi.fn<() => Promise<DocsNavItem[] | null>>();
vi.mock('../docsClient.js', () => ({ getDocsNav: () => getDocsNav() }));
// The doc BODY is the shared public renderer; it fetches on its own and is not
// what these cases are about, so stub it to a marker.
vi.mock('../../site/FrontPage.js', () => ({ FrontPage: () => <div data-testid="doc-body" /> }));

const { DocsPublicPage } = await import('../DocsPublicPage.js');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

/** Two grouped sections + one ungrouped doc, in `docsNav` order. */
function nav(): DocsNavItem[] {
  const mk = (slug: string, title: string, order: string): DocsNavItem =>
    ({ slug, title, order, updatedAt: '2026-07-20T10:00:00.000Z' });
  return [
    mk('install', 'Install', 'getting-started/10'),
    mk('first-run', 'First run', 'getting-started/20'),
    mk('workflows', 'Workflows', 'guides/10'),
    mk('agents', 'Agents', 'guides/20'),
    mk('packs', 'Packs', 'guides/30'),
    mk('cli', 'CLI', 'guides/40'),
    mk('api', 'API reference', 'reference/10'),
    mk('changelog', 'Changelog', 'zz-changelog'),
  ];
}

const renderDocs = (slug: string | null) =>
  render(<MemoryRouter><DocsPublicPage orgId="org-1" slug={slug} /></MemoryRouter>);

/**
 * The sidebar, AFTER its data has landed. Awaiting the `<nav>` alone proves
 * nothing: the shell renders before `getDocsNav` resolves, so any synchronous
 * assertion on its contents is a race that only surfaces under load — which is
 * exactly how the grouping case failed once in a full-suite run and passed on
 * every re-run. Worse for a NEGATIVE assertion ("the filter is hidden"), which
 * would pass vacuously against an empty nav.
 */
async function sidebarWithDocs(): Promise<HTMLElement> {
  const sidebar = await screen.findByRole('navigation', { name: /documentation navigation/i });
  await within(sidebar).findAllByRole('link');
  return sidebar;
}

describe('docs sidebar — grouping (D-G2) + filter (D-G1)', () => {
  it('groups the SIDEBAR by the same docsNav prefix the index groups by', async () => {
    getDocsNav.mockResolvedValue(nav());
    renderDocs('install');
    const sidebar = await sidebarWithDocs();
    // Group headings are shown humanised, never with the numeric order key.
    expect(within(sidebar).getByText('getting started')).toBeTruthy();
    expect(within(sidebar).getByText('guides')).toBeTruthy();
    expect(within(sidebar).getByText('reference')).toBeTruthy();
    expect(sidebar.textContent).not.toContain('getting-started/10');
  });

  it('filters the sidebar and ALWAYS keeps the page you are on reachable', async () => {
    getDocsNav.mockResolvedValue(nav());
    renderDocs('install');
    const sidebar = await sidebarWithDocs();
    expect(within(sidebar).getAllByRole('link')).toHaveLength(8);

    fireEvent.change(screen.getByRole('textbox', { name: /filter documentation/i }), { target: { value: 'agents' } });
    await waitFor(() => {
      const links = within(sidebar).getAllByRole('link').map((a) => a.textContent);
      // The match, plus the ACTIVE doc — never stranding the current page.
      expect(links).toEqual(['Install', 'Agents']);
    });

    // A filter that matches nothing but the active doc still lists the active doc.
    fireEvent.change(screen.getByRole('textbox', { name: /filter documentation/i }), { target: { value: 'zzzz' } });
    await waitFor(() => expect(within(sidebar).getAllByRole('link').map((a) => a.textContent)).toEqual(['Install']));
  });

  it('matches on the GROUP name too, not just the title', async () => {
    getDocsNav.mockResolvedValue(nav());
    renderDocs(null);
    const sidebar = await sidebarWithDocs();
    fireEvent.change(screen.getByRole('textbox', { name: /filter documentation/i }), { target: { value: 'guides' } });
    await waitFor(() => expect(within(sidebar).getAllByRole('link')).toHaveLength(4));
  });

  it('hides the filter for a short doc set', async () => {
    getDocsNav.mockResolvedValue(nav().slice(0, 3));
    renderDocs(null);
    await sidebarWithDocs();
    expect(screen.queryByRole('textbox', { name: /filter documentation/i })).toBeNull();
  });

  it('“/” and ⌘K focus the filter from anywhere on the page', async () => {
    getDocsNav.mockResolvedValue(nav());
    renderDocs(null);
    const input = await screen.findByRole('textbox', { name: /filter documentation/i });
    expect(document.activeElement).not.toBe(input);

    fireEvent.keyDown(document, { key: '/' });
    await waitFor(() => expect(document.activeElement).toBe(input));

    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    await waitFor(() => expect(document.activeElement).toBe(input));
  });
});

describe('docs article — breadcrumb (D-G5), pager (D-G3), freshness (D-G6)', () => {
  it('breadcrumbs Docs → group → title, and never shows the raw order key', async () => {
    getDocsNav.mockResolvedValue(nav());
    renderDocs('workflows');
    const crumbs = await screen.findByRole('navigation', { name: /breadcrumb/i });
    expect(crumbs.textContent).toContain('guides');
    expect(crumbs.textContent).toContain('Workflows');
    expect(crumbs.textContent).not.toContain('guides/10');
    expect(within(crumbs).getByRole('link', { name: /documentation/i })).toBeTruthy();
  });

  it('omits the group segment for an UNGROUPED doc', async () => {
    getDocsNav.mockResolvedValue(nav());
    renderDocs('changelog');
    const crumbs = await screen.findByRole('navigation', { name: /breadcrumb/i });
    expect(crumbs.textContent).toContain('Changelog');
    expect(crumbs.textContent).not.toContain('zz-changelog');
  });

  it('pages to the docsNav-adjacent docs, and drops the edge at each end', async () => {
    getDocsNav.mockResolvedValue(nav());
    renderDocs('workflows');
    const pager = await screen.findByRole('navigation', { name: /nearby pages/i });
    expect(pager.textContent).toContain('First run'); // previous
    expect(pager.textContent).toContain('Agents');    // next

    cleanup();
    getDocsNav.mockResolvedValue(nav());
    renderDocs('install'); // the FIRST doc has no previous
    const first = await screen.findByRole('navigation', { name: /nearby pages/i });
    expect(first.textContent).not.toContain('Previous');
    expect(first.textContent).toContain('First run');
  });

  it('shows a machine-readable last-updated stamp', async () => {
    getDocsNav.mockResolvedValue(nav());
    const { container } = renderDocs('workflows');
    await screen.findByRole('navigation', { name: /breadcrumb/i });
    const time = container.querySelector('.docs-updated time');
    expect(time?.getAttribute('datetime')).toBe('2026-07-20T10:00:00.000Z');
  });

  it('renders NO article chrome when the nav failed to load (error ≠ empty)', async () => {
    getDocsNav.mockResolvedValue(null);
    renderDocs('workflows');
    await waitFor(() => expect(screen.getByText(/couldn’t load the navigation/i)).toBeTruthy());
    expect(screen.queryByRole('navigation', { name: /breadcrumb/i })).toBeNull();
    expect(screen.queryByRole('navigation', { name: /nearby pages/i })).toBeNull();
  });
});
