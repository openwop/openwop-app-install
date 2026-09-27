/**
 * Drift-direction classification for vendored schemas (tooling hardening).
 *
 * `scripts/check-vendored-schemas.mjs` fails on any drift between the app's
 * vendored copy of a load-bearing schema and the canonical corpus. Its remedy
 * line used to say, unconditionally, "Refresh with: bash scripts/sync-schemas.sh"
 * — a command that overwrites vendored WITH canonical.
 *
 * That is DESTRUCTIVE when the app's copy is the newer one. It happened: the app
 * carried RFC 0123's `vendor` field on the connection-pack manifest while the
 * local `../openwop` clone was 32 commits stale and lacked the RFC entirely.
 * Following the guard's own advice would have deleted a field the connection-pack
 * loader validates against at runtime.
 *
 * So the direction is now classified before any remedy is suggested, and the
 * classification is by CONTAINMENT rather than equality — that asymmetry is the
 * whole signal. These cases pin it.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyDrift,
  leafSet,
  suiteCertifiesCorpusTag,
  AHEAD,
  BEHIND,
  DIVERGED,
  UNKNOWN,
} from '../../../scripts/schemaDrift.mjs';

const base = { $id: 'x', type: 'object', properties: { a: { type: 'string' } } };
const j = (o: unknown): string => JSON.stringify(o, null, 2);

describe('classifyDrift', () => {
  it('AHEAD — vendored is a strict superset (the real RFC 0123 case)', () => {
    const vendored = { ...base, properties: { ...base.properties, vendor: { type: 'string' } } };
    expect(classifyDrift(j(vendored), j(base))).toBe(AHEAD);
  });

  it('BEHIND — canonical has a field the app lacks (sync IS the right fix)', () => {
    const canonical = { ...base, properties: { ...base.properties, added: { type: 'number' } } };
    expect(classifyDrift(j(base), j(canonical))).toBe(BEHIND);
  });

  it('DIVERGED — each side has something the other lacks', () => {
    const vendored = { ...base, properties: { a: { type: 'string' }, mine: { type: 'string' } } };
    const canonical = { ...base, properties: { a: { type: 'string' }, theirs: { type: 'string' } } };
    expect(classifyDrift(j(vendored), j(canonical))).toBe(DIVERGED);
  });

  it('a CHANGED leaf value is DIVERGED, not AHEAD — never green-light a destructive sync on a type change', () => {
    // The dangerous near-miss: same key, different value. Both sides have a leaf
    // the other lacks, so containment must NOT report a clean superset.
    const vendored = { ...base, properties: { a: { type: 'number' } } };
    expect(classifyDrift(j(vendored), j(base))).toBe(DIVERGED);
  });

  it('key order and formatting are irrelevant — only leaf facts count', () => {
    const reordered = { properties: { a: { type: 'string' } }, type: 'object', $id: 'x' };
    expect(classifyDrift(JSON.stringify(reordered), j(base))).toBe(UNKNOWN); // semantically equal ⇒ not drift
  });

  it('unparseable input degrades to UNKNOWN, which never suggests sync', () => {
    expect(classifyDrift('{not json', j(base))).toBe(UNKNOWN);
    expect(classifyDrift(j(base), 'nope')).toBe(UNKNOWN);
    // Defensive: non-string input is typed `unknown`, so this is a real call.
    expect(classifyDrift(null, undefined)).toBe(UNKNOWN);
  });

  it('nested additions are detected, not just top-level ones', () => {
    const deep = { a: { b: { c: { d: 1 } } } };
    const deeper = { a: { b: { c: { d: 1, e: 2 } } } };
    expect(classifyDrift(j(deeper), j(deep))).toBe(AHEAD);
    expect(classifyDrift(j(deep), j(deeper))).toBe(BEHIND);
  });
});

describe('leafSet', () => {
  it('flattens to path=value leaves including array indices', () => {
    expect([...leafSet({ a: [1, 2], b: null })].sort()).toEqual(['a.0=1', 'a.1=2', 'b=null']);
  });
});

describe('suiteCertifiesCorpusTag', () => {
  it('accepts a harness-only patch whose artifact stamp names the vendored corpus', () => {
    expect(suiteCertifiesCorpusTag('v2.31.0', '2.31.1', 'v2.31.0')).toBe(true);
  });

  it('rejects a suite artifact stamped for a different corpus', () => {
    expect(suiteCertifiesCorpusTag('v2.31.0', '2.31.1', 'v2.31.1')).toBe(false);
  });

  it('retains exact version matching for legacy unstamped suites', () => {
    expect(suiteCertifiesCorpusTag('openwop-conformance/v1.163.2', '1.163.2')).toBe(true);
    expect(suiteCertifiesCorpusTag('v2.31.0', '2.31.1')).toBe(false);
  });
});
