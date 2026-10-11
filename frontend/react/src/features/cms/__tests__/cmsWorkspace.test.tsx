/**
 * The page editor (ADR 0822 / ADR 0828): Edit, Preview and Page tabs; sections
 * edit and reorder in place on the page; drafts save themselves, a live page
 * only on request; undo, compare-and-take and AI rewrites work on the page's
 * content.
 *
 * Sabotage that turns it red (each probed in /grade-tests w17): the autosave
 * gate (`autosaveDraft`, and `opts.silent` for the toast), undo coalescing and
 * the save-is-not-an-edit key check, the insert index, the `new:`→`sec:` editor
 * id remap, the delete confirm (asked AND honoured), jump-selects-without-
 * opening, Apply vs Discard on an AI proposal, `typedSlug`, the SEO-only save.
 *
 * Timing: every autosave case runs the 1.5 s `AUTOSAVE_MS` debounce on fake
 * time (`runAutosave`), so none waits on the wall clock; the live-page case
 * advances 10 s of fake time to prove no save ever fires. "Publish is last"
 * can only red on an inverted order —
 * `ACTIONS_FOR.draft` already lists publish last, so `orderedActions` is a
 * no-op for a draft.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReactNode } from 'react';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

vi.mock('../PublicPreviewFrame.js', () => ({
  PublicPreviewFrame: ({ children }: { children: ReactNode }) => <div data-testid="public-preview">{children}</div>,
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));
const ui = vi.hoisted(() => {
  const page = {
    pageId: 'p1', title: 'Launch post', slug: 'p', status: 'draft', version: 1, updatedAt: '2026-01-01T00:00:00Z',
    sections: [
      { sectionId: 'sec:a', type: 'richText', data: { heading: 'The story we were sold', text: 'Body A' } },
      { sectionId: 'sec:b', type: 'richText', data: { heading: 'Where it shows up', text: 'Body B' } },
    ],
  };
  return {
    page,
    confirm: vi.fn(async () => true),
    listVersions: vi.fn(async (): Promise<unknown[]> => []),
    rewriteSection: vi.fn(async (_org: string, input: { data: Record<string, unknown> }) => ({ ...input.data, text: 'Short body.' })),
    savePage: vi.fn(async (_org: string, _id: string, patch: Record<string, unknown>) => {
      // Like the server: a `new:` section gets a minted `sec:` id on save.
      const sections = Array.isArray(patch.sections)
        ? (patch.sections as Array<{ sectionId: string }>).map((x, i) => (x.sectionId.startsWith('new:') ? { ...x, sectionId: `sec:minted-${i}` } : x))
        : page.sections;
      return { ...page, ...patch, sections, version: page.version + 1 };
    }),
    transition: vi.fn(async () => page),
  };
});
vi.mock('../../../ui/confirm.js', () => ({ confirm: ui.confirm }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../cmsClient.js', () => ({
  SECTION_TYPES: ['hero'],
  PAGE_STATUSES: ['draft', 'in_review', 'published', 'archived'],
  SYSTEM_SITE_ORG: 'host-site',
  assetUrl: (token: string) => `/asset/${token}`,
  cmsErrorInfo: () => null,
  CmsApiError: class extends Error {},
  listOrgs: vi.fn(async () => [{ orgId: 'o1', name: 'Org One' }]),
  listPages: vi.fn(async () => [ui.page]),
  getLanguageSettings: vi.fn(async () => ({ baseLocale: 'en', supportedLocales: [], autoTranslateOnPublish: false })),
  putLanguageSettings: vi.fn(), getPageReview: vi.fn(async () => null), getPage: vi.fn(async () => ui.page),
  createPage: vi.fn(), deletePage: vi.fn(), savePage: ui.savePage, transition: ui.transition, translateSection: vi.fn(),
  listVersions: ui.listVersions, restoreVersion: vi.fn(), rewriteSection: ui.rewriteSection,
  schedulePublish: vi.fn(), cancelSchedule: vi.fn(),
  listSharedSections: vi.fn(async () => []), createSharedSection: vi.fn(), updateSharedSection: vi.fn(),
  deleteSharedSection: vi.fn(), listSharedSectionPages: vi.fn(async () => []),
  listLocaleGrants: vi.fn(async () => []), putLocaleGrant: vi.fn(), setLocalePublish: vi.fn(), getTranslationStatus: vi.fn(async () => ({ locales: [], sections: {}, counts: {} })), confirmTranslationSource: vi.fn(),
}));
// ADR 0836 — the editor reads the caller's org access (admin tier): an admin here.
vi.mock('../../../client/accessClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), listMembers: vi.fn(async () => []), getEffectiveAccess: vi.fn(async () => ({ roles: ['owner'], scopes: ['workspace:read', 'workspace:write', 'host:members:manage'], basis: 'member' })) }));
vi.mock('../../media/mediaClient.js', () => ({ listAssets: vi.fn(async () => []), uploadAsset: vi.fn(), absoluteServeUrl: (u: string) => u }));
vi.mock('../../sharing/sharingClient.js', () => ({ createLink: vi.fn(), listLinks: vi.fn(async () => []), revokeLink: vi.fn(), sharedPageUrl: (t: string) => `/shared/${t}` }));
// The Page tab reads and writes the page's search and social record.
const seoApi = vi.hoisted(() => ({
  getSeo: vi.fn(async (): Promise<Record<string, unknown> | null> => ({ metaDescription: 'Old description', noindex: false })),
  putSeo: vi.fn(async (_o: string, _p: string, seo: unknown) => seo),
}));
vi.mock('../../publishing/publishingClient.js', () => seoApi);
vi.mock('../../site/siteConfigClient.js', () => ({ getSiteConfig: vi.fn(async () => { throw new Error('forbidden'); }), putSiteConfig: vi.fn(), invalidateFrontPage: vi.fn() }));

import { CmsPage } from '../CmsPage.js';
import { toast } from '../../../ui/toast.js';

afterEach(() => {
  cleanup(); vi.useRealTimers();
  ui.savePage.mockClear(); ui.confirm.mockClear(); ui.rewriteSection.mockClear(); ui.transition.mockClear();
  seoApi.putSeo.mockClear(); seoApi.getSeo.mockClear();
  vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear();
  ui.page.status = 'draft';
});

function renderDetail(): void {
  render(
    <MemoryRouter initialEntries={['/cms/p/o1/p1']}>
      <Routes><Route path="/cms/p/:routeOrgId/:routePageId" element={<CmsPage />} /></Routes>
    </MemoryRouter>,
  );
}
const canvas = (): HTMLElement => screen.getByTestId('public-preview');
const editing = (name: string): HTMLElement => screen.getByRole('group', { name: `Editing “${name}”` });
const pagePanel = (): HTMLElement => screen.getByRole('tabpanel');
/** Run the draft autosave (`AUTOSAVE_MS`, 1.5 s) on fake time: the case calls
 *  `vi.useFakeTimers({ shouldAdvanceTime: true })` first; afterEach restores. */
