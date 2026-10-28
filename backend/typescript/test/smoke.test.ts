/**
 * Smoke tests covering the golden path: discovery (the major-2 document and
 * its version literal), auth on a protected route, create → complete a run,
 * the Idempotency-Key replay, and BYOK strip-on-persist.
 *
 * (An older header also promised "stream events → cancel → fork"; nothing here
 * tests those — they live in their own suites. Corrected in /grade-tests
 * wave 61.)
 *
 * What breaks it (sabotage-witnessed, 8fw3g1-smk-*): the strip (twin of
 * test/byok-redaction.test.ts "redacts across nested objects and arrays" — a
 * protected double, kept), the idempotency replay. Waits are on the real
 * condition (`vi.waitFor`), never a fixed sleep; run secrets are cleared in
 * `finally` so a failed case cannot leak one into a later strip.
 */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import {
  setRunSecrets,
  stripSecretsFromPersisted,
  clearRunSecrets,
} from '../src/byok/ephemeralRunSecrets.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  // Tests run in legacy Bearer-only mode (no cookies). The cookie
  // path is exercised separately in test/auth-cookies.test.ts.
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

interface DiscoveryBody {
  protocolVersion: string;
  protocolVersions: readonly string[];
  interrupt?: { status?: string; tokenAlgs?: readonly string[] };
}

interface CreateRunBody {
  runId: string;
  status: string;
  eventsUrl: string;
}

interface RunSnapshotBody {
  runId: string;
  status: string;
}

async function jsonFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
  // JSON-only — if a route returns non-JSON (HTML error page, plain
  // text 401) the parse failure throws and surfaces as a test error
  // with the raw response in the stack. For deliberately-unauth probes
  // call `fetch` directly.
  return { status: res.status, body: (await res.json()) as T };
}

async function waitTerminal(runId: string): Promise<RunSnapshotBody> {
  let last: RunSnapshotBody | undefined;
  await vi.waitFor(async () => {
    last = (await jsonFetch<RunSnapshotBody>(`/runs/${runId}`)).body;
    expect(['completed', 'failed', 'cancelled']).toContain(last.status);
  }, { timeout: 10_000, interval: 25 });
  return last!;
}

describe('discovery', () => {
  it('serves /.well-known/openwop with capabilities', async () => {
    // ADR 0812 P3c-0 — the major-2 document. v1's `capabilities.interrupts.kinds`
    // has no v2 seat; the v2 `interrupt` record is the advertisement.
    const { status, body } = await jsonFetch<DiscoveryBody>('/.well-known/openwop', { headers: { 'OpenWOP-Version': '2' } });
    expect(status).toBe(200);
    // A literal, not `preferredVersion()` (an expectation computed by the
    // product moves with it): v1 is retired, so the preferred version is 2.0.
    expect(body.protocolVersion).toBe('2.0');
    expect(body.protocolVersions).toContain('2.0');
    expect(body.interrupt?.status).toBe('experimental');
    expect(body.interrupt?.tokenAlgs ?? []).toContain('hs256');
  });

  it('rejects unauth requests on protected routes', async () => {
    const res = await fetch(`${BASE}/runs/nonexistent`);
    expect(res.status).toBe(401);
  });
});

describe('run lifecycle', () => {
  it('creates and completes a sample run', async () => {
    const create = await jsonFetch<CreateRunBody>('/runs', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: 'openwop-app.uppercase',
        tenantId: 'demo',
        inputs: { text: 'hello' },
      }),
    });
    expect(create.status).toBe(201);
    expect(typeof create.body.runId).toBe('string');
    const runId = create.body.runId;

    // Wait for a TERMINAL status (not a fixed number of polls), then assert it.
    const final = await waitTerminal(runId);
    expect(final.status).toBe('completed');
  });

  it('replays the same response for an Idempotency-Key', async () => {
    const headers = { 'idempotency-key': 'fixed-key-001-smoke-replay' };
    const first = await jsonFetch<CreateRunBody>('/runs', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workflowId: 'openwop-app.uppercase',
        tenantId: 'demo',
        inputs: { text: 'idem' },
      }),
    });
    expect(first.status).toBe(201);
    // Wait for the inline dispatch to finish so the cached response is final
    // (not __pending__) before the second request.
    await waitTerminal(first.body.runId);
    const second = await jsonFetch<CreateRunBody>('/runs', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workflowId: 'openwop-app.uppercase',
        tenantId: 'demo',
        inputs: { text: 'idem' },
      }),
    });
    expect(second.status).toBe(201);
    expect(second.body.runId).toBe(first.body.runId);
  });
});

describe('BYOK strip-on-persist invariant', () => {
  interface NestedPayload {
    nested: { token: string };
    arr: readonly string[];
    safe: string;
  }
  it('replaces secret values with credentialRef placeholders', () => {
    setRunSecrets('test-run-1', { mySecret: 'super-confidential-value' });
    try {
      const before: NestedPayload = {
        nested: { token: 'super-confidential-value' },
        arr: ['public', 'super-confidential-value'],
        safe: 'no-secrets-here',
      };
      const after = stripSecretsFromPersisted<NestedPayload>(before);
      expect(after.nested.token).toBe('<<redacted:mySecret>>');
      expect(after.arr[1]).toBe('<<redacted:mySecret>>');
      expect(after.arr[0]).toBe('public');
      expect(after.safe).toBe('no-secrets-here');
    } finally {
      clearRunSecrets('test-run-1');
    }
  });

  it('passes through when no run secrets are set', () => {
    const before = { token: 'arbitrary-string' };
    const after = stripSecretsFromPersisted(before);
    expect(after).toEqual(before);
  });
});
