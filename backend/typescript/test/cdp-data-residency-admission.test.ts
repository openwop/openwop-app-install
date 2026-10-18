/**
 * RFC 0129 / ADR 0290 — data-residency admission-control gate (host tier-1 witness).
 *
 * The frozen contract: when the host ADVERTISES residency (flag on) and a
 * `POST /runs` pins a `residency.region`, an advertised region is admitted and an
 * unadvertised region is rejected `residency_unavailable` (422) with NO run created.
 * Flag off ⇒ residency is ignored. The advert appears only when the flag is on AND
 * at least one region is pinned (honest-off).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { assertFlatErrorEnvelope, detailOf, errorCodeOf } from './helpers/errorEnvelope.js';

let server: http.Server;
let BASE: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_DATA_RESIDENCY_ENABLED = 'true';
  process.env.OPENWOP_DATA_RESIDENCY_REGIONS = 'eu,us';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_DATA_RESIDENCY_ENABLED;
  delete process.env.OPENWOP_DATA_RESIDENCY_REGIONS;
  await new Promise<void>((res) => server.close(() => res()));
});

/** ADR 0858 P3 slice 3 — the v2 root, read over the wire (the family is projected at major 2). */
async function v2Root(): Promise<Record<string, unknown>> {
  const r = await fetch(`${BASE}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2' } });
  expect(r.status).toBe(200);
  return (await r.json()) as Record<string, unknown>;
}

async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token', ...(init.headers ?? {}) } });
  return { status: res.status, body: (await res.json()) as T };
}

/** Runs of the test workflow, read back through the protocol list. */
async function runCount(): Promise<number> {
  const r = await jsonFetch<{ runs?: unknown[] }>('/runs?workflowId=app.residency-admission-test&limit=200');
  expect(r.status).toBe(200);
  expect(Array.isArray(r.body.runs)).toBe(true);
  return r.body.runs!.length;
}

describe('RFC 0129 data-residency admission gate (POST /runs)', () => {
  beforeAll(async () => {
    const reg = await jsonFetch('/host/openwop-app/workflows', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: 'app.residency-admission-test',
        nodes: [{ nodeId: 'n', typeId: 'core.flow.noop' }],
        edges: [],
      }),
    });
    expect([200, 201]).toContain(reg.status);
  });

  it('admits an ADVERTISED region — proceeds, no residency rejection', async () => {
    const before = await runCount();
    const res = await jsonFetch<{ runId?: string; error?: string }>('/runs', {
      method: 'POST',
      body: JSON.stringify({ workflowId: 'app.residency-admission-test', residency: { region: 'eu' } }),
    });
    expect(res.status).toBe(201);
    expect(res.body.runId).toBeTruthy();
    expect(res.body.error).toBeUndefined();
    expect(await runCount()).toBe(before + 1); // positive control for the count the reject case reads
  });

  it('rejects an UNADVERTISED region — 422 residency_unavailable, NO run created', async () => {
    const before = await runCount();
    const res = await jsonFetch<{ runId?: string; error?: string; message?: string; details?: { requestedRegion?: string; availableRegions?: string[] } }>('/runs', {
      method: 'POST',
      body: JSON.stringify({ workflowId: 'app.residency-admission-test', residency: { region: 'antarctica' } }),
    });
    expect(res.status).toBe(422);
    // H27 / S22 — CORRECTED. This asserted the "RFC 0129 §3 nested
    // `{ error: { code } }` envelope"; there is no such envelope. The schema is
    // flat, the §3 prose that said otherwise was 2026-06→08 drift, and the
    // `data-residency-admission` witness reads the code through the corpus's
    // `readErrorCode` (flat first).
    assertFlatErrorEnvelope(res.body, 'residency refusal');
    expect(errorCodeOf(res.body)).toBe('residency_unavailable');
    expect(res.body.runId).toBeUndefined();
    expect(detailOf(res.body, 'requestedRegion')).toBe('antarctica');
    expect(detailOf(res.body, 'availableRegions')).toEqual(['eu', 'us']);
    // "NO run created" read from the run store, not inferred from an absent runId.
    expect(await runCount()).toBe(before);
  });

  it('with residency but NO region field, admits normally (nothing pinned)', async () => {
    const res = await jsonFetch<{ runId?: string }>('/runs', {
      method: 'POST',
      body: JSON.stringify({ workflowId: 'app.residency-admission-test', residency: {} }),
    });
    expect(res.status).toBe(201);
    expect(res.body.runId).toBeTruthy();
  });

  it('FLAG OFF — residency is ignored even for an unadvertised region', async () => {
    delete process.env.OPENWOP_DATA_RESIDENCY_ENABLED;
    try {
      const res = await jsonFetch<{ runId?: string; error?: string }>('/runs', {
        method: 'POST',
        body: JSON.stringify({ workflowId: 'app.residency-admission-test', residency: { region: 'antarctica' } }),
      });
      expect(res.status).toBe(201);
      expect(res.body.runId).toBeTruthy();
    } finally {
      process.env.OPENWOP_DATA_RESIDENCY_ENABLED = 'true';
    }
  });
});

describe('RFC 0129 data-residency advert (/.well-known/openwop) — honest-off', () => {
  it('advertises dataResidency ONLY when flag on with non-empty regions', async () => {
    // ADR 0858 P3 slice 3 — the v2 record: presence is the claim (no `supported`),
    // `regions` is the list the admission gate above admits.
    const rec = (await v2Root()).dataResidency;
    expect(rec).toMatchObject({ regions: ['eu', 'us'] });
    expect(rec).not.toHaveProperty('supported');
  });

  it('OMITS dataResidency entirely when the flag is OFF', async () => {
    delete process.env.OPENWOP_DATA_RESIDENCY_ENABLED;
    try {
      expect((await v2Root()).dataResidency).toBeUndefined();
    } finally {
      process.env.OPENWOP_DATA_RESIDENCY_ENABLED = 'true';
    }
  });

  it('OMITS dataResidency when enabled but NO regions are pinned (empty advert stays dark)', async () => {
    const prevRegions = process.env.OPENWOP_DATA_RESIDENCY_REGIONS;
    process.env.OPENWOP_DATA_RESIDENCY_REGIONS = '';
    try {
      expect((await v2Root()).dataResidency).toBeUndefined();
    } finally {
      process.env.OPENWOP_DATA_RESIDENCY_REGIONS = prevRegions;
    }
  });
});
