/**
 * ADR 1082 — the `films` section: N films, each held to the `video` rules.
 *
 * Pins: every film needs src, poster, title, description and an m:ss length;
 * every URL is https-only (the SAME rule `video` uses, injected); `shape` and
 * `filter` are closed enums; a locale overlay keeps only the text it carries and
 * drops a bad URL instead of failing; crawlers get each film as a figure; and
 * the page carries ONE VideoObject per valid film.
 *
 * Sabotage-witnessed: accepting an http:// src, dropping the length check,
 * accepting an unknown shape, or skipping `films` in jsonLdBlocks each reds a case.
 */
import { describe, expect, it } from 'vitest';
import { SECTION_TYPES, validateSection, type Section } from '../src/features/cms/cmsService.js';
import { designSectionHtml, designSectionMarkdown } from '../src/features/cms/designSections.js';
import { jsonLdBlocks } from '../src/features/publishing/prerenderService.js';

const v = (data: Record<string, unknown>): Section => validateSection({ type: 'films', data }, 'en', 't1');
const film = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  src: `https://cdn.example.test/f${n}.mp4`, poster: `https://cdn.example.test/f${n}.jpg`,
  title: `Film ${n}`, description: `What film ${n} shows.`, length: '1:0' + String(n % 10), ...extra,
});
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

describe('ADR 1082 films — validation', () => {
  it('is a registered section type and keeps every film field', () => {
    expect(SECTION_TYPES).toContain('films');
    const s = v({ heading: 'Examples', filter: 'useCase', films: [
      film(1, { useCase: 'Onboarding', shape: '9:16', captions: 'https://cdn.example.test/f1.vtt', uploadDate: '2026-11-01' }),
      film(2, { useCase: 'Sales', shape: '1:1' }),
    ] });
    expect(s.data.heading).toBe('Examples');
    expect(s.data.filter).toBe('useCase');
    const films = s.data.films as Record<string, unknown>[];
    expect(films).toHaveLength(2);
    expect(films[0]).toEqual({ src: 'https://cdn.example.test/f1.mp4', poster: 'https://cdn.example.test/f1.jpg', captions: 'https://cdn.example.test/f1.vtt', title: 'Film 1', description: 'What film 1 shows.', length: '1:01', uploadDate: '2026-11-01', useCase: 'Onboarding', shape: '9:16' });
  });

  it('refuses a film missing a required field, or with a bad length', () => {
    for (const k of ['src', 'poster', 'title', 'description']) {
      const f = film(1); delete f[k];
      expect(() => v({ films: [f] }), k).toThrow(new RegExp(`films\\[0\\]\\.${k}`));
    }
    expect(() => v({ films: [film(1, { length: '90 seconds' })] })).toThrow(/m:ss/);
    expect(() => v({ films: [] })).toThrow(/films/);
  });

  it('holds every URL to the video https-only rule', () => {
    for (const bad of ['http://cdn.example.test/f.mp4', 'javascript:alert(1)', '//cdn.example.test/f.mp4', 'https://u:p@cdn.example.test/f.mp4']) {
      expect(() => v({ films: [film(1, { src: bad })] }), bad).toThrow(/https|credentials|URL/);
    }
    expect(() => v({ films: [film(1, { captions: 'http://cdn.example.test/c.vtt' })] })).toThrow(/https/);
  });

  it('shape and filter are closed enums', () => {
    expect(() => v({ films: [film(1, { shape: '4:3' })] })).toThrow(/shape/);
    expect(() => v({ filter: 'tags', films: [film(1)] })).toThrow(/filter/);
  });

  it('a locale overlay keeps only its text and drops a bad URL instead of failing', () => {
    const s = validateSection({ type: 'films', data: { films: [film(1)] }, localizations: { fr: { films: [{ title: 'Film un', src: 'http://bad.example.test/x.mp4' }] } } }, 'en', 't1');
    expect(s.localizations?.fr).toEqual({ films: [{ title: 'Film un' }] });
  });
});

describe('ADR 1082 films — what crawlers and search get', () => {
  const data = { heading: 'Examples', films: [film(1), film(2, { src: 'https://cdn.example.test/<f2>.mp4' })] };

  it('the prerender lists each film as a figure with its poster, title, length and a link', () => {
    const html = designSectionHtml('films', data, '<h2>Examples</h2>\n', esc)!;
    expect(html).toContain('<figure><img src="https://cdn.example.test/f1.jpg" alt="Film 1"><figcaption><strong>Film 1</strong> (1:01). What film 1 shows. <a href="https://cdn.example.test/f1.mp4">Film 1</a></figcaption></figure>');
    expect(html).toContain('https://cdn.example.test/&lt;f2>.mp4');
    expect(designSectionMarkdown('films', data, '## Examples\n\n')).toBe('## Examples\n\n- **Film 1** (1:01): What film 1 shows. [Watch](https://cdn.example.test/f1.mp4)\n- **Film 2** (1:02): What film 2 shows. [Watch](https://cdn.example.test/<f2>.mp4)');
  });

  it('emits one VideoObject per valid film', () => {
    const sections = [validateSection({ type: 'films', data: { films: [film(1), film(2), film(3)] } }, 'en', 't1')];
    // A stored film that lost its poster (never valid on save) emits nothing, never a fabricated block.
    (sections[0]!.data.films as Record<string, unknown>[])[2]!.poster = '';
    const seo: Parameters<typeof jsonLdBlocks>[0]['seo'] = { title: 'T', description: 'D', canonicalUrl: 'https://site.example.test/p/x', ogTitle: 'T', ogDescription: 'D', noindex: false };
    const videos = jsonLdBlocks({ seo, page: { title: 'X', updatedAt: '2026-11-10T00:00:00Z', slug: 'x', sections }, locale: 'en', baseUrl: 'https://site.example.test' })
      .filter((b) => (b as { '@type'?: string })['@type'] === 'VideoObject') as Array<{ name: string; contentUrl: string; duration?: string }>;
    expect(videos.map((x) => x.name)).toEqual(['Film 1', 'Film 2']);
    expect(videos[0]).toMatchObject({ contentUrl: 'https://cdn.example.test/f1.mp4', duration: 'PT1M1S' });
  });
});
