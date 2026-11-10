/**
 * ADR 1071 — design batch Phase 3b3: the feature head, number chips and the
 * inset aside.
 *
 *   - D1: a columns section with a `stat` leads with the feature head: its
 *     heading, the headline number with its words, the lede, and the section's
 *     picture beside them, on the cards and bento layouts. Without a stat the
 *     plain head renders, as before.
 *   - D2: a bento eyebrow that is only a number ("01") is a number chip; any
 *     other eyebrow is not.
 *   - D3: an inset row may carry a note on its other side.
 *
 * Sabotage witnesses: never choosing the feature head, choosing it without a
 * stat, dropping the heading, the number, the stat words, the lede or the
 * picture, chipping a word eyebrow or no eyebrow, dropping the aside, or moving
 * the aside off its own grid column (global.css) reds a case.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

const renderSection = (s: Section): HTMLElement => render(<MemoryRouter><RenderSection section={s} mode="public" /></MemoryRouter>).container;
const cssRoot = postcss.parse(readFileSync(join(__dirname, '..', '..', '..', 'styles', 'global.css'), 'utf8'));
/** The declarations of every rule whose selector is exactly `sel`, in source order. */
function decls(sel: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  cssRoot.walkRules((r) => {
    if (r.selector !== sel) return;
    const d: Record<string, string> = {};
    r.walkDecls((x) => { d[x.prop] = x.value; });
    out.push(d);
  });
  return out;
}
const cards = [{ title: 'Sign-in', text: 'a' }, { title: 'Billing', text: 'b' }, { title: 'Agents', text: 'c' }];

describe('feature head (ADR 1071 D1)', () => {
  it('leads a cards section that has a stat with the number, its words and the picture', () => {
    const c = renderSection({ sectionId: 'sec:foundation', type: 'columns', data: { layout: 'cards', eyebrow: 'Already built', heading: 'The boring parts are done', lede: 'Sign-in, billing and the rest.', stat: { value: 130, label: 'features, already built' }, imageToken: 'tok-admin', alt: 'The feature toggles', frameUrl: 'Admin · Feature toggles', columns: cards } });
    const head = c.querySelector<HTMLElement>('header.fp-head--feature');
    if (!head) throw new Error('no feature head');
    expect(within(head).getByRole('heading', { level: 2, name: 'The boring parts are done' })).toBeTruthy();
    expect(head.querySelector('.fp-head__stat-n')?.textContent).toBe('130');
    expect(head.querySelector('.fp-head__stat-label')?.textContent).toBe('features, already built');
    expect(head.querySelector('.fp-head__lede')?.textContent).toBe('Sign-in, billing and the rest.');
    expect(head.querySelector('.fp-head__shot img')?.getAttribute('alt')).toBe('The feature toggles');
    expect(c.querySelectorAll('.fp-card')).toHaveLength(3);
  });

  it('uses it on bento too, and keeps the plain head without a stat', () => {
    const b = renderSection({ sectionId: 'sec:b', type: 'columns', data: { layout: 'bento', heading: 'Built', stat: { value: 7, label: 'apps' }, columns: cards } });
    expect(b.querySelector('header.fp-head--feature .fp-head__stat-n')?.textContent).toBe('7');
    expect(b.querySelector('header.fp-head--feature .fp-head__stat-label')?.textContent).toBe('apps');
    cleanup();
    const p = renderSection({ sectionId: 'sec:p', type: 'columns', data: { layout: 'cards', heading: 'Plain', lede: 'x', columns: cards } });
    expect(p.querySelector('.fp-head--feature')).toBeNull();
    expect(p.querySelector('header.fp-head .fp-head__lede')?.textContent).toBe('x');
  });
});

describe('number chips and the inset aside (ADR 1071 D2/D3)', () => {
  it('chips a number-only eyebrow, and only that', () => {
    const c = renderSection({ sectionId: 'sec:loop', type: 'columns', data: { layout: 'bento', columns: [{ title: 'Tell it', text: 'a', eyebrow: '01' }, { title: 'Step', text: 'b', eyebrow: 'Step 2' }] } });
    const [num, word] = [...c.querySelectorAll('.fp-bento__eyebrow')];
    expect(num?.textContent).toBe('01');
    expect(word?.textContent).toBe('Step 2');
    expect(num?.classList.contains('fp-bento__eyebrow--num')).toBe(true);
    expect(word?.classList.contains('fp-bento__eyebrow--num')).toBe(false);
  });

  it('puts an inset row\'s aside on its other side', () => {
    const c = renderSection({ sectionId: 'sec:loop', type: 'columns', data: { layout: 'bento', columns: [{ title: 'Print', text: 'a', items: [{ label: 'Ready to print', meta: 'Brand checked', aside: 'your-app.com' }] }] } });
    expect(c.querySelector('.fp-bento__inset .fp-bento__inset-aside')?.textContent).toBe('your-app.com');
    // The other side is the CSS: a row with an aside gets a second track, and the
    // aside takes it on the title's row.
    expect(decls('.fp-bento__inset:has(.fp-bento__inset-aside)')).toEqual([expect.objectContaining({ 'grid-template-columns': 'minmax(0, 1fr) auto' })]);
    expect(decls('.fp-bento__inset-aside')).toEqual([expect.objectContaining({ 'grid-column': '2', 'grid-row': '1' })]);
  });
});
