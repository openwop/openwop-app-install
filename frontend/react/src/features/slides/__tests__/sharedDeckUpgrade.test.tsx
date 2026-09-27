/**
 * UX_UPGRADE-slides — the public shared-deck viewer's AUDIENCE projection.
 *
 * ADR 0328 §S7 already established the posture: an audience surface must not
 * expose backstage material, which is why speaker notes are *structurally*
 * absent here rather than merely hidden. These cases extend that same rule to
 * the two places it was leaking — the counter and the jump strip — and pin the
 * analytics contract that must NOT change with them (frames are reported by
 * their real deck index, not the audience-facing position).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { SharedDeckViewer } from '../SharedDeckViewer.js';

/** 5 slides, of which 2 are skipped ⇒ an audience can reach exactly 3. */
const deck = {
  theme: 'default',
  slides: [
    { layout: 'title', name: 'Opening', title: 'One' },
    { layout: 'title', name: 'Cut', skip: true, title: 'HIDDEN A' },
    { layout: 'section', name: 'Middle', title: 'Two' },
    { layout: 'title', name: 'Also cut', skip: true, title: 'HIDDEN B' },
    { layout: 'section', name: 'Close', title: 'Three' },
  ],
};

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 }))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const renderDeck = () => render(<SharedDeckViewer token="tok" deck={deck} />);

describe('shared deck — the counter tells the truth (SL-G1)', () => {
  it('counts only reachable slides, and advances by ONE each time', async () => {
    const { container, getByLabelText } = renderDeck();
    // 5 slides, 2 skipped ⇒ "1 / 3", never "1 / 5".
    expect(container.textContent).toContain('1 / 3');

    await act(async () => { fireEvent.click(getByLabelText('Next')); });
    // The old viewer jumped 1 → 3 here (raw deck index); the audience now sees
    // a consecutive count that matches what they are actually being shown.
    expect(container.textContent).toContain('2 / 3');
    expect(container.textContent).toContain('Two');

    await act(async () => { fireEvent.click(getByLabelText('Next')); });
    expect(container.textContent).toContain('3 / 3');
    expect(container.textContent).toContain('Three');
  });

  it('never renders the hidden slides’ content at any position', async () => {
    const { container, getByLabelText } = renderDeck();
    for (let i = 0; i < 3; i += 1) {
      expect(container.textContent).not.toContain('HIDDEN A');
      expect(container.textContent).not.toContain('HIDDEN B');
      await act(async () => { fireEvent.click(getByLabelText('Next')); });
    }
  });
});

describe('shared deck — the jump strip shows no backstage (SL-G2)', () => {
  it('draws one dot per REACHABLE slide and names them consecutively', () => {
    const { container } = renderDeck();
    const dots = Array.from(container.querySelectorAll('.cv-shared-deck__dot'));
    expect(dots).toHaveLength(3);
    // A named slide keeps its name; the labels must not imply a 5-slide deck.
    expect(dots.map((d) => d.getAttribute('aria-label'))).toEqual(['Opening', 'Middle', 'Close']);
  });

  it('jumping by dot lands on that slide and keeps the counter consistent', async () => {
    const { container } = renderDeck();
    const dots = Array.from(container.querySelectorAll('.cv-shared-deck__dot'));
    await act(async () => { fireEvent.click(dots[2]!); });
    expect(container.textContent).toContain('Three');
    expect(container.textContent).toContain('3 / 3');
  });
});

describe('shared deck — the analytics contract is unchanged', () => {
  it('still reports the REAL deck index, not the audience position', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(null, { status: 204 });
    }));
    const { getByLabelText } = renderDeck();
    await act(async () => { fireEvent.click(getByLabelText('Next')); });
    await act(async () => { fireEvent.click(getByLabelText('Next')); });
    // Audience positions 1,2,3 ⇒ deck indices 0,2,4. Reporting the friendly
    // position instead would silently corrupt every existing frame-view tally.
    expect(bodies.map((b) => JSON.parse(b).frame)).toEqual([0, 2, 4]);
  });
});
