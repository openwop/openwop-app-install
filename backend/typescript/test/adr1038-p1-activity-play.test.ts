/**
 * ADR 1038 P1 — a hero activity card that plays once.
 *
 *   1. `play` is a closed, hero-only presentation enum on the BASE layer: junk and
 *      other section types drop it, and a locale overlay never carries it, so a
 *      translation (which replaces `activity` whole, RFC 0103 §C) cannot stop or
 *      change the card playing.
 *   2. The card's `result` line is content: kept on base and overlay, scrubbed and
 *      capped like the rows.
 *   3. Crawlers and the markdown export read the result line after the rows; the
 *      translated count never reaches them (no translations there).
 *
 * Double guard: an overlay that names no `visual` loses `play` twice, at the
 * partial-build early return AND at the activity-visual gate. The overlay case
 * names `visual: 'activity'` so the early return stands alone; a probe breaking
 * both in one edit is witnessed too.
 *
 * Sabotage-witnessed (w86 grade-tests): keeping any `play` value, keeping it on
 * another section type or another hero visual, or keeping it on a partial
 * (overlay) build reds 1; dropping `result` from `cleanActivity` or leaving it
 * uncapped reds 2; writing the result unescaped or leaving it out of the
 * markdown reds 3. "Without a count" is a contract statement, not a witness:
 * this renderer has no translations, so nothing there can produce the count.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeSectionOverlay, validateSection } from '../src/features/cms/cmsService.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';

const ACTIVITY = { title: 'Launch', items: [{ actor: 'Ana', action: 'set up billing', status: 'Done', state: 'done' }], result: 'Live at <your-app>.com' };

describe('hero play', () => {
  it('is a closed enum on the hero base layer only', () => {
    const hero = (play: unknown) => validateSection({ type: 'hero', data: { heading: 'H', visual: 'activity', activity: ACTIVITY, play } }).data;
    expect(hero('once').play).toBe('once');
    expect(hero('still').play).toBe('still');
    expect('play' in hero('loop')).toBe(false);
    expect('play' in validateSection({ type: 'richText', data: { body: 'x', play: 'once' } }).data).toBe(false);
    // Only the activity card plays; a leftover on another visual is dropped.
    expect('play' in validateSection({ type: 'hero', data: { heading: 'H', visual: 'plan', play: 'once' } }).data).toBe(false);
  });

  it('never rides a locale overlay', () => {
    const overlay = sanitizeSectionOverlay('hero', { heading: 'Hola', visual: 'activity', play: 'once', activity: ACTIVITY });
    expect(overlay.visual).toBe('activity');
    expect('play' in overlay).toBe(false);
    expect((overlay.activity as { result?: string }).result).toBe('Live at <your-app>.com');
  });
});

describe('activity result', () => {
  it('is kept, scrubbed and capped like the rows', () => {
    const d = validateSection({ type: 'hero', data: { heading: 'H', activity: { ...ACTIVITY, result: 'x'.repeat(300) } } }).data;
    expect(((d.activity as { result: string }).result).length).toBe(80);
    const blank = validateSection({ type: 'hero', data: { heading: 'H', activity: { ...ACTIVITY, result: '   ' } } }).data;
    expect('result' in (blank.activity as object)).toBe(false);
  });

  it('reaches crawlers and markdown after the rows, escaped, without a count', () => {
    const s = validateSection({ type: 'hero', data: { heading: 'H', visual: 'activity', activity: ACTIVITY, play: 'once' } });
    const html = sectionHtml(s, { assetBase: 'https://app.example.test' })!;
    expect(html).toMatch(/set up billing[\s\S]*<\/ol>\n<p>Live at &lt;your-app&gt;\.com<\/p>/);
    expect(html).not.toMatch(/of \d+ done/);
    const md = sectionMarkdown(s, 'https://app.example.test')!;
    expect(md).toMatch(/set up billing — Done\n\nLive at <your-app>\.com/);
  });
});
