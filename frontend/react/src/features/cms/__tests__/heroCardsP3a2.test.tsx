/**
 * ADR 1067 — design batch Phase 3a2: the checklist activity card, the log
 * terminal and the fan-out's waiting output.
 *
 *   - D3: `activity.style: 'checklist'` draws a browser bar with its words, the
 *     title with its count and bar ON TOP (always, not only while playing), and
 *     an icon tile on a row whose slug is known (the dot otherwise). A card
 *     with no style is exactly the approval list it was.
 *   - D1: the log card is darker than the inverse band it sits on, and keeps
 *     one event per line with a long detail cut off visually.
 *   - D2: a waiting fan-out output's status is uppercase with a dot; a done
 *     check fills in the accent, not green.
 *
 * Sabotage witnesses (re-measured, /grade-tests wave 95): dropping the bar, the
 * tally or the icon lookup, rendering the tally at the foot,
 * dropping the icon tile (or drawing one for an unknown slug), leaking the
 * checklist look into the default card, restoring the band-coloured log
 * background or the wrapping line, dropping the waiting dot, or turning the
 * done meter green again reds a case.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

const css = readFileSync(join(__dirname, '..', '..', '..', 'styles', 'global.css'), 'utf8');
const renderSection = (s: Section): HTMLElement => render(<MemoryRouter><RenderSection section={s} mode="public" /></MemoryRouter>).container;
const rows = [
  { actor: 'Sign-in', action: 'Accounts, passwords, Google sign-in', status: 'Done', state: 'done', icon: 'lock' },
  // Waiting, so the count (1 of 2) tells settled rows from all rows.
  { actor: 'Your brand', action: 'Name, colors, logo, domain', status: 'Waiting', state: 'waiting', icon: 'no-such-icon' },
];
const hero = (activity: Record<string, unknown>): Section => ({ sectionId: 'sec:home', type: 'hero', data: { heading: 'Your app took an afternoon', visual: 'activity', activity } });

describe('checklist activity card (ADR 1067 D3)', () => {
  it('draws the bar, the title with its count on top, and an icon tile per known slug', () => {
    const c = renderSection(hero({ style: 'checklist', barLabel: 'your-app.com · launch checklist', title: 'The business around your app', items: rows, result: 'Live at your-app.com' }));
    const fig = c.querySelector('figure.fp-activity')!;
    expect(fig.classList.contains('fp-activity--checklist')).toBe(true);
    expect(fig.querySelector('.fp-activity__bar .fp-activity__address')?.textContent).toBe('your-app.com · launch checklist');
    const head = fig.querySelector('.fp-activity__head')!;
    expect(head.querySelector('.fp-activity__title')?.textContent).toBe('The business around your app');
    expect(head.querySelector('.fp-activity__count')?.textContent).toBe('1 of 2 done');
    expect(head.querySelector('.fp-activity__tally .fp-progress'), 'the bar is in the head').not.toBeNull();
    expect(head.compareDocumentPosition(fig.querySelector('.fp-activity__list')!) & Node.DOCUMENT_POSITION_FOLLOWING, 'the tally is on top').toBeTruthy();
    expect(fig.querySelectorAll('.fp-activity__tally'), 'one tally, not a second at the foot').toHaveLength(1);
    const [lock, unknown] = [...fig.querySelectorAll('.fp-activity__row')];
    expect(lock!.querySelector('.fp-activity__icon svg'), 'a known slug draws its icon').not.toBeNull();
    expect(unknown!.querySelector('.fp-activity__icon'), 'an unknown slug draws no tile').toBeNull();
    expect(unknown!.querySelector('.fp-activity__mark')).not.toBeNull();
  });

  it('leaves a card with no style exactly the approval list', () => {
    const c = renderSection(hero({ barLabel: 'ignored without the style', title: 'Approvals', items: rows }));
    const fig = c.querySelector('figure.fp-activity')!;
    expect(fig.classList.contains('fp-activity--checklist')).toBe(false);
    expect(fig.querySelector('.fp-activity__bar')).toBeNull();
    expect(fig.querySelector('.fp-activity__head')).toBeNull();
    expect(fig.querySelector('.fp-activity__tally'), 'the count shows only while playing').toBeNull();
    expect(fig.querySelector('.fp-activity__icon')).toBeNull();
    expect(fig.querySelectorAll('.fp-activity__mark')).toHaveLength(2);
  });
});

describe('log terminal and fan-out styling (ADR 1067 D1/D2)', () => {
  it('draws the log darker than its band, one event per line', () => {
    expect(css).toMatch(/\.fp-log \{[^}]*--fp-log-bg: color-mix\(in oklab, var\(--tone-inverse-bg\) 45%, black\);[^}]*background: var\(--fp-log-bg\);/);
    expect(css).toMatch(/\.fp-log__line \{[^}]*white-space: nowrap;/);
    expect(css).toMatch(/\.fp-log__detail \{[^}]*text-overflow: ellipsis;/);
  });

  it('marks a waiting output with an uppercase status and a dot, and fills a done check in the accent', () => {
    expect(css).toMatch(/\.fp-fanout__output--waiting \.fp-fanout__status \{[^}]*text-transform: uppercase;/);
    expect(css).toMatch(/\.fp-fanout__output--waiting \.fp-fanout__status::before \{[^}]*border-radius: 50%;[^}]*background: var\(--color-warning\);/);
    expect(css).toMatch(/\.fp-fanout__output--done \.fp-fanout__meter > span \{[^}]*background: var\(--clay-strong\);/);
  });
});
