/**
 * Grade pass 2026-07-10 — CanvasPresentPage wiring (the pure presentNav math
 * is covered separately): keyboard nav across skip flags, build-step
 * advancing, the empty-deck designed state, blanking announcement, and the
 * kiosk auto-advance timer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const state: { record: { canvasId: string; canvasTypeId: string; name: string; version: number; state: Record<string, unknown> } } = {
  record: { canvasId: 'c1', canvasTypeId: 'canvas.slides', name: 'Deck', version: 1, state: { title: 'Deck', slides: [] } },
};

vi.mock('../canvasClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../canvasClient.js')>();
  return {
    ...orig,
    listOrgs: vi.fn().mockResolvedValue([{ orgId: 'org1', name: 'Acme' }]),
    createCanvasClient: () => ({
      getCanvas: vi.fn().mockImplementation(() => Promise.resolve(state.record)),
    }),
  };
});

import { CanvasPresentPage } from '../CanvasPresentPage.js';
import { slidesDefinition } from '../../features/slides/definition.js';

afterEach(cleanup);
beforeEach(() => {
  state.record = {
    canvasId: 'c1', canvasTypeId: 'canvas.slides', name: 'Deck', version: 1,
    state: { title: 'Deck', slides: [
      { id: 's1', name: 'One', layout: 'title', title: 'Slide one' },
      { id: 's2', name: 'Hidden', layout: 'section', title: 'Skipped', skip: true },
      { id: 's3', name: 'Three', layout: 'section', title: 'Slide three' },
    ] },
  };
});

function mount(search = ''): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[`/slides/c1/present${search}`]}>
      <Routes>
        <Route path="/slides/:canvasId/present" element={<CanvasPresentPage definition={slidesDefinition} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CanvasPresentPage', () => {
  it('navigates with the keyboard, passing over skipped slides, and announces blanking', async () => {
    // The key handler is attached in an EFFECT. Under load (e.g. inside
    // `npm run ci`, after the backend suite) that effect can still be pending
    // when `fireEvent.keyDown` fires, and the key is silently DROPPED — no
    // amount of waiting afterwards recovers a lost event, so flush pending
    // effects first and only then dispatch. (Surfaced as a load-dependent flake:
    // green standalone, red inside `npm run ci`.)
    const r = mount();
    await screen.findByText('Slide one');
    await act(async () => {});
    expect(r.container.textContent).toContain('1 / 3');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(r.container.textContent).toContain('Slide three')); // s2 skipped
    expect(r.container.textContent).toContain('3 / 3');
    fireEvent.keyDown(window, { key: 'b' });
    await waitFor(() => expect(r.container.querySelector('.cv-present__blank--blackout')).not.toBeNull());
    expect(r.container.querySelector('[role="status"]')?.textContent).toBe('Screen blanked');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await waitFor(() => expect(r.container.querySelector('.cv-present__blank--blackout')).toBeNull()); // nav clears blank
    expect(r.container.textContent).toContain('Slide one');
  });

  it('never renders "1 / 0" — present runs the doc through the same coercion as the editor', async () => {
    // A raw empty/malformed doc: coerceDeck synthesizes the minItems fallback
    // slide, so the counter is 1 / 1 (the old path trusted the raw doc and
    // showed 1 / 0 over a blank stage).
    state.record.state = {} as Record<string, unknown>;
    const r = mount();
    await screen.findByLabelText('Presentation');
    expect(r.container.textContent).toContain('1 / 1');
    expect(r.container.textContent).not.toContain('1 / 0');
  });

  it('kiosk auto-advances and loops', async () => {
    vi.useFakeTimers();
    try {
      const r = mount('?kiosk=1&advance=2&loop=1');
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(r.container.textContent).toContain('Slide one');
      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
      expect(r.container.textContent).toContain('Slide three');
      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
      expect(r.container.textContent).toContain('Slide one'); // looped
    } finally {
      vi.useRealTimers();
    }
  });

  it('build steps gate blocks and advance before the next slide', async () => {
    state.record.state = { title: 'Deck', slides: [
      { id: 'b1', name: 'B', layout: 'blocks', variant: 'full', build: true, blocks: [
        { type: 'heading', props: { text: 'First block' } },
        { type: 'text', props: { text: 'Second block' } },
      ] },
      { id: 'end', name: 'End', layout: 'section', title: 'The end' },
    ] };
    const r = mount();
    await screen.findByText('First block');
    // Step 0: block 2 hidden.
    expect(r.container.querySelectorAll('.canvas-slides__blk--pending').length).toBe(2);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(r.container.querySelectorAll('.canvas-slides__blk--pending').length).toBe(1);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(r.container.querySelectorAll('.canvas-slides__blk--pending').length).toBe(0);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(r.container.textContent).toContain('The end');
  });
});

/**
 * SLU-1 — Present mode announced POSITION ("Frame 2 of 3: Three") but carried no
 * deck STRUCTURE, so a screen-reader user could not learn what was coming without
 * arrowing through every frame. The editor gives sighted authors an outline tree;
 * Present gave its screen-reader users nothing. Born red: before the fix there is
 * no `Deck outline` navigation landmark at all.
 */
describe('CanvasPresentPage — the screen-reader deck outline (SLU-1)', () => {
  const outlineItems = (): string[] =>
    Array.from(screen.getByRole('navigation', { name: 'Deck outline' }).querySelectorAll('li'))
      .map((li) => (li.textContent ?? '').trim());

  it('lists every PRESENTED frame by name, omits skipped frames, and numbers by the frame own index', async () => {
    mount();
    await screen.findByText('Slide one');
    // Slide 2 ("Hidden") carries skip:true — it is not part of the presented deck.
    // Slide 3 keeps its own index, so it reads "Frame 3", not "Frame 2".
    expect(outlineItems()).toEqual(['Frame 1: One (current)', 'Frame 3: Three']);
    expect(outlineItems().join(' ')).not.toContain('Hidden');
  });

  it('marks the CURRENT frame with aria-current and moves it as the deck advances', async () => {
    mount();
    await screen.findByText('Slide one');
    const current = (): string =>
      (screen.getByRole('navigation', { name: 'Deck outline' })
        .querySelector('li[aria-current="true"]')?.textContent ?? '').trim();
    expect(current()).toBe('Frame 1: One (current)');
    await act(async () => { await Promise.resolve(); });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(current()).toBe('Frame 3: Three (current)'));
    // Exactly one item is ever current.
    expect(screen.getByRole('navigation', { name: 'Deck outline' })
      .querySelectorAll('li[aria-current="true"]').length).toBe(1);
  });

  it('a frame with no name of its own still reads by a label, never blank', async () => {
    state.record = {
      canvasId: 'c1', canvasTypeId: 'canvas.slides', name: 'Deck', version: 1,
      state: { title: 'Deck', slides: [
        { id: 's1', layout: 'title' },
        { id: 's2', name: 'Named', layout: 'section', title: 'Two' },
      ] },
    };
    mount();
    await screen.findByRole('navigation', { name: 'Deck outline' });
    // slidesDefinition normalises an unnamed slide to its title, else 'Slide N'
    // (features/slides/definition.tsx:80), so the outline is never a bare number.
    expect(outlineItems()).toEqual(['Frame 1: Slide 1 (current)', 'Frame 2: Named']);
  });
});
