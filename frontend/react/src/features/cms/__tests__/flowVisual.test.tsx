/**
 * ADR 1038 P8 — the authored flow, as a visitor and an editor meet it.
 * Guards:
 * - a hero flow is a figure with its caption and an ordered list of real steps
 *   (label, status word, text); a waiting step's mark pulses in the hero only, a
 *   columns flow never pulses (it is timed from load and would finish unseen);
 * - every mark is decoration (`aria-hidden`), and its state class only styles it;
 * - the editor offers the hero flow's steps, and a columns flow's status and
 *   state per item, and stops at six steps (both the hero flow and a columns
 *   flow, the latter with a pointer to the timeline);
 * - the CSS (which jsdom cannot run) keeps the motion inside the reduced-motion
 *   guards (and the scroll lane inside `@supports`), lays a wide columns flow out
 *   as one row from 900px with the connector growing from the inline start in
 *   RTL too, and gives each state a distinct shape.
 *
 * - review fixes: a state without a status is spoken (visually hidden), a list
 *   is capped at six on render, item text is inline markdown, the row aligns its
 *   steps to the top and lights them start to end, waiting stays distinct in
 *   forced colours, and the editor seeds two hero steps and warns at seven.
 *
 * Ceiling: layout and motion are CSS. "Inside a guard" is checked with `openAt`,
 * which walks the braces and returns the blocks still OPEN at a rule (an inner,
 * indented block that closes early counts as closed; grade-tests wave 88).
 *
 * Sabotage-witnessed (2026-11-03; re-probed /grade-tests wave 88): pulsing a
 * columns flow's waiting step, dropping either six-step stop in the editor (hero
 * or columns), the seven-item warning, the two-step seed or the two-step hint,
 * moving any flow animation (hero, scroll lane, wide-row lane) outside its
 * reduced-motion or `@supports` guard, dropping a rule's in-app guard, dropping
 * the render cap, the visually hidden state word, `aria-hidden` or the figure
 * name, mis-indexing a step edit, and the RTL, one-row and forced-colours rules
 * each turn a case red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import { SectionFields } from '../SectionsEditor.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

type DataChange = (data: Record<string, unknown>) => void;
/** The `flow.nodes` of the last section data the editor wrote (narrowed, no cast). */
function lastNodes(onChange: Mock<DataChange>): Array<Record<string, unknown>> {
  const data = onChange.mock.lastCall?.[0];
  const flow = data?.flow;
  if (!flow || typeof flow !== 'object' || !('nodes' in flow) || !Array.isArray(flow.nodes)) throw new Error('no flow.nodes written');
  return flow.nodes.filter((n: unknown): n is Record<string, unknown> => typeof n === 'object' && n !== null);
}

/** An OS reduced-motion media block, however its prelude is spelled (`screen and` or not). */
const isMotionGuard = (p: string): boolean => /^@media\b[^{]*\(prefers-reduced-motion:\s*no-preference\)/.test(p);
const SUPPORTS = '@supports (animation-timeline: view())';
/** The block preludes still open at `index` (comments blanked to keep offsets). */
function openAt(text: string, index: number): string[] {
  const s = text.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < index; i++) {
    if (s[i] === '{') { stack.push(s.slice(start, i).trim()); start = i + 1; }
    else if (s[i] === '}') { stack.pop(); start = i + 1; }
    else if (s[i] === ';') start = i + 1;
  }
  return stack;
}

const nodes = [
  { label: 'Brief', text: 'You say what you need', status: 'Done', state: 'done' },
  { label: 'Draft', status: 'Waiting for you', state: 'waiting' },
  { label: 'Ship', state: 'idle' },
];
const view = (section: Section) => render(<MemoryRouter><RenderSection section={section} mode="public" /></MemoryRouter>);

