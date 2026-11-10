/**
 * ADR 1068 D2 (myndhyve.ai design batch, P3d-2): the page half.
 *
 *  1. `==highlight==` renders a real <mark class="fp-mark"> (emphasis is not
 *     colour alone), styled as the design's ink highlight, Mark/MarkText in
 *     forced colours.
 *  2. Incidents under `head: 'split'`: the heading in the first column; the lede,
 *     the list and the closing note in the second. Without split, unchanged.
 *     The note is lede-sized; the glyph is an amber tile; `card` is a real icon.
 *  3. Rows with a diagram: the head and the diagram take the side column, the
 *     toggles panel moves above the rows; the waiting step is marked by its class
 *     and ringed in the warning colour; the card uses the inverse tokens.
 *
 * Sabotage (each witnessed red): drop the mark branch; the incidents split
 * keeps the lede in the head; the note leaves the side column; the `card` slug
 * falls back to the node motif; the diagram stays out of the side column; the
 * toggles stay in the side column when a diagram is present; the waiting class
 * is dropped; the waiting ring stops using the warning token.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

const css = readFileSync(join(__dirname, '..', '..', '..', 'styles', 'global.css'), 'utf8');
function rule(sel: string): string {
  const i = css.indexOf(`${sel} {`);
  if (i < 0) throw new Error(`no rule ${sel}`);
  return css.slice(i, css.indexOf('}', i) + 1);
}
const view = (data: Section['data']) =>
  render(<MemoryRouter><RenderSection section={{ sectionId: 's', type: 'columns', data }} mode="public" /></MemoryRouter>);

const INCIDENTS = {
  layout: 'incidents',
  heading: 'You tried agents.',
  lede: 'It worked in the demo. On Tuesday:',
  note: 'You need to ==see what they did== first.',
  columns: [
    { eyebrow: 'Tue 09:14', text: 'A follow-up went to the wrong list.', icon: 'chat' },
    { eyebrow: 'Tue 11:02', text: 'A refund ran twice.', icon: 'card' },
  ],
};

describe('1. ==highlight==', () => {
  it('renders a <mark class="fp-mark"> styled as an ink highlight', () => {
    const { container } = view(INCIDENTS);
    const mark = container.querySelector('mark.fp-mark');
    expect(mark?.textContent).toBe('see what they did');
    expect(rule('mark.fp-mark')).toMatch(/background: linear-gradient\(transparent 62%/);
    expect(css).toContain('@media (forced-colors: active) { mark.fp-mark { background: Mark; color: MarkText; } }');
  });
});

describe('2. incidents', () => {
  it('under a split head: heading left; lede, list and note right', () => {
    const { container } = view({ ...INCIDENTS, head: 'split' });
    const head = container.querySelector('.fp-incidents__split > .fp-incidents__head')!;
    const side = container.querySelector('.fp-incidents__split > .fp-incidents__side')!;
    expect(head.querySelector('h2')?.textContent).toBe('You tried agents.');
    expect(head.querySelector('.fp-head__lede')).toBeNull();
    const kids = Array.from(side.children).map((n) => n.className.split(' ')[0]);
    expect(kids).toEqual(['fp-head__lede', 'fp-incidents__list', 'fp-cols__note']);
  });

  it('without split keeps the stacked layout, note included', () => {
    const { container } = view(INCIDENTS);
    expect(container.querySelector('.fp-incidents__split')).toBeNull();
    expect(container.querySelector('.fp-head .fp-head__lede')?.textContent).toBe('It worked in the demo. On Tuesday:');
    expect(container.querySelector('.fp-incidents__note')).toBeTruthy();
  });

  it('draws the card glyph and the amber tile; the note is lede-sized', () => {
    const { container } = view(INCIDENTS);
    const glyphs = container.querySelectorAll('.fp-incident .fp-glyph svg');
    expect(glyphs).toHaveLength(2);
    expect(glyphs[1]!.querySelector('rect[width="20"][height="14"]')).toBeTruthy();
    expect(rule('.fp-incident .fp-glyph')).toContain('background: color-mix(in srgb, var(--color-warning) 16%, transparent);');
    // Two classes, so the generic `.fp-cols__note` (later in the file, same class count otherwise) cannot win.
    expect(rule('.fp-incidents .fp-incidents__note')).toContain('font-size: calc(var(--text-lg) * 19 / 16);');
    // The generic glyph strokes its svg in the accent; the incident glyph must hand it the tile's colour.
    expect(rule('.fp-incident .fp-glyph svg')).toContain('stroke: currentColor;');
  });
});

describe('3. rows with a diagram', () => {
  const ROWS = {
    layout: 'rows',
    heading: 'You stay in charge',
    columns: [{ title: 'Approvals', text: 'Risky steps wait.' }],
    toggles: { title: 'Try it', items: [{ label: 'Send email', on: true }] },
    diagram: { nodes: [{ label: 'Trigger', text: 'New sign-up' }, { label: 'Waits for you', text: 'Send 10 replies', waiting: true }], caption: 'A real run.' },
  };

  it('puts the diagram beside the head and the toggles above the rows', () => {
    const { container } = view(ROWS);
    const side = container.querySelector('.fp-rows__side')!;
    expect(side.querySelector('figure.fp-diagram')).toBeTruthy();
    expect(side.querySelector('.fp-try')).toBeNull();
    const main = container.querySelector('.fp-rows__main')!;
    expect(Array.from(main.children).map((n) => n.className.split(' ')[0])).toEqual(['fp-try', 'fp-rows__list']);
    const nodes = Array.from(side.querySelectorAll('.fp-diagram__node')).map((n) => [n.className, n.textContent]);
    expect(nodes).toEqual([['fp-diagram__node', 'TriggerNew sign-up'], ['fp-diagram__node fp-diagram__node--waiting', 'Waits for youSend 10 replies']]);
    expect(side.querySelector('figcaption.fp-diagram__cap')?.textContent).toBe('A real run.');
  });

  it('without a diagram keeps the toggles beside the head', () => {
    const { container } = view({ ...ROWS, diagram: undefined });
    expect(container.querySelector('.fp-rows__main')).toBeNull();
    expect(container.querySelector('.fp-rows__side [role="switch"]')).toBeTruthy();
  });

  it('rings the waiting step in the warning colour on the inverse card', () => {
    expect(rule('.fp-diagram__node--waiting')).toContain('border-color: var(--color-warning);');
    expect(rule('.fp-diagram')).toContain('background: var(--tone-inverse-bg);');
  });
});
