/**
 * ADR 1071 — server half of the feature head and the inset aside.
 *
 *   - D1: a columns `stat` is a whole number 0–9,999,999 with its words, both or
 *     nothing; a section with a stat may carry the section picture (alt
 *     required, with its own message), which outside a timeline it could not
 *     before; crawlers read the stat as its words and see the picture.
 *   - D3: an inset item keeps its `aside`, and crawlers read it.
 *
 * Sabotage witnesses (w96 probes): keeping a half stat, a fractional or
 * negative value, refusing 0 or widening the 9,999,999 cap, dropping the
 * picture for a stat section (or keeping it without one), letting a picture
 * through without alt or with the timeline's message, serving it from the
 * wrong asset base, or dropping the stat or aside from either prerender reds a
 * case.
 */
import { describe, expect, it } from 'vitest';
import { validateSection } from '../src/features/cms/cmsService.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';

const OPTS = { assetBase: 'https://app.example.test' };
const cols = (extra: Record<string, unknown>, columns: Record<string, unknown>[] = [{ title: 'A', text: 'a' }]) =>
  validateSection({ type: 'columns', data: { layout: 'cards', heading: 'Built', columns, ...extra } });

describe('feature head (ADR 1071 D1)', () => {
  it('keeps a whole stat, and nothing half-made', () => {
    expect(cols({ stat: { value: 130, label: 'features, already built' } }).data.stat).toEqual({ value: 130, label: 'features, already built' });
    expect('stat' in cols({ stat: { value: 130 } }).data).toBe(false);
    expect('stat' in cols({ stat: { value: 1.5, label: 'x' } }).data).toBe(false);
    expect('stat' in cols({ stat: { value: -1, label: 'x' } }).data).toBe(false);
    // Both ends of 0–9,999,999 are kept; one past the top is not.
    expect(cols({ stat: { value: 0, label: 'x' } }).data.stat).toEqual({ value: 0, label: 'x' });
    expect(cols({ stat: { value: 9_999_999, label: 'x' } }).data.stat).toEqual({ value: 9_999_999, label: 'x' });
    expect('stat' in cols({ stat: { value: 10_000_000, label: 'x' } }).data).toBe(false);
  });

  it('keeps the section picture only beside a stat, and never without alt', () => {
    const withStat = cols({ stat: { value: 130, label: 'features' }, imageToken: 'tok-admin', alt: 'Toggles', frameUrl: 'Admin' }).data;
    expect(withStat).toMatchObject({ imageToken: 'tok-admin', alt: 'Toggles', frameUrl: 'Admin' });
    expect('imageToken' in cols({ imageToken: 'tok-admin', alt: 'Toggles' }).data, 'no stat, no head picture').toBe(false);
    expect(() => cols({ stat: { value: 1, label: 'x' }, imageToken: 'tok-admin' })).toThrow(/^columns\.alt is required when a section with a stat has an imageToken\.$/);
  });

  it('reads the stat as its words and shows the picture to crawlers', () => {
    const s = cols({ lede: 'The rest.', stat: { value: 130, label: 'features, already built' }, imageToken: 'tok-admin', alt: 'Toggles' });
    const html = sectionHtml(s, OPTS);
    expect(html).toMatch(/<p>130 features, already built<\/p>\n<p>The rest\.<\/p>\n<img src="https:\/\/app\.example\.test\/host\/openwop-app\/assets\/tok-admin" alt="Toggles"/);
    expect(sectionMarkdown(s, OPTS.assetBase)).toContain('130 features, already built\n\n');
  });
});

describe('inset aside (ADR 1071 D3)', () => {
  it('keeps the aside and reads it', () => {
    const s = validateSection({ type: 'columns', data: { layout: 'bento', columns: [{ title: 'Print', text: 'a', items: [{ label: 'Ready to print', aside: 'your-app.com' }] }] } });
    expect(s.data.columns).toEqual([expect.objectContaining({ items: [{ label: 'Ready to print', aside: 'your-app.com' }] })]);
    expect(sectionHtml(s, OPTS)).toContain('<li>Ready to print <small>your-app.com</small></li>');
    expect(sectionMarkdown(s, OPTS.assetBase)).toContain('- Ready to print (your-app.com)');
  });
});
