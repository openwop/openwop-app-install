/**
 * ADR 0549 P3 — the advertised LLM cache-key recipe must be the one the host
 * computes.
 *
 * ## Why this file exists
 *
 * `conformance/quarantine.json` excludes `replay-llm-cache-key.test.ts` and
 * `replay-llm-cache-key-portable.test.ts`: both assert the RETIRED v1 recipe,
 * which `spec/v1/replay.md` now documents as the defect, so they fail against a
 * host that computes v2. Quarantining a whole file also drops the assertions in
 * it that were still RIGHT — and one of those was load-bearing:
 *
 *   "hosts advertising version: 4 MUST advertise replayDeterminism.llmCacheKeyRecipe"
 *
 * Dropping a correct assertion to hide a stale one is how a quarantine turns
 * into decoration. So it is re-pinned here, and STRENGTHENED: the conformance
 * scenario only checked that the advertisement is a string. This checks that the
 * advertisement is TRUE.
 *
 * ## The claim being checked
 *
 * RFC 0041 §A: the value `spec-rfc-0041` "claims the canonical recipe"; a vendor
 * recipe must use `x-host-<host>-<recipe-name>` instead. The canonical recipe
 * became RFC 0150 §C v2 when `replay.md` did, so advertising `spec-rfc-0041`
 * while computing anything else is a false wire claim — and it was one, silently,
 * between §C landing and ADR 0549 P3. This is the mechanical guard that stops it
 * recurring: the seam that reports the host's recipe and the constant that
 * advertises it are compared against the SAME function `callAI` uses.
 *
 * TST-DKD-4 (grade-tests wave 72) — CORRECTION. An ADR 0812 P3c-0 edit deleted
 * the advertisement leg, saying `replayDeterminism` "exists only in the retired
 * v1 document (the v2 root carries no such record)". That was false: the v2 root
 * serves it (`routes/discovery.ts` `v2MultiAgentFamily`, executionModel version
 * >= 4), so the property this file is named for went unguarded. The leg is
 * restored against the v2 root. And every expected value is now a LITERAL:
 * importing `SEMANTIC_REQUEST_RECIPE_V2` and recomputing the digest with
 * `semanticRequestDigestV2` made the oracle move with any change to either (w72
 * probes lc-const / lc-advert were vacuous). The digest literal was captured
 * once (2026-10-31) from this PROBE; the golden-vector contract for the recipe
 * itself is `semantic-request-digest-v2.test.ts` (overlap with the "which
 * fields change the key" legs is recorded dedupe-needs-human-ask; both kept).
 * Red when: the advert names another recipe (lc-advert), the seam reports or
 * computes another recipe (lc-seam-recipe, lc-seam-digest, lc-const).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  // The seam is env-gated; a guard that only passes because the surface is off
  // proves nothing about what the host would report.
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  // Phase 4 is what makes `replayDeterminism.llmCacheKeyRecipe` appear at all,
  // and the whole `multiAgent` block is omitted unless the base flag is set
  // too (the ladder is additive). Both are required, or the advertisement leg
  // below has nothing to read — it originally skipped on `version < 4` and
  // passed while asserting nothing, caught by sabotaging the advert to
  // `homegrown-v9` and watching it stay green.
  // CORRECTED (w72): the version is the highest N with EVERY phase 1..N on
  // (`multiAgentExecutionModelVersion`), so phase 2 is required too — with only
  // base + PHASE_4 the host serves version 1 and no `replayDeterminism` at all.
  // (Phase 3 is implied by PHASE_4.)
  process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL = 'true';
  process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_2 = 'true';
  process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_4 = 'true';
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => {
      BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      res();
    });
  });
});

afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  delete process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL;
  delete process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_2;
  delete process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_4;
  await new Promise<void>((res) => server.close(() => res()));
});

/** The probe body both the seam and the local recomputation are given. */
const PROBE = {
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-20240620',
  messages: [
    { role: 'system' as const, content: 'You are a helpful assistant.' },
    { role: 'user' as const, content: 'What is 2+2?' },
  ],
  temperature: 0.7,
};

async function seam(body: Record<string, unknown>): Promise<{ cacheKey: string; recipe: string }> {
  const res = await fetch(`${BASE}/host/openwop-app/test/llm-cache-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token' },
    body: JSON.stringify(body),
  });
  expect(res.status, 'the llm-cache-key seam must answer — a 404 makes every leg below vacuous').toBe(200);
  return (await res.json()) as { cacheKey: string; recipe: string };
}

/** RFC 0150 §C v2 — the canonical recipe since replay.md adopted it. */
const CANONICAL_RECIPE = 'openwop-semantic-request-v2';
/** The v2 digest of PROBE, captured once (2026-10-31) — a literal, so a recipe
 *  change cannot move the expectation with it. */
const PROBE_DIGEST_V2 = 'b8d3304e343970ac53f3cc7cb486b5f2ac91147262c57994abca3f5688fd9f93';

describe('ADR 0549 P3 — the advertised recipe is the recipe the host computes', () => {
  // CORRECTED (w72): the v2 root DOES serve `multiAgent.executionModel.replayDeterminism`
  // (version >= 4, set in beforeAll); the ADR 0812 P3c-0 note that deleted this leg was wrong.
  it('the v2 root advertises spec-rfc-0041, and the seam computes the canonical recipe', async () => {
    const res = await fetch(`${BASE}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2' } });
    expect(res.status).toBe(200);
    const root = (await res.json()) as { multiAgent?: { executionModel?: { version?: number; replayDeterminism?: { llmCacheKeyRecipe?: unknown } } } };
    expect(root.multiAgent?.executionModel?.version).toBeGreaterThanOrEqual(4);
    // RFC 0041 §A: `spec-rfc-0041` claims the CANONICAL recipe — honest only while
    // the host computes RFC 0150 §C v2.
    expect(root.multiAgent?.executionModel?.replayDeterminism?.llmCacheKeyRecipe).toBe('spec-rfc-0041');
    expect((await seam(PROBE)).recipe).toBe(CANONICAL_RECIPE);
  });

  it('the seam reports the CANONICAL recipe, and reports which one', async () => {
    const { cacheKey, recipe } = await seam(PROBE);
    expect(recipe).toBe(CANONICAL_RECIPE);
    // Not a shape check: the exact v2 digest of PROBE. A seam that drifted to
    // any other recipe fails here rather than in a peer's replay months later.
    expect(cacheKey).toBe(PROBE_DIGEST_V2);
  });

  it('the three fields v1 wrongly excluded DO change the seam key', async () => {
    // The precise inversion of the quarantined scenario's assertion, and the
    // reason it is quarantined rather than fixed: v1 required these to be
    // invariant, which returns a response the caller never asked for.
    const base = (await seam(PROBE)).cacheKey;
    for (const extra of [{ maxOutputTokens: 256 }, { stop: ['END'] }, { seed: 7 }]) {
      const got = (await seam({ ...PROBE, ...extra })).cacheKey;
      expect(got, `${Object.keys(extra)[0]} must change the digest`).not.toBe(base);
    }
  });

  it('transport-only fields do NOT change the seam key', async () => {
    // The half of the quarantined scenarios that was always correct, kept.
    const base = (await seam(PROBE)).cacheKey;
    const noisy = await seam({
      ...PROBE,
      requestId: 'req-1',
      traceparent: '00-abc-def-01',
      tenantId: 'tenant-a',
      timeoutMs: 30_000,
      stream: true,
    });
    expect(noisy.cacheKey).toBe(base);
  });
});
