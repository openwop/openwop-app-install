/**
 * ADR 1105 round follow-ups (the end-of-round grades, 2026-11-11).
 *
 *   - UXG-1105-1/2: on the accent tone every CMS picker's pressed state is
 *     inverted, so the selected item does not vanish into the clay band;
 *   - CG-1105-1: dateCalc follows an author's edit in the Page Builder preview
 *     (it is keyed on the authored values, like the worksheets);
 *   - UXG-1105-3: a target margin of 100% or more says why it has no markup.
 *
 * Sabotage witnesses: a picker left out of the accent rule, the doubled class
 * dropped (it then loses to the picker's own rule), the dateCalc key removed,
 * or the hint shown below 100% each turn a case red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);
const page = (s: Section) => <MemoryRouter><RenderSection section={s} mode="public" /></MemoryRouter>;

describe('accent-tone pickers (UXG-1105-1/2)', () => {
  it('invert every CMS picker\'s pressed state on the accent band', () => {
    const css = readFileSync(join(__dirname, '..', 'designSections.css'), 'utf8');
    const rule = css.match(/\.cms-public-section\.fp-tone--accent :is\(([^)]*)\)\[aria-pressed='true'\],/);
    expect(rule, 'the accent rule, with the doubled class').not.toBeNull();
    const pickers = rule![1]!.split(',').map((x) => x.trim());
    for (const p of ['.fp-psim__mode', '.fp-psim__preset', '.fp-parties__btn', '.fp-convo__ask', '.fp-findex__pick', '.fp-dtree__tree']) expect(pickers, p).toContain(p);
    expect(css).toMatch(/\.fp-psim__ctl--primary:hover \{ color: var\(--clay-strong\); background: var\(--tone-inverse-ink\);/);
  });
});

describe('dateCalc follows the author (CG-1105-1)', () => {
  it('reseeds its inputs when the authored values change', () => {
    const s = (lead: number): Section => ({ sectionId: 'd', type: 'dateCalc', data: { needDate: '2027-03-12', leadWeeks: lead, floatDays: 10, approveDays: 5 } });
    const view = render(page(s(10)));
    expect((screen.getByLabelText('Lead time, in weeks') as HTMLInputElement).value).toBe('10');
    view.rerender(page(s(14)));
    expect((screen.getByLabelText('Lead time, in weeks') as HTMLInputElement).value).toBe('14');
  });
});

describe('target margin hint (UXG-1105-3)', () => {
  it('explains a target of 100% or more, and only then', () => {
    render(page({ sectionId: 'm', type: 'marginCalc', data: { cost: 4000, markup: 25, target: 30 } }));
    expect(screen.queryByText(/No markup reaches a margin of 100%/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Target margin, in percent'), { target: { value: '100' } });
    expect(screen.getByText(/No markup reaches a margin of 100%/)).toBeTruthy();
  });
});
