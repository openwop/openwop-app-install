/**
 * F3(c) (review of ADR 0587 §5) — the two ALLOW paths a real signed-in human
 * must keep, asserted over HTTP against the real route.
 *
 * WHY A SECOND FILE. `test/memory-endpoint.test.ts` authenticates as
 * `Bearer dev-token`, which resolves to the WILDCARD OPERATOR principal
 * (`principal.tenants` includes `*`, no cookie session, no durable user). That
 * harness can witness the wildcard exit and nothing else: `resolveCallerUser`
 * refuses it, so `/users/me` is 401 there and a `user:` allow is unreachable. It
 * also sets `OPENWOP_AUTH_DISABLE_COOKIES=true` for the whole file. So the
 * personal-workspace exit and the own-`user:` allow need a genuinely signed-in
 * cookie session — this file — and the split is a property of the two
 * PRINCIPALS, not a convenience.
 *
 * WHAT THESE CATCH — AND WHAT THEY DO NOT. Say it precisely, because the review
 * that prompted this file predicted a solo personal-workspace caller would 403
 * under the old predicate, and MEASUREMENT SAYS OTHERWISE:
 *
 *   MEASURED (probe RUN, 2026-08-19) with the old `resolveEffectiveAccess(
 *   tenantId, { subject })` restored and a real `/test/login` cookie session:
 *   `basis=member`, **29 scopes**, `workspace:read` among them — so this case
 *   returned 200 both before and after the fix. ADR 0025 auto-provisioning gives
 *   a personal workspace a personal org AND an owner membership, so "a solo user
 *   has no member row" is false on this path. (My own first reading said zero
 *   rows; that was a measurement error — `listMembers(tenantId, orgId)` is
 *   ORG-scoped and I passed one argument, so it filtered on
 *   `orgId === undefined` and returned `[]`. The route-level probe is the
 *   authority, not the store call I mis-invoked.)
 *
 * So the two `agent:`/`user:` cases below are ANTI-ROT, not discriminators: they
 * fail if the gate is ever tightened into a refuse-everything, which is the point
 * of an allow-path witness, but they would NOT have caught the F3 defect.
 *
 * The case that DOES discriminate is the WILDCARD OPERATOR principal, and it
 * lives in `test/memory-endpoint.test.ts` (`Bearer dev-token` → `tenants: ['*']`,
 * no member row anywhere). MEASURED: 403 `Missing required scope: workspace:read`
 * under the old predicate, 200 under `requireTenantScope` — a scope that
 * principal can never obtain, i.e. a gate with no exit. Both files are needed
 * because one harness cannot produce both principals.
 *
 * @see docs/adr/0587-memory-trust-provenance-and-erasure.md
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
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
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T> { status: number; body: T }

function client(): {
  get: <T>(p: string) => Promise<Res<T>>;
  post: <T>(p: string, b?: unknown) => Promise<Res<T>>;
} {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const sc of getSetCookies(res.headers) as string[]) {
      const m = /(__session=[^;]+)/.exec(sc);
      if (m) cookie = m[1]!;
    }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T };
  };
  return {
    get: <T>(p: string) => call<T>('GET', p),
    post: <T>(p: string, b?: unknown) => call<T>('POST', p, b),
  };
}

let n = 0;
/** A real signed-in user in their OWN personal workspace, via the ADR 0026 seam. */
async function signIn(): Promise<{ c: ReturnType<typeof client>; userId: string; tenantId: string }> {
  const c = client();
  const login = await c.post<{ user: { userId: string } }>('/v1/host/openwop-app/test/login', {
    email: `f3c-${Date.now()}-${n++}@acme.test`,
  });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  // Take the subject + tenant from `/users/me` — the SAME `resolveCallerUser` the
  // gate's `user:` arm calls. Hardcoding either would assert the test's guess
  // about auth rather than the gate's behaviour, and would stay green against a
  // gate that had stopped resolving anything at all.
  const me = await c.get<{ userId: string; tenantId: string }>('/v1/host/openwop-app/users/me');
  expect(me.status, JSON.stringify(me.body)).toBe(200);
  return { c, userId: me.body.userId, tenantId: me.body.tenantId };
}

interface MemoryListBody {
  memoryRef: string;
  entries: { id: string; content: string; tags: string[] }[];
}

describe('F3(c) — the legitimate reads a signed-in human must still get', () => {
  it("a caller's OWN `user:` memory is 200, with the row it asked for", async () => {
    const { c, userId, tenantId } = await signIn();
    const { writeMemoryEntry } = await import('../src/host/inMemorySurfaces.js');
    // Seed a REAL row: a 200 over an empty list would also pass against a gate
    // that refused and a handler that swallowed, so the row is what makes the
    // assertion about ACCESS rather than about status codes.
    await writeMemoryEntry(tenantId, `user:${userId}`, { content: 'my own private fact', tags: [] });

    const res = await c.get<MemoryListBody>(
      `/v1/host/openwop-app/memory?memoryRef=user:${encodeURIComponent(userId)}`,
    );
    expect(res.status, 'a person must still be able to read their OWN memory').toBe(200);
    expect(res.body.entries.map((e) => e.content)).toContain('my own private fact');
  });

  // ANTI-ROT only — see the file header. This caller resolves `basis=member` with
  // 29 scopes (personal-org auto-provisioning), so it passed under the old
  // predicate too. It guards the allow, it does not witness the fix.
  it('an `agent:` read in the caller\'s OWN personal workspace is 200', async () => {
    const { c, tenantId } = await signIn();
    const { createRosterEntry } = await import('../src/host/rosterService.js');
    const { writeMemoryEntry } = await import('../src/host/inMemorySurfaces.js');
    // `createRosterEntry` mints a DETERMINISTIC `host:<slug>` id (ADR 0379 P2);
    // take what it returns rather than reconstructing the slug here.
    const entry = await createRosterEntry({
      tenantId,
      persona: `F3c Personal Agent ${n++}`,
      agentRef: { agentId: 'core.openwop.agents/assistant' },
    });
    await writeMemoryEntry(tenantId, `agent:${entry.rosterId}`, { content: 'agent private fact', tags: [] });

    const res = await c.get<MemoryListBody>(
      `/v1/host/openwop-app/memory?memoryRef=agent:${encodeURIComponent(entry.rosterId)}`,
    );
    expect(
      res.status,
      'ANTI-ROT: a personal-workspace caller must keep this read',
    ).toBe(200);
    expect(res.body.entries.map((e) => e.content)).toContain('agent private fact');
  });

  it("ANTI-ROT: the same signed-in caller is still REFUSED another person's `user:` scope", async () => {
    // Without this, the two allows above could be satisfied by a gate that had
    // been loosened to permit everything — which is the failure mode in the
    // opposite direction from the one this file was written for.
    const { c } = await signIn();
    const { writeMemoryEntry, listMemoryEntries } = await import('../src/host/inMemorySurfaces.js');
    const victim = 'f3c-victim-user';
    await writeMemoryEntry('default', `user:${victim}`, { content: 'victim private fact', tags: [] });

    const res = await c.get<{ error?: string }>(`/v1/host/openwop-app/memory?memoryRef=user:${victim}`);
    expect(res.status).toBe(404);
    expect(await listMemoryEntries('default', `user:${victim}`)).toHaveLength(1);
  });
});
