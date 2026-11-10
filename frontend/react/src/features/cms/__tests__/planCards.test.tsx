/**
 * ADR 1069 — plan cards on the columns `list` layout, and the callout footnote.
 *
 *   - D1: a list with a price `unit` or a card button (and no status) is a plan
 *     list (`fp-cols--plans`): each card shows its eyebrow, its price with the
 *     unit small inside the same heading (so it reads "$299 a month, per app"),
 *     and its own button at the foot, primary on the highlighted plan (which
 *     takes the band tokens) and ghost elsewhere. A status list never becomes
 *     a plan list.
 *   - D2: `noteStyle: 'callout'` boxes the footnote behind a decorative mark.
 *
 * Sabotage witnesses: dropping the eyebrow, the unit, the card button or its
 * primary-on-highlight rule, marking a status list as plans, or dropping the
 * callout reds a case.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

const renderSection = (s: Section): HTMLElement => render(<MemoryRouter><RenderSection section={s} mode="public" /></MemoryRouter>).container;
const plans = [
  { eyebrow: 'Run it yourself', title: 'Free', text: 'The open-source code.', items: [{ label: 'Every feature' }], ctaLabel: 'Read the code', ctaUrl: '/p/open-source' },
  { eyebrow: 'We launch it with you', title: 'About $1,000', unit: 'once', text: 'We set it up.', highlight: true, ctaLabel: 'Book a free call', ctaUrl: '/p/design-partners' },
  { eyebrow: 'We run it', title: '$299', unit: 'a month, per app', text: 'We host it.' },
];

describe('plan cards (ADR 1069 D1)', () => {
  it('draws the eyebrow, the price with its unit, and a button at the foot of each card', () => {
    const c = renderSection({ sectionId: 'sec:offer', type: 'columns', data: { layout: 'list', columns: plans } });
    expect(c.querySelector('section')!.classList.contains('fp-cols--plans')).toBe(true);
    const [free, launch, run] = [...c.querySelectorAll('.fp-col')];
    expect(free!.querySelector('.fp-col__eyebrow')?.textContent).toBe('Run it yourself');
    expect(screen.getByRole('heading', { name: '$299 a month, per app' })).toBeTruthy();
    expect(run!.querySelector('.fp-col__title .fp-col__unit')?.textContent).toBe('a month, per app');
    expect(free!.querySelector('.fp-col__cta a')?.classList.contains('fp-btn--ghost')).toBe(true);
    expect(launch!.querySelector('.fp-col__cta a')?.classList.contains('fp-btn--primary')).toBe(true);
    expect(launch!.classList.contains('fp-tone--inverse'), 'the featured plan is the dark card').toBe(true);
    expect(free!.classList.contains('fp-tone--inverse')).toBe(false);
    expect(run!.querySelector('.fp-col__cta'), 'no button without a label').toBeNull();
    expect(launch!.lastElementChild!.classList.contains('fp-col__cta'), 'the button is the card\'s last child').toBe(true);
  });

  it('never turns a status list into plans', () => {
    const c = renderSection({ sectionId: 'sec:status', type: 'columns', data: { layout: 'list', columns: [{ title: 'Works', items: [{ label: 'Sign-in' }], unit: 'ignored' }, { title: 'Not yet', future: true, items: [{ label: 'Voice' }] }] } });
    const s = c.querySelector('section')!;
    expect(s.classList.contains('fp-cols--status')).toBe(true);
    expect(s.classList.contains('fp-cols--plans')).toBe(false);
  });
});

describe('callout footnote (ADR 1069 D2)', () => {
  it('boxes the note behind a decorative mark', () => {
    const c = renderSection({ sectionId: 'sec:offer', type: 'columns', data: { layout: 'list', columns: plans, note: '**Not included:** your ad spend.', noteStyle: 'callout' } });
    const note = c.querySelector('.fp-cols__note')!;
    expect(note.classList.contains('fp-cols__note--callout')).toBe(true);
    expect(note.querySelector('.fp-cols__note-mark')?.getAttribute('aria-hidden')).toBe('true');
    expect(note.querySelector('strong')?.textContent).toBe('Not included:');
  });

  it('keeps the plain line without the style', () => {
    const c = renderSection({ sectionId: 'sec:offer', type: 'columns', data: { layout: 'list', columns: plans, note: 'A plain note.' } });
    expect(c.querySelector('.fp-cols__note')!.classList.contains('fp-cols__note--callout')).toBe(false);
    expect(c.querySelector('.fp-cols__note-mark')).toBeNull();
  });
});
