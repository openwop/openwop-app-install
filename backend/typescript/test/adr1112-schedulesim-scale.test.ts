/**
 * ADR 1112 P2 — scheduleSim grouped and at scale.
 *
 * Pins:
 *  - phases, categories and roles are closed-world keys: a decision or rule naming a key
 *    the section lacks is a 400 (a rule is dropped, never widened), two rows sharing a key
 *    are a 400, and options are optional;
 *  - a locale overlay changes words only: it is aligned to the base by id (an item the base
 *    lacks is dropped; an id-less list of another length is dropped), then scheduleSim's
 *    ids, keys, references, numbers and flags follow the base whatever their JSON type.
 *    A decision's `decider` stays translatable (it is shown); a rule's follows the base.
 *    Another section's `role` (a quote's) stays translatable; the start date is base-only
 *    and must be a real day;
 *  - a translation missing a newer decision gets the base's copy; an options list of
 *    another length is the base's; a scenario rule's `decider` takes the translated name of
 *    a decision that had its base name, so scenarios work in every locale;
 *  - a base edit that removes or reorders decisions leaves an untouched translation
 *    outdated, never current; an old translation without ids still aligns by position;
 *  - every saved decision has an id (minted, never colliding);
 *  - a page over the request limit, and an AI translation of a section too large to come
 *    back whole, are refused with the reason; the kernel's structure check (system
 *    rewrites, erasure) never refuses a stored page for its size or an old start date;
 *  - the D5 measurement: 1,500 decisions shaped like CasaVoga's catalog (1,145 rows,
 *    ~210 B each with compact keys) save with one translation, and a section whose
 *    translations take it past the byte limit is refused with the reason;
 *  - crawlers get milestone dates and counts by phase, not 1,500 rows.
 *
 * Sabotage, each restored, each red: drop the group-key check; restore only strings and
 * numbers (the old rule) for scheduleSim; skip the id alignment; put `role` in the global
 * ITEM_BASE_KEYS (the quote case); remove the byte guard or the page guard; list every
 * decision in the projection; drop the startDate check; drop the AI size check.
 */
import { describe, expect, it } from 'vitest';
import { stampSourceDigests, translationStatus, validateSection, validateSections, type Section } from '../src/features/cms/cmsService.js';
import { autoTranslateMissingOverlays, translateSectionData } from '../src/features/cms/translate.js';
import { DESIGN_MAX, designSectionHtml, designSectionMarkdown } from '../src/features/cms/designSections.js';

type Raw = Record<string, unknown>;
const v = (data: Raw, localizations?: Raw) => validateSection({ type: 'scheduleSim', data, ...(localizations ? { localizations } : {}) }, 'en', 't1');

const milestones = Array.from({ length: 12 }, (_, i) => ({ id: `m${i + 1}`, label: `Milestone ${i + 1}`, startWeek: i * 4, weeks: 4, floatDays: 3 }));
const phases = ['survey', 'schematic', 'design', 'documents', 'permits', 'bidding', 'construction', 'finishes', 'install', 'closeout'].map((key) => ({ key, label: key[0]?.toUpperCase() + key.slice(1) }));
const categories = ['rooms', 'build', 'mep', 'finish', 'site'].map((key) => ({ key, label: key.toUpperCase() }));
const roles = ['client', 'designer', 'architect', 'builder', 'trades'].map((key) => ({ key, label: key }));

/** Field lengths measured on CasaVoga's catalog (2026-11-12): title 39, element 33, id 9, 0.88 deps. */
function catalog(n: number): Raw[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `DEC-${String(i).padStart(5, '0')}`,
    title: `What finish and size does item ${i} need for t`.slice(0, 39),
    element: `Kitchen layout and work zones ${i}`.slice(0, 33),
    milestone: `m${(i % 12) + 1}`, phase: phases[i % 10]?.key, category: categories[i % 5]?.key, role: roles[i % 5]?.key,
    lockWeek: (i % 12) * 4 + 2, leadDays: (i % 7) * 7, ...(i % 3 === 0 ? { back: true } : {}),
    ...(i > 0 && i % 8 !== 0 ? { dependsOn: [`DEC-${String(i - 1).padStart(5, '0')}`] } : {}),
  }));
}
const big = (n: number): Raw => ({ startDate: '2027-03-01', phases, categories, roles, milestones, decisions: catalog(n) });
/** A translation of every label and title, the same length as the base (the usual case). */
const overlayOf = (base: Raw): Raw => ({
  milestones: (base.milestones as Raw[]).map((m) => ({ ...m, label: `ES ${String(m.label)}` })),
  decisions: (base.decisions as Raw[]).map((x) => ({ ...x, title: `ES ${String(x.title)}`.slice(0, 39) })),
});

