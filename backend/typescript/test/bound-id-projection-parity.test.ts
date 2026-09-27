/**
 * `src/host/boundIdProjection.ts` is a MIRROR of the corpus codec at
 * `@openwop/openwop-conformance` `src/lib/bound-id.ts` (RFC 0184 §A.1). It is a
 * copy rather than an import because the conformance package is a
 * devDependency — the suite that GRADES production must not be a runtime
 * dependency OF production.
 *
 * A mirror nothing pins drifts silently, and this one drifts in the worst
 * possible direction: the projection is how every bound id reaches this host
 * and how every link leaves it, so a one-character divergence strands ids
 * without failing anything that looks related. This file is the pin. It
 * imports the ORACLE and asserts byte equality, so the moment the corpus moves
 * the mirror goes red here rather than in production.
 *
 * Note the asymmetry this deliberately keeps: the corpus copy is the oracle,
 * NOT a second opinion. When these disagree the corpus is right by definition.
 */
import { describe, it, expect } from 'vitest';
import { projectBoundId as oracleProject, unprojectBoundId as oracleUnproject } from '@openwop/openwop-conformance/src/lib/bound-id.js';
import { projectBoundId, unprojectBoundId, BoundIdProjectionError, looksProjected } from '../src/host/boundIdProjection.js';

/**
 * Vectors chosen to exercise each branch, not to look thorough: the separator
 * that motivates the RFC, the `anon:` tenant prefix that already moved this
 * grammar once, the escape marker itself (the injectivity case), multi-byte
 * UTF-8, and already-safe input where the codec must be the identity.
 */
const VECTORS = [
  'default/5979280b-dd70-4b78-8353-9f369f84efce',
  'anon:abc123/run-1',
  'tenant/opaque:fork',
  'a~b',
  'a~3Ab',
  'tenant/ünïcøde-ID',
  'tenant/🙂',
  'already-safe.id_ok-1',
  '',
  '/',
  '~',
];

describe('bound-id projection: parity with the corpus oracle', () => {
  it('encodes byte-for-byte identically to @openwop/openwop-conformance', () => {
    for (const v of VECTORS) {
      expect(projectBoundId(v), `projectBoundId(${JSON.stringify(v)}) must equal the corpus codec`).toBe(oracleProject(v));
    }
  });

  it('decodes identically to the corpus oracle', () => {
    for (const v of VECTORS) {
      const projected = projectBoundId(v);
      expect(unprojectBoundId(projected), `round trip of ${JSON.stringify(v)}`).toBe(oracleUnproject(projected));
    }
  });

  it('round-trips every vector back to the original', () => {
    for (const v of VECTORS) {
      expect(unprojectBoundId(projectBoundId(v)), `round trip of ${JSON.stringify(v)}`).toBe(v);
    }
  });

  it('emits only RFC 3986 unreserved characters — nothing an intermediary may rewrite', () => {
    for (const v of VECTORS) {
      const projected = projectBoundId(v);
      expect(encodeURIComponent(projected), `${JSON.stringify(v)} projects to something still encodable`).toBe(projected);
    }
  });

  it('is NOT idempotent — escaping its own marker is what makes it injective', () => {
    // If this ever becomes idempotent the double-projection 404 leg of
    // `v2-bound-id-path-projection` silently starts passing for the wrong
    // reason: a second application would resolve to the same run.
    const once = projectBoundId('default/abc');
    expect(projectBoundId(once), 'a second projection must differ from the first').not.toBe(once);
    expect(unprojectBoundId(projectBoundId(once)), 'double-projected decodes to the PROJECTED form, not the id').toBe(once);
  });

  it('refuses a `~` that does not introduce two hex digits', () => {
    for (const bad of ['default~2', 'default~', 'default~zz', 'a~2Fb~']) {
      expect(() => unprojectBoundId(bad), `${bad} must throw`).toThrow(BoundIdProjectionError);
    }
  });

  it('refuses a decoded byte sequence that is not valid UTF-8', () => {
    // `~FF` alone is not a legal UTF-8 start byte. A decoder that tolerated it
    // would hand a replacement character to the store as if it were an id.
    expect(() => unprojectBoundId('~FF'), '~FF must throw').toThrow(BoundIdProjectionError);
  });

  it('accepts lower-case hex on input, per RFC 0184 §A.1 "accept lower-case hex"', () => {
    expect(unprojectBoundId('default~2fabc')).toBe('default/abc');
  });

  it('looksProjected gates on the marker only — a percent-encoded segment is NOT projected', () => {
    expect(looksProjected('default~2Fabc')).toBe(true);
    expect(looksProjected('default%2Fabc')).toBe(false);
    expect(looksProjected('plain-id')).toBe(false);
  });
});
