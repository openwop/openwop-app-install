/**
 * RFC 0076 §B / §host.http hardening + advertisement.
 *
 * Proves, against the REAL app boot:
 *   1. The v2 `auth` family carries the `oidc` lane (with its issuer) ONLY when
 *      OPENWOP_OIDC_* is configured (honest-off). (The v1 `httpClient` advert
 *      leg this file used to carry was deleted with the v1 document, ADR 0812
 *      P3c-0 — see the note inside the first describe.)
 *   2. `ctx.http.safeFetch` refuses `Connection: upgrade`, blocks SSRF
 *      targets, and emits the DURABLE content-free
 *      `agent.toolCalled`/`agent.toolReturned` pair (`transport: "http"`) on
 *      the ok and forbidden paths — neither half carries the destination.
 *   3. The guarded-agent response-body ceiling aborts a response larger than
 *      the cap with undici's own size error (mechanism proven with a 1 KiB cap
 *      and a body under it as the positive control).
 *   4. The conformance seams (`/http/safe-fetch`, `/http/safe-fetch-run`)
 *      echo the guard decisions and back the durable event-log query. The
 *      DNS-rebind seam case exercises the SEAM's own re-application of
 *      `isDeniedWebhookHost` to a simulated resolution — the conformance seam
 *      contract, not the production pinned connector (which needs real DNS).
 *
 * Sabotage witnessed red (8f grade-tests wave 2): the upgrade refusal removed
 * (`8fw2g3-sf-upgrade`), the SSRF string precheck removed
 * (`-sf-ssrf-precheck`), the ok half of the pair dropped (`-sf-ok-pair`), the
 * agent options dropped (`-sf-agent-opts`, `-sf-agent-opts-r2`), and the
 * destination written into the audit payload (`-sf-content-free-r2`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetch as undiciFetch } from 'undici';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeConnectionSafeFetch } from '../src/host/connectionInjection.js';
import { makeGuardedAgent } from '../src/host/webhookEgressGuard.js';
import { bareRunId } from './support/bareRunId.js';

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
  auth?: { lanes?: Array<{ lane: string; issuers?: string[] }> };
}

const disco = async (): Promise<Disco> => (await (await fetch(`${BASE}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2' } })).json()) as Disco;

describe('discovery advertisement (advertise/enforce agreement + honest-off OIDC)', () => {
  // ADR 0812 P3c-0 — the `httpClient` advert leg is deleted: that family exists only in the
  // retired v1 document (the v2 root carries no `httpClient` record), so there is no
  // advertised value left to pair with the enforced constants.

  // ADR 0812 P3c-0 — v2 spelling: the `oidc` LANE of the v2 `auth` family replaces the v1
  // `openwop-auth-oidc-user-bearer` profile + `oidc` block (the lane carries no audience).
  it('OIDC is honest-off: no oidc lane without env, the lane with its issuer with env', async () => {
    const before = (await disco()).auth;
    expect(before?.lanes?.some((l) => l.lane === 'oidc')).toBe(false);

    process.env.OPENWOP_OIDC_ISSUER = 'https://issuer.example.test';
    process.env.OPENWOP_OIDC_AUDIENCE = 'aud-test';
    try {
      const after = (await disco()).auth;
      expect(after?.lanes?.find((l) => l.lane === 'oidc')?.issuers).toEqual(['https://issuer.example.test']);
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
    expect(returned).toHaveLength(1);
    expect(returned[0]!.status).toBe('forbidden');
    expect(returned[0]!.callId).toBe(called[0]!.callId);
    for (const p of [...called, ...returned]) expect(JSON.stringify(p)).not.toContain('169.254');
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
    expect(returned).toHaveLength(1);
    expect(returned[0]!.status).toBe('ok');
    expect(returned[0]!.callId).toBe(called[0]!.callId);
    for (const p of [...called, ...returned]) expect(JSON.stringify(p)).not.toContain('127.0.0.1');
  });

  it('guarded-agent response-body ceiling aborts an oversized body (mechanism)', async () => {
    // `/small` is under the cap (positive control); anything else is 64 KiB.
    const big = http.createServer((q, s) => {
      s.writeHead(200, { 'content-type': 'application/octet-stream' });
      s.end(Buffer.alloc(q.url === '/small' ? 512 : 64 * 1024));
    });
    await new Promise<void>((r) => big.listen(0, '127.0.0.1', r));
    const port = (big.address() as AddressInfo).port;
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const capped = makeGuardedAgent({ maxResponseSize: 1024 }); // 1 KiB cap
    try {
      const small = await undiciFetch(`http://127.0.0.1:${port}/small`, { dispatcher: capped });
      expect((await small.arrayBuffer()).byteLength).toBe(512);
      // Draining past the cap must reject with undici's SIZE error — not any
      // error (a guard refusal or a refused connection would also "throw").
      const err: unknown = await (async () => {
        const res = await undiciFetch(`http://127.0.0.1:${port}/`, { dispatcher: capped });
        await res.arrayBuffer();
      })().then(() => null, (e: unknown) => e);
      const codeOf = (e: unknown): unknown => (typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined);
      const causeOf = (e: unknown): unknown => (typeof e === 'object' && e !== null ? (e as { cause?: unknown }).cause : undefined);
      expect([codeOf(err), codeOf(causeOf(err))]).toContain('UND_ERR_RES_EXCEEDED_MAX_SIZE');
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
 *  `/host/sample/*` seam with no credentials at all and got 200s, which was
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
    const { status, json } = await post('/host/sample/http/safe-fetch', { url: 'http://169.254.169.254/latest/meta-data/' });
    expect(status).toBe(200);
    expect(json.outcome).toBe('blocked');
    expect(json.blocked).toBe('ssrf');
  });

  it('blocks a simulated DNS-rebind (public name → denied address)', async () => {
    const { json } = await post('/host/sample/http/safe-fetch', { url: 'http://example.com/', simulateRebindTo: '169.254.169.254' });
    expect(json.outcome).toBe('blocked');
    expect(json.blocked).toBe('ssrf');
  });

  it('refuses Connection: upgrade: { outcome: blocked, blocked: upgrade }', async () => {
    const { json } = await post('/host/sample/http/safe-fetch', { url: 'https://example.com/', init: { headers: { Connection: 'upgrade' } } });
    expect(json.outcome).toBe('blocked');
    expect(json.blocked).toBe('upgrade');
  });

  it('safe-fetch-run returns a runId whose DURABLE event log carries the audit pair (queryable via the events seam)', async () => {
    const { status, json } = await post('/host/sample/http/safe-fetch-run', { url: 'http://169.254.169.254/latest/meta-data/' });
    expect(status).toBe(200);
    expect(json.outcome).toBe('blocked');
    // The seam answers with the projected (tenant-bound, once v1 retires) id; the events
    // seam is a host lane keyed on the bare id (`./support/bareRunId.ts`).
    const runId = bareRunId(json.runId as string);
    expect(typeof json.runId).toBe('string');

    // The suite's event-log query seam — must surface the DURABLE pair. v2 spelling of the
    // event types (`agent.tool-called` / `agent.tool-returned`) on the header-less seam call.
    const calledRes = (await (await fetch(`${BASE}/host/sample/test/runs/${runId}/events?type=agent.tool-called`, { headers: SEAM_AUTH })).json()) as { events: Array<{ payload: Record<string, unknown> }> };
    const returnedRes = (await (await fetch(`${BASE}/host/sample/test/runs/${runId}/events?type=agent.tool-returned`, { headers: SEAM_AUTH })).json()) as { events: Array<{ payload: Record<string, unknown> }> };
    expect(calledRes.events.length).toBe(1);
    expect(calledRes.events[0]!.payload.transport).toBe('http');
    const callId = calledRes.events[0]!.payload.callId;
    expect(returnedRes.events.some((e) => e.payload.callId === callId)).toBe(true);
  });
});
