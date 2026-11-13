/**
 * ADR 1105 P2 — `partyViews` and `stageChart`.
 *
 *   - D1/D2: closed validators (a party needs a label, a stage a label and an
 *     integer count; a tone needs its status word; a stage naming a missing
 *     group is a 400; `initial` is a valid index or absent);
 *   - D5: numbers and group keys are the base's. A translated `stages` list keeps
 *     the base's counts and groups (ITEM_BASE_KEYS), even when the overlay does
 *     not repeat `groups`, and an overlay's `initial` is dropped;
 *   - D9: crawlers get every party, and the chart's counts with their totals.
 *
 * Red when: the dangling-group check goes, an overlay can change a count or lose
 * a group, `initial` rides an overlay, or the prerender drops a party or a total.
 */
import { describe, expect, it } from 'vitest';
import { validateSection } from '../src/features/cms/cmsService.js';
import { designSectionHtml } from '../src/features/cms/designSections.js';

const v = (type: string, data: Record<string, unknown>) => validateSection({ type, data }, 'en', 't1');
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const chart = { unit: 'decisions', groups: [{ key: 'early', label: 'Before walls' }, { key: 'late', label: 'After walls' }], stages: [{ label: 'Rough-in', count: 120, group: 'early' }, { label: 'Finishes', count: 30, group: 'late' }, { label: 'Punch', count: 5 }] };

describe('the validators (ADR 1105 D1/D2)', () => {
  it('partyViews keeps labelled parties, worded statuses and a valid initial', () => {
    const d = v('partyViews', { initial: 1, parties: [{ label: 'Builder', rows: [{ title: 'Tile', tone: 'bad' }, { title: 'Valve', status: 'Late', tone: 'bad' }] }, { needs: ['x'] }, { label: 'Client' }] }).data;
    expect(d.parties).toEqual([{ label: 'Builder', rows: [{ title: 'Tile' }, { title: 'Valve', status: 'Late', tone: 'bad' }] }, { label: 'Client' }]);
    expect(d.initial).toBe(1);
    expect(v('partyViews', { initial: 5, parties: [{ label: 'A' }] }).data).not.toHaveProperty('initial');
    expect(() => v('partyViews', { parties: [{ needs: ['no label'] }] })).toThrow(/partyViews\.parties is required/);
  });

  it('stageChart refuses a stage naming a missing group, and keeps integer counts only', () => {
    expect(() => v('stageChart', { groups: [], stages: [{ label: 'A', count: 1, group: 'ghost' }] })).toThrow(/names a group the section does not have/);
    expect(v('stageChart', { stages: [{ label: 'A', count: 1.5 }, { label: 'B', count: '3' }, { label: 'C', count: 4 }] }).data.stages).toEqual([{ label: 'C', count: 4 }]);
  });
});

describe('numbers and groups are the base\'s (ADR 1105 D5)', () => {
  it('a translated stages list keeps the base counts and groups without repeating groups', () => {
    const s = validateSection({ type: 'stageChart', data: chart, localizations: { es: { stages: [{ label: 'Instalación', count: 1 }, { label: 'Acabados', count: 2, group: 'early' }, { label: 'Repaso', count: 3 }] } } }, 'en', 't1');
    expect((s.localizations?.es as { stages: unknown }).stages).toEqual([{ label: 'Instalación', count: 120, group: 'early' }, { label: 'Acabados', count: 30, group: 'late' }, { label: 'Repaso', count: 5 }]);
  });

  it('an overlay cannot set initial', () => {
    // The overlay carries two parties, so only the base-only rule can drop `initial`.
    const s = validateSection({ type: 'partyViews', data: { parties: [{ label: 'A' }, { label: 'B' }] }, localizations: { fr: { label: 'Parties', parties: [{ label: 'Un' }, { label: 'Deux' }], initial: 1 } } }, 'en', 't1');
    expect(s.localizations?.fr).toEqual({ label: 'Parties', parties: [{ label: 'Un' }, { label: 'Deux' }] });
  });
});

describe('crawlers get every party and the totals (ADR 1105 D9)', () => {
  it('prints each party with its needs and view rows', () => {
    const d = v('partyViews', { parties: [{ label: 'Builder', needs: ['Dates that hold'], rows: [{ title: 'Tile order', status: 'Late', tone: 'bad' }] }, { label: 'Client', needs: ['Fewer surprises'] }] }).data;
    const html = designSectionHtml('partyViews', d, '', esc)!;
    expect(html).toContain('<h3>Builder</h3>');
    expect(html).toContain('<li>Tile order (Late)</li>');
    expect(html).toContain('<h3>Client</h3>');
    expect(html).toContain('<li>Fewer surprises</li>');
  });

  it('prints each stage\'s count and each group\'s total', () => {
    const html = designSectionHtml('stageChart', v('stageChart', chart).data, '', esc)!;
    expect(html).toContain('<li>Rough-in: 120 decisions</li>');
    expect(html).toContain('<ul><li>Before walls: 120 decisions</li><li>After walls: 30 decisions</li></ul>');
  });
});
