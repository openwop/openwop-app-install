/**
 * RFC 0076 §B / §host.http hardening + advertisement (task: advertise the
 * implemented-but-unadvertised httpClient/safeFetch + OIDC capabilities).
 *
 * Proves, against the REAL app boot:
 *   1. `/.well-known/openwop` advertises `capabilities.httpClient` whose
 *      numbers ARE the enforced constants (advertise/enforce agreement), and
 *      `auth.oidc` + the `openwop-auth-oidc-user-bearer` profile appear ONLY
 *      when OPENWOP_OIDC_* is configured (honest-off).
 *   2. `ctx.http.safeFetch` refuses `Connection: upgrade`, blocks SSRF
 *      targets, and emits the DURABLE content-free
 *      `agent.toolCalled`/`agent.toolReturned` pair (`transport: "http"`) on
 *      every invocation — ok, forbidden, and error paths.
 *   3. The guarded-agent response-body ceiling mechanism actually aborts a
 *      response larger than the cap (mechanism proven with a small cap; the
 *      production cap is the advertised constant by construction).
 *   4. The conformance seams (`/http/safe-fetch`, `/http/safe-fetch-run`)
 *      echo the guard decisions and back the durable event-log query.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetch as undiciFetch } from 'undici';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import {
  makeConnectionSafeFetch,
  SAFE_FETCH_MAX_RESPONSE_BODY_BYTES,
  SAFE_FETCH_REQUEST_TIMEOUT_MS,
} from '../src/host/connectionInjection.js';
import { makeGuardedAgent } from '../src/host/webhookEgressGuard.js';

let server: http.Server;
let BASE = '';
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true'; // seams register at boot
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE; // guard ACTIVE by default
  delete process.env.OPENWOP_OIDC_ISSUER;
  delete process.env.OPENWOP_OIDC_AUDIENCE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => {
      BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      res();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  delete process.env.OPENWOP_OIDC_ISSUER;
  delete process.env.OPENWOP_OIDC_AUDIENCE;
});

interface Disco {
  capabilities?: {
    httpClient?: {
      supported?: boolean;
      ssrfGuard?: boolean;
      maxResponseBodyBytes?: number;
      requestTimeoutMs?: number;
      methods?: string[];
      safeFetch?: { supported?: boolean };
      egressPolicy?: unknown;
    };
    auth?: { profiles?: string[]; oidc?: { supported?: boolean; issuers?: string[]; audience?: string } };
  };
}

const disco = async (): Promise<Disco> => (await (await fetch(`${BASE}/.well-known/openwop`)).json()) as Disco;

describe('discovery advertisement (advertise/enforce agreement + honest-off OIDC)', () => {
  it('advertises httpClient with the ENFORCED constants and no egressPolicy sub-block', async () => {
    const hc = (await disco()).capabilities?.httpClient;
    expect(hc?.supported).toBe(true);
    expect(hc?.ssrfGuard).toBe(true);
    // The advertised numbers ARE the constants the dispatcher enforces —
    // sabotage check: hard-coding either side breaks this pairing.
    expect(hc?.maxResponseBodyBytes).toBe(SAFE_FETCH_MAX_RESPONSE_BODY_BYTES);
    expect(hc?.requestTimeoutMs).toBe(SAFE_FETCH_REQUEST_TIMEOUT_MS);
    expect(hc?.safeFetch?.supported).toBe(true);
    expect(Array.isArray(hc?.methods) && hc.methods.includes('GET') && hc.methods.includes('POST')).toBe(true);
    // RFC 0079 egressPolicy is deliberately NOT claimed (no egress.decided emission).
    expect(hc?.egressPolicy).toBeUndefined();
  });

  it('OIDC is honest-off: no profile / no oidc block without env, both with env', async () => {
    const before = (await disco()).capabilities?.auth;
    expect(before?.profiles ?? []).not.toContain('openwop-auth-oidc-user-bearer');
    expect(before?.oidc).toBeUndefined();

    process.env.OPENWOP_OIDC_ISSUER = 'https://issuer.example.test';
    process.env.OPENWOP_OIDC_AUDIENCE = 'aud-test';
    try {
      const after = (await disco()).capabilities?.auth;
      expect(after?.profiles).toContain('openwop-auth-oidc-user-bearer');
      expect(after?.oidc?.supported).toBe(true);
      expect(after?.oidc?.issuers).toEqual(['https://issuer.example.test']);
      expect(after?.oidc?.audience).toBe('aud-test');
    } finally {
      delete process.env.OPENWOP_OIDC_ISSUER;
      delete process.env.OPENWOP_OIDC_AUDIENCE;
    }
  });
});

/** Read the durable audit pair for a run straight from storage. */
async function durablePair(runId: string): Promise<{ called: Array<Record<string, unknown>>; returned: Array<Record<string, unknown>> }> {
  const events = await storage.listEvents(runId);
  const called = events.filter((e) => e.type === 'agent.toolCalled').map((e) => e.payload as Record<string, unknown>);
  const returned = events.filter((e) => e.type === 'agent.toolReturned').map((e) => e.payload as Record<string, unknown>);
  return { called, returned };
}

