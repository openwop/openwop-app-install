/**
 * ADR 1029 D2 — a section's `motion` reaches the public markup as stylesheet
 * hooks, and nothing else changes. Guards:
 * - every render site that draws without a live read carries
 *   `fp-motion fp-motion--<v>` on its root `<section>`: every hero visual but
 *   `film`, every columns layout, and the other host types;
 * - a section without motion, or with an unknown value, keeps its exact markup;
 * - `stagger` marks the item list it moves, and only then;
 * - the editor offers the choice on the base layer, "Page default" removes the
 *   key, and a locale overlay or a `fields` section has no motion control.
 *
 * Not covered: `productGrid`, `pricing`, `entityList`, `entityDetail`, `form`
 * with an id, and the `film` hero (its demo read). They fetch on render and use
 * the same `${mx}` template; mocking those reads is outside this test (w86 ruling).
 *
 * Ceiling: the motion itself is CSS (scroll timelines, which jsdom does not run);
 * these hook classes are the claim. Sabotage-witnessed (w86 grade-tests):
 * dropping `${mx}` from a render site (comparison, features, hub) reds that row;
 * giving an unknown value a class reds the additive guarantee; marking the list
 * on `reveal`, or dropping `${stg}` from the faq list, reds the stagger case;
 * applying motion to `fields` reds its case; showing the control on an overlay
 * or a `fields` section, or keeping the key on "Page default", reds the editor.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import { SectionFields } from '../SectionsEditor.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

function view(type: Section['type'], data: Record<string, unknown>) {
  return render(<MemoryRouter><RenderSection section={{ sectionId: 's', type, data }} mode="public" /></MemoryRouter>);
}
const root = (c: HTMLElement): Element | null => c.querySelector('section');

const COLS = [{ title: 'A', text: 'One' }, { title: 'B', text: 'Two' }];
const CASES: Array<[string, Section['type'], Record<string, unknown>]> = [
  ['hero (workflow)', 'hero', { heading: 'H' }],
  ['hero (journey)', 'hero', { heading: 'H', visual: 'journey' }],
  ['hero (run)', 'hero', { heading: 'H', visual: 'run' }],
  ['hero (plan)', 'hero', { heading: 'H', visual: 'plan', plan: { title: 'P' } }],
  ['hero (none)', 'hero', { heading: 'H', visual: 'none' }],
  ['hero (activity)', 'hero', { heading: 'H', visual: 'activity', activity: { items: [{ action: 'approved' }] } }],
  ['hero (hub)', 'hero', { heading: 'H', visual: 'hub', hub: { center: { label: 'Agent' }, spokes: [{ label: 'Chat' }, { label: 'Phone' }] } }],
  ['hero (flow)', 'hero', { heading: 'H', visual: 'flow', flow: { nodes: [{ label: 'Ask' }, { label: 'Ship' }] } }],
  ['hero (receipt)', 'hero', { heading: 'H', visual: 'receipt' }],
  ['richText', 'richText', { text: 'Body' }],
  ['richText (chat)', 'richText', { text: 'Body', visual: 'chat', chat: { title: 'Guide', messages: [{ from: 'person', text: 'Hi' }] } }],
  ['image', 'image', { token: 'media:x', alt: 'A' }],
  ['cta', 'cta', { heading: 'Go', label: 'Start', url: '/start' }],
  ...(['cards', 'steps', 'stats', 'showcase', 'rows', 'prompts', 'dives', 'ruled', 'progress', 'list', 'tiles', 'panels', 'timeline', 'bento', 'marquee', 'features', 'flow'] as const)
    .map((layout): [string, Section['type'], Record<string, unknown>] => [`columns (${layout})`, 'columns', { heading: 'H', layout, columns: COLS }]),
  ['comparison', 'comparison', { columns: ['Us'], rows: [{ label: 'Fast', cells: ['✓'] }] }],
  ['faq', 'faq', { items: [{ q: 'Why?', a: 'Because.' }] }],
  ['quotes', 'quotes', { items: [{ quote: 'Great.', name: 'Ana' }] }],
  ['video', 'video', { title: 'Film', src: 'https://example.com/v.mp4' }],
  ['faq (empty)', 'faq', {}],
  ['form (no id)', 'form', {}],
];

describe('ADR 1029 — every section type carries its motion hooks', () => {
  it.each(CASES)('%s', (_label, type, data) => {
    const { container } = view(type, { ...data, motion: 'reveal' });
    const cls = root(container)?.className ?? '';
    expect(cls).toContain('cms-public-section');
    expect(cls).toContain('fp-motion fp-motion--reveal');
  });
});

describe('ADR 1029 — additive guarantee', () => {
  it.each(CASES)('%s keeps its exact markup without motion, and with an unknown value', (_label, type, data) => {
    const before = view(type, data).container.innerHTML;
    cleanup();
    const junk = view(type, { ...data, motion: 'spin' }).container.innerHTML;
    expect(junk).toBe(before);
    expect(before).not.toContain('fp-motion');
    expect(before).not.toContain('fp-stagger');
  });
});

describe('ADR 1029 — `fields` is the author\'s own data', () => {
  it('a field named "motion" is content, never the enum', () => {
    const { container } = view('fields', { motion: 'reveal', title: 'T' });
    expect(container.innerHTML).not.toContain('fp-motion');
  });
});

describe('ADR 1029 — stagger marks the list it moves', () => {
  it('columns, faq and quotes mark their item list only when motion is stagger', () => {
    for (const [type, data] of [
      ['columns', { heading: 'H', layout: 'cards', columns: COLS }],
      ['faq', { items: [{ q: 'Why?', a: 'Because.' }] }],
      ['quotes', { items: [{ quote: 'Great.', name: 'Ana' }] }],
    ] as Array<[Section['type'], Record<string, unknown>]>) {
      const staggered = view(type, { ...data, motion: 'stagger' }).container;
      expect(staggered.querySelectorAll('.fp-stagger').length, type).toBe(1);
      expect(staggered.querySelector('.fp-stagger')!.children.length, type).toBeGreaterThan(0);
      cleanup();
      expect(view(type, { ...data, motion: 'reveal' }).container.querySelector('.fp-stagger'), type).toBeNull();
      cleanup();
    }
  });
});

describe('ADR 1029 — the editor control', () => {
  const sec = (type: Section['type'], data: Record<string, unknown>): Section => ({ sectionId: 's', type, data });

  it('sets a motion on the base layer, and "Page default" removes the key', () => {
    const onChange = vi.fn();
    render(<SectionFields section={sec('richText', { text: 'Body', motion: 'rise' })} assets={[]} onChange={onChange} />);
    const select = screen.getByLabelText('Motion');
    if (!(select instanceof HTMLSelectElement)) throw new Error('Motion is not a select');
    expect(select.value).toBe('rise');
    fireEvent.change(select, { target: { value: 'stagger' } });
    expect(onChange).toHaveBeenLastCalledWith({ text: 'Body', motion: 'stagger' });
    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ text: 'Body' });
  });

  it('is not offered on a locale overlay or on a `fields` section', () => {
    render(<SectionFields section={sec('richText', { text: 'Cuerpo' })} assets={[]} onChange={vi.fn()} baseData={{ text: 'Body' }} />);
    expect(screen.queryByLabelText('Motion')).toBeNull();
    cleanup();
    render(<SectionFields section={sec('fields', { a: 'b' })} assets={[]} onChange={vi.fn()} />);
    expect(screen.queryByLabelText('Motion')).toBeNull();
  });
});
