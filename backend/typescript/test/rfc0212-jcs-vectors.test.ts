/**
 * openwop RFC 0212 §A–§C — both certification-bundle verifiers (the TS host
 * verifier `src/host/certificationEvidence.ts` and its plain-ESM deploy twin
 * `scripts/lib/bundle-v3-verify.mjs`) canonicalize with RFC 8785 JCS over I-JSON
 * and REFUSE rather than coerce.
 *
 * Fixtures (`fixtures/rfc0212/`), copied so this runs with no sibling checkout:
 *   - `jcs-v1.json` — the normative vectors, openwop `conformance/vectors/jcs-v1.json`
 *     at openwop@752d46d5 (RFC 0212 Active).
 *   - `evidence-*.json` — the three committed v3 host bundles, openwop
 *     `evidence/v2-host-bundles/` at the same commit.
 *   - `served-ea9cd39ee-major2.json` + `served-signing-keys.json` — the bundle this
 *     host actually serves from GCS for ea9cd39ee, and the signingKeys its live
 *     discovery published (2026-09-24). `publish-evidence.sh` gates every upload
 *     on `bundle-v3-verify.mjs`, so a false refusal here would block publishing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as ts from '../src/host/certificationEvidence.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const FIX = join(import.meta.dirname, 'fixtures', 'rfc0212');
const read = (f: string): string => readFileSync(join(FIX, f), 'utf8');

type Verdict = { ok: true; keyId: string } | { ok: false; reason: string; detail: string };
interface MjsModule {
  canonicalJSON(v: unknown): string;
  parseIJson(t: string): unknown;
  witnessDigest(rows: unknown[], relaxations?: unknown[]): string;
  verifyServedBundle(doc: unknown, e: unknown): Verdict;
  verifyServedBundleText(text: string, e: unknown): Verdict;
}
const mjs = (await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'bundle-v3-verify.mjs')).href)) as MjsModule;

interface Vectors {
  numbers: { ieee754: string; canonical: string }[];
  numberRefusals: { ieee754: string; refuse: string }[];
  objects: { id: string; input: string; canonical: string }[];
  refusals: { id: string; input: string; refuse: string }[];
  ordering: { ids: string[]; codeUnit: string[] };
}
const V = JSON.parse(read('jcs-v1.json')) as Vectors;
const fromBits = (hex: string): number => Buffer.from(hex, 'hex').readDoubleBE(0);

const IMPLS = [
  { name: 'ts', canonicalJSON: ts.canonicalJSON, parseIJson: ts.parseIJson },
  { name: 'mjs', canonicalJSON: mjs.canonicalJSON, parseIJson: mjs.parseIJson },
] as const;

describe.each(IMPLS)('RFC 0212 §A/§B vectors — $name', (impl) => {
  it('every object vector reproduces its canonical bytes', () => {
    expect(V.objects.length).toBeGreaterThan(5);
    for (const o of V.objects) expect(impl.canonicalJSON(impl.parseIJson(o.input)), o.id).toBe(o.canonical);
  });
  it('every number vector serializes per RFC 8785 Appendix B', () => {
    expect(V.numbers.length).toBeGreaterThan(20);
    for (const n of V.numbers) expect(impl.canonicalJSON(fromBits(n.ieee754)), n.ieee754).toBe(n.canonical);
  });
  it('every text refusal vector is refused — never coerced', () => {
    expect(V.refusals.length).toBeGreaterThan(5);
    for (const r of V.refusals) {
      expect(() => impl.canonicalJSON(impl.parseIJson(r.input)), r.id).toThrow(/RFC 0212 §B refusal/);
    }
  });
  it('every non-finite number vector is refused at the value boundary', () => {
    expect(V.numberRefusals.length).toBeGreaterThan(0);
    for (const r of V.numberRefusals) expect(() => impl.canonicalJSON(fromBits(r.ieee754)), r.ieee754).toThrow(/non-finite/);
  });
  it('member order is UTF-16 code units, never a collation', () => {
    const obj = Object.fromEntries(V.ordering.ids.map((id) => [id, 0]));
    const keys = Object.keys(JSON.parse(impl.canonicalJSON(obj)) as Record<string, unknown>);
    expect(keys).toEqual(V.ordering.codeUnit);
  });
});

describe('RFC 0212 §C — witness digest and full verification', () => {
  const evidence = ['myndhyve', 'openwop-host-v2-reference', 'openwop-workflow-engine'];

  it.each(evidence)('committed openwop bundle %s re-derives its witnessSha256 in both verifiers', (name) => {
    const b = ts.parseIJson(read(`evidence-${name}.json`)) as {
      witnessSha256: string;
      results: { requirements: Parameters<typeof ts.witnessDigest>[0] };
      host?: { relaxations?: unknown[] };
    };
    const rel = Array.isArray(b.host?.relaxations) ? b.host?.relaxations : undefined;
    expect(ts.witnessDigest(b.results.requirements, rel)).toBe(b.witnessSha256);
    expect(mjs.witnessDigest(b.results.requirements as unknown[], rel)).toBe(b.witnessSha256);
  });

  it('the bundle this host serves for ea9cd39ee verifies end to end in both verifiers — no false refusal', () => {
    const keys = (JSON.parse(read('served-signing-keys.json')) as { signingKeys: Record<string, unknown>[] }).signingKeys;
    const expect_ = { commit: 'ea9cd39eee5b6e214d52221c693d3f1005f666b4', major: 2 as const, signingKeys: keys };
    const text = read('served-ea9cd39ee-major2.json');
    expect(mjs.verifyServedBundleText(text, expect_)).toEqual({ ok: true, keyId: 'openwop-app-bundle-2' });
    expect(ts.verifyServedBundle(ts.parseIJson(text), expect_)).toEqual({ ok: true, keyId: 'openwop-app-bundle-2' });
  });

  it('a served bundle carrying a duplicate member name is refused as non-ijson, not verified', () => {
    const keys = (JSON.parse(read('served-signing-keys.json')) as { signingKeys: Record<string, unknown>[] }).signingKeys;
    const expect_ = { commit: 'ea9cd39eee5b6e214d52221c693d3f1005f666b4', major: 2 as const, signingKeys: keys };
    const tampered = read('served-ea9cd39ee-major2.json').replace('{', '{"bundleVersion":"3",');
    const v = mjs.verifyServedBundleText(tampered, expect_);
    expect(v.ok).toBe(false);
    expect(v.ok ? '' : v.reason).toBe('non-ijson');
    expect(() => ts.parseIJson(tampered)).toThrow(/duplicate-name/);
  });

  it('a non-finite value inside a row is a structured non-ijson rejection in both verifiers, never a throw', () => {
    const keys = (JSON.parse(read('served-signing-keys.json')) as { signingKeys: Record<string, unknown>[] }).signingKeys;
    const expect_ = { commit: 'ea9cd39eee5b6e214d52221c693d3f1005f666b4', major: 2 as const, signingKeys: keys };
    const doc = JSON.parse(read('served-ea9cd39ee-major2.json')) as { results: { requirements: Record<string, unknown>[] } };
    const first = doc.results.requirements[0];
    if (first === undefined) throw new Error('fixture has no rows');
    first['evidence'] = { n: Number.NaN };
    for (const verdict of [mjs.verifyServedBundle(doc, expect_), ts.verifyServedBundle(doc, expect_)]) {
      expect(verdict.ok).toBe(false);
      expect(verdict.ok ? '' : verdict.reason).toBe('non-ijson');
    }
  });

  it('non-empty relaxations join the preimage as {rows, relaxations}; empty ones do not (ADR 0744 residual)', () => {
    const rows = [{ id: 'openwop.x.b', scenario: 's', result: 'executed-pass' as const }, { id: 'openwop.x.a', scenario: 's', result: 'skipped' as const }];
    const relax = [{ id: 'r1', reason: 'operator relaxation' }];
    const bare = ts.witnessDigest(rows);
    expect(ts.witnessDigest(rows, [])).toBe(bare);
    const relaxed = ts.witnessDigest(rows, relax);
    expect(relaxed).not.toBe(bare);
    expect(mjs.witnessDigest(rows, relax)).toBe(relaxed);
    expect(mjs.witnessDigest(rows, [])).toBe(bare);
  });
});
