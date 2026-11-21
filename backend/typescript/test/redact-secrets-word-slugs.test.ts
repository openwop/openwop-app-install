/**
 * `scrubSecretShaped` keeps readable URL slugs and still redacts credentials
 * (issue #5044; slug fix 7fb38d8221, embedded-key guard 0f4eff818b).
 *
 * The opaque-blob rule (`[A-Za-z0-9_-]{40,}`) used to redact any long hyphenated
 * slug, and `safeUrl` scrubs through `cleanString`, so a 41-char blog slug's
 * `canonicalUrl` was stored as `[REDACTED:secret-shaped]` on an adopter's blog from
 * 2026-09-19 on (every re-save reproduced it). #5044 reported the same for an
 * article slug inside CMS text: the log lane keeps it through the slug exemption,
 * and the content lane (`cleanContent`) refuses only the high-precision credential
 * shapes, never the 40+ run.
 *
 * Sabotage (witnessed, grade-tests wave 64; re-probed wave 121 as w121g1-rsw-*):
 * returning the marker for every match reds the slug, #5044 and safeUrl legs
 * (rsw-replace); dropping the `sk-` guard in `isWordSlug` reds the
 * embedded/hyphenated-key legs (rsw-skguard); loosening the segment count, the
 * segment length or the lowercase/no-underscore character class each reds the
 * opaque-blob leg (rsw-segcount, rsw-seglen, rsw-charclass-r2); narrowing the
 * `AKIA` or `xox?-` rule reds the named-key leg; adding the 40+ run to the
 * content lane's credential shapes reds the #5044 CMS leg.
 */
import { describe, expect, it } from 'vitest';
import { scrubSecretShaped } from '../src/host/redactSecrets.js';
import { cleanContent, safeUrl } from '../src/host/boundedStrings.js';

const MARK = '[REDACTED:secret-shaped]';

describe('word slugs survive the secret scrub', () => {
  it('keeps a 40+ char lowercase slug of words, alone and inside a URL', () => {
    const slug = 'plans-that-adapt-without-erasing-progress';
    expect(slug.length).toBeGreaterThanOrEqual(40);
    expect(scrubSecretShaped(slug)).toBe(slug);
    const url = `https://acme.example/blog/${slug}`;
    expect(safeUrl(url, 2048)).toBe(url);
  });

  it('keeps the #5044 article slug, in the log lane and in CMS content', () => {
    const slug = 'b2b-content-marketing-in-2026-ai-adoption-is-near-universal-but-performance-gains-are-not';
    const lede = `As https://news.example/${slug} reports, adoption is near universal.`;
    expect(scrubSecretShaped(lede)).toBe(lede);
    expect(cleanContent(lede, 4000, 'lede')).toBe(lede);
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
