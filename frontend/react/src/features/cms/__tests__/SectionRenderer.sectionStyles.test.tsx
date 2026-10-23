/**
 * ADR 0920 — CMS section styles. Guards:
 * - additive: a section with none of the new fields keeps its exact markup;
 * - tone / split head reach the section as stylesheet hooks, unknown values add nothing;
 * - the hero `plan` card is real text in a figure named "Example plan" with the
 *   friend's note folded into the name (heard once), its action and chips are
 *   inert text, and its progress is stated in words beside the decorative bar;
 * - the new column layouts render their item fields (eyebrow, badge, future, list rows, note);
 * - the richText `chat` picture is a named figure with inert proposal actions;
 * - a same-page fragment CTA renders as a plain anchor, an unsafe one not at all.
 *
 * Ceiling: layout and colour are CSS; jsdom sees only the hook classes, so those
 * class assertions are the claim, not incidental shape.
 * Sabotage-witnessed: w55g1-ss-* (round 1), w55g1-ss-*-r2 (round 2).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

function view(type: Section['type'], data: Record<string, unknown>) {
  return render(<MemoryRouter><RenderSection section={{ sectionId: 's', type, data }} mode="public" /></MemoryRouter>);
}

const PLAN = {
  eyebrow: 'EXAMPLE PLAN · DAY 5 OF 7', title: 'An hour a week for: guitar', meta: 'Sunday, 9:00',
  progress: 0.7, progressNote: '21 minutes made this week', stepTitle: 'Five minutes on guitar',
  lines: [{ label: 'Done when', text: 'your 5 minutes are in.' }], action: 'Did it', chips: ['Later today', 'Swap'],
  initial: 'S', note: 'Day 5 update sent to Sam.', bubble: 'Sam: Look at you.',
};

describe('ADR 0920 — additive guarantee', () => {
  it('a stock columns section keeps its exact class list and markup', () => {
    const base = { heading: 'Why', layout: 'cards', columns: [{ title: 'A', text: 'B' }] };
    const before = view('columns', base).container.innerHTML;
    cleanup();
    const junk = view('columns', { ...base, tone: 'neon', head: 'sideways' }).container.innerHTML;
    expect(junk).toBe(before);
    expect(before).toContain('class="cms-public-section fp-section fp-cards"');
  });
});

describe('ADR 0920 — tone and split head', () => {
  it('adds the tone and split hooks only for known values', () => {
    const { container } = view('columns', { heading: 'H', lede: 'L', layout: 'cards', tone: 'inverse', head: 'split', columns: [] });
    const section = container.querySelector('section');
    expect(section?.className).toContain('fp-tone fp-tone--inverse');
    expect(section?.className).toContain('fp-split');
  });

  it('gives a toned faq the section rhythm it needs to paint a band', () => {
    const { container } = view('faq', { heading: 'Q', tone: 'muted', items: [{ q: 'Why?', a: 'Because.' }] });
    expect(container.querySelector('section')?.className).toBe('cms-public-section fp-section fp-faq-section fp-tone fp-tone--muted');
  });
});

describe('ADR 0920 — hero plan card', () => {
  it('is a figure named Example plan with the note folded in and heard once', () => {
    view('hero', { heading: 'Big dreams', visual: 'plan', plan: PLAN });
    const fig = screen.getByRole('figure', { name: 'Example plan. Sam: Look at you.' });
    expect(within(fig).getByText('An hour a week for: guitar')).toBeTruthy();
    expect(fig.querySelector('.fp-plan__bubble')?.getAttribute('aria-hidden')).toBe('true');
    expect(fig.getAttribute('aria-hidden')).toBeNull();
  });

  it('keeps the action and chips inert and states progress in words', () => {
    view('hero', { heading: 'Big dreams', visual: 'plan', plan: PLAN });
    const fig = screen.getByRole('figure');
    expect(within(fig).queryAllByRole('button')).toHaveLength(0);
    expect(within(fig).queryAllByRole('link')).toHaveLength(0);
    expect(within(fig).getByText('Later today · Swap')).toBeTruthy();
    expect(fig.querySelector('.fp-progress')?.getAttribute('aria-hidden')).toBe('true');
    expect(within(fig).getByText('21 minutes made this week')).toBeTruthy();
  });

  it('renders the hero note and the play-icon second CTA as a same-page anchor', () => {
    view('hero', { heading: 'Big dreams', visual: 'plan', plan: PLAN, ctaLabel2: 'Watch the film', ctaUrl2: '#the-film', ctaIcon2: 'play', note: 'Early access: free.' });
    const link = screen.getByRole('link', { name: 'Watch the film' });
    expect(link.getAttribute('href')).toBe('#the-film');
    // A plain same-page anchor, not the external-link branch.
    expect(link.getAttribute('rel')).toBeNull();
    expect(link.getAttribute('target')).toBeNull();
    expect(link.querySelector('.fp-btn__icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('Early access: free.')).toBeTruthy();
  });

  it('renders no CTA for an unsafe fragment', () => {
    view('hero', { heading: 'Big dreams', ctaLabel2: 'Bad', ctaUrl2: '#javascript:alert(1)' });
    expect(screen.queryByRole('link', { name: 'Bad' })).toBeNull();
  });

  it('draws no card without a title', () => {
    view('hero', { heading: 'Big dreams', visual: 'plan', plan: { eyebrow: 'only' } });
    expect(screen.queryByRole('figure')).toBeNull();
  });
});

describe('ADR 0920 — column layouts', () => {
  it('tiles carry a badge inside the heading and mark a future card', () => {
    const { container } = view('columns', { layout: 'tiles', columns: [{ title: 'A coach', text: 'Not yet.', badge: 'Coming soon', future: true }] });
    expect(screen.getByRole('heading', { level: 3, name: 'A coach Coming soon' })).toBeTruthy();
    expect(container.querySelector('.fp-cols--tiles .fp-col--future')).toBeTruthy();
  });

  it('progress cards show the eyebrow and a decorative bar', () => {
    const { container } = view('columns', { layout: 'progress', columns: [{ eyebrow: 'WEEK 3 OF 8', title: 'Runs', text: 'Easy.', progress: 0.375 }] });
    expect(screen.getByText('WEEK 3 OF 8')).toBeTruthy();
    expect(container.querySelector<HTMLElement>('.fp-progress__fill')?.style.inlineSize).toBe('38%');
    // Decorative: the bar is hidden from assistive tech (the card's text carries the meaning).
    expect(container.querySelector('.fp-progress')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('lists render each row with its meta, and the section note', () => {
    view('columns', { layout: 'list', note: 'Real days.', columns: [{ title: 'Make time', items: [{ label: 'Make Room', meta: '7 days' }, { label: '' }] }] });
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toBe('Make Room7 days');
    expect(screen.getByText('Real days.')).toBeTruthy();
  });

  it('panels draw only known art, decoratively', () => {
    const { container } = view('columns', { layout: 'panels', columns: [{ title: 'A', text: 'x', art: 'feed' }, { title: 'B', text: 'y', art: 'unknown' }] });
    const art = container.querySelectorAll('.fp-panel__art');
    expect(art).toHaveLength(1);
    expect(art[0]?.getAttribute('aria-hidden')).toBe('true');
  });

  it('circled steps number plainly', () => {
    const { container } = view('columns', { layout: 'steps', numbers: 'circle', columns: [{ title: 'One', text: 'x' }] });
    expect(container.querySelector('.fp-steps--circle .fp-step__num')?.textContent).toBe('1');
  });
});

describe('ADR 0920 — richText chat picture', () => {
  it('is a named figure; the proposal actions are text, not controls', () => {
    view('richText', {
      heading: 'It suggests.', text: 'Copy.', visual: 'chat',
      chat: { title: 'KickBot', messages: [{ from: 'person', text: 'Late again.' }, { from: 'guide', text: 'Move it?' }], proposal: { text: 'Wed → Thu', accept: 'Approve', decline: 'Keep my plan' } },
    });
    const fig = screen.getByRole('figure', { name: 'KickBot' });
    expect(within(fig).getByText('Wed → Thu')).toBeTruthy();
    // The actions ARE rendered — as text — and are neither buttons nor links.
    expect(within(fig).getByText('Approve')).toBeTruthy();
    expect(within(fig).getByText('Keep my plan')).toBeTruthy();
    expect(within(fig).queryAllByRole('button')).toHaveLength(0);
    expect(within(fig).queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByText('Copy.')).toBeTruthy();
  });
});
