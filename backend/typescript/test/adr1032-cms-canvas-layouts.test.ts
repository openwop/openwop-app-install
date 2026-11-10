/**
 * ADR 1032 — the canvas layouts on the server: a second film in a `video`
 * section, a head and browser frame on an `image`, and a `rows` try-it panel.
 *
 * Pins:
 *   1. `film2` is held to the first film's rules: https-only URLs, and on the
 *      base every required field (src, poster, title, description, length) is
 *      required; an overlay may carry only its text; an empty object is no film;
 *   2. an image keeps eyebrow/heading/lede, `frame: 'browser'` (any other value
 *      dropped) and a plain-text `frameUrl`;
 *   3. `toggles` keeps at most six labelled switches with a boolean start, drops
 *      blank ones, and disappears when none are left;
 *   4. the prerender and markdown carry the new text (the second film's title
 *      and links, the image head, the switch labels), and the JSON-LD gains one
 *      VideoObject per film.
 *
 * Sabotage-witnessed (2026-11-02; re-measured /grade-tests wave 84, TST-FPD-1):
 * letting a base `film2` through without a poster, admitting an http URL,
 * treating `{}` as a film, or holding an overlay to the base rules reds 1;
 * keeping an unknown frame or dropping `frameUrl` reds 2; dropping the `.slice`
 * cap, reading `on` as truthy or keeping an empty panel reds 3; a shorter bento
 * meta cap reds the inset case; dropping `film2` from the prerender, markdown or
 * jsonLdBlocks, the switch labels or the image head reds 4.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeSectionOverlay, validateSection, type Section } from '../src/features/cms/cmsService.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';
import { jsonLdBlocks } from '../src/features/publishing/prerenderService.js';

const OPTS = { assetBase: 'https://app.example.test' };
const FILM = { title: 'One', description: 'The first film.', src: 'https://cdn.example.test/one.mp4', poster: 'https://cdn.example.test/one.jpg', length: '1:13' };
const FILM2 = { title: 'Two', description: 'The second film.', src: 'https://cdn.example.test/two.mp4', poster: 'https://cdn.example.test/two.jpg', length: '1:44' };

const data = (type: Section['type'], d: Record<string, unknown>): Record<string, unknown> => validateSection({ type, data: d }).data;

describe('ADR 1032 — video film2', () => {
  it('keeps a complete second film and a footnote', () => {
    const d = data('video', { ...FILM, film2: FILM2, note: 'Narrated by an AI voice.' });
    expect(d.film2).toEqual(FILM2);
    expect(d.note).toBe('Narrated by an AI voice.');
  });
  it('requires every field of a base second film', () => {
    for (const k of ['src', 'poster', 'title', 'description', 'length'] as const) {
      const f2: Record<string, unknown> = { ...FILM2 };
      delete f2[k];
      expect(() => data('video', { ...FILM, film2: f2 }), k).toThrow(new RegExp(`film2\\.${k}`));
    }
  });
  it('refuses a non-https second film', () => {
    // The exact refusal: a bare toThrow() would pass on any other throw.
    expect(() => data('video', { ...FILM, film2: { ...FILM2, src: 'http://cdn.example.test/two.mp4' } })).toThrow(/video\.film2\.src must be an absolute https:\/\/ URL/);
  });
  it('keeps a second film\u2019s uploadDate and refuses a malformed one', () => {
    expect((data('video', { ...FILM, film2: { ...FILM2, uploadDate: '2026-11-02' } }).film2 as Record<string, unknown>).uploadDate).toBe('2026-11-02');
    expect(() => data('video', { ...FILM, film2: { ...FILM2, uploadDate: 'Nov 2' } })).toThrow(/video\.film2\.uploadDate must be YYYY-MM-DD or an ISO 8601 datetime/);
  });
  it('treats an empty object as no second film', () => {
    expect(data('video', { ...FILM, film2: {} }).film2).toBeUndefined();
  });
  it('lets an overlay carry only the second film’s text', () => {
    const o = sanitizeSectionOverlay('video', { film2: { title: 'Dos' } });
    expect(o.film2).toEqual({ title: 'Dos' });
  });
});

describe('ADR 1032 — image head and frame', () => {
  it('keeps the head, the browser frame and its address label', () => {
    const d = data('image', { token: 'tok_1', alt: 'A', heading: 'The real app', lede: 'No mockups.', eyebrow: 'Today', frame: 'browser', frameUrl: 'myndhyve.ai/dashboard' });
    expect(d).toMatchObject({ heading: 'The real app', lede: 'No mockups.', eyebrow: 'Today', frame: 'browser', frameUrl: 'myndhyve.ai/dashboard' });
  });
  it('drops an unknown frame', () => {
    expect(data('image', { token: 'tok_1', frame: 'phone' }).frame).toBeUndefined();
  });
});

describe('ADR 1032 — bento inset card', () => {
  it('keeps a detail line long enough for the inset card', () => {
    const meta = 'Agents set up · Workflow tested · Billing switched on';
    const d = data('columns', { layout: 'bento', columns: [{ title: 'Print your app', text: 'T', items: [{ label: 'Ready to print', meta }] }] });
    expect((d.columns as { items: { meta: string }[] }[])[0]!.items[0]!.meta).toBe(meta);
  });
});

describe('ADR 1032 — rows toggles', () => {
  it('keeps up to six labelled switches with a boolean start', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ label: `Step ${i + 1}`, on: i % 2 === 0 ? true : 'yes' }));
    const d = data('columns', { layout: 'rows', columns: [{ title: 'A', text: 'B' }], toggles: { title: 'Try it', items: [{ label: '' }, ...items] } });
    const t = d.toggles as { title: string; items: { label: string; on?: boolean }[] };
    expect(t.title).toBe('Try it');
    expect(t.items).toHaveLength(5); // the blank one is cut by the six-cap first, then dropped
    expect(t.items[0]).toEqual({ label: 'Step 1', on: true });
    expect(t.items[1]).toEqual({ label: 'Step 2' });
  });
  it('drops a panel with no labelled switch', () => {
    expect(data('columns', { layout: 'rows', columns: [], toggles: { title: 'Try it', items: [{ label: '' }] } }).toggles).toBeUndefined();
  });
});

describe('ADR 1032 — prerender, markdown and JSON-LD', () => {
  const video: Section = { sectionId: 'sec:v', type: 'video', data: data('video', { ...FILM, heading: 'See it', film2: FILM2, note: 'Fictional.' }) };
  const image: Section = { sectionId: 'sec:i', type: 'image', data: data('image', { token: 'tok_1', alt: 'Dash', heading: 'The real app', frame: 'browser' }) };
  const rows: Section = { sectionId: 'sec:r', type: 'columns', data: data('columns', { layout: 'rows', columns: [{ title: 'A', text: 'B' }], toggles: { items: [{ label: 'Send the email', on: true }] } }) };
  it('renders both films and the footnote as text', () => {
    const html = sectionHtml(video, OPTS)!;
    expect(html).toContain('<strong>Two</strong>');
    expect(html).toContain(FILM2.src);
    expect(html).toContain('Fictional.');
    const md = sectionMarkdown(video, 'https://app.example.test')!;
    expect(md).toContain('**Two** (1:44)');
    expect(md).toContain('Fictional.');
  });
  it('renders the image head and the switch labels', () => {
    expect(sectionHtml(image, OPTS)).toContain('The real app</h2>');
    expect(sectionMarkdown(image, 'https://app.example.test')).toContain('## The real app');
    expect(sectionHtml(rows, OPTS)).toContain('<li>Send the email</li>');
    expect(sectionMarkdown(rows, 'https://app.example.test')).toContain('- Send the email');
  });
  it('emits one VideoObject per film', () => {
    const input: Parameters<typeof jsonLdBlocks>[0] = {
      seo: { title: 'Films', description: 'Two films.', canonicalUrl: 'https://app.example.test/p/films', ogTitle: 'Films', ogDescription: 'Two films.', noindex: false },
      page: { title: 'Films', updatedAt: '2026-11-02T00:00:00.000Z', slug: 'films', sections: [video] },
      locale: 'en',
      baseUrl: 'https://app.example.test',
    };
    const isVideo = (b: object): b is { '@type': 'VideoObject'; name: string } => '@type' in b && b['@type'] === 'VideoObject';
    expect(jsonLdBlocks(input).filter(isVideo).map((b) => b.name)).toEqual(['One', 'Two']);
  });
  it('gives the second film\u2019s VideoObject its own uploadDate', () => {
    const v: Section = { sectionId: 'sec:v2', type: 'video', data: data('video', { ...FILM, uploadDate: '2026-11-01', film2: { ...FILM2, uploadDate: '2026-11-02' } }) };
    const input: Parameters<typeof jsonLdBlocks>[0] = {
      seo: { title: 'Films', description: 'Two films.', canonicalUrl: 'https://app.example.test/p/films', ogTitle: 'Films', ogDescription: 'Two films.', noindex: false },
      page: { title: 'Films', updatedAt: '2026-11-02T00:00:00.000Z', slug: 'films', sections: [v] },
      locale: 'en',
      baseUrl: 'https://app.example.test',
    };
    const vids = jsonLdBlocks(input).filter((b) => '@type' in b && (b as { '@type': string })['@type'] === 'VideoObject') as { name: string; uploadDate?: string }[];
    expect(vids.map((b) => [b.name, b.uploadDate])).toEqual([['One', '2026-11-01T00:00:00Z'], ['Two', '2026-11-02T00:00:00Z']]);
  });
});
