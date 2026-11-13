/**
 * ADR 1105 P2 — `partyViews` and `stageChart` on the page.
 *
 * Party views use the ADR 1080 D4 picker: pressed buttons in a labelled group,
 * each controlling its own panel, every panel in the DOM and the others hidden;
 * a party's view is the hero queue card. The stage chart is a list whose labels
 * and counts are text, its groups named in the legend with totals and told
 * apart by a class (pattern) as well as color; bar lengths follow the counts.
 *
 * Sabotage witnesses: rendering only the picked panel, a button that does not
 * control its panel, ignoring `initial`, dropping the count text or the
 * legend totals, or losing the group class each turn a case red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);
const mount = (s: Section): HTMLElement => render(<MemoryRouter><RenderSection section={s} mode="public" /></MemoryRouter>).container;

const parties = { heading: 'Who sees what', parties: [
  { label: 'Builder', needs: ['Dates that hold'], viewTitle: 'Builder view', rows: [{ title: 'Tile order', status: 'Late', tone: 'bad' }] },
  { label: 'Client', needs: ['Fewer surprises'] },
  { label: 'Architect', needs: ['Drawings that match'] },
] };

describe('partyViews (ADR 1105 D1/D9)', () => {
  it('keeps every panel in the DOM and shows the picked one', () => {
    const c = mount({ sectionId: 'p', type: 'partyViews', data: parties });
    const group = screen.getByRole('group', { name: 'Who sees what' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Builder', 'Client', 'Architect']);
    const panels = [...c.querySelectorAll('.fp-parties__panel')];
    expect(panels).toHaveLength(3);
    buttons.forEach((b, i) => expect(b.getAttribute('aria-controls')).toBe(panels[i]!.id));
    expect(panels.map((p) => (p as HTMLElement).hidden)).toEqual([false, true, true]);
    expect(panels[0]!.querySelector('.fp-queue')?.getAttribute('aria-label')).toBe('Builder view');
    // The reused queue card drops its id column here (party rows have no id).
    const css = readFileSync(join(__dirname, '..', 'designSections.css'), 'utf8');
    expect(css).toContain('.fp-parties .fp-queue__row { grid-template-columns: minmax(0, 1fr) auto; }');
    expect(css).toContain('.fp-parties .fp-queue__id { display: none; }');
    fireEvent.click(buttons[2]!);
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);
    expect(panels.map((p) => (p as HTMLElement).hidden)).toEqual([true, true, false]);
  });

  it('opens on `initial`', () => {
    const c = mount({ sectionId: 'p', type: 'partyViews', data: { ...parties, initial: 1 } });
    expect([...c.querySelectorAll('.fp-parties__panel')].map((p) => (p as HTMLElement).hidden)).toEqual([true, false, true]);
  });
});

describe('stageChart (ADR 1105 D2/D8)', () => {
  const data = { unit: 'decisions', groups: [{ key: 'early', label: 'Before walls' }, { key: 'late', label: 'After walls' }], stages: [{ label: 'Rough-in', count: 120, group: 'early' }, { label: 'Finishes', count: 30, group: 'late' }, { label: 'Punch', count: 5 }] };

  it('shows each label and count as text, with the group named for screen readers', () => {
    const c = mount({ sectionId: 's', type: 'stageChart', data });
    const items = [...c.querySelectorAll('ol.fp-schart__bars > li')];
    expect(c.querySelector('ol.fp-schart__bars')!.getAttribute('role')).toBe('list');
    expect(items.map((li) => li.querySelector('.fp-schart__count')!.textContent)).toEqual(['120 decisions', '30 decisions', '5 decisions']);
    expect(items[0]!.querySelector('.fp-schart__label')!.textContent).toBe('Rough-in (Before walls)');
    expect(items.map((li) => [...li.classList].find((k) => k.startsWith('fp-schart--g')) ?? '')).toEqual(['fp-schart--g0', 'fp-schart--g1', '']);
    expect((items[1] as HTMLElement).style.getPropertyValue('--v')).toBe(String(30 / 120));
    // Columns only from 900px, where 14 stages fit; inside a column the unit is visually hidden.
    const css = readFileSync(join(__dirname, '..', 'designSections.css'), 'utf8');
    expect(css).toMatch(/@media \(min-width: 900px\) \{\s*\.fp-schart__bars \{ grid-auto-flow: column;/);
    expect(css).toMatch(/\.fp-schart__unit \{ position: absolute; inline-size: 1px;/);
    expect(items[0]!.querySelector('.fp-schart__unit')!.textContent).toBe(' decisions');
  });

  it('names each group in the legend with its total', () => {
    const c = mount({ sectionId: 's', type: 'stageChart', data });
    const keys = [...c.querySelectorAll('.fp-schart__legend li')];
    expect(keys.map((k) => k.textContent)).toEqual(['Before walls 120 decisions', 'After walls 30 decisions']);
    expect(keys.map((k) => k.className)).toEqual(['fp-schart__key fp-schart--g0', 'fp-schart__key fp-schart--g1']);
  });
});
