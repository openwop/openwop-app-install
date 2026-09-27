/**
 * ADR 0391 (a) — the `/blog/*` matcher must resolve the index, the three
 * archive facets (tag/category/author), and a single post; match archives
 * BEFORE the bare post so `/blog/tag/x` is never read as a post named "tag";
 * decode percent-encoded segments (author ids carry `:`); never throw on
 * malformed encoding; and keep the strict slug shape on a decoded post slug.
 */
import { describe, it, expect } from 'vitest';
import { matchBlogRoute } from '../blogRoute.js';

describe('matchBlogRoute', () => {
  it('matches the index (with and without trailing slash)', () => {
    expect(matchBlogRoute('/blog')).toEqual({ kind: 'index' });
    expect(matchBlogRoute('/blog/')).toEqual({ kind: 'index' });
  });

  it('matches the tag / category / author archives', () => {
    expect(matchBlogRoute('/blog/tag/launch')).toEqual({ kind: 'tag', value: 'launch' });
    expect(matchBlogRoute('/blog/category/product')).toEqual({ kind: 'category', value: 'product' });
    expect(matchBlogRoute('/blog/author/user%3Aabc')).toEqual({ kind: 'author', value: 'user:abc' });
  });

  it('matches a single post', () => {
    expect(matchBlogRoute('/blog/hello-world')).toEqual({ kind: 'post', slug: 'hello-world' });
    expect(matchBlogRoute('/blog/my%2Dpost')).toEqual({ kind: 'post', slug: 'my-post' });
  });

  it('prefers the archive over a post named like a facet segment', () => {
    // Two-segment archive wins; it never resolves as a post whose slug is "tag".
    expect(matchBlogRoute('/blog/tag/x')).toEqual({ kind: 'tag', value: 'x' });
  });

  it('returns null (not a throw) for malformed percent-encoding', () => {
    expect(matchBlogRoute('/blog/100%')).toBeNull();
    expect(matchBlogRoute('/blog/tag/bad%zz')).toBeNull();
  });

  it('rejects a decoded post slug that is not a valid slug', () => {
    expect(matchBlogRoute('/blog/UPPER')).toBeNull();
    expect(matchBlogRoute('/blog/-leading')).toBeNull();
    expect(matchBlogRoute('/blog/%2E%2E')).toBeNull(); // ..
  });

  it('does NOT over-match a nested path or a different route', () => {
    expect(matchBlogRoute('/blog/tag/x/extra')).toBeNull();
    expect(matchBlogRoute('/blogs')).toBeNull();
    expect(matchBlogRoute('/pricing')).toBeNull();
    expect(matchBlogRoute('/')).toBeNull();
  });
});
