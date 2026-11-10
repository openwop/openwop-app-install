/**
 * ADR 1063 P2b/P2c — validator half:
 *   - P2b the `video` section keeps `chip: "corner"` (the film card's
 *     bottom-left play chip) and drops any other value;
 *   - P2c a `columns` item keeps an integer `count` 0–9,999,999 and
 *     `tone: "inverse"`, and drops anything else.
 * Sabotage witnesses: removing the chip, count or tone line from the
 * validator reds its case.
 */
import { describe, expect, it } from 'vitest';
import { validateSection } from '../src/features/cms/cmsService.js';

const FILM = {
  title: 'Whose agent is it?',
  length: '3:57',
  description: 'A narrated film about who an agent works for.',
  src: 'https://example.test/film.mp4',
  poster: 'https://example.test/film.jpg',
};
const data = (d: Record<string, unknown>): Record<string, unknown> => validateSection({ type: 'video', data: d }).data;

describe('video chip (ADR 1063 P2b)', () => {
  it('keeps chip "corner"', () => {
    expect(data({ ...FILM, chip: 'corner' }).chip).toBe('corner');
  });

  it('drops any other chip value', () => {
    for (const chip of ['top', 'Corner', true, 1, '']) {
      expect(data({ ...FILM, chip }).chip, JSON.stringify(chip)).toBeUndefined();
    }
    expect(data(FILM).chip).toBeUndefined();
  });
});

describe('bento count and tone (ADR 1063 P2c)', () => {
  const cols = (c: Record<string, unknown>): Record<string, unknown> =>
    (validateSection({ type: 'columns', data: { layout: 'bento', columns: [{ title: 'T', text: 't', ...c }] } }).data.columns as Record<string, unknown>[])[0]!;

  it('keeps an integer count and the inverse tone', () => {
    expect(cols({ count: 130, tone: 'inverse' })).toMatchObject({ count: 130, tone: 'inverse' });
    expect(cols({ count: 0 }).count).toBe(0);
    expect(cols({ count: 9_999_999 }).count).toBe(9_999_999);
  });

  it('drops a non-integer, negative, too-large or string count, and any other tone', () => {
    for (const count of [1.5, -1, 10_000_000, '130', Number.NaN]) {
      expect(cols({ count }).count, String(count)).toBeUndefined();
    }
    for (const tone of ['muted', 'accent', 'Inverse', true]) {
      expect(cols({ tone }).tone, String(tone)).toBeUndefined();
    }
  });
});