describe('a hero flow', () => {
  it('is a captioned figure of ordered, real steps; the waiting mark pulses', () => {
    view({ sectionId: 's', type: 'hero', data: { heading: 'H', visual: 'flow', flow: { label: 'How it works', nodes } } });
    const fig = screen.getByRole('figure', { name: 'How it works' });
    const steps = [...fig.querySelectorAll('ol > li')];
    expect(steps.map((li) => li.textContent)).toEqual(['BriefDoneYou say what you need', 'DraftWaiting for you', 'ShipNot started']);
    // A state without a status word is still spoken, visually hidden.
    expect(steps[2]!.querySelector('.sr-only')?.textContent).toBe('Not started');
    expect(steps[0]!.querySelector('.sr-only')).toBeNull();
    const marks = [...fig.querySelectorAll('.fp-flow__mark')];
    expect(marks.every((m) => m.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(marks.map((m) => m.classList.contains('fp-attention'))).toEqual([false, true, false]);
    expect(steps[0]!.className).toContain('fp-flow__step--done');
  });

  it('renders nothing with fewer than two steps', () => {
    const { container } = view({ sectionId: 's', type: 'hero', data: { heading: 'H', visual: 'flow', flow: { nodes: [nodes[0]] } } });
    expect(container.querySelector('.fp-flow')).toBeNull();
  });
});

describe('grading fixes', () => {
  it('names an uncaptioned hero flow, and hides the mark picker from a translator', () => {
    view({ sectionId: 's', type: 'hero', data: { heading: 'H', visual: 'flow', flow: { nodes } } });
    expect(screen.getByRole('figure', { name: 'Process steps' })).toBeTruthy();
    cleanup();
    render(<SectionFields section={{ sectionId: 's', type: 'hero', data: { heading: 'Hola', visual: 'flow', flow: { nodes } } }} baseData={{ heading: 'H' }} assets={[]} onChange={vi.fn<DataChange>()} />);
    expect(screen.getByRole('textbox', { name: 'Step 1 status' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Step 1 mark' })).toBeNull();
  });

  it('says a flow needs two named steps until it has them', () => {
    render(<SectionFields section={{ sectionId: 's', type: 'hero', data: { heading: 'H', visual: 'flow', flow: { nodes: [{ label: 'Brief' }, { label: '' }] } } }} assets={[]} onChange={vi.fn<DataChange>()} />);
    expect(screen.getByRole('status').textContent).toContain('at least two steps');
    expect(screen.getByRole('combobox', { name: 'Step 1 mark' })).toBeTruthy();
  });
});

describe('a columns flow', () => {
  it('renders the items as steps and never pulses', () => {
    const columns = nodes.map((n) => ({ title: n.label, text: n.text ?? '', status: n.status, state: n.state }));
    const { container } = view({ sectionId: 's', type: 'columns', data: { layout: 'flow', heading: 'How', columns } });
    expect(container.querySelector('section')!.className).toContain('fp-cols--flow');
    expect(container.querySelectorAll('.fp-flow--row ol > li')).toHaveLength(3);
    expect(container.querySelector('.fp-attention')).toBeNull();
  });

  it('shows at most six steps (an overlay is not checked against the cap) and renders inline markdown', () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ title: `s${i}`, text: i === 0 ? 'a **bold** step' : '' }));
    const { container } = view({ sectionId: 's', type: 'columns', data: { layout: 'flow', columns: seven } });
    expect(container.querySelectorAll('.fp-flow--row ol > li')).toHaveLength(6);
    expect(container.querySelector('.fp-flow__text strong')?.textContent).toBe('bold');
  });
});

describe('the editor', () => {
  it('edits the hero flow’s steps', () => {
    const onChange = vi.fn<DataChange>();
    render(<SectionFields section={{ sectionId: 's', type: 'hero', data: { heading: 'H', visual: 'flow', flow: { nodes } } }} assets={[]} onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Step 2 status' }), { target: { value: 'Ready' } });
    expect(lastNodes(onChange).map((n) => n.status)).toEqual(['Done', 'Ready', undefined]);
    fireEvent.click(screen.getByRole('button', { name: 'Add a step' }));
    expect(lastNodes(onChange)).toHaveLength(4);
    expect(screen.queryByText('A flow holds six steps.')).toBeNull();
    cleanup();
    // At six steps the hero editor stops: no add button, and it says why.
    const six = Array.from({ length: 6 }, (_, i) => ({ label: `s${i}` }));
    render(<SectionFields section={{ sectionId: 's', type: 'hero', data: { heading: 'H', visual: 'flow', flow: { nodes: six } } }} assets={[]} onChange={vi.fn<DataChange>()} />);
    expect(screen.queryByRole('button', { name: 'Add a step' })).toBeNull();
    expect(screen.getByText('A flow holds six steps.')).toBeTruthy();
  });

  it('offers status and state on a columns flow (no link or icon), and stops at six steps', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ title: `s${i}`, text: '' }));
    render(<SectionFields section={{ sectionId: 's', type: 'columns', data: { layout: 'flow', columns: six } }} assets={[]} onChange={vi.fn<DataChange>()} />);
    expect(screen.getByRole('textbox', { name: 'Step 1 status' })).toBeTruthy();
    expect(screen.queryByText('Link (optional)')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add item' })).toBeNull();
    expect(screen.getByText(/A flow holds six steps\. Use/)).toBeTruthy();
  });

  it('warns before save when a section switched to flow has more than six items', () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ title: `s${i}`, text: '' }));
    render(<SectionFields section={{ sectionId: 's', type: 'columns', data: { layout: 'flow', columns: seven } }} assets={[]} onChange={vi.fn<DataChange>()} />);
    expect(screen.getByRole('status').textContent).toContain('this section has 7');
  });

  it('starts a new hero flow with two empty steps', () => {
    const onChange = vi.fn<DataChange>();
    render(<SectionFields section={{ sectionId: 's', type: 'hero', data: { heading: 'H', visual: 'workflow' } }} assets={[]} onChange={onChange} />);
    fireEvent.change(screen.getByDisplayValue(/Workflow/), { target: { value: 'flow' } });
    expect(onChange.mock.lastCall?.[0]).toMatchObject({ visual: 'flow', flow: { nodes: [{ label: '' }, { label: '' }] } });
  });
});

