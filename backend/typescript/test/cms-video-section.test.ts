/**
 * ADR 0843 — the `video` CMS section type, end to end on the server.
 *
 * 1. `validateSection` — https-only media URLs, required fields, bounds, the
 *    `m:ss` length and YouTube-host rules; a partial overlay drops (never
 *    throws on) a bad URL.
 * 2. `sectionHtml` — the crawler render is a <figure> with the poster <img>,
 *    the title, the description and followable links.
 * 3. `jsonLdBlocks` — one VideoObject per video section, from the same data.
 * 4. `sectionMarkdown` — the markdown twin.
 */
import { describe, expect, it } from 'vitest';
import { validateSection, sanitizeSectionOverlay, type Section } from '../src/features/cms/cmsService.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';
import { jsonLdBlocks, videoIsoDuration } from '../src/features/publishing/prerenderService.js';

const GOOD = {
  heading: 'Why companies run it as their *own*',
  lede: 'A short film.',
  title: 'OpenWOP for Companies',
  description: 'A narrated film, with English captions.',
  length: '1:57',
  src: 'https://openwop.dev/assets/video/openwop-companies.mp4?v=2026-10-06.3',
  poster: 'https://openwop.dev/assets/video/openwop-companies-poster.jpg?v=2026-10-06.3',
  captions: 'https://openwop.dev/assets/video/openwop-companies.en.vtt?v=2026-10-06.3',
  youtubeUrl: 'https://www.youtube.com/watch?v=ABqfybP2w4k',
};
const video = (data: Record<string, unknown>): Section => validateSection({ type: 'video', data });