describe('ADR 1112 P2 — grouping keys are closed-world', () => {
  const base = { phases, categories, roles, milestones: milestones.slice(0, 1) };
  const dec = (extra: Raw) => ({ id: 'a', title: 'Tile', milestone: 'm1', ...extra });
  it('keeps a decision with known keys and no options', () => {
    const s = v({ ...base, decisions: [dec({ phase: 'design', category: 'finish', role: 'client' })] });
    expect((s.data.decisions as Raw[])[0]).toMatchObject({ phase: 'design', category: 'finish', role: 'client' });
    expect((s.data.decisions as Raw[])[0]).not.toHaveProperty('options'); // none stored when there are none
  });
  it('refuses a decision naming a phase, category or role the section lacks', () => {
    expect(() => v({ ...base, decisions: [dec({ phase: 'nope' })] })).toThrow(/names a phase that does not exist/);
    expect(() => v({ ...base, decisions: [dec({ category: 'nope' })] })).toThrow(/names a category that does not exist/);
    expect(() => v({ ...base, decisions: [dec({ role: 'nope' })] })).toThrow(/names a role that does not exist/);
  });
  it('refuses two rows sharing a key, and drops a rule naming an unknown key', () => {
    expect(() => v({ ...base, roles: [...roles, { key: 'client', label: 'Again' }], decisions: [dec({})] })).toThrow(/two roles share a key/);
    const s = v({ ...base, decisions: [dec({})], presets: [{ label: 'Slow', rules: [{ role: 'client', delayDays: 7 }, { role: 'ghost', delayDays: 30 }] }] });
    expect((s.data.presets as Raw[])[0]).toMatchObject({ rules: [{ role: 'client', delayDays: 7 }] });
  });
});

