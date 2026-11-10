/**
 * ADR 1047 — feature cards and the hero hub as a visitor and an editor meet them.
 * Guards:
 * - a `features` section renders one card per item: eyebrow, title with its
 *   heading emphasis, the picture (alt text, framed when an address is set),
 *   the lead, the callout, labelled pills, and a native <details> disclosure;
 * - each pill's words are its authored label; its state only styles it, and
 *   the legend word is read with it (never a fixed "Now"/"Soon");
 * - the legend renders only when the section supplies its words;
 * - a hub hero is a <figure> whose accessible name lists the centre and every
 *   place; the centre picture keeps its alt; the glyphs and lines are hidden;
 *   fewer than two places renders no hub;
 * - the editor offers the hub and features fields.
 *
 * Ceiling: the spoke draw and the pill colours are CSS; jsdom sees the markup.
 * Sabotage-witnessed (w86 grade-tests): dropping the eyebrow, lead, callout
 * label or text, or disclosure body, or opening the <details>, reds the full
 * card; dropping a pill's legend word or state class reds the pill case; showing
 * the legend without words reds the "never invents" case; joining the hub name
 * differently, unhiding the lines or a glyph, or blanking the centre alt reds the
 * figure case; a one-place hub reds the "fewer than two" case; hiding the hub or
 * feature fields, or a place/pill input that writes nothing, reds the editor.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import { SectionFields } from '../SectionsEditor.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

function el<T extends Element>(node: Element | null | undefined, type: new () => T): T {
  if (!(node instanceof type)) throw new Error(`expected a ${type.name}`);
  return node;
}
function view(type: Section['type'], data: Record<string, unknown>) {
  return render(<MemoryRouter><RenderSection section={{ sectionId: 's', type, data }} mode="public" /></MemoryRouter>);
}
const FEATURE = {
  eyebrow: 'Stop 1 · Team chat', title: 'Your agent, *in the thread.*', text: 'Mention your agent where your team already talks.',
  imageToken: 'tok_chat', alt: 'A chat thread with an approval card', frameUrl: 'app.example.test/chat',
  callout: { label: 'The problem it solves', text: 'Nothing goes out unapproved.' },
  tags: [{ label: 'Start work from Slack', state: 'now' }, { label: 'Two-way chat', state: 'soon' }],
  more: { label: 'How you use it', text: 'Connect Slack under Connections.' },
};
const HUB = {
  center: { eyebrow: 'One', label: 'Your agent', imageToken: 'tok_head', alt: 'The robot head mark' },
  spokes: [{ label: 'Team chat', index: '01', icon: 'chat' }, { label: 'Customers', index: '02', icon: 'users' }, { label: 'The phone', index: '03', icon: 'phone' }],
};

describe('ADR 1047 — feature cards', () => {
  it('renders a full card', () => {
    const { container } = view('columns', { layout: 'features', tagLegend: { now: 'Available now', soon: 'Rolling out' }, columns: [FEATURE] });
    const card = el(container.querySelector('.fp-features__grid .fp-feature'), HTMLElement);
    expect(card.querySelector('.fp-feature__eyebrow')?.textContent).toBe('Stop 1 · Team chat');
    expect(within(card).getByRole('heading', { level: 3 }).querySelector('.fp-em')?.textContent).toBe('in the thread.');
    expect(card.querySelector('.fp-feature__text')?.textContent).toBe('Mention your agent where your team already talks.');
    const media = el(card.querySelector('.fp-feature__media'), HTMLElement);
    expect(media.classList.contains('fp-browser')).toBe(true);
    expect(within(media).getByRole('img', { name: 'A chat thread with an approval card' })).toBeTruthy();
    expect(card.querySelector('.fp-feature__callout-label')?.textContent).toBe('The problem it solves');
    expect(card.querySelector('.fp-feature__callout')?.textContent).toBe('The problem it solvesNothing goes out unapproved.');
    const details = el(card.querySelector('details.fp-feature__more'), HTMLDetailsElement);
    expect(details.querySelector('summary')?.textContent).toBe('How you use it');
    expect(details.querySelector('.fp-feature__more-body')?.textContent).toBe('Connect Slack under Connections.');
    expect(details.open).toBe(false);
  });
  it('reads each pill with its legend word and styles it by state', () => {
    const { container } = view('columns', { layout: 'features', tagLegend: { now: 'Available now', soon: 'Rolling out' }, columns: [FEATURE] });
    const pills = Array.from(container.querySelectorAll('.fp-feature__tags .fp-tag'));
    expect(pills.map((p) => p.textContent)).toEqual(['Start work from Slack (Available now)', 'Two-way chat (Rolling out)']);
    expect(pills.map((p) => [p.classList.contains('fp-tag--now'), p.classList.contains('fp-tag--soon')])).toEqual([[true, false], [false, true]]);
    const legend = el(container.querySelector('.fp-features__legend'), HTMLElement);
    expect(legend.textContent).toBe('Available nowRolling out');
  });
  it('never invents state words when the section names none', () => {
    const { container } = view('columns', { layout: 'features', columns: [FEATURE] });
    expect(container.querySelector('.fp-features__legend')).toBeNull();
    const pills = Array.from(container.querySelectorAll('.fp-feature__tags .fp-tag'));
    expect(pills.map((p) => p.textContent)).toEqual(['Start work from Slack', 'Two-way chat']);
  });
});

describe('ADR 1047 — hero hub', () => {
  it('is a figure naming the centre and every place', () => {
    const { container } = view('hero', { heading: 'Everywhere your work happens.', visual: 'hub', hub: HUB });
    const fig = screen.getByRole('figure', { name: 'Your agent: Team chat, Customers, The phone' });
    expect(within(fig).getByRole('img', { name: 'The robot head mark' })).toBeTruthy();
    expect(fig.querySelector('.fp-hub__lines')?.getAttribute('aria-hidden')).toBe('true');
    expect(fig.querySelectorAll('.fp-hub__place')).toHaveLength(3);
    expect(fig.querySelector('.fp-hub__icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.fp-hero--hub')).toBeTruthy();
  });
  it('renders no hub with fewer than two places', () => {
    const { container } = view('hero', { heading: 'H', visual: 'hub', hub: { center: { label: 'C' }, spokes: [{ label: 'Only' }] } });
    expect(container.querySelector('.fp-hub')).toBeNull();
  });
});

describe('ADR 1047 — the editor', () => {
  it('offers the hub fields on a hub hero', () => {
    const onChange = vi.fn<(d: Record<string, unknown>) => void>();
    render(<MemoryRouter><SectionFields section={{ sectionId: 's', type: 'hero', data: { heading: 'H', visual: 'hub', hub: HUB } }} onChange={onChange} assets={[]} /></MemoryRouter>);
    expect(screen.getByText('Hub picture')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Place 1 label' }), { target: { value: 'Chats' } });
    expect(onChange.mock.lastCall?.[0].hub).toEqual({ ...HUB, spokes: [{ ...HUB.spokes[0], label: 'Chats' }, HUB.spokes[1], HUB.spokes[2]] });
  });
  it('offers the legend, callout, pills and disclosure on feature cards', () => {
    const onChange = vi.fn<(d: Record<string, unknown>) => void>();
    render(<MemoryRouter><SectionFields section={{ sectionId: 's', type: 'columns', data: { layout: 'features', columns: [FEATURE] } }} onChange={onChange} assets={[]} /></MemoryRouter>);
    expect(screen.getByText(/Legend for "now" pills/)).toBeTruthy();
    expect(screen.getByText(/Callout label/)).toBeTruthy();
    expect(screen.getByText(/Disclosure text/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Pill 1 label' }), { target: { value: 'Slack' } });
    const cols = onChange.mock.lastCall?.[0].columns;
    expect(Array.isArray(cols) ? cols[0] : undefined).toEqual({ ...FEATURE, tags: [{ label: 'Slack', state: 'now' }, FEATURE.tags[1]] });
  });
});
