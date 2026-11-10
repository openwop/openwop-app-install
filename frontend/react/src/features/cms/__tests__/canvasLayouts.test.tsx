/**
 * ADR 1032 — the canvas layouts as a visitor and an editor meet them.
 * Guards:
 * - a `video` section with `film2` shows two players side by side, then the
 *   footnote; without it, one player and no grid;
 * - an `image` shows its head, and with `frame: 'browser'` the screenshot sits
 *   under a decorative (aria-hidden) window bar carrying the address label;
 * - a bento tile's item renders as an inset card (bold line + detail);
 * - a `rows` section with `toggles` shows real switches (role="switch"), each
 *   with its state in WORDS that change when flipped; nothing else changes;
 * - the editor offers the frame, the second film and the switches.
 *
 * Ceiling: the side-by-side layout and the switch's look are CSS; jsdom sees the
 * markup and the hooks. Sabotage-witnessed (2026-11-02; re-measured /grade-tests
 * wave 84, TST-FPG-1): rendering only the first film or no footnote, dropping
 * aria-hidden or the address from the window bar, framing without `frame`, an
 * inset title that is not bold, a state word that never changes, a flip that
 * changes the other switches (inverts them, or sets them all), dropping
 * role="switch", or an editor without the address, second-film or switches
 * control each turn a case red.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import { SectionFields } from '../SectionsEditor.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

function view(type: Section['type'], data: Record<string, unknown>) {
  return render(<MemoryRouter><RenderSection section={{ sectionId: 's', type, data }} mode="public" /></MemoryRouter>);
}
const FILM = { title: 'One', description: 'First.', src: 'https://cdn.example.test/one.mp4', poster: 'https://cdn.example.test/one.jpg', length: '1:13' };
const FILM2 = { title: 'Two', description: 'Second.', src: 'https://cdn.example.test/two.mp4', poster: 'https://cdn.example.test/two.jpg', length: '1:44' };

describe('ADR 1032 — two films', () => {
  it('puts both films in one grid, then the footnote', () => {
    const { container } = view('video', { ...FILM, film2: FILM2, note: 'Narrated by an AI voice.' });
    const grid = container.querySelector('.fp-films__grid') as HTMLElement;
    expect(grid.querySelectorAll('video')).toHaveLength(2);
    expect(within(grid).getByText('Two')).toBeTruthy();
    expect(container.querySelector('.fp-films__note')?.textContent).toBe('Narrated by an AI voice.');
  });
  it('keeps a single film exactly as before (no grid)', () => {
    const { container } = view('video', FILM);
    expect(container.querySelector('.fp-films__grid')).toBeNull();
    expect(container.querySelectorAll('video')).toHaveLength(1);
  });
});

describe('ADR 1032 — framed image', () => {
  it('shows the head and a decorative window bar with the address', () => {
    const { container } = view('image', { token: 'tok', alt: 'The dashboard', heading: 'This is the real app, today.', lede: 'No mockups.', frame: 'browser', frameUrl: 'myndhyve.ai/dashboard' });
    expect(screen.getByRole('heading', { name: 'This is the real app, today.' })).toBeTruthy();
    const bar = container.querySelector('.fp-browser__bar') as HTMLElement;
    expect(bar.getAttribute('aria-hidden')).toBe('true');
    expect(bar.textContent).toBe('myndhyve.ai/dashboard');
    expect(screen.getByRole('img', { name: 'The dashboard' })).toBeTruthy();
  });
  it('has no frame without `frame`', () => {
    const { container } = view('image', { token: 'tok', alt: 'A' });
    expect(container.querySelector('.fp-browser')).toBeNull();
  });
});

describe('ADR 1032 — bento inset card', () => {
  it('renders a tile item as a bold line and its detail', () => {
    const { container } = view('columns', { layout: 'bento', columns: [{ title: 'Print your app', text: 'Out comes your app.', wide: true, items: [{ label: 'Ready to print', meta: 'Agents set up · Workflow tested' }] }] });
    const inset = container.querySelector('.fp-bento__inset') as HTMLElement;
    expect(inset.querySelector('strong')?.textContent).toBe('Ready to print');
    expect(inset.textContent).toContain('Agents set up · Workflow tested');
  });
});

describe('ADR 1032 — rows try-it switches', () => {
  const data = { layout: 'rows', heading: 'You stay in charge', columns: [{ title: 'See every step', text: 'Who it wrote to.' }], toggles: { title: 'Try it: which steps wait for you?', items: [{ label: 'Draft the reply' }, { label: 'Send the email', on: true }, { label: 'Archive the thread' }] } };
  it('shows switches with their state in words, and flipping one changes only it', () => {
    view('columns', data);
    const group = screen.getByRole('group', { name: 'Try it: which steps wait for you?' });
    const switches = within(group).getAllByRole('switch');
    expect(switches.map((s) => (s as HTMLInputElement).checked)).toEqual([false, true, false]);
    const rows = within(group).getAllByRole('listitem');
    expect(rows[0]!.textContent).toContain('Runs on its own');
    expect(rows[1]!.textContent).toContain('Waits for you');
    expect(rows[2]!.textContent).toContain('Runs on its own');
    // Three switches, mixed: a flip that set EVERY switch would turn the third on
    // (two switches [off, on] cannot tell that bug from the right answer).
    fireEvent.click(switches[0]!);
    expect(switches.map((s) => (s as HTMLInputElement).checked)).toEqual([true, true, false]);
    expect(rows[0]!.textContent).toContain('Waits for you');
    expect(rows[1]!.textContent).toContain('Waits for you');
    expect(rows[2]!.textContent).toContain('Runs on its own');
    expect(screen.getByRole('heading', { name: 'See every step' })).toBeTruthy();
  });
  it('renders plain rows when there are no switches', () => {
    const { container } = view('columns', { ...data, toggles: undefined });
    expect(container.querySelector('.fp-try')).toBeNull();
    expect(container.querySelector('.fp-rows--try')).toBeNull();
  });
});

describe('ADR 1032 — the editor', () => {
  it('offers the frame, the second film and the switches', () => {
    const noop = (): void => undefined;
    render(<MemoryRouter><SectionFields section={{ sectionId: 's', type: 'image', data: { token: 'tok', frame: 'browser' } }} onChange={noop} assets={[]} /></MemoryRouter>);
    expect(screen.getByRole('combobox', { name: /frame/i })).toBeTruthy();
    expect(screen.getByText(/address shown/i)).toBeTruthy();
    cleanup();
    render(<MemoryRouter><SectionFields section={{ sectionId: 's', type: 'video', data: { ...FILM } }} onChange={noop} assets={[]} /></MemoryRouter>);
    expect(screen.getByRole('checkbox', { name: /second film/i })).toBeTruthy();
    cleanup();
    render(<MemoryRouter><SectionFields section={{ sectionId: 's', type: 'columns', data: { layout: 'rows', columns: [] } }} onChange={noop} assets={[]} /></MemoryRouter>);
    expect(screen.getByRole('group', { name: /try-it switches/i })).toBeTruthy();
  });
});
