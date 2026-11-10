/**
 * ADR 1045 (CHAN-P6-1, P6-2, D4, D6) — the A2A server's caller boundary, driven
 * over HTTP through the real auth middleware.
 *
 * What it proves, each leg against the live route:
 *  - P6-1: a credential-less caller (the cookie posture MINTS an anon principal
 *    for it, which is what production sees) is refused 401
 *    `anonymous_principal_refused` before any JSON-RPC frame; it is admitted only
 *    when the host advertises `anonymousActor`. The tenant of record is the
 *    authenticated principal's, never `default`, and the principal id is never
 *    `anon`.
 *  - D4 cross-tenant: tenant B cannot read, resume, or attach a push config to
 *    tenant A's task — on the 0.3 JSON-RPC methods AND the durable-task seams —
 *    and B's send no longer overwrites A's derived task id.
 *  - P6-2: the per-principal budget on run-starting methods answers a typed 429
 *    (`a2a_principal_rate`), leaves reads alone, and is per principal.
 *  - D6: an `owk_` key that declared only `runs:read` cannot start work over A2A
 *    (the `POST /runs` predicate, shared).
 *
 * Sabotage-witnessed 2026-11-03 (each reverted, the named legs went red, then
 * restored): (1) `resolveA2aCaller` returning `{tenantId: req.tenantId ??
 * 'default', principalId: principal?.principalId ?? 'anon'}` without the
 * anonymous check → both anonymous-401 legs (route and seam) red;
 * (2) the 0.3 `message/send` reading `getA2aTask` (no tenant) with the shared
 * `a2a:<agentId>` id → the overwrite and resume legs red; (3) the seams reading
 * `getA2aTask` by id → the seam GET/push-config 404 legs red; (4) removing the
 * `enforceA2aPrincipalRateLimit` call → the 429 leg red; (5) dropping
 * `authorizeA2aMethod` → the owk `runs:read` leg red.
 *
 * Fixture note (w86 grade-tests, 2026-11-05): an env key's principal id used to
 * be built from the key's first 8 characters (product finding TST-FUD-GC-1, fixed
 * by #5593: it is now derived from a hash of the full key). The keys here used to
 * share the prefix `adr1045-`, so all three were ONE principal, and the "per
 * principal" bucket was only ever tested as "per tenant". Every key here now has
 * its own 8-character prefix as well, and KEY_A2 is a
 * second principal in tenant A. Principals are asserted DISTINCT, never by
 * their format. Keying the budget by tenant alone must red the KEY_A2 leg. With
 * distinct principals, keying it by principal alone is an equivalent mutant here
 * (no two keys share a principal), so the tenant half of the key is not claimed.
 *
 * `getA2aTaskFor` (`readableBy`) is the single tenant guard on every 0.3 read
 * and on the seams; dropping it reds both D4 read legs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { getA2aTask, setA2aPushSink, type A2aPushConfig } from '../src/host/a2aTaskStore.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { _resetRateLimitState } from '../src/middleware/rateLimit.js';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const SUPERVISOR = 'core.openwop.agents.supervisor.default';
// Distinct in their first 8 characters: the pre-TST-FUD-GC-1 principal id was
// that prefix, so three `adr1045-…` keys were ONE principal and the budget leg
// below was per-tenant, not per-principal. Same-prefix keys are covered in
// `adr1045-env-key-principal.test.ts`. KEY_A2 is a second principal in tenant A,
// so the budget leg shows the limit is per principal, not per tenant.
const OP = 'op1045ab-operator-token';
const KEY_A = 'ka1045ab-tenant-a-token';
const KEY_A2 = 'ka2045ab-tenant-a-token';
const KEY_B = 'kb1045ab-tenant-b-token';
const TENANT_A = 'adr1045-tenant-a';
const TENANT_B = 'adr1045-tenant-b';
const ENV_KEYS = [
  'OPENWOP_STORAGE_DSN', 'OPENWOP_A2A_SERVER_ENABLED', 'OPENWOP_A2A_DURABLE_TASKS', 'OPENWOP_API_KEYS',
  'OPENWOP_SESSION_SECRET', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_TEST_SEAM_ENABLED', 'OPENWOP_ANON_ACTOR_ENABLED',
  'OPENWOP_A2A_PRINCIPAL_REQS_PER_MIN', 'OPENWOP_RATELIMIT_IP_REQS_PER_MIN',
];
const saved: Record<string, string | undefined> = {};
let server: http.Server;
let BASE = '';
let READ_ONLY_OWK = '';
const pushed: Array<{ config: A2aPushConfig; event: Record<string, unknown> }> = [];

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_A2A_SERVER_ENABLED = 'true';
  process.env.OPENWOP_A2A_DURABLE_TASKS = 'true';
  process.env.OPENWOP_API_KEYS = `${OP}:*,${KEY_A}:${TENANT_A},${KEY_A2}:${TENANT_A},${KEY_B}:${TENANT_B}`;
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN = '100000';
  process.env.OPENWOP_A2A_PRINCIPAL_REQS_PER_MIN = '100000';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES; // the COOKIE posture — prod's
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  delete process.env.OPENWOP_ANON_ACTOR_ENABLED;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'core.openwop.agents.supervisor'));
  // Capture pushes instead of egress, so a carried push config is observable.
  setA2aPushSink((config, event) => { pushed.push({ config, event }); });
  READ_ONLY_OWK = (await issueApiKey({ tenantId: TENANT_A, name: 'read-only', createdBy: 'user:adr1045-reader', scopes: ['runs:read', 'workspace:write'] })).token;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);

afterAll(async () => {
  setA2aPushSink(null);
  await new Promise<void>((res) => server.close(() => res()));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

interface RpcBody { result?: Record<string, unknown>; error?: { code?: number; message?: string } }

function rpc(token: string | null, method: string, params?: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${BASE}/host/openwop-app/a2a`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}
const send = (token: string, params: Record<string, unknown> = {}) =>
  rpc(token, 'message/send', { agentId: SUPERVISOR, message: { parts: [{ kind: 'text', text: 'hello' }] }, ...params });

describe('ADR 1045 D1 (CHAN-P6-1) — authenticated callers only, tenant from the principal', () => {
  it('a credential-less caller (anon cookie minted for it) is refused 401 before any JSON-RPC frame', async () => {
    const r = await rpc(null, 'agent/getCard');
    expect(r.status).toBe(401);
    const body = await r.json() as { error?: string; details?: { reason?: string }; jsonrpc?: string };
    expect(body.error).toBe('unauthenticated');
    expect(body.details?.reason).toBe('anonymous_principal_refused');
    expect(body.jsonrpc).toBeUndefined();
  });

  it('the same caller is admitted only when the host ADVERTISES anonymousActor', async () => {
    process.env.OPENWOP_ANON_ACTOR_ENABLED = 'true';
    try {
      const r = await rpc(null, 'agent/getCard');
      expect(r.status).toBe(200);
      expect(((await r.json()) as RpcBody).result?.name).toBe('openwop-reference-host');
    } finally {
      delete process.env.OPENWOP_ANON_ACTOR_ENABLED;
    }
  });

  it('a scoped key\'s task is bound to ITS tenant and principal — never default / anon', async () => {
    const principalOf = async (token: string): Promise<{ tenantId?: string; principalId?: string }> => {
      const id = ((await (await send(token)).json()) as RpcBody).result?.id;
      expect(typeof id, `fixture: ${token.slice(0, 8)} opened no task`).toBe('string');
      const rec = await getA2aTask(id as string);
      return { tenantId: rec?.tenantId, principalId: rec?.principalId };
    };
    const a = await principalOf(KEY_A);
    const a2 = await principalOf(KEY_A2);
    const b = await principalOf(KEY_B);
    expect(a.tenantId).toBe(TENANT_A);
    expect(a2.tenantId).toBe(TENANT_A);
    expect(b.tenantId).toBe(TENANT_B);
    for (const p of [a, a2, b]) {
      expect(typeof p.principalId).toBe('string');
      expect(p.principalId).not.toBe('');
      expect(p.principalId).not.toBe('anon');
    }
    // Each key is its own principal (asserted by identity, never by format).
    expect(new Set([a.principalId, a2.principalId, b.principalId]).size).toBe(3);
  });

  it('the wildcard operator key acts in the documented operator tenant `default`', async () => {
    const id = ((await (await send(OP)).json()) as RpcBody).result?.id as string;
    expect((await getA2aTask(id))?.tenantId).toBe('default');
  });
});

describe('ADR 1045 D4 — tenant B cannot see or drive tenant A\'s task', () => {
  it('derived 0.3 task ids differ per tenant, so B\'s send no longer overwrites A\'s task', async () => {
    const a = ((await (await send(KEY_A)).json()) as RpcBody).result?.id as string;
    const b = ((await (await send(KEY_B)).json()) as RpcBody).result?.id as string;
    expect(a).not.toBe(b);
    expect((await getA2aTask(a))?.tenantId).toBe(TENANT_A);
    expect((await getA2aTask(b))?.tenantId).toBe(TENANT_B);
  });

  it('B reading, resuming, or attaching a push config to A\'s task answers -32001, and A\'s record is untouched', async () => {
    const aId = ((await (await send(KEY_A)).json()) as RpcBody).result?.id as string;
    // A registers a push target on its own task.
    const set = await (await rpc(KEY_A, 'tasks/pushNotificationConfig/set', { id: aId, pushNotificationConfig: { url: 'https://a.example.com/hook' } })).json() as RpcBody;
    expect(set.error).toBeUndefined();
    const before = await getA2aTask(aId);

    expect(((await (await rpc(KEY_B, 'tasks/get', { id: aId })).json()) as RpcBody).error?.code).toBe(-32001);
    expect(((await (await rpc(KEY_B, 'tasks/resubscribe', { id: aId })).json()) as RpcBody).error?.code).toBe(-32001);
    expect(((await (await rpc(KEY_B, 'tasks/pushNotificationConfig/set', { id: aId, pushNotificationConfig: { url: 'https://b.example.com/hook' } })).json()) as RpcBody).error?.code).toBe(-32001);
    pushed.length = 0;
    expect(((await (await send(KEY_B, { id: aId })).json()) as RpcBody).error?.code).toBe(-32001);

    const after = await getA2aTask(aId);
    expect(after?.tenantId).toBe(TENANT_A);
    expect(after?.pushConfig?.url).toBe('https://a.example.com/hook');
    // Supporting only (two writes in one ms would tie); tenant + push URL carry it.
    expect(after?.updatedAt).toBe(before?.updatedAt);
    // B's refused send pushed nothing to A's target.
    expect(pushed).toEqual([]);
    // A still reads its own task.
    expect(((await (await rpc(KEY_A, 'tasks/get', { id: aId })).json()) as RpcBody).result?.id).toBe(aId);
  });

  it('the durable-task seams bind the record and refuse a foreign read or push config with 404', async () => {
    const started = await fetch(`${BASE}/host/openwop-app/a2a/tasks/start`, {
      method: 'POST', headers: { authorization: `Bearer ${KEY_A}`, 'content-type': 'application/json' }, body: '{}',
    });
    expect(started.status, await started.clone().text()).toBe(201);
    const { taskId } = await started.json() as { taskId: string };
    expect((await getA2aTask(taskId))?.tenantId).toBe(TENANT_A);

    const get = (token: string) => fetch(`${BASE}/host/openwop-app/a2a/tasks/${encodeURIComponent(taskId)}`, { headers: { authorization: `Bearer ${token}` } });
    expect((await get(KEY_B)).status).toBe(404);
    expect((await get(KEY_A)).status).toBe(200);

    const push = (token: string) => fetch(`${BASE}/host/openwop-app/a2a/tasks/push-config`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ taskId, url: 'https://b.example.com/hook' }),
    });
    expect((await push(KEY_B)).status).toBe(404);
    expect((await getA2aTask(taskId))?.pushConfig).toBeUndefined();
    expect((await push(KEY_A)).status).toBe(200);
  });

  it('the seams refuse an anonymous caller too', async () => {
    const r = await fetch(`${BASE}/host/openwop-app/a2a/tasks/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
    const body = await r.json() as { error?: string; details?: { reason?: string }; taskId?: unknown };
    expect(body.details?.reason).toBe('anonymous_principal_refused');
    // The refusal is the 401 envelope itself, not a 201 carrying a task id.
    expect(body.error).toBe('unauthenticated');
    expect(body.taskId).toBeUndefined();
  });
});

describe('ADR 1045 D2 (CHAN-P6-2) — per-principal budget on run-starting methods', () => {
  it('the budget answers a typed 429, leaves reads alone, and is per principal', async () => {
    _resetRateLimitState();
    process.env.OPENWOP_A2A_PRINCIPAL_REQS_PER_MIN = '2';
    try {
      const first = await send(KEY_A);
      const id = ((await first.json()) as RpcBody).result?.id as string;
      expect((await send(KEY_A)).status).toBe(200);
      const third = await send(KEY_A);
      expect(third.status).toBe(429);
      expect(third.headers.get('retry-after')).toBeTruthy();
      const body = await third.json() as { error?: string; details?: { reason?: string; scope?: string } };
      expect(body.error).toBe('rate_limited');
      expect(body.details?.reason).toBe('a2a_principal_rate');
      expect(body.details?.scope).toBe('tenant');
      // Reads are not run-starting: they stay on the per-IP floor.
      expect((await rpc(KEY_A, 'tasks/get', { id })).status).toBe(200);
      // Another principal in the SAME tenant has its own bucket.
      expect((await send(KEY_A2)).status).toBe(200);
      // So does a principal in another tenant.
      expect((await send(KEY_B)).status).toBe(200);
    } finally {
      process.env.OPENWOP_A2A_PRINCIPAL_REQS_PER_MIN = '100000';
      _resetRateLimitState();
    }
  });
});

describe('ADR 1045 D6 — A2A methods take their HTTP sibling\'s scope', () => {
  it('an owk_ key that declared runs:read but not runs:create cannot start work, but can read', async () => {
    // `workspace:write` is declared so the host-wide owk_ write-method guard
    // passes and the refusal below is provably the A2A method's own scope.
    const r = await send(READ_ONLY_OWK);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { details?: { requiredScope?: string } }).details?.requiredScope).toBe('runs:create');
    const reads = await rpc(READ_ONLY_OWK, 'tasks/get', { id: 'adr1045-missing' });
    expect(reads.status, await reads.clone().text()).toBe(200);
    expect(((await reads.json()) as RpcBody).error?.code).toBe(-32001);
  });
});
