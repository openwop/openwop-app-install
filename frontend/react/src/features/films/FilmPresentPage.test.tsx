import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { blankFilm, type FilmSpec } from '../../../../../contracts/films.js';
import { listOrgs } from '../../canvas/canvasClient.js';
import { FilmPresentPage } from './FilmPresentPage.js';

vi.mock('../../canvas/canvasClient.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../canvas/canvasClient.js')>(),
  listOrgs: vi.fn(),
}));
vi.mock('./FilmPresenter.js', () => ({ FilmPresenter: ({ film }: { film: FilmSpec }) => <h1>{film.title}</h1> }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.mocked(listOrgs).mockReset(); });
const orgs = [{ orgId: 'first', name: 'First agency' }, { orgId: 'second', name: 'Second agency' }];
function mount(path: string) {
  render(<MemoryRouter initialEntries={[path]}>
    <Link to="/films/film-1/present?org=second">Switch agency</Link>
    <Routes><Route path="/films/:canvasId/present" element={<FilmPresentPage />} /></Routes>
  </MemoryRouter>);
}
function response(title: string) {
  return new Response(JSON.stringify({ canvasId: 'film-1', version: 2, film: blankFilm(title), assetUrls: {} }), { status: 200 });
}

describe('film presenter organization authority', () => {
  it('discloses a failed organization read and retries it before requesting the film', async () => {
    vi.mocked(listOrgs).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(orgs);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response('Saved film'));
    mount('/films/film-1/present?org=second');
    await screen.findByText(/The film was not requested/);
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button'));
    await screen.findByRole('heading', { name: 'Saved film' });
    expect(String(fetch.mock.calls[0]![0])).toContain('/orgs/second/canvases/film-1/presenter');
  });

  it('requires a choice for an ambiguous link and refuses a non-member link', async () => {
    vi.mocked(listOrgs).mockResolvedValue(orgs);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response('Selected film'));
    mount('/films/film-1/present');
    await screen.findByRole('button', { name: 'Second agency' });
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Second agency' }));
    await screen.findByRole('heading', { name: 'Selected film' });
    expect(String(fetch.mock.calls[0]![0])).toContain('/orgs/second/');
    cleanup(); fetch.mockClear();
    mount('/films/film-1/present?org=not-a-member');
    await screen.findByText("This link points at a workspace you're not a member of.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it('hides the previous film while a different organization is loading', async () => {
    vi.mocked(listOrgs).mockResolvedValue(orgs);
    let finish: (value: Response) => void = () => undefined;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response('Private first film'))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    mount('/films/film-1/present?org=first');
    await screen.findByRole('heading', { name: 'Private first film' });
    fireEvent.click(screen.getByRole('link', { name: 'Switch agency' }));
    await screen.findByText('Loading film…');
    expect(screen.queryByRole('heading', { name: 'Private first film' })).toBeNull();
    // Wait until the second projection request exists before answering it.
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    finish(response('Private second film'));
    await screen.findByRole('heading', { name: 'Private second film' });
  });
});
