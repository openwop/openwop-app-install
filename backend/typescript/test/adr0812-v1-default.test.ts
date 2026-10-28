/**
 * ADR 0812 P3c — v1 is GONE, not merely retired by default.
 *
 * P1 made retirement the default and left one opt-back-in
 * (`OPENWOP_V1_RETIRED=false`) for one deprecation window. P3c removed it, with
 * the vitest pin that kept most of this suite on v1 (`test/setup/pinV1Served.ts`)
 * and the three non-vitest boots that pinned it. These legs pin that:
 * - the former opt-in serves nothing: discovery lists only `2.0`, and `/v1`
 *   answers 410 with the variable set to `false`;
 * - nothing re-introduces the pin (setup file, scripts, conformance harness);
 * - decision 2: a major-1 webhook subscription gets nothing, whatever the env.
 * Tracker: TST-BVC-10. The `.github/workflows/ci.yml` leg lives in
 * `test/steward/adr0812-v1-pin-ci-workflow.test.ts` (the adopter bundle strips
 * `.github/`).
 *
 * Red when (wave 60 probes w60g4-v1-*): a major-1 version is advertised; the
 * negotiator reads the env again; a major-1 or legacy subscription is
 * delivered to.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { minClientVersion, preferredVersion, protocolVersionMiddleware, protocolVersions } from '../src/middleware/protocolVersion.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { __deliverToSubscribersForTests } from '../src/routes/webhooks.js';
import type { EventRecord, RunRecord } from '../src/types.js';

const BE = join(__dirname, '..');
const ROOT = join(BE, '..', '..');
const read = (p: string): string => readFileSync(p, 'utf8');
const saved = process.env.OPENWOP_V1_RETIRED;
afterEach(() => {
  if (saved === undefined) delete process.env.OPENWOP_V1_RETIRED; else process.env.OPENWOP_V1_RETIRED = saved;
});

describe('ADR 0812 P3c — the former opt-in serves nothing', () => {
  let server: http.Server;
  let base = '';
  beforeAll(async () => {
    const app = express();
    app.use(protocolVersionMiddleware());
    app.get('/runs', (_req, res) => { res.json({ runs: [] }); });
    server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('OPENWOP_V1_RETIRED=false advertises only 2.0', () => {
    process.env.OPENWOP_V1_RETIRED = 'false';
    expect([...protocolVersions()]).toEqual(['2.0']);
    expect(preferredVersion()).toBe('2.0');
    expect(minClientVersion()).toBe('2.0');
  });

  it('OPENWOP_V1_RETIRED=false: /v1 answers 410 and OpenWOP-Version: 1 answers 406', async () => {
    process.env.OPENWOP_V1_RETIRED = 'false';
    const gone = await fetch(`${base}/v1/runs`, { headers: { accept: 'application/json' } });
    expect(gone.status).toBe(410);
    expect(((await gone.json()) as { error: string }).error).toBe('protocol_version_unsupported');
    const v1Header = await fetch(`${base}/runs`, { headers: { accept: 'application/json', 'openwop-version': '1' } });
    expect(v1Header.status).toBe(406);
    // Control: the same route answers under major 2, so the 410/406 are refusals, not a missing route.
    const ok = await fetch(`${base}/runs`, { headers: { accept: 'application/json', 'openwop-version': '2' } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('openwop-version')).toBe('2.0');
  });

  it('the vitest pin is gone and no boot re-introduces it', () => {
    expect(existsSync(join(BE, 'test', 'setup', 'pinV1Served.ts'))).toBe(false);
    expect(read(join(BE, 'vitest.config.ts'))).not.toMatch(/pinV1Served/);
    // `.github/workflows/ci.yml` is asserted in test/steward/adr0812-ci-workflow-no-v1-pin.test.ts:
    // the white-label bundle strips `.github/`, so reading it here ENOENTs every adopter.
    for (const f of ['scripts/e2e-routes.sh', 'scripts/ci.sh', 'backend/typescript/conformance/run.ts']) {
      expect(read(join(ROOT, f)), f).not.toMatch(/OPENWOP_V1_RETIRED/);
    }
  });

  it('the source no longer reads the variable', () => {
    expect(read(join(BE, 'src', 'middleware', 'protocolVersion.ts'))).not.toMatch(/process\.env\.OPENWOP_V1_RETIRED/);
  });
});

describe('ADR 0812 decision 2 — this host emits no v1 webhook body', () => {
  const TENANT = 'acme-0812';
  const RUN_ID = '0812aaaa-2222-4333-8444-555555555555';
  let storage: Storage;

  beforeAll(async () => {
    storage = await openStorage('memory://');
    const run: RunRecord = {
      runId: RUN_ID, workflowId: 'wf-noop', status: 'completed', tenantId: TENANT, inputs: {}, metadata: {}, configurable: {},
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await storage.insertRun(run);
    for (const [id, major] of [['sub-0812-v1', 1], ['sub-0812-legacy', undefined], ['sub-0812-v2', 2]] as const) {
      await storage.insertWebhook({
        subscriptionId: id, tenantId: TENANT, url: `https://example.test/${id}`, events: ['run.completed'],
        secret: 's3cret', createdAt: new Date().toISOString(), ...(major ? { protocolMajor: major } : {}),
      });
    }
  });

  async function deliveredTo(seq: number): Promise<string[]> {
    const event: EventRecord = { type: 'run.completed', runId: RUN_ID, eventId: `e${seq}`, sequence: seq, payload: {}, timestamp: new Date().toISOString() };
    await __deliverToSubscribersForTests(storage, event);
    const rows = await storage.claimDueWebhookDeliveries(`w${seq}`, Date.now(), 60_000, 50);
    return rows.filter((r) => r.subscriptionId.startsWith('sub-0812-')).map((r) => r.subscriptionId).sort();
  }

  it('the major-1 and the legacy (absent ⇒ 1) subscriptions get nothing; major 2 still does', async () => {
    expect(await deliveredTo(1)).toEqual(['sub-0812-v2']);
  });

  it('the former opt-in does not revive delivery to them', async () => {
    process.env.OPENWOP_V1_RETIRED = 'false';
    expect(await deliveredTo(2)).toEqual(['sub-0812-v2']);
  });
});
