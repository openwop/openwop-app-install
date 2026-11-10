/**
 * ADR 1050 D5 — an `image` section takes the same `tone` band as the other
 * toned sections, server half: validation (base and locale overlay) and
 * crawler/markdown parity.
 *
 * Claims: (1) every tone value the other sections keep, `image` keeps; (2) an
 * unknown or non-string tone is dropped, never thrown, and leaves no key; (3) an
 * overlay is held to the same cleaner; (4) tone is presentation (ADR 0920 D7), so
 * the prerendered HTML and the markdown export of a toned image are byte-identical
 * to the untoned one.
 *
 * Sabotage-witnessed (2026-11-03): removing `...tone()` from the image case reds
 * (1) and (3); replacing it with a raw `tone: d.tone` reds (2).
 */
import { describe, expect, it } from 'vitest';
import { sanitizeSectionOverlay, validateSection } from '../src/features/cms/cmsService.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';

const IMG = { token: 'tok_shot', alt: 'The dashboard', heading: 'See it', lede: 'One screen.', caption: 'Live data.' };
const data = (type: string, d: Record<string, unknown>): Record<string, unknown> => validateSection({ type, data: d }).data;
const OPTS = { assetBase: 'https://app.example.test' };
const BASE = 'https://app.example.test';

describe('ADR 1050 D5 — image tone validation', () => {
  it.each(['default', 'muted', 'inverse', 'accent'])('keeps tone %s, like richText does', (tone) => {
    expect(data('image', { ...IMG, tone }).tone).toBe(tone);
    expect(data('richText', { text: 'x', tone }).tone).toBe(tone);
  });

  it.each([['neon'], [''], [42], [{ v: 'muted' }], [null]])('drops tone %j and leaves no key', (tone) => {
    const d = data('image', { ...IMG, tone });
    expect('tone' in d).toBe(false);
  });

  it('a section without a tone validates exactly as before', () => {
    expect(data('image', IMG)).toEqual({ heading: 'See it', lede: 'One screen.', token: 'tok_shot', alt: 'The dashboard', caption: 'Live data.' });
  });

  it('holds a locale overlay to the same cleaner', () => {
    expect(sanitizeSectionOverlay('image', { tone: 'muted', caption: 'Données en direct.' })).toEqual({ caption: 'Données en direct.', tone: 'muted' });
    expect(sanitizeSectionOverlay('image', { tone: 'neon' })).toEqual({});
  });
});

describe('ADR 1050 D5 — crawler and markdown parity', () => {
  const plain = validateSection({ sectionId: 's-img', type: 'image', data: IMG });
  const toned = validateSection({ sectionId: 's-img', type: 'image', data: { ...IMG, tone: 'inverse' } });

  it('the tone reached the stored section (so parity below is not vacuous)', () => {
    expect(toned.data.tone).toBe('inverse');
  });

  it('prerenders a toned image byte-identically to an untoned one', () => {
    const html = sectionHtml(toned, OPTS);
    expect(html).toBe(sectionHtml(plain, OPTS));
    expect(html).toContain('alt="The dashboard"');
    expect(html).not.toMatch(/tone|inverse/);
  });

  it('exports the same markdown', () => {
    expect(sectionMarkdown(toned, BASE)).toBe(sectionMarkdown(plain, BASE));
  });
});
