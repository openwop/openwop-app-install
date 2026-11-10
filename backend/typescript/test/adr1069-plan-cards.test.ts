/**
 * ADR 1069 — server half of the plan cards and the callout footnote.
 *
 *   - D1: a column keeps a price `unit` and a button (`ctaLabel` + a guarded
 *     `ctaUrl`; an unsafe scheme becomes no link, and a link without a label
 *     is dropped); crawlers read the unit with its price, and the button as a
 *     link, in the prerender and the markdown export.
 *   - D2: `noteStyle` is a closed enum kept only with a note.
 *
 * Sabotage witnesses: dropping `unit` or the button in the validator, skipping
 * `safeLink`, keeping `noteStyle` without a note or outside its set, or
 * dropping the unit or the link from either prerender reds a case.
 */
import { describe, expect, it } from 'vitest';
import { validateSection } from '../src/features/cms/cmsService.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';

const OPTS = { assetBase: 'https://app.example.test' };
const cols = (columns: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  validateSection({ type: 'columns', data: { layout: 'list', columns, ...extra } });

describe('plan cards (ADR 1069 D1)', () => {
  it('keeps the unit and the button, guarding the link', () => {
    const d = cols([
      { title: '$299', unit: 'a month, per app', ctaLabel: 'Book a call', ctaUrl: '/p/design-partners' },
      { title: 'Free', ctaLabel: 'Bad link', ctaUrl: 'javascript:alert(1)' },
      { title: 'Solo', ctaUrl: '/p/no-label' },
    ]).data.columns as Record<string, unknown>[];
    expect(d[0]).toMatchObject({ unit: 'a month, per app', ctaLabel: 'Book a call', ctaUrl: '/p/design-partners' });
    expect(d[1]!.ctaUrl, 'an unsafe scheme is no link').toBe('');
    expect('ctaUrl' in d[2]!, 'no label, no link').toBe(false);
  });

  it('reads the unit with its price and the button as a link', () => {
    const s = cols([{ title: '$299', unit: 'a month, per app', text: 'We host it.', ctaLabel: 'Book a call', ctaUrl: '/p/design-partners' }]);
    const html = sectionHtml(s, OPTS);
    expect(html).toContain('<h3>$299 <small>a month, per app</small></h3>');
    expect(html).toMatch(/<p><a href="\/p\/design-partners"[^>]*>Book a call<\/a><\/p><\/li>/);
    const md = sectionMarkdown(s, OPTS.assetBase);
    expect(md).toContain('**$299 a month, per app** — We host it.');
    expect(md).toContain('\n   [Book a call](/p/design-partners)');
  });
});

describe('callout footnote (ADR 1069 D2)', () => {
  it('keeps the callout style only with a note, and nothing outside its set', () => {
    expect(cols([{ title: 'A' }], { note: 'Not included: ads.', noteStyle: 'callout' }).data.noteStyle).toBe('callout');
    expect('noteStyle' in cols([{ title: 'A' }], { noteStyle: 'callout' }).data).toBe(false);
    expect('noteStyle' in cols([{ title: 'A' }], { note: 'x', noteStyle: 'banner' }).data).toBe(false);
  });
});
