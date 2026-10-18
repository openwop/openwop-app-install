/**
 * ADR 0812 P4 slice 4 — an idempotency REPLAY of `POST /runs` re-mints its
 * `eventsUrl` / `statusUrl` from the stored `runId` (`remintRunWireUrls`).
 *
 * The projector's legacy run-URL leg was deleted before the ledger TTL ran
 * out: production still held rows written before slice 2b, whose stored links
 * are the major-1 spelling with a bare id, which answers 410 since the cut. A same-key
 * retry of one of those creates must still hand back links that resolve, and
 * the URL's id must be the replayed `runId` (one run, one address).
 *
 * The legacy row is planted through the storage interface the route itself
 * uses (claim + complete), with the exact pre-2b body shape measured in
 * production on 2026-10-17: `{ runId: <bare>, status, statusUrl, eventsUrl }`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { canonicalRequestDigest, idempotencyLeaseMs, RUNS_IDEMPOTENT_ENDPOINT } from '../src/host/idempotentResponse.js';
import { projectBoundId } from '../src/host/boundIdProjection.js';

let app: Express;
let server: http.Server;
let BASE = '';
let storage: Storage;
const TENANT = 'demo';
const BODY = { workflowId: 'openwop-app.uppercase', tenantId: TENANT, inputs: { text: 'remint' } };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
  BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function create(key: string): Promise<{ status: number; replay: string | null; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'idempotency-key': key },
    body: JSON.stringify(BODY),
  });
  return { status: res.status, replay: res.headers.get('openwop-idempotent-replay'), json: (await res.json()) as Record<string, unknown> };
}

/** The links a response's own `runId` addresses: `/runs/<bound id>`, `~2F`-projected. */
function expectLinksAddress(json: Record<string, unknown>): void {
  const runId = String(json['runId']);
  expect(runId).toContain('/'); // tenant-bound on the major-2 wire
  expect(new URL(String(json['statusUrl'])).pathname).toBe(`/runs/${projectBoundId(runId)}`);
  expect(new URL(String(json['eventsUrl'])).pathname).toBe(`/runs/${projectBoundId(runId)}/events`);
}

describe('ADR 0812 P4 slice 4 — a replay re-mints its run links', () => {
  it('a row written BEFORE slice 2b (stored major-1 links, bare id) replays links that address the run', async () => {
    const key = `p44-legacy-${randomUUID()}`;
    const bare = randomUUID();
    const claim = await storage.claimIdempotentResponse({
      tenantId: TENANT, endpoint: RUNS_IDEMPOTENT_ENDPOINT, key,
      requestDigest: canonicalRequestDigest(BODY, RUNS_IDEMPOTENT_ENDPOINT),
      createdAt: new Date().toISOString(), leaseMs: idempotencyLeaseMs(),
    });
    if (claim.outcome !== 'claimed') throw new Error(`plant: expected a fresh claim, got ${claim.outcome}`);
    const committed = await storage.completeIdempotentResponse({
      tenantId: TENANT, endpoint: RUNS_IDEMPOTENT_ENDPOINT, key, claimToken: claim.claimToken,
      responseStatus: 201, runId: bare, updatedAt: new Date().toISOString(),
      // The measured pre-2b body; its major-1 links are the reason this test exists.
      responseBody: JSON.stringify({ runId: bare, status: 'pending', statusUrl: `${BASE}/v1/runs/${bare}`, eventsUrl: `${BASE}/v1/runs/${bare}/events` }),
    });
    expect(committed).toBe(true);

    const r = await create(key);
    expect(r.status).toBe(201);
    expect(r.replay).toBe('true'); // served from the planted row, not a fresh create
    expect(String(r.json['runId'])).toContain(bare);
    expectLinksAddress(r.json);
  });

  it('a row written SINCE slice 2b replays exactly the links the first answer carried', async () => {
    const key = `p44-fresh-${randomUUID()}`;
    const first = await create(key);
    expect(first.status).toBe(201);
    expect(first.replay).toBeNull();
    expectLinksAddress(first.json);

    const again = await create(key);
    expect(again.replay).toBe('true');
    expect(again.json['runId']).toBe(first.json['runId']);
    expect(again.json['statusUrl']).toBe(first.json['statusUrl']);
    expect(again.json['eventsUrl']).toBe(first.json['eventsUrl']);
  });
});
