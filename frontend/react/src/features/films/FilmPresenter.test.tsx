import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { blankFilm } from '../../../../../contracts/films.js';
import { FilmAudience, FilmPresenter } from './FilmPresenter.js';

class Channel {
  static opened: Channel[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: unknown[] = [];
  closed = false;
  constructor(readonly name: string) { Channel.opened.push(this); }
  postMessage(data: unknown) { this.sent.push(structuredClone(data)); }
  close() { this.closed = true; }
}
beforeEach(() => { vi.useFakeTimers(); Channel.opened = []; vi.stubGlobal('BroadcastChannel', Channel); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });

describe('shared film presenter', () => {
  it('holds indefinitely, advances a group, goes back, and does not capture or fetch', () => {
    const film = blankFilm('Live story');
    const fetch = vi.spyOn(globalThis, 'fetch');
    render(<FilmPresenter film={film} source="canvas:1:7" />);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText(/Cue 1 of 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next cue' }));
    expect(screen.getByRole('button', { name: 'Complete animation' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Complete animation' }));
    expect(screen.getByText(/Cue 2 of 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText(/Cue 1 of 2/)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    act(() => vi.advanceTimersByTime(700));
    expect(screen.getByText(/Holding/)).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('sends notes-free snapshots bound to a source and reports popup refusal', () => {
    const film = blankFilm('Live story'); film.scenes[0]!.notes = 'PRIVATE-CANARY';
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(<FilmPresenter film={film} source="canvas:1:7" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open audience window' }));
    expect(screen.getByText(/audience window was blocked/i)).toBeTruthy();
    expect(Channel.opened[0]!.closed).toBe(true);
    cleanup();
    vi.mocked(window.open).mockReturnValue({ closed: false, opener: window } as Window);
    render(<FilmPresenter film={film} source="canvas:1:7" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open audience window' }));
    const channel = Channel.opened[1]!;
    act(() => channel.onmessage?.({ data: { type: 'hello', source: 'canvas:1:7' } }));
    expect(JSON.stringify(channel.sent)).toContain('Live story');
    expect(JSON.stringify(channel.sent)).not.toContain('PRIVATE-CANARY');
    expect(JSON.stringify(channel.sent)).toContain('canvas:1:7');
  });
  it('does not intercept input navigation and snaps cues for reduced motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    render(<><input aria-label="Notes search" /><FilmPresenter film={blankFilm('Story')} source="c:1" /></>);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowRight' });
    expect(screen.getByText(/Cue 1 of 2/)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText(/Cue 2 of 2/)).toBeTruthy();
    expect(screen.getByText(/Holding/)).toBeTruthy();
  });
});
describe('notes-free audience', () => {
  it('refuses another source or invalid position, strips notes, and detects disconnect', () => {
    window.history.replaceState(null, '', '/films/audience#channel=test-session&source=canvas%3A1%3A7');
    render(<FilmAudience />); const channel = Channel.opened[0]!;
    const film = blankFilm('Audience story'); film.scenes[0]!.notes = 'PRIVATE-CANARY';
    const snapshot = { type: 'snapshot', source: 'canvas:1:7', film, position: { step: 0, progress: 1, blank: false }, assetUrls: {} };
    act(() => channel.onmessage?.({ data: { ...snapshot, source: 'canvas:1:8' } }));
    expect(screen.getByText('Waiting for the presenter…')).toBeTruthy();
    act(() => channel.onmessage?.({ data: { ...snapshot, position: { ...snapshot.position, step: 100 } } }));
    expect(screen.queryByRole('img')).toBeNull();
    act(() => channel.onmessage?.({ data: snapshot }));
    expect(screen.getByRole('img', { name: 'Audience story' })).toBeTruthy();
    expect(screen.queryByText('PRIVATE-CANARY')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next cue' })).toBeNull();
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByText(/Presenter disconnected/)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
