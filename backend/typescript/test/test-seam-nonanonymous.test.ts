/**
 * `host-sample-test-seams.md` §"Production safety" — an ENABLED test seam must
 * refuse a credential-less caller, and two controls reading one switch are not
 * two layers.
 *
 * BOTH clauses exist because of a defect on THIS host, measured 2026-08-15
 * against the live deployment:
 *
 *   GET …/test/mock-ai/last-dispatch-budget?nodeId=probe  ->  200 {"maxTokens":null}
 *
 * with no credentials. `authMiddleware` runs on the seam prefix and the prefix
 * is NOT public — auth simply SUCCEEDS anonymously (`mintAnonSession`, ADR
 * 0015). So "the seam applies the canonical surface's authentication" was true
 * and bought nothing, which is why the normative clause binds a
 * *non-anonymous* principal rather than parity with the canonical surface.
 *
 * WHAT THIS SUITE ASSERTS, AND WHY IT IS SHAPED THIS WAY. It probes over real
 * HTTP and asserts the OBSERVABLE answer — never a 200 to a credential-less
 * caller. It deliberately does NOT assert "the route has a guard": that is a
 * proxy for the property, and the proxy already failed once here in the
 * reassuring direction. A guard can be present and bypassed; a 200 cannot be
 * argued with.
 */
import { describe, expect, it, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { mockProviderEnabled } from '../src/aiProviders/aiProvidersHost.js';

const servers: Server[] = [];
afterAll(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
});

async function bootWithSeam(): Promise<string> {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((r) => server.once('listening', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Every seam path a credential-less caller might reach, in BOTH spellings —
 *  the `/v1/host/sample` legacy alias rewrites onto the same handlers, so
 *  guarding only the product spelling would leave an open door beside a shut
 *  one. That is the failure mode this list exists to make impossible. */
const SEAM_PATHS = [
  '/v1/host/openwop-app/test/mock-ai/last-dispatch-budget?nodeId=probe',
  '/v1/host/sample/test/mock-ai/last-dispatch-budget?nodeId=probe',
];

describe('an enabled test seam refuses anonymous callers', () => {
  it('no seam path answers 200 without credentials — in either spelling', async () => {
    const base = await bootWithSeam();
    const answers: Array<{ path: string; status: number }> = [];
    for (const p of SEAM_PATHS) {
      const res = await fetch(`${base}${p}`);
      answers.push({ path: p, status: res.status });
    }
    // Non-zero-probe guard: if the list is ever emptied or the loop skipped,
    // "no 200s" would be true because nothing was asked.
    expect(answers.length).toBe(SEAM_PATHS.length);
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.filter((a) => a.status === 200)).toEqual([]);
  });

  it('the staging route — the one that can bend a replay — refuses too', async () => {
    // `POST …/mock-ai/program` stages a deliberate RFC 0041 §B divergence keyed
    // by `nodeId`, and node ids are published in the chain packs. This is the
    // call that made the open seam a determinism hole rather than an info leak.
    const base = await bootWithSeam();
    const res = await fetch(`${base}/v1/host/openwop-app/test/mock-ai/program`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'probe-node', program: [{ content: 'staged' }] }),
    });
    expect(res.status).not.toBe(200);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { details?: { reason?: string } };
    expect(body.details?.reason).toBe('anonymous_principal_refused');
  });

  it('an authenticated caller still reaches the seam — the gate is not a wall', async () => {
    // The refusal must be about the PRINCIPAL, not about the seam being shut.
    // Without this, "no 200s" would also pass on a host that had simply broken
    // the seam, and the conformance harness would be locked out.
    const base = await bootWithSeam();
    const res = await fetch(`${base}/v1/host/openwop-app/test/mock-ai/last-dispatch-budget?nodeId=probe`, {
      headers: { authorization: 'Bearer dev-token' },
    });
    expect(res.status).toBe(200);
  });
});

describe('two controls reading one switch are not two layers', () => {
  const seam = process.env.OPENWOP_TEST_SEAM_ENABLED;
  const mock = process.env.OPENWOP_MOCK_PROVIDER_ENABLED;
  const restore = (): void => {
    if (seam === undefined) delete process.env.OPENWOP_TEST_SEAM_ENABLED; else process.env.OPENWOP_TEST_SEAM_ENABLED = seam;
    if (mock === undefined) delete process.env.OPENWOP_MOCK_PROVIDER_ENABLED; else process.env.OPENWOP_MOCK_PROVIDER_ENABLED = mock;
  };

  it('the mock provider can be refused while the seam stays enabled', () => {
    // The property the clause demands: the two controls must be able to
    // DISAGREE. Before this, five call sites read `OPENWOP_TEST_SEAM_ENABLED`
    // under a comment claiming "defense-in-depth" — one switch, so the second
    // control could never catch a failure of the first.
    try {
      process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
      process.env.OPENWOP_MOCK_PROVIDER_ENABLED = 'false';
      expect(mockProviderEnabled()).toBe(false);

      process.env.OPENWOP_MOCK_PROVIDER_ENABLED = 'true';
      expect(mockProviderEnabled()).toBe(true);
    } finally {
      restore();
    }
  });

  it('unset defaults to the seam flag, so an existing posture is unchanged', () => {
    try {
      delete process.env.OPENWOP_MOCK_PROVIDER_ENABLED;
      process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
      expect(mockProviderEnabled()).toBe(true);
      delete process.env.OPENWOP_TEST_SEAM_ENABLED;
      expect(mockProviderEnabled()).toBe(false);
    } finally {
      restore();
    }
  });

  it('TRIPWIRE — the mock dispatch sites no longer read the seam flag directly', async () => {
    // The independence above is only real while the call sites go through
    // `mockProviderEnabled()`. A future edit re-inlining
    // `process.env.OPENWOP_TEST_SEAM_ENABLED` beside `provider === 'mock'`
    // silently recouples them, and both tests above would still pass.
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'aiProviders', 'aiProvidersHost.ts'), 'utf8');
    const recoupled = src.match(/provider === 'mock' && process\.env\.OPENWOP_TEST_SEAM_ENABLED/g) ?? [];
    expect(recoupled).toEqual([]);
    // Vacuity guard: the file must still contain the mock gate at all.
    expect(src).toContain("provider === 'mock' && mockProviderEnabled()");
  });
});
