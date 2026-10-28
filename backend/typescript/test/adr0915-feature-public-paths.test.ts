/**
 * ADR 0915 (Book AI P4) — a feature declares public paths confined to its own
 * namespace. Red under: accepting a path outside `/host/openwop-app/<id>/`,
 * accepting the feature root itself (that would open the whole feature), a
 * prefix match that leaks to a sibling (`/reader-admin`), or not merging the
 * declaration into `isPublicPath`.
 *
 * Tracker TST-BJU. Red when (probe-witnessed, w65): the canonical-path check (dot
 * segment / percent-escape) is dropped; the prefix match leaks to a sibling; the
 * registration confinement or the feature-id check is skipped.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { isPublicPath, registerFeaturePublicPaths, featurePublicPaths, resetFeaturePublicPathsForTests } from '../src/middleware/auth.js';

afterEach(() => resetFeaturePublicPathsForTests());

describe('ADR 0915 — feature-declared public paths', () => {
  it('a declared path (and below it) becomes public; its siblings and parent do not', () => {
    const p = '/host/openwop-app/bookai-author-suite/reader';
    expect(isPublicPath(p)).toBe(false);
    registerFeaturePublicPaths('bookai-author-suite', [p]);
    expect(isPublicPath(p)).toBe(true);
    expect(isPublicPath(`${p}/open`)).toBe(true);
    expect(isPublicPath('/host/openwop-app/bookai-author-suite/reader-admin')).toBe(false);
    expect(isPublicPath('/host/openwop-app/bookai-author-suite')).toBe(false);
    expect(isPublicPath('/host/openwop-app/bookai-author-suite/books')).toBe(false);
    expect(featurePublicPaths()).toEqual([p]);
  });

  it.each([
    ['the feature root', '/host/openwop-app/bookai-author-suite'],
    ['the root with a trailing slash', '/host/openwop-app/bookai-author-suite/'],
    ['another feature\'s namespace', '/host/openwop-app/kicktodo/reader'],
    ['outside the vendor tree', '/public/reader'],
    ['a wildcard', '/host/openwop-app/bookai-author-suite/*'],
    ['a parent hop', '/host/openwop-app/bookai-author-suite/../admin'],
    ['a trailing slash', '/host/openwop-app/bookai-author-suite/reader/'],
    ['an uppercase segment', '/host/openwop-app/bookai-author-suite/Reader'],
  ])('refuses %s at registration', (_label, path) => {
    expect(() => registerFeaturePublicPaths('bookai-author-suite', [path])).toThrow(/strictly below/);
    expect(featurePublicPaths()).toEqual([]);
  });

  it('a dot segment or a percent-escape under the prefix is never public', () => {
    const p = '/host/openwop-app/bookai-author-suite/reader';
    registerFeaturePublicPaths('bookai-author-suite', [p]);
    for (const bad of [`${p}/../../books`, `${p}/./open`, `${p}/..%2F..%2Fbooks`, `${p}/%2e%2e/books`, `${p}/x/..`, `${p}%2Fx`]) {
      expect(isPublicPath(bad), bad).toBe(false);
    }
    expect(isPublicPath(`${p}/open`)).toBe(true); // control
  });

  it('refuses a malformed feature id (it would build a different root)', () => {
    expect(() => registerFeaturePublicPaths('Bad/Id', ['/host/openwop-app/Bad/Id/x'])).toThrow(/invalid feature id/);
  });

  it('no shipped feature declares a public path yet (adding one is a reviewed change)', async () => {
    const { BACKEND_FEATURES } = await import('../src/features/index.js');
    const declared = BACKEND_FEATURES.flatMap((f) => (f.publicPaths ?? []).map((p) => `${f.id} ${p}`));
    expect(declared).toEqual([]);
  });
});
