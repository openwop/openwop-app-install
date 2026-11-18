import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { blankFilm } from '../../../../../contracts/films.js';
import { FilmPresenter } from './FilmPresenter.js';
const endpoint = '/api/host/openwop-app/films/orgs/o/canvases/c/performances?revision=7';
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('TextEncoder', TextEncoder); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('never loads or captures a rehearsal implicitly, retains a failed save, retries the same intent and previews silently', async () => {
 const film = blankFilm('Agency rehearsal'); film.scenes[0]!.notes = 'PRIVATE-REHEARSAL-NOTES';
 const posts: { requestId: string; performance: unknown }[] = []; let fail = true;
 const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
   if (options?.method === 'POST') {
     const body = JSON.parse(String(options.body)) as { requestId: string; performance: unknown }; posts.push(body);
     if (fail) { fail = false; return Response.json({ error: 'unavailable' }, { status: 503 }); }
     return Response.json({ id: 'film-take:saved', name: 'Rehearsal 1', createdAt: '2026-11-09T00:00:00Z', performance: body.performance });
   }
   return Response.json({ takes: [], next: null, canSave: true });
 });
 const dirty = vi.fn();
 render(<FilmPresenter film={film} source="canvas:c:7" performanceEndpoint={endpoint} onUnsavedChange={dirty} />);
 expect(fetch).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: 'Stop and review timing' })).toBeNull();
 fireEvent.click(screen.getByRole('button', { name: 'Rehearse and replay' }));
 const start = screen.getByRole('button', { name: 'Start timing rehearsal' }); await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false));
 fireEvent.click(start); expect(screen.getByText('Capturing cue timings only.')).toBeTruthy();
 fireEvent.click(screen.getByRole('button', { name: 'Next cue' })); fireEvent.click(screen.getByRole('button', { name: 'Stop and review timing' }));
 fireEvent.click(screen.getByRole('button', { name: 'Save new take' })); expect(await screen.findByRole('alert')).toBeTruthy();
 expect(screen.getByRole('button', { name: 'Discard unsaved take' })).toBeTruthy();
 fireEvent.click(screen.getByRole('button', { name: 'Save new take' }));
 expect(await screen.findByText('Private timing take saved. Previous takes are unchanged.')).toBeTruthy();
 expect(dirty).toHaveBeenCalledWith(true); expect(dirty).toHaveBeenLastCalledWith(false);
 expect(posts).toHaveLength(2); expect(posts[1]).toEqual(posts[0]); expect(JSON.stringify(posts)).not.toContain('PRIVATE-REHEARSAL-NOTES');
 expect(screen.getByRole('button', { name: 'Play replay' })).toBeTruthy(); expect(screen.getByRole('slider', { name: 'Seek timing replay' })).toBeTruthy();
 expect(screen.queryByRole('button', { name: 'Discard unsaved take' })).toBeNull();
 expect(fetch.mock.calls.every(([u]) => String(u).includes('/performances?revision=7'))).toBe(true);
});

it('lets a reader preview locally without offering a persistent write', async () => {
 const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ takes: [], next: null, canSave: false }));
 render(<FilmPresenter film={blankFilm('Read-only rehearsal')} source="canvas:readonly:1" performanceEndpoint={endpoint} />);
 fireEvent.click(screen.getByRole('button', { name: 'Rehearse and replay' }));
 await screen.findByText('You can preview timings, but saving a take requires edit access to this film.');
 fireEvent.click(screen.getByRole('button', { name: 'Start timing rehearsal' }));
 fireEvent.click(screen.getByRole('button', { name: 'Stop and review timing' }));
 expect(screen.getByRole('button', { name: 'Save new take' }).hasAttribute('disabled')).toBe(true);
 fireEvent.click(screen.getByRole('button', { name: 'Preview timing' }));
 expect(screen.getByRole('button', { name: 'Play replay' })).toBeTruthy();
 expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
