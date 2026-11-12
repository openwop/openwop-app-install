/**
 * The public docs tier's route matchers (`docsRoute.ts`, ADR 0392; grade-ux row 88
 * finding 2). Every `/docs` URL must stay inside the docs tier: a trailing slash,
 * an upper-case slug or a nested path used to match nothing, so `App.tsx` dropped
 * an anonymous visitor into the signed-in app shell (measured live on
 * app.openwop.dev, 2026-11-04).
 *
 * Red when: the index stops accepting `/docs/`; case folding is dropped; a
 * non-slug remainder returns null again; a sibling path (`/docsx`) is matched.
 */
import { describe, expect, it } from 'vitest';
import { canonicalDocsPath, matchDocsIndex, matchDocsSlug } from '../docsRoute.js';

describe('docs route matchers', () => {
  it('the index is /docs with or without a trailing slash', () => {
    expect(matchDocsIndex('/docs')).toBe(true);
    expect(matchDocsIndex('/docs/')).toBe(true);
    expect(matchDocsIndex('/docsx')).toBe(false);
    expect(matchDocsSlug('/docs/')).toBeNull();
  });

  it('a slug is returned case-folded, one trailing slash dropped', () => {
    expect(matchDocsSlug('/docs/welcome')).toBe('welcome');
    expect(matchDocsSlug('/docs/welcome/')).toBe('welcome');
    expect(matchDocsSlug('/docs/Welcome')).toBe('welcome');
    expect(matchDocsSlug('/docs/getting%2Dstarted')).toBe('getting-started');
  });

  it('any other /docs/ remainder stays in the docs tier (it reads as not-found there)', () => {
    expect(matchDocsSlug('/docs/a/b')).toBe('a/b');
    expect(matchDocsSlug('/docs/%E0')).toBe('%E0');
    expect(matchDocsSlug('/docs/under_score')).toBe('under_score');
  });

  it('never matches outside /docs/', () => {
    expect(matchDocsSlug('/docsx/welcome')).toBeNull();
    expect(matchDocsSlug('/p/welcome')).toBeNull();
  });
});

// ADR 1057 D1 (grade-ux N1) — the SAME canonical rule the backend crawler door
// 301s by (`adr1057-docs-crawlable.test.ts` pins the bot side). Red when the SPA
// renders a variant spelling instead of replacing it with the canonical path.
describe('canonicalDocsPath', () => {
  it('maps every variant spelling of a doc to /docs/<lowercase>', () => {
    expect(canonicalDocsPath('/docs/Welcome')).toBe('/docs/welcome');
    expect(canonicalDocsPath('/docs/welcome/')).toBe('/docs/welcome');
    expect(canonicalDocsPath('/docs/WELCOME/')).toBe('/docs/welcome');
    expect(canonicalDocsPath('/docs/')).toBe('/docs');
  });

  it('leaves canonical paths and non-slugs alone', () => {
    expect(canonicalDocsPath('/docs')).toBeNull();
    expect(canonicalDocsPath('/docs/welcome')).toBeNull();
    expect(canonicalDocsPath('/docs/a/b')).toBeNull();
    expect(canonicalDocsPath('/p/Welcome')).toBeNull();
  });
});

