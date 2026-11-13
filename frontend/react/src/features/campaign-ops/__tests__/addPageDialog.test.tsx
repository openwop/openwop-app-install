/**
 * CC-OPS-1: an operator registers one of the client org's CMS pages as an asset from the
 * Operations page. This runs the real API transport (fetch stubbed) through the real dialog.
 *
 * Invariants:
 *  - Only pages not yet registered are offered. The field list is the server's own (the CMS
 *    adapter's paths), so the UI never invents a path.
 *  - Choosing a page pre-ticks the title and defaults the name to the page title. The POST body
 *    is exactly `{destination, locator:{pageId}, label, editableFields}` with the ticked paths.
 *  - A refused add shows the server's words (which name the valid fields) and stays open.
 *  - A failed page read is said, with a retry, never shown as "no pages".
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { config } from '../../../client/config.js';
import { AddPageDialog } from '../AddPageDialog.js';

const HEADING = 'sections[sec:1].data.heading';
const PAGES = [
  { pageId: 'p-reg', title: 'Already added', status: 'published', registered: true, fields: [{ path: 'title', preview: 'Already added' }] },
  { pageId: 'p-1', title: 'Q4 launch', status: 'draft', registered: false, fields: [
    { path: 'title', preview: 'Q4 launch' }, { path: HEADING, preview: 'Ship faster this quarter' },
  ] },
];
const transport = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const candidatesUrl = `${config.baseUrl}/host/openwop-app/campaign-ops/clients/org%3Akick/asset-candidates`;
const assetsUrl = `${config.baseUrl}/host/openwop-app/campaign-ops/clients/org%3Akick/assets`;
const onClose = vi.fn();
const onAdded = vi.fn();
const mount = () => render(<AddPageDialog orgId="org:kick" onClose={onClose} onAdded={onAdded} />);
const dialog = () => within(screen.getByRole('dialog'));
const button = (name: string): HTMLButtonElement => { const el = dialog().getByRole('button', { name }); if (!(el instanceof HTMLButtonElement)) throw new Error('Expected a button'); return el; };
const box = (name: string): HTMLInputElement => { const el = dialog().getByRole('checkbox', { name }); if (!(el instanceof HTMLInputElement)) throw new Error('Expected a checkbox'); return el; };
const nameInput = (): HTMLInputElement => { const el = dialog().getByRole('textbox', { name: 'Name in requests' }); if (!(el instanceof HTMLInputElement)) throw new Error('Expected an input'); return el; };

beforeEach(() => {
  onClose.mockReset(); onAdded.mockReset();
  transport.mockReset().mockImplementation(async (url) =>
    String(url) === candidatesUrl ? json({ pages: PAGES }) : json({ asset: { assetId: 'a1' } }, 201));
  vi.stubGlobal('fetch', transport);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('offers only unregistered pages and posts exactly the ticked server field paths', async () => {
  mount();
  const select = await dialog().findByRole('combobox', { name: 'Page' });
  const options = within(select).getAllByRole('option').map((o) => o.textContent);
  expect(options).toEqual(['Choose a page', 'Q4 launch']);
  expect(button('Add page').disabled).toBe(true);

  fireEvent.change(select, { target: { value: 'p-1' } });
  expect(nameInput().value).toBe('Q4 launch');
  expect(box('Page title').checked).toBe(true);
  const heading = box('Ship faster this quarter');
  expect(heading.checked).toBe(false);
  fireEvent.click(heading);
  fireEvent.click(button('Add page'));

  await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
  expect(onClose).toHaveBeenCalledTimes(1);
  const post = transport.mock.calls.find(([url]) => String(url) === assetsUrl);
  if (!post) throw new Error('Adding a page must POST the asset');
  expect(post[1]?.method).toBe('POST');
  expect(JSON.parse(String(post[1]?.body))).toEqual({
    destination: 'openwop.cms.page', locator: { pageId: 'p-1' }, label: 'Q4 launch', editableFields: ['title', HEADING],
  });
});

it('cannot submit with no field ticked or a blank name', async () => {
  mount();
  fireEvent.change(await dialog().findByRole('combobox', { name: 'Page' }), { target: { value: 'p-1' } });
  fireEvent.click(box('Page title'));
  expect(button('Add page').disabled).toBe(true);
  fireEvent.click(box('Page title'));
  fireEvent.change(nameInput(), { target: { value: '   ' } });
  expect(button('Add page').disabled).toBe(true);
});

it('shows the server refusal, which names the valid fields, and stays open', async () => {
  const words = `Some editable fields do not exist on this page. Valid fields: title, ${HEADING}.`;
  transport.mockImplementation(async (url) => String(url) === candidatesUrl
    ? json({ pages: PAGES })
    : json({ error: 'validation_error', message: words }, 400));
  mount();
  fireEvent.change(await dialog().findByRole('combobox', { name: 'Page' }), { target: { value: 'p-1' } });
  fireEvent.click(button('Add page'));
  expect(await dialog().findByText(words)).toBeTruthy();
  expect(onAdded).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it('says a failed page read with a retry, and says when no pages are left', async () => {
  transport.mockResolvedValueOnce(json({ error: 'internal' }, 500));
  mount();
  expect(await dialog().findByText('Couldn’t load this client’s pages.')).toBeTruthy();
  expect(dialog().queryByText('No pages left to add')).toBeNull();
  transport.mockImplementation(async () => json({ pages: [PAGES[0]] }));
  fireEvent.click(button('Try again'));
  expect(await dialog().findByText('No pages left to add')).toBeTruthy();
});
