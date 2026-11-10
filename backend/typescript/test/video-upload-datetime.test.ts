/**
 * ADR 0843 / ADR 1032 — VideoObject `uploadDate` (the first film and the
 * ADR 1032 second film) must be a datetime with a timezone (myndhyve.ai,
 * 2026-11-07, `abda42cbb`). Search Console reported every film on the homepage as
 * "Invalid datetime value for uploadDate" because the CMS stores `YYYY-MM-DD`
 * and the prerender passed it straight into the JSON-LD.
 *
 * Pins three things:
 * 1. the CMS accepts a date OR a full ISO 8601 datetime with a timezone, stores
 *    what was typed unchanged, and refuses a datetime with no zone, a non-date
 *    (`2026-02-30`) and free text;
 * 2. the JSON-LD widens a stored date to `T00:00:00Z` and passes a datetime
 *    through, for the first film and for the second (`film2`);
 * 3. a malformed value that reached storage some other way emits NO uploadDate
 *    rather than an invalid one.
 *
 * Sabotage (each witnessed red): `videoUploadDateTime` returning the raw value
 * (case 2 and 3); `UPLOAD_DATE_RE` without the time branch (case 1 datetime);
 * the time branch with an optional zone (case 1 no-zone); dropping the
 * calendar check in `isValidUploadDate` (case 1 Feb 30); either film's write-time
 * refusal; storing a widened value instead of what was typed; dropping the
 * second film's VideoObject (/grade-tests wave 95).
 */
import { describe, expect, it } from 'vitest';
import { validateSection, type Section } from '../src/features/cms/cmsService.js';
import { jsonLdBlocks } from '../src/features/publishing/prerenderService.js';
import { videoUploadDateTime } from '../src/host/videoUploadDate.js';

const FILM = {
  src: 'https://cdn.example.test/a.mp4',
  poster: 'https://cdn.example.test/a.jpg',
  title: 'One',
  description: 'The first film.',
  length: '4:18',
};
const FILM2 = { ...FILM, src: 'https://cdn.example.test/b.mp4', poster: 'https://cdn.example.test/b.jpg', title: 'Two', description: 'The second film.' };

const data = (d: Record<string, unknown>) => validateSection({ type: 'video', data: d }).data as Record<string, unknown>;

function isVideoObject(b: object): b is { '@type': 'VideoObject'; uploadDate?: string } {
  return '@type' in b && b['@type'] === 'VideoObject';
}

function videoDates(sections: Section[]): Array<string | undefined> {
  const seo: Parameters<typeof jsonLdBlocks>[0]['seo'] = { title: 'T', description: 'D', canonicalUrl: 'https://site.example.test/p/x', ogTitle: 'T', ogDescription: 'D', noindex: false };
  const page = { title: 'X', updatedAt: '2026-11-07T00:00:00Z', slug: 'x', sections };
  return jsonLdBlocks({ seo, page, locale: 'en', baseUrl: 'https://site.example.test' })
    .filter(isVideoObject)
    .map((b) => b.uploadDate);
}

describe('video uploadDate — what the CMS accepts', () => {
  it('stores a date or a zoned datetime exactly as typed', () => {
    expect(data({ ...FILM, uploadDate: '2026-11-02' }).uploadDate).toBe('2026-11-02');
    expect(data({ ...FILM, uploadDate: '2026-11-02T09:30:00-05:00' }).uploadDate).toBe('2026-11-02T09:30:00-05:00');
    expect(data({ ...FILM, uploadDate: '2026-11-02T14:30Z' }).uploadDate).toBe('2026-11-02T14:30Z');
    const f2 = data({ ...FILM, film2: { ...FILM2, uploadDate: '2026-11-03T08:00:00.000Z' } }).film2 as Record<string, unknown>;
    expect(f2.uploadDate).toBe('2026-11-03T08:00:00.000Z');
  });

  it('refuses a datetime with no timezone, an impossible date, and free text', () => {
    for (const bad of ['2026-11-02T09:30:00', '2026-02-30', '2026-13-01', 'Nov 2', '2026-11-02 09:30Z']) {
      expect(() => data({ ...FILM, uploadDate: bad }), bad).toThrow(/video\.uploadDate must be YYYY-MM-DD or an ISO 8601 datetime with a timezone/);
    }
    expect(() => data({ ...FILM, film2: { ...FILM2, uploadDate: '2026-11-02T09:30' } })).toThrow(/video\.film2\.uploadDate/);
  });
});

describe('video uploadDate — what the JSON-LD emits', () => {
  it('widens a stored date to midnight UTC and keeps a datetime, for both films', () => {
    const s: Section = { sectionId: 'v', type: 'video', data: data({ ...FILM, uploadDate: '2026-11-01', film2: { ...FILM2, uploadDate: '2026-11-02T09:30:00-05:00' } }) };
    expect(videoDates([s])).toEqual(['2026-11-01T00:00:00Z', '2026-11-02T09:30:00-05:00']);
  });

  it('emits no uploadDate for a malformed stored value, never an invalid one', () => {
    const s: Section = { sectionId: 'v', type: 'video', data: { ...FILM, uploadDate: 'last week' } };
    expect(videoDates([s])).toEqual([undefined]);
    expect(videoUploadDateTime('2026-02-30')).toBe('');
    expect(videoUploadDateTime(undefined)).toBe('');
    expect(videoUploadDateTime(' 2026-11-01 ')).toBe('2026-11-01T00:00:00Z');
  });
});
