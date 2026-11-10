import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Media files must be cacheable on Firebase Hosting, or nobody can seek in a video.
 *
 * MEASURED 2026-11-03 on myndhyve.ai: every file matched by the catch-all
 * `no-cache, no-store, must-revalidate` rule ignored `Range` (200, no
 * Content-Range), while an excluded .jpg answered 206. The homepage films were
 * .mp4, so `video.seekable` was empty and the scrubber snapped back to where
 * playback was. Captions (.vtt) were in the same rule.
 *
 * The fix keeps the no-store rule for the HTML shell (DEPLOY.md: index.html needs
 * it) and moves media out of it into its own cacheable rule. No `immutable`:
 * media files are replaced in place under the same name.
 *
 * Fix PR #5514; operator rule in DEPLOY.md §15 (which cites this file).
 *
 * Sabotage (witnessed, re-measured w85): drop mp4 from the exclusion → the
 * exclusion case fails; delete the media rule, rename its source, give it
 * no-store, immutable, no max-age, or drop nosniff → the media-rule case fails;
 * turn another rule into a broad no-store glob (`**`) → the exact-path case fails
 * (before w85 that case only rejected a rule that NAMED a media extension, so a
 * `**` no-store rule covering every video passed every case).
 */
const ROOT = resolve(__dirname, '../../../..');
type Header = { key: string; value: string };
type Rule = { source: string; headers: Header[] };
const hosting = JSON.parse(readFileSync(resolve(ROOT, 'firebase.json'), 'utf8')).hosting as { headers: Rule[] };

const MEDIA = ['mp4', 'webm', 'vtt', 'm4a', 'mp3'];
const value = (rule: Rule, key: string) => rule.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;

describe('hosting headers: media stays seekable', () => {
  const noStore = hosting.headers.filter((r) => /no-store/.test(value(r, 'Cache-Control') ?? ''));

  it('every no-store catch-all excludes the media extensions', () => {
    const catchAll = noStore.filter((r) => r.source.startsWith('**/!('));
    expect(catchAll.length).toBeGreaterThan(0);
    for (const rule of catchAll) {
      const excluded = /^\*\*\/!\(\*\.@\(([^)]*)\)\)$/.exec(rule.source)?.[1]?.split('|') ?? [];
      expect(excluded, rule.source).toEqual(expect.arrayContaining(MEDIA));
    }
  });

  it('every other no-store rule is an exact path that names no media file', () => {
    // A no-store rule that is not the parsed exclusion catch-all must be an
    // absolute path with no wildcard segment: a glob (`**`, `/films/**`, `*.x`)
    // can cover a media file without naming it, which is the incident again.
    for (const rule of noStore.filter((r) => !r.source.startsWith('**/!('))) {
      expect(rule.source.startsWith('/'), rule.source).toBe(true);
      expect(rule.source, rule.source).not.toMatch(/\*/);
      for (const ext of MEDIA) expect(rule.source).not.toMatch(new RegExp(`\\.${ext}\\b|[|(]${ext}[|)]`));
    }
  });

  it('media has its own cacheable rule (no no-store, no immutable, nosniff kept)', () => {
    const rule = hosting.headers.find((r) => r.source === `**/*.@(${MEDIA.join('|')})`);
    expect(rule).toBeDefined();
    const cc = value(rule!, 'Cache-Control') ?? '';
    expect(cc).toMatch(/max-age=\d+/);
    expect(cc).not.toMatch(/no-store|no-cache|immutable/);
    expect(value(rule!, 'X-Content-Type-Options')).toBe('nosniff');
  });
});
