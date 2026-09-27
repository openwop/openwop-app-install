/**
 * RFC 0213 §B / idempotency.md Concurrency — an idempotent REPLAY on the major-2
 * wire answers with the SAME tenant-bound run id as the original.
 *
 * MEASURED 2026-09-24 by suite 2.38.0 `v2-idempotency-in-flight`: two same-key
 * creates came back as `default/4bdc8735-…` and `4bdc8735-…` — one run, two id
 * shapes — so the scenario counted two runs. The replay sent the stored body with
 * `res.send(raw)`, skipping the major-2 `res.json` projection (`protocolVersion.ts`)
 * that tenant-binds run ids; the original went through it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE = '';
const BODY = { workflowId: 'openwop-app.uppercase', inputs: { text: 'replay' } };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => {
      BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      res();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function create(key: string, major: '1' | '2'): Promise<{ status: number; replay: string | null; runId: string }> {
  const path = major === '2' ? '/runs' : '/v1/runs';
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer dev-token',
      'idempotency-key': key,
      ...(major === '2' ? { 'OpenWOP-Version': '2' } : {}),
    },
    body: JSON.stringify(BODY),
  });
  const json = (await res.json()) as { runId?: string };
  return { status: res.status, replay: res.headers.get('openwop-idempotent-replay'), runId: String(json.runId) };
}

describe('idempotent replay keeps the major-2 run-id projection', () => {
  it('under major 2 the replay returns the IDENTICAL tenant-bound runId, flagged as a replay', async () => {
    const key = `replay-v2-${Date.now()}`;
    const first = await create(key, '2');
    expect(first.status, JSON.stringify(first)).toBe(201);
    expect(first.runId, 'identity.md §5: a major-2 run id is tenant-bound').toContain('/');
    const second = await create(key, '2');
    expect(second.replay, 'the second response must be the cached replay').toBe('true');
    expect(second.runId, 'one key, one run — and one id SHAPE').toBe(first.runId);
  });

  it('under major 1 the replay still returns the bare runId (unchanged)', async () => {
    const key = `replay-v1-${Date.now()}`;
    const first = await create(key, '1');
    const second = await create(key, '1');
    expect(second.replay).toBe('true');
    expect(second.runId).toBe(first.runId);
    expect(first.runId).not.toContain('/');
  });
});
