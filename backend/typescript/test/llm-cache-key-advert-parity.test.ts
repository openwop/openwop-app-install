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
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import {
  semanticRequestDigestV2,
  SEMANTIC_REQUEST_RECIPE_V2,
} from '../src/providers/llmCacheKey.js';

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
  process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL = 'true';
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
  const res = await fetch(`${BASE}/v1/host/openwop-app/test/llm-cache-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token' },
    body: JSON.stringify(body),
  });
  expect(res.status, 'the llm-cache-key seam must answer — a 404 makes every leg below vacuous').toBe(200);
  return (await res.json()) as { cacheKey: string; recipe: string };
}

describe('ADR 0549 P3 — the advertised recipe is the recipe the host computes', () => {
  it('discovery advertises a recipe at all (RFC 0041 §D)', async () => {
    const res = await fetch(`${BASE}/.well-known/openwop`);
    const caps = (await res.json()) as Record<string, unknown>;
    const em = (caps.multiAgent as { executionModel?: Record<string, unknown> } | undefined)?.executionModel;
    // Vacuity guard: `beforeAll` turns Phase 4 on, so a boot that does not
    // reach version 4 means the advert moved and this leg is testing nothing.
    expect(em?.version, 'Phase 4 must be advertised, or this assertion is vacuous').toBeGreaterThanOrEqual(4);
    const rd = em?.replayDeterminism as { llmCacheKeyRecipe?: unknown } | undefined;
    expect(typeof rd?.llmCacheKeyRecipe).toBe('string');
    // `spec-rfc-0041` means "the canonical recipe". A host computing its own
    // must say so in the host-extension namespace instead.
    expect(
      rd!.llmCacheKeyRecipe === 'spec-rfc-0041' || String(rd!.llmCacheKeyRecipe).startsWith('x-host-'),
      'llmCacheKeyRecipe must be `spec-rfc-0041` or `x-host-<host>-<recipe>` (RFC 0041 §A)',
    ).toBe(true);
  });

  it('the seam reports the CANONICAL recipe, and reports which one', async () => {
    const { cacheKey, recipe } = await seam(PROBE);
    expect(recipe).toBe(SEMANTIC_REQUEST_RECIPE_V2);
    // Not a shape check: the exact digest, recomputed through the same function
    // `callAI` uses. A seam that drifted to any other recipe fails here rather
    // than in a peer's replay six months from now.
    expect(cacheKey).toBe(semanticRequestDigestV2(PROBE));
    expect(cacheKey).toMatch(/^[0-9a-f]{64}$/);
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