async function runAutosave(): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(2000));
}
async function openEditor(name: string): Promise<HTMLElement> {
  fireEvent.click(await within(await screen.findByTestId('public-preview', {}, { timeout: 3000 })).findByRole('button', { name: `Edit “${name}”` }));
  return editing(name);
}

describe('the page editor', () => {
  it('Edit opens only that section in place; the others stay drawn; Done closes it', async () => {
    renderDetail();
    const card = await openEditor('Where it shows up');
    expect(within(card).getByDisplayValue('Where it shows up')).toBeTruthy();
    expect(within(card).queryByDisplayValue('The story we were sold')).toBeNull();
    // The other section is still DRAWN (its public h2), not a second editor —
    // an open editor's head also prints the name, so plain text proves nothing.
    expect(within(canvas()).getByRole('heading', { level: 2, name: 'The story we were sold' })).toBeTruthy();
    expect(screen.getAllByRole('group', { name: /^Editing/ })).toHaveLength(1);
    fireEvent.click(within(card).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('group', { name: /^Editing/ })).toBeNull();
  });

  it('Escape inside the editor closes it', async () => {
    renderDetail();
    const card = await openEditor('The story we were sold');
    fireEvent.keyDown(within(card).getByDisplayValue('The story we were sold'), { key: 'Escape' });
    expect(screen.queryByRole('group', { name: /^Editing/ })).toBeNull();
  });

  it('a draft saves itself shortly after an edit, without a toast or a click', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderDetail();
    const card = await openEditor('The story we were sold');
    fireEvent.change(within(card).getByDisplayValue('The story we were sold'), { target: { value: 'The story I was sold' } });
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    await runAutosave();
    await waitFor(() => expect(ui.savePage).toHaveBeenCalledTimes(1));
    const sent = ui.savePage.mock.calls[0]![2] as { sections: Array<{ data: { heading: string } }> };
    expect(sent.sections[0]!.data.heading).toBe('The story I was sold');
    await waitFor(() => expect(screen.getByText('All changes saved')).toBeTruthy());
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('a published page never saves itself: the status says Save updates the live page', async () => {
    ui.page.status = 'published';
    renderDetail();
    const card = await openEditor('The story we were sold');
    // Fake only the timer the autosave effect would schedule, and run well past it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(within(card).getByDisplayValue('The story we were sold'), { target: { value: 'Live edit' } });
    expect(screen.getByText(/save to update the live page/i)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(ui.savePage).not.toHaveBeenCalled();
    vi.useRealTimers();
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(ui.savePage).toHaveBeenCalledTimes(1));
  });

  it('"+" after a section inserts there, through the picker, and opens the new section', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderDetail();
    fireEvent.click(await within(await screen.findByTestId('public-preview', {}, { timeout: 3000 })).findByRole('button', { name: 'Add a section after “The story we were sold”' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add a section' })).getByRole('button', { name: /^Hero/ }));
    expect(screen.queryByRole('dialog', { name: 'Add a section' })).toBeNull();
    await runAutosave();
    const sent = await waitFor(() => { expect(ui.savePage).toHaveBeenCalled(); return ui.savePage.mock.calls[0]![2] as { sections: Array<{ type: string }> }; });
    expect(sent.sections.map((x) => x.type)).toEqual(['richText', 'hero', 'richText']);
    expect(screen.getByRole('group', { name: /^Editing/ })).toBeTruthy();
  });

  it('a new section stays open in its editor across the save that gives it its permanent id', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderDetail();
    fireEvent.click(await within(await screen.findByTestId('public-preview', {}, { timeout: 3000 })).findByRole('button', { name: 'Add a section at the top' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add a section' })).getByRole('button', { name: /^Hero/ }));
    await runAutosave();
    await waitFor(() => expect(ui.savePage).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('All changes saved')).toBeTruthy());
    expect(screen.getByRole('group', { name: /^Editing/ })).toBeTruthy();
  });

  it('Delete asks first, then removes the section from the page', async () => {
    renderDetail();
    const deleteBtn = async (): Promise<HTMLElement> => within(await screen.findByTestId('public-preview', {}, { timeout: 3000 })).findByRole('button', { name: 'Delete “The story we were sold”' });
    // Declined: the section stays.
    ui.confirm.mockResolvedValueOnce(false);
    fireEvent.click(await deleteBtn());
    await waitFor(() => expect(ui.confirm).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setImmediate(r)); });
    expect(within(canvas()).getByText('The story we were sold')).toBeTruthy();
    // Confirmed: it goes.
    fireEvent.click(await deleteBtn());
    await waitFor(() => expect(ui.confirm).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(canvas()).queryByText('The story we were sold')).toBeNull());
    expect(within(canvas()).getByText('Where it shows up')).toBeTruthy();
  });

  it('move and duplicate act on the page in place', async () => {
    renderDetail();
    fireEvent.click(await within(await screen.findByTestId('public-preview', {}, { timeout: 3000 })).findByRole('button', { name: 'Move “Where it shows up” up' }));
    const order = (): string[] => Array.from(canvas().querySelectorAll('[data-section-id]')).map((n) => n.querySelector('h2')?.textContent ?? '');
    expect(order()).toEqual(['Where it shows up', 'The story we were sold']);
    fireEvent.click(within(canvas()).getByRole('button', { name: 'Duplicate “Where it shows up”' }));
    expect(order()).toEqual(['Where it shows up', 'Where it shows up', 'The story we were sold']);
  });

  it('every section has a drag handle named for it, with keyboard instructions', async () => {
    renderDetail();
    const handle = await within(await screen.findByTestId('public-preview', {}, { timeout: 3000 })).findByRole('button', { name: 'Drag to reorder The story we were sold' });
    const describedBy = handle.getAttribute('aria-describedby');
    expect(describedBy && document.getElementById(describedBy)?.textContent).toMatch(/arrow keys/i);
  });

  it('the Sections menu lists the sections and jumps without opening an editor', async () => {
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Jump to a section' }, { timeout: 3000 }));
    expect(await screen.findByRole('menuitem', { name: /The story we were sold/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: /Where it shows up/ }));
    // Jumped: that section is now the selected one…
    await waitFor(() => expect(canvas().querySelector('[data-section-id="sec:b"]')?.getAttribute('data-selected')).toBe('true'));
    // …and no editor opened.
    expect(screen.queryByRole('group', { name: /^Editing/ })).toBeNull();
  });

  it('Undo and Redo restore and re-apply an edit; a burst of typing is one step', async () => {
    renderDetail();
    const card = await openEditor('The story we were sold');
    const heading = within(card).getByDisplayValue('The story we were sold');
    const undo = screen.getByRole('button', { name: 'Undo' });
    expect((undo as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(heading, { target: { value: 'The story' } });
    fireEvent.change(heading, { target: { value: 'The story I was sold' } });
    fireEvent.click(undo);
    expect(within(editing('The story we were sold')).getByDisplayValue('The story we were sold')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(screen.getByDisplayValue('The story I was sold')).toBeTruthy();
  });

  it('Cmd+Z outside a text field undoes; inside one it is left to the field', async () => {
    renderDetail();
    const card = await openEditor('The story we were sold');
    const heading = within(card).getByDisplayValue('The story we were sold');
    fireEvent.change(heading, { target: { value: 'Edited' } });
    fireEvent.keyDown(heading, { key: 'z', metaKey: true });
    expect(screen.getByDisplayValue('Edited')).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    expect(screen.getByDisplayValue('The story we were sold')).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true, shiftKey: true });
    expect(screen.getByDisplayValue('Edited')).toBeTruthy();
  });

  it('an autosave adds no undo step: Undo still goes back to before the edit', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderDetail();
    const card = await openEditor('The story we were sold');
    fireEvent.change(within(card).getByDisplayValue('The story we were sold'), { target: { value: 'Saved edit' } });
    await runAutosave();
    await waitFor(() => expect(screen.getByText('All changes saved')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByDisplayValue('The story we were sold')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the section picker filters by search and says so when nothing matches', async () => {
    renderDetail();
    fireEvent.click(await within(await screen.findByTestId('public-preview', {}, { timeout: 3000 })).findByRole('button', { name: 'Add a section at the top' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a section' });
    expect(within(dialog).getByRole('button', { name: /^Hero/ })).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('searchbox', { name: 'Search sections' }), { target: { value: 'zzz' } });
    expect(within(dialog).getByText('No section matches that search.')).toBeTruthy();
  });

  it('an AI rewrite is a proposal: Discard changes nothing, Apply edits the section, Undo takes it back', async () => {
    renderDetail();
    const card = await openEditor('The story we were sold');
    fireEvent.click(within(card).getByRole('button', { name: 'Shorten' }));
    const proposal = await within(card).findByRole('region', { name: 'Proposed rewrite' });
    expect(within(proposal).getByText('Short body.')).toBeTruthy();
    expect(ui.rewriteSection.mock.calls[0]![1]).toMatchObject({ sectionType: 'richText', action: 'shorten' });
    fireEvent.click(within(proposal).getByRole('button', { name: 'Discard' }));
    expect(within(card).getByDisplayValue('Body A')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Shorten' }));
    fireEvent.click(within(await within(card).findByRole('region', { name: 'Proposed rewrite' })).getByRole('button', { name: 'Apply' }));
    expect(within(editing('The story we were sold')).getByDisplayValue('Short body.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(within(editing('The story we were sold')).getByDisplayValue('Body A')).toBeTruthy();
  });
});

describe('the header', () => {
  it('Publish is the last workflow action; occasional actions live under More', async () => {
    renderDetail();
    await screen.findByTestId('public-preview', {}, { timeout: 3000 });
    expect(screen.queryByRole('button', { name: /check accessibility/i })).toBeNull();
    const submit = screen.getByRole('button', { name: /^Submit$/ });
    const publish = screen.getByRole('button', { name: /^Publish$/ });
    expect(submit.compareDocumentPosition(publish) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: /check accessibility/i })).toBeTruthy();
  });
});

describe('the Page tab', () => {
  it('cleans the address as it is typed and saves it with the page', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderDetail();
    fireEvent.click(await screen.findByRole('tab', { name: 'Page' }, { timeout: 3000 }));
    const address = within(pagePanel()).getByLabelText(/address/i) as HTMLInputElement;
    fireEvent.change(address, { target: { value: 'My New Post!' } });
    expect(address.value).toBe('my-new-post-');
    await runAutosave();
    await waitFor(() => expect(ui.savePage).toHaveBeenCalled());
    expect(ui.savePage.mock.calls[0]![2]).toMatchObject({ slug: 'my-new-post-' });
  });

  it('the description saves through the search and social record, keeping its other fields', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderDetail();
    fireEvent.click(await screen.findByRole('tab', { name: 'Page' }, { timeout: 3000 }));
    const description = await within(pagePanel()).findByDisplayValue('Old description');
    fireEvent.change(description, { target: { value: 'A sharper description' } });
    expect(within(pagePanel()).getByText('21 / 160')).toBeTruthy();
    await runAutosave();
    await waitFor(() => expect(seoApi.putSeo).toHaveBeenCalledTimes(1));
    expect(seoApi.putSeo.mock.calls[0]![2]).toEqual({ metaDescription: 'A sharper description', noindex: false });
    expect(ui.savePage).not.toHaveBeenCalled();
  });

  it('a failed search-and-social read says so and offers no fields to overwrite it', async () => {
    seoApi.getSeo.mockRejectedValueOnce(new Error('boom'));
    renderDetail();
    fireEvent.click(await screen.findByRole('tab', { name: 'Page' }, { timeout: 3000 }));
    expect(await within(pagePanel()).findByText(/could not be read/i)).toBeTruthy();
    expect(within(pagePanel()).queryByLabelText(/^description/i)).toBeNull();
  });

  it('History compares a seeded update by position and takes one section; Undo takes it back', async () => {
    ui.listVersions.mockResolvedValue([{
      versionId: 'pver:seed', version: 1, origin: 'seed', publishedAt: '2026-10-05T09:00:00Z', publishedBy: 'system (seeded update)',
      snapshot: { title: 'Launch post', slug: 'p', sections: [
        { sectionId: 'sec:s1', type: 'richText', data: { heading: 'The story we were sold', text: 'Body A' } },
        { sectionId: 'sec:s2', type: 'richText', data: { heading: 'Where it shows up, with an example', text: 'Body B' } },
      ] },
    }]);
    try {
      renderDetail();
      fireEvent.click(await screen.findByRole('tab', { name: 'Page' }, { timeout: 3000 }));
      fireEvent.click(within(pagePanel()).getByText('History'));
      fireEvent.click(await within(pagePanel()).findByRole('button', { name: 'Compare' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).queryByText('Only in your draft.')).toBeNull();
      fireEvent.click(within(dialog).getByRole('button', { name: /^Use this version of Where it shows up/ }));
      fireEvent.click(within(dialog).getByRole('button', { name: /close/i }));
      // The draft has it: open that section on the Edit tab.
      fireEvent.click(screen.getByRole('tab', { name: 'Edit' }));
      const card = await openEditor('Where it shows up, with an example');
      expect(within(card).getByDisplayValue('Where it shows up, with an example')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(screen.getByDisplayValue('Where it shows up')).toBeTruthy();
    } finally {
      ui.listVersions.mockResolvedValue([]);
    }
  });
});
