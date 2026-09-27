/**
 * ADR 0549 P3 — RFC 0150 §C golden vectors for the semantic request digest v2.
 *
 * The vectors are the contract, not this file's prose. §C's acceptance criterion
 * is that TypeScript, Python and Go compute the same digest for the same
 * request; three independent readings of "canonicalize via JCS and hash" is
 * precisely how three implementations disagree, and the disagreement is
 * invisible until two hosts replay the same run and get different cache keys.
 *
 * The vectors are loaded from the PINNED `@openwop/openwop-conformance`
 * package rather than copied into `test/fixtures/`. That matters: a copied
 * fixture pins this host to a snapshot of the contract and goes green forever
 * after the corpus moves, which is the failure mode the file would exist to
 * prevent. Reading the pinned package means a suite bump that changes a vector
 * turns this red.
 *
 * Several vectors are PAIRS, and the relationship between the members is the
 * actual requirement:
 *   - tools sorted vs reversed  → MUST be equal (tool order is not semantic)
 *   - message order reversed    → MUST differ  (message order IS semantic)
 *   - two Unicode forms of "é"  → MUST differ  (JCS does not apply NFC)
 *
 * That last pair is the one that earns its keep. An implementer who adds NFC
 * "to be safe" makes those two collide while every other vector still passes —
 * so a suite checking only individual digests would go green on an
 * implementation that had silently broken cross-host agreement.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import {
  semanticRequestDigestV2,
  projectSemanticRequestV2,
  canonicalize,
  SEMANTIC_REQUEST_RECIPE_V2,
  type SemanticRequestV2Input,
} from '../src/providers/llmCacheKey.js';

interface Vector {
  readonly id: string;
  readonly why: string;
  readonly input: Record<string, unknown>;
  readonly canonical: string;
  readonly digest: string;
}

const require = createRequire(import.meta.url);
const VECTORS_PATH = resolve(
  dirname(require.resolve('@openwop/openwop-conformance/package.json')),
  'vectors',
  'semantic-request-digest-v2.json',
);

const doc = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as {
  recipe: string;
  vectors: readonly Vector[];
};
const byId = new Map(doc.vectors.map((v) => [v.id, v]));

/** The vector `input` is untyped JSON; the recipe input is a closed shape. */
function asInput(raw: Record<string, unknown>): SemanticRequestV2Input {
  return raw as unknown as SemanticRequestV2Input;
}

describe('RFC 0150 §C — semantic request digest v2 golden vectors', () => {
  it('the vector file loaded, and pins the recipe this host implements', () => {
    // Guard: an empty or renamed vector file makes every leg below vacuous —
    // `for (const v of [])` passes, loudly reporting nothing.
    // 11 → 13 at suite 2.38.0: `tools-code-unit-order` + `-reversed` (RFC 0212
    // UTF-16 code-unit ordering applied to the tool sort). Both passed on this
    // host unchanged — only this count was stale.
    expect(doc.vectors.length, 'the pinned conformance package MUST ship the vectors').toBe(13);
    expect(doc.recipe).toBe(SEMANTIC_REQUEST_RECIPE_V2);
  });

  for (const vector of doc.vectors) {
    it(`${vector.id}: ${vector.why}`, () => {
      const input = asInput(vector.input);
      // The canonical preimage is asserted alongside the digest so a failure
      // shows WHICH byte diverged instead of two opaque hashes.
      expect(canonicalize(projectSemanticRequestV2(input))).toBe(vector.canonical);
      expect(semanticRequestDigestV2(input)).toBe(vector.digest);
    });
  }

  it('tool order is not semantic — sorted and reversed inputs agree', () => {
    const a = byId.get('tools-sorted-by-name');
    const b = byId.get('tools-reversed-same-digest');
    expect(a && b).toBeTruthy();
    expect(semanticRequestDigestV2(asInput(a!.input))).toBe(semanticRequestDigestV2(asInput(b!.input)));
  });

  it('tools sort by UTF-16 code unit — the code-unit pair agrees (RFC 0212, suite 2.38.0)', () => {
    const a = byId.get('tools-code-unit-order');
    const b = byId.get('tools-code-unit-order-reversed');
    expect(a && b).toBeTruthy();
    expect(semanticRequestDigestV2(asInput(a!.input))).toBe(semanticRequestDigestV2(asInput(b!.input)));
  });

  it('message order IS semantic — a reordered conversation digests differently', () => {
    const a = byId.get('message-order-is-semantic');
    const b = byId.get('message-order-reversed');
    expect(a && b).toBeTruthy();
    expect(semanticRequestDigestV2(asInput(a!.input))).not.toBe(semanticRequestDigestV2(asInput(b!.input)));
  });

  it('JCS applies no NFC — the decomposed and composed forms of "é" MUST differ', () => {
    const decomposed = byId.get('non-ascii-not-normalized');
    const composed = byId.get('non-ascii-composed');
    expect(decomposed && composed).toBeTruthy();
    // Guard the guard: if the two vectors carried the same bytes the assertion
    // below would be testing nothing.
    expect(JSON.stringify(decomposed!.input)).not.toBe(JSON.stringify(composed!.input));
    expect(semanticRequestDigestV2(asInput(decomposed!.input))).not.toBe(
      semanticRequestDigestV2(asInput(composed!.input)),
    );
  });

  it('the three fields v1 excluded each change the digest', () => {
    const base = byId.get('minimal')!;
    for (const id of ['stop-changes-digest', 'seed-changes-digest', 'max-output-changes-digest']) {
      expect(semanticRequestDigestV2(asInput(byId.get(id)!.input)), id).not.toBe(base.digest);
    }
  });

  it('an unknown provider option is carried into the digest, never dropped', () => {
    const base = byId.get('minimal')!;
    const carried = byId.get('provider-options-carried')!;
    expect(semanticRequestDigestV2(asInput(carried.input))).not.toBe(base.digest);
    // And the option's VALUE participates — carrying the key while ignoring the
    // value would still be a wrong hit.
    const other = semanticRequestDigestV2({
      ...asInput(carried.input),
      providerOptions: { 'vendor.anthropic.reasoningEffort': 'low' },
    });
    expect(other).not.toBe(carried.digest);
  });

  it('transport-only fields do not reach the digest', () => {
    const base = byId.get('minimal')!;
    const withNoise = {
      ...(base.input as Record<string, unknown>),
      timeoutMs: 30_000,
      traceId: 'trace-abc',
      requestId: 'req-1',
      attempt: 3,
      credentialRef: 'byok:tenant-a:anthropic',
      tenantId: 'tenant-a',
      runId: 'run-1',
    };
    expect(semanticRequestDigestV2(asInput(withNoise))).toBe(base.digest);
  });
});
