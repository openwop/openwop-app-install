/**
 * `scrubSecretShaped` keeps readable URL slugs and still redacts credentials.
 *
 * The opaque-blob rule (`[A-Za-z0-9_-]{40,}`) used to redact any long hyphenated
 * slug, and `safeUrl` scrubs through `cleanString`, so a 41-char blog slug's
 * `canonicalUrl` was stored as `[REDACTED:secret-shaped]` on kicktodo.com from
 * 2026-09-19 on (every re-save reproduced it).
 *
 * Sabotage (witnessed, grade-tests wave 64): returning the marker for every
 * match reds the slug and safeUrl legs (8fw5g5-rsw-replace); dropping the `sk-`
 * guard in `isWordSlug` reds the embedded/hyphenated-key legs (rsw-skguard);
 * loosening the segment count, the segment length or the lowercase/no-underscore
 * character class each reds the opaque-blob leg (rsw-segcount, rsw-seglen,
 * rsw-charclass-r2).
 */
import { describe, expect, it } from 'vitest';
import { scrubSecretShaped } from '../src/host/redactSecrets.js';
import { safeUrl } from '../src/host/boundedStrings.js';

const MARK = '[REDACTED:secret-shaped]';

describe('word slugs survive the secret scrub', () => {
  it('keeps a 40+ char lowercase slug of words, alone and inside a URL', () => {
    const slug = 'plans-that-adapt-without-erasing-progress';
    expect(slug.length).toBeGreaterThanOrEqual(40);
    expect(scrubSecretShaped(slug)).toBe(slug);
    const url = `https://kicktodo.com/blog/${slug}`;
    expect(safeUrl(url, 2048)).toBe(url);
  });

  it('still redacts opaque blobs: mixed case, underscores, one long run', () => {
    expect(scrubSecretShaped('AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEf')).toBe(MARK);
    expect(scrubSecretShaped('abcd_efgh_ijkl_mnop_qrst_uvwx_yz01_2345_6789')).toBe(MARK);
    expect(scrubSecretShaped('a'.repeat(45))).toBe(MARK);
    // The two fixtures above carry no hyphen, so the segment-count rule refuses
    // them before the character class is consulted. These pass every other slug
    // rule (6 hyphenated segments, none over 20 chars) and differ only in case /
    // an underscore, so they are what pins the character class itself.
    expect(scrubSecretShaped('Plans-That-Adapt-Without-Erasing-Progress')).toBe(MARK);
    expect(scrubSecretShaped('plans_that-adapt-without-erasing-progress')).toBe(MARK);
    // Too few words, or a segment too long to be a word.
    expect(scrubSecretShaped('abcdefghijabcdefghij-abcdefghij-abcdefghij')).toBe(MARK);
    expect(scrubSecretShaped('abcdefghijklmnopqrstuvwxyz0123-abcd-efgh-ijkl')).toBe(MARK);
  });

  it('still redacts the named key shapes, including a lowercase hyphenated `sk-` key', () => {
    expect(scrubSecretShaped('sk-proj-abcd-efgh-ijkl-mnop-qrst-uvwx-yz01')).toBe(MARK);
    expect(scrubSecretShaped('xoxb-1234-5678-abcd-efgh')).toBe(MARK);
    expect(scrubSecretShaped('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe(MARK);
    expect(scrubSecretShaped('AKIAABCDEFGHIJKLMNOP')).toBe(MARK);
  });

  it('does not exempt a named credential embedded after readable slug words', () => {
    for (const token of [
      'notes-sk-proj-abcd-efgh-ijkl-mnop-qrst-uvwx-yz01',
      'notes-about-xoxb-1234-5678-abcd-efgh-ijkl-mnop',
    ]) {
      expect(scrubSecretShaped(token)).toBe(MARK);
      expect(safeUrl(`https://example.test/${token}`, 2048)).not.toContain(token);
    }
  });
});
