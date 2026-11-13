/**
 * ADR 1080 — design-led site sections. Pins the validators (required fields,
 * closed enums, dangling references refused, overlays partial), the hero queue
 * and richText card cleaners, the nested media tokens, and the crawler HTML.
 * Sabotage that turns it red: drop the dangling-`next` check, keep a tone with
 * no status word, stop collecting a gallery column's token, or render a tree's
 * outcomes only client-side.
 */
import { describe, expect, it } from 'vitest';
import { collectMediaTokens, SECTION_TYPES, validateSection } from '../src/features/cms/cmsService.js';
import { designSectionHtml, designSectionMarkdown } from '../src/features/cms/designSections.js';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const v = (type: string, data: Record<string, unknown>) => validateSection({ type, data }, 'en', 't1');

describe('ADR 1080 section types', () => {
  it('registers every design type', () => {
    for (const t of ['statusTable', 'dateCalc', 'conversation', 'featureIndex', 'decisionTree', 'scheduleSim']) expect(SECTION_TYPES).toContain(t);
  });

  it('statusTable keeps a tone only with its word, and requires rows', () => {
    const s = v('statusTable', { columns: ['Tag', 'Item'], rows: [{ cells: ['UP-07', 'Sofa'], status: 'CFA overdue', tone: 'bad' }, { cells: ['LT-12', 'Pendant'], tone: 'warn' }, { cells: ['PF-04', 'Faucet'], status: 'Received', tone: 'neon' }] });
    const rows = s.data.rows as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ status: 'CFA overdue', tone: 'bad' });
    expect(rows[1]).not.toHaveProperty('tone');
    expect(rows[2]).not.toHaveProperty('tone');
    expect(() => v('statusTable', { columns: ['Tag'], rows: [] })).toThrow(/rows/);
  });

  it('statusTable keeps a split head and up to six plain points, and crawls them (#5765)', () => {
    const base = { columns: ['Tag', 'Item'], rows: [{ cells: ['UP-07', 'Sofa'], status: 'Ready', tone: 'good' }] };
    // Unset: no new keys, so a stock section is byte-identical.
    expect(Object.keys(v('statusTable', base).data).sort()).toEqual(['columns', 'rows']);
    const pts = ['One', '', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 42];
    const s = v('statusTable', { ...base, head: 'split', points: pts });
    expect(s.data.head).toBe('split');
    expect(s.data.points).toEqual(['One', 'Two', 'Three', 'Four', 'Five', 'Six']); // blanks and non-strings dropped, capped at six
    expect(v('statusTable', { ...base, head: 'sideways' }).data).not.toHaveProperty('head');
    const html = designSectionHtml('statusTable', s.data, '<h2>H</h2>\n', esc) ?? '';
    expect(html).toContain('<ul><li>One</li><li>Two</li>');
    expect(html.indexOf('<ul>')).toBeLessThan(html.indexOf('<table>')); // read in the order shown
    expect(designSectionMarkdown('statusTable', s.data, '## H\n\n')).toContain('- One\n- Two');
    expect(designSectionHtml('statusTable', v('statusTable', base).data, '', esc)).not.toContain('<ul>');
  });

  it('dateCalc clamps numbers and drops a malformed date', () => {
    const s = v('dateCalc', { needDate: '03/12/2027', leadWeeks: -4, floatDays: 9999, approveDays: 5.7 });
    expect(s.data).not.toHaveProperty('needDate');
    expect(s.data).toMatchObject({ leadWeeks: 0, floatDays: 520, approveDays: 5 });
  });

  it('decisionTree refuses an option that points nowhere', () => {
    const tree = (next: string) => ({ trees: [{ title: 'Go or no-go', nodes: [{ id: 'a', text: 'In scope?', options: [{ label: 'Yes', next }, { label: 'No', outcome: 'Refer out.' }] }, { id: 'b', text: 'Budget fits?', options: [{ label: 'Yes', outcome: 'Take it.' }] }] }] });
    expect(() => v('decisionTree', tree('b'))).not.toThrow();
    expect(() => v('decisionTree', tree('missing'))).toThrow(/does not exist/);
  });

  it('scheduleSim refuses a decision on a milestone that does not exist', () => {
    const base = { milestones: [{ id: 'rough', label: 'Plumbing rough', startWeek: 20, weeks: 2, floatDays: 5 }] };
    expect(() => v('scheduleSim', { ...base, decisions: [{ title: 'Shower valve', milestone: 'rough', options: [{ label: 'On time', delayDays: 0 }] }] })).not.toThrow();
    expect(() => v('scheduleSim', { ...base, decisions: [{ title: 'Shower valve', milestone: 'tile', options: [{ label: 'On time', delayDays: 0 }] }] })).toThrow(/does not exist/);
  });

  it('scheduleSim refuses two milestones or two decisions sharing an id (ADR 1112)', () => {
    const m = { id: 'rough', label: 'Plumbing rough', startWeek: 20, weeks: 2 };
    const dec = (title: string) => ({ id: 'x', title, milestone: 'rough', options: [{ label: 'On time', delayDays: 0 }] });
    expect(() => v('scheduleSim', { milestones: [m, { ...m, label: 'Again' }], decisions: [dec('A')] })).toThrow(/two milestones share an id/);
    expect(() => v('scheduleSim', { milestones: [m], decisions: [dec('A'), dec('B')] })).toThrow(/two decisions share an id/);
    expect(() => v('scheduleSim', { milestones: [m], decisions: [{ ...dec('A'), id: undefined }, { ...dec('B'), id: undefined }] })).not.toThrow();
  });

  it('scheduleSim keeps stickySummary only in its closed form, and no longer keeps startMode (#5779 B5, ADR 1112 D3)', () => {
    const base = { milestones: [{ id: 'rough', label: 'Plumbing rough', startWeek: 20, weeks: 2 }], decisions: [{ id: 'valve', title: 'Shower valve', milestone: 'rough', leadDays: 42, options: [{ label: 'On time', delayDays: 0 }] }] };
    expect(v('scheduleSim', base).data).not.toHaveProperty('stickySummary');
    const on = v('scheduleSim', { ...base, startMode: 'whatIf', stickySummary: true }).data;
    expect(on).toMatchObject({ stickySummary: true });
    expect(on).not.toHaveProperty('startMode'); // one view: there is no mode to open on
    expect(v('scheduleSim', { ...base, stickySummary: 'yes' }).data).not.toHaveProperty('stickySummary');
    // Behaviour belongs to the base: a locale overlay cannot switch it.
    const s = validateSection({ type: 'scheduleSim', data: base, localizations: { es: { finishLabel: 'Fin', startMode: 'whatIf', stickySummary: true } } }, 'en', 't1');
    expect(s.localizations?.es).toEqual({ finishLabel: 'Fin' });
  });

  it('scheduleSim keeps the decision fields and presets, and refuses a dangling dependency', () => {
    const base = { milestones: [{ id: 'rough', label: 'Plumbing rough', startWeek: 20, weeks: 2, floatDays: 5 }] };
    const valve = { id: 'valve', title: 'Shower valve', milestone: 'rough', element: 'Primary shower', decider: 'Owner', leadDays: 42, lockWeek: 22, back: true, choices: ['Thermostatic', 'Pressure-balance'], risk: 'Wrong valve means opening tile.', options: [{ label: 'On time', delayDays: 0 }] };
    const trim = { id: 'trim', title: 'Trim kit', milestone: 'rough', leadUnknown: true, dependsOn: ['valve'], options: [{ label: 'On time', delayDays: 0 }] };
    const s = v('scheduleSim', { ...base, decisions: [valve, trim], presets: [{ label: 'Slow owner', rules: [{ decider: 'Owner', delayDays: 21 }, { kind: 'neon', delayDays: 5 }] }] });
    const decisions = s.data.decisions as Record<string, unknown>[];
    expect(decisions[0]).toMatchObject({ id: 'valve', element: 'Primary shower', decider: 'Owner', leadDays: 42, lockWeek: 22, back: true });
    expect(decisions[0]).not.toHaveProperty('choices'); // the live mode's answers (ADR 1112 D3)
    expect(decisions[1]).not.toHaveProperty('back');
    expect(decisions[1]).toMatchObject({ leadUnknown: true, dependsOn: ['valve'] });
    expect(s.data.presets).toEqual([{ label: 'Slow owner', rules: [{ decider: 'Owner', delayDays: 21 }] }]);
    expect(() => v('scheduleSim', { ...base, decisions: [{ ...trim, dependsOn: ['nope'] }] })).toThrow(/does not exist/);
    const html = designSectionHtml('scheduleSim', { ...base, decisions: [valve] }, '', esc);
    expect(html).toContain('Primary shower: Shower valve. Wrong valve means opening tile.');
  });

  it('a locale overlay keeps only the fields it names', () => {
    const s = validateSection({ type: 'conversation', data: { exchanges: [{ q: 'Why?', a: 'Because.' }] }, localizations: { es: { title: 'Asistente' } } }, 'en', 't1');
    expect(s.localizations?.es).toEqual({ title: 'Asistente' });
  });

  it('hero queue, richText card and its picture', () => {
    const hero = v('hero', { heading: 'Every selection', visual: 'queue', queue: { title: 'Before the walls close', rows: [{ id: 'PLB-018', title: 'Shower valve', status: 'No owner', tone: 'bad' }] } });
    expect(hero.data).toMatchObject({ visual: 'queue', queue: { title: 'Before the walls close' } });
    // #5779 B7 — the queue hero keeps its photo, so the renderer can set the card over it.
    const withPhoto = v('hero', { heading: 'Every selection', visual: 'queue', imageToken: 'tok-h', alt: 'A tiled shower', queue: { title: 'Before the walls close', rows: [{ id: 'PLB-018', title: 'Shower valve' }] } });
    expect(withPhoto.data).toMatchObject({ visual: 'queue', imageToken: 'tok-h', alt: 'A tiled shower' });
    expect(() => v('richText', { text: 'x', visual: 'card', card: { title: 'Vanity finish', imageToken: 'tok-1' } })).toThrow(/alt/);
    const rt = v('richText', { text: 'x', visual: 'card', side: 'start', card: { title: 'Vanity finish', imageToken: 'tok-1', alt: 'A vanity', actions: [{ label: 'Approve', url: 'javascript:alert(1)', primary: true }] } });
    expect(rt.data.side).toBe('start');
    expect((rt.data.card as { actions: { url: string }[] }).actions[0]!.url).not.toMatch(/javascript/);
  });

  it('collects nested pictures for the media graph', () => {
    const tokens = collectMediaTokens([
      { sectionId: 's1', type: 'columns', data: { layout: 'gallery', bleed: true, columns: [{ text: '', imageToken: 'tok-g', alt: 'Room' }] } },
      { sectionId: 's2', type: 'richText', data: { visual: 'card', card: { title: 'T', imageToken: 'tok-c', alt: 'A' } } },
    ]);
    expect(tokens).toEqual(expect.arrayContaining(['tok-g', 'tok-c']));
  });

  it('prerenders every tree outcome and every milestone for crawlers', () => {
    const html = designSectionHtml('decisionTree', { trees: [{ title: 'Go', nodes: [{ id: 'a', text: 'In scope?', options: [{ label: 'No', outcome: 'Refer out.' }] }] }] }, '', esc);
    expect(html).toContain('Refer out.');
    const sim = designSectionHtml('scheduleSim', { milestones: [{ id: 'm', label: 'Plumbing rough', rework: 'Open tile' }] }, '', esc);
    expect(sim).toContain('if late: Open tile');
  });
});