describe('ADR 1112 P2 — an overlay changes words only', () => {
  const base: Raw = {
    startDate: '2027-03-01', phases, categories, roles, milestones: milestones.slice(0, 2),
    decisions: [
      { id: 'a', title: 'Shower valve', milestone: 'm1', phase: 'design', category: 'mep', role: 'client', leadDays: 28, lockWeek: 3, back: true, decider: 'Owner' },
      { id: 'b', title: 'Trim kit', milestone: 'm2', phase: 'design', category: 'mep', role: 'builder', leadUnknown: true, dependsOn: ['a'] },
    ],
    presets: [{ label: 'Slow owner', rules: [{ decider: 'Owner', delayDays: 14 }] }],
  };
  it('restores every scheduleSim behaviour key from the base, whatever its type, and keeps the shown words', () => {
    const es: Raw = {
      startDate: '2030-01-01',
      decisions: [
        { id: 'a', title: 'Válvula de ducha', milestone: 'm2', phase: 'permits', category: 'site', role: 'trades', leadDays: 1, lockWeek: 9, back: false, decider: 'Dueño' },
        { id: 'b', title: 'Kit de acabado', milestone: 'm2', phase: 'design', category: 'mep', role: 'builder', dependsOn: [] },
      ],
      presets: [{ label: 'Dueño lento', rules: [{ decider: 'Dueño', delayDays: 99 }] }],
    };
    const out = v(base, { es }).localizations?.es as Raw;
    expect(out).not.toHaveProperty('startDate');
    const [a, b] = out.decisions as Raw[];
    expect(a).toMatchObject({ id: 'a', title: 'Válvula de ducha', milestone: 'm1', phase: 'design', category: 'mep', role: 'client', leadDays: 28, lockWeek: 3, back: true, decider: 'Dueño' });
    expect(b).toMatchObject({ id: 'b', title: 'Kit de acabado', leadUnknown: true, dependsOn: ['a'] });
    // A rule's decider is a match key: it takes the translated name of the decision that had
    // the base's ("Owner" → "Dueño"), whatever the translation wrote; its number follows the base.
    expect(out.presets).toEqual([{ label: 'Dueño lento', rules: [{ decider: 'Dueño', delayDays: 14 }] }]);
  });

  it('aligns a translation to the base by id: extra items are dropped, order is the base\'s, a list of another length is the base\'s', () => {
    const es: Raw = {
      decisions: [
        { id: 'b', title: 'Kit de acabado' },
        { id: 'ghost', title: 'Fantasma', milestone: 'nope', phase: 'nope', role: 'nope', leadDays: 300 },
        { id: 'a', title: 'Válvula' },
      ],
      presets: [{ label: 'Uno' }, { label: 'Dos' }], // two presets where the base has one: the base's
    };
    const out = v(base, { es }).localizations?.es as Raw;
    expect((out.decisions as Raw[]).map((x) => [x.id, x.title, x.milestone])).toEqual([['a', 'Válvula', 'm1'], ['b', 'Kit de acabado', 'm2']]);
    expect(out.presets).toEqual(base.presets);
  });

  it('saves a translation written before the base grew: its words kept, the new decision the base\'s', () => {
    const grown = { ...base, decisions: [...(base.decisions as Raw[]), { id: 'c', title: 'Tile', milestone: 'm2' }] };
    const out = v(grown, { es: { decisions: [{ id: 'a', title: 'Válvula' }, { id: 'b', title: 'Kit' }] } }).localizations?.es as Raw;
    expect((out.decisions as Raw[]).map((x) => x.title)).toEqual(['Válvula', 'Kit', 'Tile']);
  });

  it('drops a start date that is not a real day, and a stored one never breaks the page', () => {
    expect(v({ ...base, startDate: '2026-13-01' }).data).not.toHaveProperty('startDate');
    expect(v({ ...base, startDate: '2026-02-30' }).data).not.toHaveProperty('startDate');
    expect(v(base).data).toMatchObject({ startDate: '2027-03-01' });
    expect(designSectionHtml('scheduleSim', { ...base, startDate: '2026-13-01' }, '', (x) => x)).toContain('Milestone 1');
  });

  it('a scenario rule takes the translated name of the decision it matched', () => {
    const out = v(base, { es: { decisions: [{ id: 'a', title: 'Válvula', decider: 'Dueño' }, { id: 'b', title: 'Kit' }] } }).localizations?.es as Raw;
    // The translation carries no presets of its own; it gets the base's, with the name carried over.
    expect(out.presets).toEqual([{ label: 'Slow owner', rules: [{ decider: 'Dueño', delayDays: 14 }] }]);
  });

  it('fills a decision the translation lacks with the base\'s, and an options list of another length with the base\'s', () => {
    const withOptions = { ...base, decisions: [{ ...(base.decisions as Raw[])[0], options: [{ label: 'Late', delayDays: 7 }, { label: 'Very late', delayDays: 21 }] }, (base.decisions as Raw[])[1]] };
    const out = v(withOptions, { es: { decisions: [{ id: 'a', title: 'Válvula', options: [{ label: 'Tarde' }] }] } }).localizations?.es as Raw;
    const [a, b] = out.decisions as Raw[];
    expect(a).toMatchObject({ title: 'Válvula', options: [{ label: 'Late', delayDays: 7 }, { label: 'Very late', delayDays: 21 }] });
    expect(b).toMatchObject({ id: 'b', title: 'Trim kit', milestone: 'm2' });
  });

  it('aligns an old translation without ids by position, and mints an id for every saved decision', () => {
    const idless = { ...base, decisions: [{ id: 'd1', title: 'Authored', milestone: 'm1' }, { title: 'No id', milestone: 'm1' }, { title: 'Also none', milestone: 'm2' }] };
    const saved = v(idless);
    expect((saved.data.decisions as Raw[]).map((x) => x.id)).toEqual(['d1', 'd2', 'd3']);
    const out = v(saved.data, { es: { decisions: [{ title: 'Uno' }, { title: 'Dos' }, { title: 'Tres' }] } }).localizations?.es as Raw;
    expect((out.decisions as Raw[]).map((x) => [x.id, x.title, x.milestone])).toEqual([['d1', 'Uno', 'm1'], ['d2', 'Dos', 'm1'], ['d3', 'Tres', 'm2']]);
  });

  it('a base edit that removes a decision leaves an untouched translation outdated', () => {
    const es = { decisions: [{ id: 'a', title: 'Válvula' }, { id: 'b', title: 'Kit' }] };
    const v1 = validateSection({ sectionId: 'sec:1', type: 'scheduleSim', data: base, localizations: { es } }, 'en', 't1');
    const [stamped] = stampSourceDigests(undefined, [v1]);
    expect(translationStatus(stamped as Section, 'es')).toBe('current');
    // The author retitles one decision and removes the other; the client sends the stored translation back.
    const edited = { ...base, decisions: [{ ...(base.decisions as Raw[])[0], title: 'Shower valve, thermostatic' }] };
    const v2 = validateSection({ sectionId: 'sec:1', type: 'scheduleSim', data: edited, localizations: stamped?.localizations }, 'en', 't1');
    const [next] = stampSourceDigests([stamped as Section], [v2]);
    expect(translationStatus(next as Section, 'es')).toBe('outdated');
  });
  it('leaves another section\'s `role` translatable (a quote\'s byline)', () => {
    const s = validateSection({ type: 'quotes', data: { items: [{ quote: 'It works.', name: 'Ana', role: 'CEO, Acme' }] }, localizations: { es: { items: [{ quote: 'Funciona.', name: 'Ana', role: 'Directora general, Acme' }] } } }, 'en', 't1');
    expect(((s.localizations?.es as Raw).items as Raw[])[0]).toMatchObject({ role: 'Directora general, Acme' });
  });
});