describe('video section — validation', () => {
  it('accepts a complete section and keeps every field', () => {
    expect(video(GOOD).data).toEqual(GOOD);
  });

  it('captions, youtubeUrl, heading and lede are optional', () => {
    const { captions: _c, youtubeUrl: _y, heading: _h, lede: _l, ...min } = GOOD;
    expect(video(min).data).toEqual(min);
  });

  it.each(['src', 'poster', 'title', 'description', 'length'])('requires %s', (field) => {
    const { [field as keyof typeof GOOD]: _drop, ...rest } = GOOD;
    expect(() => video(rest)).toThrow(new RegExp(`video\\.${field}`));
  });

  it.each([
    ['http (not https)', 'http://openwop.dev/a.mp4'],
    ['protocol-relative', '//openwop.dev/a.mp4'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:video/mp4;base64,AAAA'],
    ['relative path', '/assets/a.mp4'],
    ['credentials', 'https://user:pw@openwop.dev/a.mp4'],
  ])('rejects a %s src', (_label, src) => {
    expect(() => video({ ...GOOD, src })).toThrow(/video\.src/);
  });

  it('rejects a non-https poster, captions or YouTube URL', () => {
    expect(() => video({ ...GOOD, poster: 'http://x.test/p.jpg' })).toThrow(/video\.poster/);
    expect(() => video({ ...GOOD, captions: 'ftp://x.test/c.vtt' })).toThrow(/video\.captions/);
    expect(() => video({ ...GOOD, youtubeUrl: 'http://www.youtube.com/watch?v=x' })).toThrow(/video\.youtubeUrl/);
  });

  it('a youtubeUrl must be on a YouTube host', () => {
    expect(() => video({ ...GOOD, youtubeUrl: 'https://evil.example/watch?v=x' })).toThrow(/video\.youtubeUrl/);
    expect(video({ ...GOOD, youtubeUrl: 'https://youtu.be/ABqfybP2w4k' }).data.youtubeUrl).toBe('https://youtu.be/ABqfybP2w4k');
  });

  it('rejects an oversized URL instead of truncating it', () => {
    const src = `https://openwop.dev/${'a'.repeat(2100)}.mp4`;
    expect(() => video({ ...GOOD, src })).toThrow(/at most 2048/);
  });

  it('bounds the text fields', () => {
    const d = video({ ...GOOD, title: 'word '.repeat(100), description: 'd '.repeat(1000) }).data;
    expect((d.title as string).length).toBeLessThanOrEqual(160);
    expect((d.title as string).length).toBeGreaterThan(150);
    expect((d.description as string).length).toBeLessThanOrEqual(1000);
  });

  it('length must be m:ss; uploadDate must be YYYY-MM-DD', () => {
    expect(() => video({ ...GOOD, length: '117s' })).toThrow(/video\.length/);
    expect(() => video({ ...GOOD, length: '1:75' })).toThrow(/video\.length/);
    expect(() => video({ ...GOOD, uploadDate: 'last week' })).toThrow(/video\.uploadDate/);
    expect(video({ ...GOOD, uploadDate: '2026-10-06' }).data.uploadDate).toBe('2026-10-06');
  });

  it('a localization overlay keeps its text and drops (never throws on) a bad URL', () => {
    expect(sanitizeSectionOverlay('video', { title: 'Para empresas', src: 'http://evil.test/a.mp4' })).toEqual({ title: 'Para empresas' });
    const s = validateSection({ type: 'video', data: GOOD, localizations: { es: { title: 'Para empresas', description: 'Una película.' } } });
    expect(s.localizations).toEqual({ es: { title: 'Para empresas', description: 'Una película.' } });
  });
});

describe('video section — crawler render', () => {
  const html = sectionHtml(video(GOOD), { assetBase: 'https://app.example.test' })!;

  it('is a <figure> with the poster, title, description and links', () => {
    expect(html).toContain('<figure>');
    expect(html).toContain(`<img src="${GOOD.poster}" alt="${GOOD.title}"`);
    expect(html).toContain(`<strong>${GOOD.title}</strong>`);
    expect(html).toContain(`<p>${GOOD.description}</p>`);
    expect(html).toContain(`<a href="${GOOD.src}" rel="noopener noreferrer">Watch the video (1:57)</a>`);
    expect(html).toContain(`<a href="${GOOD.youtubeUrl}" rel="noopener noreferrer">Watch on YouTube</a>`);
    expect(html).toContain('<em>own</em>'); // heading emphasis syntax
  });

  it('never links a non-https URL that reached storage some other way', () => {
    const raw = { sectionId: 's', type: 'video', data: { ...GOOD, src: 'javascript:alert(1)', youtubeUrl: 'http://x' } } as Section;
    const out = sectionHtml(raw, { assetBase: 'https://app.example.test' })!;
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('Watch on YouTube');
  });
});

describe('video section — VideoObject JSON-LD', () => {
  const page = (sections: Section[]) => ({ title: 'White label', updatedAt: '2026-10-06T00:00:00Z', slug: 'white-label', sections });
  const seo = { title: 'T', description: 'D', canonicalUrl: 'https://app.example.test/p/white-label' } as never;

  it('emits one VideoObject per video section', () => {
    const blocks = jsonLdBlocks({ seo, page: page([video(GOOD), video({ ...GOOD, title: 'Second', length: '1:15', uploadDate: '2026-10-02' })]), locale: 'en', baseUrl: 'https://app.example.test' });
    const videos = blocks.filter((b) => (b as { '@type': string })['@type'] === 'VideoObject');
    expect(videos).toHaveLength(2);
    expect(videos[0]).toEqual({
      '@context': 'https://schema.org',
      '@type': 'VideoObject',
      name: GOOD.title,
      description: GOOD.description,
      thumbnailUrl: GOOD.poster,
      contentUrl: GOOD.src,
      duration: 'PT1M57S',
      embedUrl: 'https://www.youtube.com/embed/ABqfybP2w4k',
      url: GOOD.youtubeUrl,
    });
    expect(videos[1]).toMatchObject({ name: 'Second', duration: 'PT1M15S', uploadDate: '2026-10-02' });
  });

  it('a page without a video section emits none', () => {
    const blocks = jsonLdBlocks({ seo, page: page([]), locale: 'en', baseUrl: 'https://app.example.test' });
    expect(blocks.some((b) => (b as { '@type': string })['@type'] === 'VideoObject')).toBe(false);
  });

  it('m:ss → ISO 8601 duration', () => {
    expect(videoIsoDuration('1:57')).toBe('PT1M57S');
    expect(videoIsoDuration('0:45')).toBe('PT45S');
    expect(videoIsoDuration('2:00')).toBe('PT2M');
    expect(videoIsoDuration('75:00')).toBe('PT1H15M');
    expect(videoIsoDuration('nope')).toBeNull();
  });
});

describe('video section — markdown twin', () => {
  it('renders heading, title + length, description and links', () => {
    const md = sectionMarkdown(video(GOOD), 'https://app.example.test')!;
    expect(md).toContain(`## ${GOOD.heading}`);
    expect(md).toContain(`**${GOOD.title}** (1:57)`);
    expect(md).toContain(GOOD.description);
    expect(md).toContain(`[Watch the video](${GOOD.src}) · [Watch on YouTube](${GOOD.youtubeUrl})`);
  });
});