describe('the flow CSS', () => {
  const css = readFileSync(join(__dirname, '..', '..', '..', 'styles', 'global.css'), 'utf8');
  const lines = css.split('\n');

  it('animates only inside the reduced-motion guards', () => {
    const animated = lines.filter((l) => l.includes('.fp-flow') && /animation(-name)?:/.test(l));
    expect(animated.length).toBeGreaterThan(0);
    for (const l of animated) expect(l).toContain(':root:not([data-reduce-motion="reduce"])');
    // Every flow rule that animates or sets a timeline is inside the OS
    // reduced-motion media block where it is declared (still open there).
    let offset = 0;
    const guarded = lines.flatMap((l) => {
      const at = offset;
      offset += l.length + 1;
      return l.includes('.fp-flow') && /(animation(-name|-range)?|view-timeline):/.test(l) ? [{ l, at }] : [];
    });
    expect(guarded.length).toBeGreaterThanOrEqual(8);
    for (const { l, at } of guarded) {
      expect(openAt(css, at).some(isMotionGuard), l).toBe(true);
    }
    const hero = css.indexOf('.fp-flow--hero .fp-flow__mark { animation:');
    expect(hero).toBeGreaterThan(0);
    expect(openAt(css, hero).some(isMotionGuard)).toBe(true);
    // The scroll lane (its timeline, its marks, and the wide-row stagger) is
    // inside `@supports` AND its own reduced-motion block.
    for (const anchor of [
      '.fp-cols--flow:not(.fp-motion--none) .fp-flow__step { view-timeline: --fp-step block; }',
      '.fp-cols--flow:not(.fp-motion--none) .fp-flow__mark { animation-name: fp-activity-tick;',
      '.fp-cols--flow:not(.fp-motion--none) .fp-flow__mark { animation-range: entry calc(var(--i, 0) * 8%)',
    ]) {
      const at = css.indexOf(anchor);
      expect(at, anchor).toBeGreaterThan(0);
      const open = openAt(css, at);
      expect(open, anchor).toContain(SUPPORTS);
      expect(open.some(isMotionGuard), anchor).toBe(true);
    }
  });

  it('aligns row steps to the top, lights them start to end, and keeps waiting distinct in forced colours', () => {
    expect(css).toContain('.fp-flow--row .fp-flow__step { grid-template-columns: minmax(0, 1fr); align-content: start; }');
    expect(css).toMatch(/\.fp-cols--flow:not\(\.fp-motion--none\) \.fp-flow__mark \{ animation-range: entry calc\(var\(--i, 0\) \* 8%\)/);
    const forced = css.slice(css.indexOf('@media (forced-colors: active) {\n  .fp-flow__step--done'));
    expect(forced.slice(0, forced.indexOf('\n}'))).toMatch(/\.fp-flow__step--waiting \.fp-flow__mark \{ forced-color-adjust: none;[^}]*radial-gradient\(circle, CanvasText/);
  });

  it('is one row from 900px with the connector growing from the inline start, and each state has its own shape', () => {
    expect(css).toContain('@media (min-width: 900px) {\n  .fp-flow--row .fp-flow__steps { grid-auto-flow: column;');
    expect(css).toContain(':root[dir="rtl"] .fp-flow--row .fp-flow__step:not(:last-child)::after { transform-origin: right; }');
    expect(css).toContain('.fp-flow__step--idle .fp-flow__mark { border-style: dashed; }');
    expect(css).toMatch(/\.fp-flow__step--done \.fp-flow__mark \{[^}]*background: var\(--color-success\)/);
    expect(css).toMatch(/\.fp-flow__step--waiting \.fp-flow__mark \{[^}]*radial-gradient/);
  });
});