describe('ADR 1112 P2 — the D5 size measurement', () => {
  it('1,500 decisions fit with one translation, and the byte limit refuses more with the reason', () => {
    const base = big(DESIGN_MAX.simDecisions);
    const bytes = Buffer.byteLength(JSON.stringify(v(base).data));
    // MEASURED 2026-11-12 with this generator: 411,343 B for 1,500 decisions (274 B each,
    // readable keys; CasaVoga's 1,145 are ~210 B compact), 314,330 B for 1,145, and
    // 821,644 B with one translation, which is a whole copy (RFC 0103 §C).
    expect(bytes).toBeGreaterThan(300_000);
    expect(bytes).toBeLessThan(DESIGN_MAX.simSectionBytes / 2);
    expect(() => v(base, { es: overlayOf(base) })).not.toThrow();
    expect(() => v(base, { es: overlayOf(base), fr: overlayOf(base) })).toThrow(/this section and its 2 translation\(s\) come to \d+ kB; the limit is 850 kB/);
    // The section limit leaves room under the 1 MB request body for the page's other sections.
    expect(DESIGN_MAX.simSectionBytes).toBeLessThan(1_000_000);
  });
  it('refuses a page whose sections pass the request limit, with its size', () => {
    const sim = (id: string) => ({ sectionId: id, type: 'scheduleSim', data: big(1_400) });
    expect(() => validateSections([sim('s1'), sim('s2'), sim('s3')], 'en', 't1')).toThrow(/This page's sections come to \d+ kB; a page saves as one request of at most 1 MB/);
    expect(() => validateSections([sim('s1')], 'en', 't1')).not.toThrow();
  });
  it('refuses an AI translation of a section too large to come back whole, before calling a model', async () => {
    await expect(translateSectionData('t1', 'scheduleSim', v(big(1_500)).data, 'es')).rejects.toMatchObject({ code: 'translation_invalid', details: { reason: 'too_large' } });
  });
  it('the auto-translate sweep skips a section too large to translate, and keeps going', async () => {
    const huge = { sectionId: 's1', type: 'scheduleSim' as const, data: v(big(1_500)).data };
    const r = await autoTranslateMissingOverlays('t1', [huge, { ...huge, sectionId: 's2' }], ['es', 'fr'], 2);
    // Four refusals, none of them a model call: the two-call budget is untouched and nothing errored.
    expect(r).toMatchObject({ errored: false, capped: false });
    expect(r.overlays.size).toBe(0);
  });
  it('the kernel structure check never refuses a stored page for its size', () => {
    const sim = (id: string) => ({ sectionId: id, type: 'scheduleSim', data: big(1_400) });
    expect(() => validateSections([sim('s1'), sim('s2'), sim('s3')], '')).not.toThrow();
  });
  it('keeps at most 1,500 decisions', () => {
    expect((v(big(1_600)).data.decisions as Raw[]).length).toBe(1_500);
  });
});

describe('ADR 1112 P2 — what crawlers get', () => {
  it('milestone dates and counts by phase, not every row', () => {
    const d = v(big(1_500)).data;
    const html = designSectionHtml('scheduleSim', d, '', (x) => x) ?? '';
    expect(html).toContain('<time datetime="2027-03-01">2027-03-01</time> Milestone 1');
    expect(html).toContain('<li>Survey: 150 decisions</li>');
    expect(html).not.toContain('Kitchen layout and work zones');
    expect(html.length).toBeLessThan(5_000);
    const md = designSectionMarkdown('scheduleSim', d, '') ?? '';
    expect(md).toContain('2. 2027-03-29 Milestone 2');
    expect(md).toContain('- Construction: 150 decisions');
  });
});