describe('ctx.http.safeFetch hardening + durable audit pair', () => {
  const sf = (runId: string) => makeConnectionSafeFetch({ storage, tenantId: 't-sf', runId, allowedProviders: [] });

  it('refuses Connection: upgrade and emits a callId-paired forbidden audit', async () => {
    const runId = 'run-sf-upgrade';
    await expect(sf(runId)('https://example.com/', { headers: { Connection: 'keep-alive, Upgrade' } }))
      .rejects.toThrow(/upgrade refused/);
    const { called, returned } = await durablePair(runId);
    expect(called).toHaveLength(1);
    expect(called[0]!.transport).toBe('http');
    expect(typeof called[0]!.callId).toBe('string');
    expect(returned).toHaveLength(1);
    expect(returned[0]!.callId).toBe(called[0]!.callId);
    expect(returned[0]!.status).toBe('forbidden');
    // Content-free: neither half may carry the destination or headers.
    for (const p of [...called, ...returned]) {
      expect(JSON.stringify(p)).not.toContain('example.com');
    }
  });

  it('blocks a cloud-metadata SSRF target and emits the forbidden pair', async () => {
    const runId = 'run-sf-ssrf';
    await expect(sf(runId)('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/destination blocked/);
    const { called, returned } = await durablePair(runId);
    expect(called).toHaveLength(1);
    expect(returned[0]!.status).toBe('forbidden');
    expect(returned[0]!.callId).toBe(called[0]!.callId);
  });

  it('emits the ok pair on a successful fetch (private egress enabled for loopback)', async () => {
    const runId = 'run-sf-ok';
    const echo = http.createServer((_q, s) => { s.writeHead(200); s.end('ok'); });
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
    const port = (echo.address() as AddressInfo).port;
    process.env.OPENWOP_SAFEFETCH_ALLOW_PRIVATE = 'true'; // safeFetch's OWN flag, not the webhook one
    try {
      const res = await sf(runId)(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      await res.body?.cancel();
    } finally {
      delete process.env.OPENWOP_SAFEFETCH_ALLOW_PRIVATE;
      await new Promise<void>((r) => echo.close(() => r()));
    }
    const { called, returned } = await durablePair(runId);
    expect(called).toHaveLength(1);
    expect(returned[0]!.status).toBe('ok');
    expect(returned[0]!.callId).toBe(called[0]!.callId);
  });

  it('guarded-agent response-body ceiling aborts an oversized body (mechanism)', async () => {
    const big = http.createServer((_q, s) => {
      s.writeHead(200, { 'content-type': 'application/octet-stream' });
      s.end(Buffer.alloc(64 * 1024)); // 64 KiB body
    });
    await new Promise<void>((r) => big.listen(0, '127.0.0.1', r));
    const port = (big.address() as AddressInfo).port;
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const capped = makeGuardedAgent({ maxResponseSize: 1024 }); // 1 KiB cap
    try {
      await expect((async () => {
        const res = await undiciFetch(`http://127.0.0.1:${port}/`, { dispatcher: capped });
        await res.arrayBuffer(); // draining past the cap must reject
      })()).rejects.toThrow();
    } finally {
      delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
      await capped.close();
      await new Promise<void>((r) => big.close(() => r()));
    }
  });
});

/** The test seam requires a non-anonymous principal (`host-sample-test-seams.md`
 *  §"Production safety" — an enabled seam MUST NOT accept an identity the host
 *  minted because no credential was presented). These helpers used to call the
 *  `/v1/host/sample/*` seam with no credentials at all and got 200s, which was
 *  the defect, not the baseline. The real conformance harness already sends a
 *  Bearer key (`conformance/run.ts`), so this only aligns the local suite. */
const SEAM_AUTH = { authorization: 'Bearer dev-token' } as const;

describe('conformance seams (/http/safe-fetch + /http/safe-fetch-run)', () => {
  const post = async (path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...SEAM_AUTH },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it('blocks a metadata target: { outcome: blocked, blocked: ssrf }', async () => {
    const { status, json } = await post('/v1/host/sample/http/safe-fetch', { url: 'http://169.254.169.254/latest/meta-data/' });
    expect(status).toBe(200);
    expect(json.outcome).toBe('blocked');
    expect(json.blocked).toBe('ssrf');
  });

  it('blocks a simulated DNS-rebind (public name → denied address)', async () => {
    const { json } = await post('/v1/host/sample/http/safe-fetch', { url: 'http://example.com/', simulateRebindTo: '169.254.169.254' });
    expect(json.outcome).toBe('blocked');
    expect(json.blocked).toBe('ssrf');
  });

  it('refuses Connection: upgrade: { outcome: blocked, blocked: upgrade }', async () => {
    const { json } = await post('/v1/host/sample/http/safe-fetch', { url: 'https://example.com/', init: { headers: { Connection: 'upgrade' } } });
    expect(json.outcome).toBe('blocked');
    expect(json.blocked).toBe('upgrade');
  });

  it('safe-fetch-run returns a runId whose DURABLE event log carries the audit pair (queryable via the events seam)', async () => {
    const { status, json } = await post('/v1/host/sample/http/safe-fetch-run', { url: 'http://169.254.169.254/latest/meta-data/' });
    expect(status).toBe(200);
    expect(json.outcome).toBe('blocked');
    const runId = json.runId as string;
    expect(typeof runId).toBe('string');

    // The suite's event-log query seam — must surface the DURABLE pair.
    const calledRes = (await (await fetch(`${BASE}/v1/host/sample/test/runs/${runId}/events?type=agent.toolCalled`, { headers: SEAM_AUTH })).json()) as { events: Array<{ payload: Record<string, unknown> }> };
    const returnedRes = (await (await fetch(`${BASE}/v1/host/sample/test/runs/${runId}/events?type=agent.toolReturned`, { headers: SEAM_AUTH })).json()) as { events: Array<{ payload: Record<string, unknown> }> };
    expect(calledRes.events.length).toBe(1);
    expect(calledRes.events[0]!.payload.transport).toBe('http');
    const callId = calledRes.events[0]!.payload.callId;
    expect(returnedRes.events.some((e) => e.payload.callId === callId)).toBe(true);
  });
});
