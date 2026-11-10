/**
 * ADR 1064 P3d — server half of the run log and the ring gauge.
 *
 *   - the hero `log` visual is held to its spec: lines keep time, event, detail
 *     and a closed state, a state outside the set is dropped, and an 11th line
 *     is refused;
 *   - crawlers read the log as its title and then "time — event — detail";
 *   - a columns item keeps its `gauge` words, which reach the prerender and the
 *     markdown export beside the badge.
 *
 * Sabotage witnesses (grade-tests w92, 10 probes): widening the line state
 * set, renaming `log` in the spec, raising its 10-line cap, reading lines with
 * no event, swapping time and event, pointing the crawler reader elsewhere,
 * dropping the title, or dropping the gauge line in the validator or either
 * prerender reds a case.
 */
import { describe, expect, it } from 'vitest';
import { validateSection } from '../src/features/cms/cmsService.js';
import { heroArtText } from '../src/features/publishing/heroArtText.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';
import { OpenwopError } from '../src/types.js';

const OPTS = { assetBase: 'https://app.example.test' };
const line = (i: number): Record<string, unknown> => ({ time: `21:0${i}`, event: `node.step${i}`, detail: 'ok' });

describe('hero log visual (ADR 1064 P3d)', () => {
  const hero = (log: Record<string, unknown>) => validateSection({ type: 'hero', data: { heading: 'Talk to us', visual: 'log', log } });

  it('keeps the spec fields and drops a state outside its set', () => {
    const d = hero({ title: 'run · recorded', lines: [{ ...line(1), state: 'done' }, { ...line(2), state: 'shiny' }] }).data;
    expect(d.visual).toBe('log');
    expect(d.log).toEqual({ title: 'run · recorded', lines: [{ ...line(1), state: 'done' }, line(2)] });
  });

  it('refuses an eleventh line', () => {
    const bad = (): unknown => hero({ lines: Array.from({ length: 11 }, (_, i) => line(i)) });
    expect(bad).toThrow(OpenwopError);
    expect(bad).toThrow(expect.objectContaining({ httpStatus: 400 }));
    expect(bad).toThrow(/^log\.lines: at most 10 items; remove one before adding another\.$/);
  });

  it('reads as the title, then each line, for crawlers', () => {
    const d = hero({ label: 'A recorded run', title: 'run · recorded', lines: [line(1), { time: '', event: '', detail: 'x' }, { time: '07:31', event: 'approval.granted', detail: 'by you' }] }).data;
    expect(heroArtText(d)).toEqual({
      caption: 'A recorded run',
      parts: [{ kind: 'strong', text: 'run · recorded' }, { kind: 'list', items: ['21:01 — node.step1 — ok', '07:31 — approval.granted — by you'] }],
    });
  });
});

describe('card gauge (ADR 1064 P3d)', () => {
  const s = validateSection({ sectionId: 's', type: 'columns', data: { layout: 'cards', columns: [{ title: 'The test results', text: 'All passed.', gauge: '415/415', progress: 1 }] } });

  it('keeps the gauge words', () => {
    expect((s.data.columns as Array<Record<string, unknown>>)[0]).toMatchObject({ gauge: '415/415', progress: 1 });
  });

  it('puts the gauge words in the prerender and the markdown', () => {
    expect(sectionHtml(s, OPTS)).toContain('<p>415/415</p>');
    expect(sectionMarkdown(s, OPTS.assetBase)).toContain('*415/415*');
  });
});
