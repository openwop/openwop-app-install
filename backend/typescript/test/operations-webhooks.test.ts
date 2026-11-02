/**
 * ADR 0395 Phase A — the operator webhook-delivery health panel, ROUTE-level:
 * superadmin gate on the cross-tenant summary + the retry write (403
 * `forbidden` for a plain tenant admin), the org-scoped summary served to the
 * org owner (who holds `webhooks:manage`), ONE batched response (counts +
 * recent rows fanned in server-side), the SAFE PROJECTION (no `secret`, no
 * `payload`, no query strings on URLs), and manual retry re-arming a dead
 * delivery for the existing worker, with its audit row. Phases B+C: the DLQ +
 * system-health reads are superadmin-only, and the durable DLQ snapshot/replay
 * never surfaces a payload and replays a message exactly once.
 *
 * NOT covered here (corrected w74; the header used to claim both): the
 * trigger-subscription pause/resume write, and an editor's 403 on the
 * org-scoped summary. Nor does any case seed a foreign-tenant webhook, so the
 * org-scoped summary's tenant filter is not asserted by this file.
 *
 * Sabotage, each red (w74 round 1): `sanitizeUrl` returning the raw URL; a
 * delivery projection carrying `secret`; a zero `dead` count; dropping
 * `requireSuperadmin` from the cross-tenant summary, the retry, or the health
 * read; skipping the retry 404; a retry that keeps the spent attempts; a replay
 * that does not delete the DLQ row; a replay that does not bump
 * `deliveryCount` or unwrap `original`; a snapshot that carries payloads.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import type { Storage } from '../src/storage/storage.js';

const SUPER_TENANT = 'org:test-ops-super';

let BASE: string;
let server: http.Server;
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_SUPERADMIN_TENANTS = SUPER_TENANT;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'operations']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
}, 120_000);
afterAll(async () => {
  delete process.env.OPENWOP_SUPERADMIN_TENANTS;
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T> { status: number; body: T }
/** The flat S22 refusal envelope (`middleware/errorEnvelope.ts`). */
interface Refusal { error: string; message: string }
interface DlqSummary { subjects: unknown[]; pointInTime: boolean; backend: string }
interface HealthSummary {
  perInstance: boolean;
  checks?: { storage?: { ok: boolean } };
  sse?: { totalStreams: unknown };
  rateLimits?: { ipReqsPerMin: unknown };
}
interface WebhookSummary {
  webhooks: Array<{ subscriptionId: string; url: string; counts: { dead: number }; recent: Array<Record<string, unknown>> }>;
}
interface Client {
  get: <T>(p: string) => Promise<Res<T>>;
  post: <T>(p: string, b?: unknown) => Promise<Res<T>>;
}
function client(): Client {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

/** A refusal from `requireSuperadmin`: exactly 403 `forbidden`. */
function expectForbidden(r: Res<Refusal>, what: string): void {
  expect(r.status, what).toBe(403);
  expect(r.body.error, what).toBe('forbidden');
}

let n = 0;
async function login(tenantId: string): Promise<{ c: Client; orgId: string }> {
  const c = client();
  const r = await c.post<unknown>('/host/openwop-app/test/login', { email: `ops-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await c.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { c, orgId: org.body.orgId };
}

const OPS = '/host/openwop-app/operations';

async function seedDelivery(subscriptionId: string, tenantId: string, status: 'pending' | 'dead'): Promise<string> {
  // A webhook subscription + a queued delivery in the DURABLE queue — the rows
  // the panel reads. The secret must never surface in any response.
  await storage.insertWebhook({
    subscriptionId, tenantId,
    url: `https://receiver.example.test/hook?token=SECRET-QS-${n}`,
    events: ['run.completed'], secret: 'shh-webhook-secret',
    createdAt: new Date().toISOString(),
  });
  const deliveryId = `dlv-${Date.now()}-${n++}`;
  await storage.enqueueWebhookDelivery({
    deliveryId, subscriptionId,
    url: `https://receiver.example.test/hook?token=SECRET-QS-${n}`,
    secret: 'shh-delivery-secret', eventType: 'run.completed',
    payload: JSON.stringify({ top: 'secret-payload' }),
    status, attempts: status === 'dead' ? 5 : 0, maxAttempts: 5,
    nextAttemptAt: Date.now() + 60_000,
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  return deliveryId;
}

describe('operations DLQ + system-health (Phases B+C) — gating + honesty', () => {
  it('DLQ summary + replay + health summary are superadmin-only; summary carries honesty flags', async () => {
    const plain = await login(`org:test-ops-dlq-plain-${Date.now()}`);
    expectForbidden(await plain.c.get<Refusal>(`${OPS}/dlq/summary`), 'dlq summary');
    expectForbidden(await plain.c.post<Refusal>(`${OPS}/dlq/replay`, { tenantId: 't', subject: 's.dlq', messageId: 'm' }), 'dlq replay');
    expectForbidden(await plain.c.get<Refusal>(`${OPS}/health/summary`), 'health summary');

    const superAdmin = await login(SUPER_TENANT);
    const dlq = await superAdmin.c.get<DlqSummary>(`${OPS}/dlq/summary`);
    expect(dlq.status).toBe(200);
    expect(Array.isArray(dlq.body.subjects)).toBe(true);
    expect(dlq.body.pointInTime).toBe(true);
    expect(['memory', 'durable']).toContain(dlq.body.backend);

    const health = await superAdmin.c.get<HealthSummary>(`${OPS}/health/summary`);
    expect(health.status, JSON.stringify(health.body)).toBe(200);
    expect(health.body.perInstance).toBe(true); // the multi-instance honesty caveat
    expect(health.body.checks?.storage?.ok).toBe(true);
    expect(typeof health.body.sse?.totalStreams).toBe('number');
    expect(typeof health.body.rateLimits?.ipReqsPerMin).toBe('number');
    // no secrets in the health payload
    expect(JSON.stringify(health.body)).not.toMatch(/secret|token|password/i);

    // replay of a nonexistent message is a typed 404, bad subject a 400 — two
    // distinct branches, so assert the code as well as the status
    const missing = await superAdmin.c.post<Refusal>(`${OPS}/dlq/replay`, { tenantId: 'org:x', subject: 'jobs.dlq', messageId: 'nope' });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('not_found');
    const badSubject = await superAdmin.c.post<Refusal>(`${OPS}/dlq/replay`, { tenantId: 'org:x', subject: 'jobs', messageId: 'nope' });
    expect(badSubject.status).toBe(400);
    expect(badSubject.body.error).toBe('validation_error');
  });
});

describe('durable DLQ snapshot + replay (the fleet-shared backend, OQ-3)', () => {
  it('dead-lettered message appears in the snapshot; replay moves it back to the base subject once', async () => {
    const { createDurableQueueBus, snapshotDurableDlqSubjects, replayDurableDlqMessage } = await import('../src/host/durable/durableQueue.js');
    const { _setDurableStorageForTesting } = await import('../src/host/durable/durableKv.js');
    _setDurableStorageForTesting(storage);
    const tenant = `org:test-ops-dlqdur-${Date.now()}`;
    const bus = createDurableQueueBus({ tenantId: tenant });
    await bus.publish({ subject: 'orders', payload: { orderId: 'o-1', card: 'PII-SENSITIVE' } });
    const consumed = await bus.consume({ subject: 'orders' }) as { found: boolean; deliveryToken: string };
    expect(consumed.found).toBe(true);
    await bus.deadLetter({ deliveryToken: consumed.deliveryToken, reason: 'downstream 500' });

    const snapshot = await snapshotDurableDlqSubjects(tenant);
    expect(snapshot.length).toBe(1);
    expect(snapshot[0]).toMatchObject({ tenantId: tenant, subject: 'orders.dlq', depth: 1, reasons: ['downstream 500'] });
    // payloads never surface in the snapshot
    expect(JSON.stringify(snapshot)).not.toContain('PII-SENSITIVE');

    const messageId = snapshot[0]!.messageIds[0]!;
    expect(await replayDurableDlqMessage(tenant, 'orders.dlq', messageId)).toEqual({ replayed: true });
    // idempotent: the second replay 404s
    expect((await replayDurableDlqMessage(tenant, 'orders.dlq', messageId)).replayed).toBe(false);
    // the ORIGINAL payload is back on the base subject with deliveryCount bumped
    const redelivered = await bus.consume({ subject: 'orders' }) as { found: boolean; payload: unknown; deliveryCount: number };
    expect(redelivered.found).toBe(true);
    expect(redelivered.payload).toEqual({ orderId: 'o-1', card: 'PII-SENSITIVE' });
    expect(redelivered.deliveryCount).toBe(2);
  });
});

describe('operations webhook summary — gating + projection', () => {
  it('cross-tenant summary: superadmin only (tenant admin 403s); tenant summary needs webhooks:manage', async () => {
    const plain = await login(`org:test-ops-plain-${Date.now()}`);
    expectForbidden(await plain.c.get<Refusal>(`${OPS}/webhooks/summary`), 'cross-tenant summary');

    // own-org summary: the org owner holds webhooks:manage (admin tier) → 200
    const own = await plain.c.get<WebhookSummary>(`${OPS}/orgs/${encodeURIComponent(plain.orgId)}/webhooks/summary`);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(Array.isArray(own.body.webhooks)).toBe(true);

    const superAdmin = await login(SUPER_TENANT);
    const all = await superAdmin.c.get<WebhookSummary>(`${OPS}/webhooks/summary`);
    expect(all.status).toBe(200);
    expect(Array.isArray(all.body.webhooks)).toBe(true);
  });

  it('returns ONE batched response with counts + recent rows, secrets/payloads/query-strings stripped', async () => {
    const tenant = `org:test-ops-proj-${Date.now()}`;
    const { c, orgId } = await login(tenant);
    const subId = `wh-sub-${Date.now()}`;
    await seedDelivery(subId, tenant, 'dead');
    const res = await c.get<WebhookSummary>(`${OPS}/orgs/${encodeURIComponent(orgId)}/webhooks/summary`);
    expect(res.status).toBe(200);
    const row = res.body.webhooks.find((w) => w.subscriptionId === subId);
    expect(row).toBeTruthy();
    expect(row!.counts.dead).toBe(1);
    expect(row!.url).toBe('https://receiver.example.test/hook'); // query string stripped
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('shh-webhook-secret');
    expect(raw).not.toContain('shh-delivery-secret');
    expect(raw).not.toContain('secret-payload');
    expect(raw).not.toContain('SECRET-QS');
  });

  it('manual retry re-arms a dead delivery (superadmin; 403 otherwise; audited path 202)', async () => {
    const tenant = `org:test-ops-retry-${Date.now()}`;
    const plain = await login(tenant);
    const deliveryId = await seedDelivery(`wh-sub-retry-${Date.now()}`, tenant, 'dead');

    expectForbidden(await plain.c.post<Refusal>(`${OPS}/webhooks/deliveries/${deliveryId}/retry`), 'retry');
    // the refused retry wrote no audit row
    expect(await storage.listAudit({ actionPrefix: 'operations.webhook.retry', resource: deliveryId })).toEqual([]);

    const superAdmin = await login(SUPER_TENANT);
    const retried = await superAdmin.c.post<{ retried: boolean }>(`${OPS}/webhooks/deliveries/${deliveryId}/retry`);
    expect(retried.status, JSON.stringify(retried.body)).toBe(202);
    expect(retried.body).toEqual({ retried: true });

    // the audited path: exactly one success row for THIS delivery
    const audit = await storage.listAudit({ actionPrefix: 'operations.webhook.retry', resource: deliveryId });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'operations.webhook.retry', resource: deliveryId, outcome: 'success' });

    // the row is pending + due again with a fresh budget
    const rows = await storage.listWebhookDeliveries({ subscriptionIds: undefined, limit: 1000 });
    const row = rows.find((d) => d.deliveryId === deliveryId);
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(0);
    // unknown delivery → 404
    const nope = await superAdmin.c.post<Refusal>(`${OPS}/webhooks/deliveries/nope/retry`);
    expect(nope.status).toBe(404);
    expect(nope.body.error).toBe('not_found');
  });
});
