/**
 * RFC 0129 / ADR 0290 — data-residency admission-control gate (host tier-1 witness).
 *
 * The frozen contract: when the host ADVERTISES residency (flag on) and a
 * `POST /v1/runs` pins a `residency.region`, an advertised region is admitted and an
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

async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token', ...(init.headers ?? {}) } });
  return { status: res.status, body: (await res.json()) as T };
}

describe('RFC 0129 data-residency admission gate (POST /v1/runs)', () => {
  beforeAll(async () => {
    const reg = await jsonFetch('/v1/host/openwop-app/workflows', {
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
    const res = await jsonFetch<{ runId?: string; error?: string }>('/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ workflowId: 'app.residency-admission-test', residency: { region: 'eu' } }),
    });
    expect(res.status).toBe(201);
    expect(res.body.runId).toBeTruthy();
    expect(res.body.error).toBeUndefined();
  });

  it('rejects an UNADVERTISED region — 422 residency_unavailable, NO run created', async () => {
    const res = await jsonFetch<{ runId?: string; error?: string; message?: string; details?: { requestedRegion?: string; availableRegions?: string[] } }>('/v1/runs', {
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
  });

  it('with residency but NO region field, admits normally (nothing pinned)', async () => {
    const res = await jsonFetch<{ runId?: string }>('/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ workflowId: 'app.residency-admission-test', residency: {} }),
    });
    expect(res.status).toBe(201);
    expect(res.body.runId).toBeTruthy();
  });

  it('FLAG OFF — residency is ignored even for an unadvertised region', async () => {
    delete process.env.OPENWOP_DATA_RESIDENCY_ENABLED;
    try {
      const res = await jsonFetch<{ runId?: string; error?: string }>('/v1/runs', {
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
  it('advertises capabilities.dataResidency ONLY when flag on with non-empty regions', async () => {
    const on = await jsonFetch<{ capabilities?: { dataResidency?: { supported?: boolean; regions?: string[] } } }>('/.well-known/openwop');
    expect(on.body.capabilities?.dataResidency).toEqual({ supported: true, regions: ['eu', 'us'] });
  });

  it('OMITS dataResidency entirely when the flag is OFF', async () => {
    delete process.env.OPENWOP_DATA_RESIDENCY_ENABLED;
    try {
      const off = await jsonFetch<{ capabilities?: { dataResidency?: unknown } }>('/.well-known/openwop');
      expect(off.body.capabilities?.dataResidency).toBeUndefined();
    } finally {
      process.env.OPENWOP_DATA_RESIDENCY_ENABLED = 'true';
    }
  });

  it('OMITS dataResidency when enabled but NO regions are pinned (empty advert stays dark)', async () => {
    const prevRegions = process.env.OPENWOP_DATA_RESIDENCY_REGIONS;
    process.env.OPENWOP_DATA_RESIDENCY_REGIONS = '';
    try {
      const empty = await jsonFetch<{ capabilities?: { dataResidency?: unknown } }>('/.well-known/openwop');
      expect(empty.body.capabilities?.dataResidency).toBeUndefined();
    } finally {
      process.env.OPENWOP_DATA_RESIDENCY_REGIONS = prevRegions;
    }
  });
});
