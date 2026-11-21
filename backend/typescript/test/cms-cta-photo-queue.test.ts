/**
 * #6150 — a `cta` band may carry a photo behind it (`imageToken`, alt required) and
 * the hero's queue card beside the copy (`queue`, ADR 1080 D7, the same closed shape).
 * Asked for by a white-label adopter (CasaVoga), whose local edit these legs were
 * ported from.
 *
 * Legs:
 *  1. The validator keeps the photo and the queue, and requires alt text with a photo.
 *  2. The queue is closed: unknown fields and an unknown tone are dropped, a queue with
 *     no titled row is dropped, and rows past the cap are cut.
 *  3. A plain cta saves exactly as before.
 *  4. The no-JavaScript page and the markdown export carry the photo and every queue row;
 *     a plain cta's output gains nothing.
 *
 * Sabotage: removing `ctaPicture(d)` from the `cta` case reds legs 1 and 4; removing
 * the queue line reds 1, 2 and 4; removing `ctaQueue` from `sectionHtml` or the queue
 * from `sectionMarkdown` reds 4.
 */
import { describe, expect, it } from 'vitest';
import { validateSection } from '../src/features/cms/cmsService.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';

const base = { heading: 'Three selections hold the rough-in.', subheading: 'In date order.', label: 'Run the simulator', url: '/p/simulator' };
const queue = { title: 'Before the walls close', label: 'Sample project', rows: [
  { id: 'PLB-018', title: 'Primary shower valve and trim', meta: 'Decide by Feb 19', status: 'No owner', tone: 'bad' },
  { id: 'PLB-022', title: 'Freestanding tub filler location', status: 'Decision due', tone: 'warn' },
] };
const cta = (data: Record<string, unknown>) => validateSection({ sectionId: 'c', type: 'cta', data });
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v : []);

describe('#6150 — a cta with a photo and a queue card', () => {
  it('keeps the photo with its alt text, and the queue', () => {
    const out = cta({ ...base, imageToken: 'tok-kitchen', alt: 'A white kitchen', queue }).data;
    expect(out.imageToken).toBe('tok-kitchen');
    expect(out.alt).toBe('A white kitchen');
    expect(out.queue).toEqual(queue);
  });

  it('refuses a photo with no alt text', () => {
    expect(() => cta({ ...base, imageToken: 'tok-kitchen' })).toThrow(/cta\.alt is required when it has an imageToken/);
  });

  it('keeps alt text out when there is no photo', () => {
    expect(cta({ ...base, alt: 'Orphan alt' }).data.alt).toBeUndefined();
  });

  it('closes the queue: unknown fields and tones go, and an empty queue is dropped', () => {
    const out = cta({ ...base, queue: { title: 'Queue', extra: 'x', rows: [{ title: 'Row', tone: 'purple', html: '<b>x</b>' }, { meta: 'no title' }] } }).data;
    expect(out.queue).toEqual({ title: 'Queue', rows: [{ title: 'Row' }] });
    expect(cta({ ...base, queue: { title: 'Queue', rows: [{ meta: 'no title' }] } }).data.queue).toBeUndefined();
    expect(cta({ ...base, queue: { rows: [{ title: 'Row' }] } }).data.queue).toBeUndefined();
    expect(cta({ ...base, queue: 'not an object' }).data.queue).toBeUndefined();
    const many = cta({ ...base, queue: { title: 'Queue', rows: Array.from({ length: 12 }, (_, i) => ({ title: `Row ${i}` })) } }).data;
    expect(list((many.queue as { rows: unknown }).rows)).toHaveLength(6);
  });

  it('saves a plain cta exactly as before', () => {
    expect(cta(base).data).toEqual(base);
  });

  it('carries the photo and every queue row to the no-JavaScript page and the markdown export', () => {
    const section = cta({ ...base, imageToken: 'tok-kitchen', alt: 'A white kitchen', queue });
    const html = sectionHtml(section, { assetBase: 'https://site.example' })!;
    expect(html).toContain('alt="A white kitchen"');
    expect(html).toContain('tok-kitchen');
    expect(html).toContain('<figcaption>Before the walls close</figcaption>');
    expect(html).toContain('PLB-018 · Primary shower valve and trim · Decide by Feb 19 · No owner');
    expect(html).toContain('PLB-022 · Freestanding tub filler location · Decision due');
    const md = sectionMarkdown(section, 'https://site.example')!;
    expect(md).toContain('**Before the walls close**');
    expect(md).toContain('- PLB-018 · Primary shower valve and trim · Decide by Feb 19 · No owner');
    expect(md).toContain('- PLB-022 · Freestanding tub filler location · Decision due');
    const plain = cta(base);
    expect(sectionHtml(plain, { assetBase: 'https://site.example' })).not.toMatch(/<figure>|<img/);
    expect(sectionMarkdown(plain, 'https://site.example')).not.toContain('- ');
  });
});
