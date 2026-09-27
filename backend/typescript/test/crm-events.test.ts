/**
 * CRM event + audit wiring end-to-end (ADR 0208 §1/§3):
 *   - host-event bindings CRUD (`routes/hostEvents.ts`): validation, 422 on an
 *     unresolvable workflow, cross-tenant delete 404.
 *   - a webhook subscribed to `host.crm.contact.created` gets a durable
 *     delivery row enqueued when a contact is created.
 *   - a binding from `host.crm.contact.created` to a real workflow starts a
 *     run stamped with `metadata.hostEvent` when a contact is created.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

let BASE: string;
let server: http.Server;
let app: Express;
let storage: Storage;
let workflowId: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
  const wk = getToggleDefault('crm');
  if (wk) await saveConfig({ ...wk, status: 'on' }, 'test');
  const wellKnown = (await (await fetch(`${BASE}/.well-known/openwop`)).json()) as { fixtures?: string[] };
  workflowId = wellKnown.fixtures?.[0] ?? 'openwop-app.uppercase';
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T = any> { status: number; body: T }
interface Client {
  get: (p: string) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
  del: (p: string) => Promise<Res>;
}
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const sc = getSetCookies(res.headers);
    for (const c of sc as string[]) {
      const m = /(__session=[^;]+)/.exec(c);
      if (m) cookie = m[1];
    }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: Client): Promise<{ userId: string; tenantId: string }> {
  const tenantId = `org:test-${Date.now()}-${n++}`;
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('crmev'), tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { userId: r.body.user.userId, tenantId };
}

const BINDINGS = '/v1/host/openwop-app/host-events/bindings';

describe('crm events — host-event bindings CRUD', () => {
  it('validates eventType, refuses an unresolvable workflow (422), and cross-tenant delete 404s', async () => {
    const a = client();
    await signup(a);

    // Non-host.* eventType → 400.
    const badType = await a.post(BINDINGS, { eventType: 'run.completed', workflowId });
    expect(badType.status).toBe(400);

    // Unknown workflow → 422.
    const badWorkflow = await a.post(BINDINGS, { eventType: 'host.crm.contact.created', workflowId: 'nope.does-not-exist' });
    expect(badWorkflow.status).toBe(422);

    // Valid → 201, listed.
    const created = await a.post(BINDINGS, { eventType: 'host.crm.contact.created', workflowId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.eventType).toBe('host.crm.contact.created');
    const list = await a.get(BINDINGS);
    expect(list.body.bindings.some((b: { bindingId: string }) => b.bindingId === created.body.bindingId)).toBe(true);

    // A different tenant cannot see or delete it.
    const b = client();
    await signup(b);
    const foreignList = await b.get(BINDINGS);
    expect(foreignList.body.bindings.some((x: { bindingId: string }) => x.bindingId === created.body.bindingId)).toBe(false);
    expect((await b.del(`${BINDINGS}/${created.body.bindingId}`)).status).toBe(404);

    // Owning tenant can delete it.
    expect((await a.del(`${BINDINGS}/${created.body.bindingId}`)).status).toBe(204);
  });
});

describe('crm events — webhook fanout on contact create', () => {
  it('enqueues a durable delivery row for a host.crm.contact.created subscriber', async () => {
    const a = client();
    await signup(a);

    const sub = await a.post('/v1/webhooks', { url: 'https://example.com/openwop-test/crm-events', events: ['host.crm.contact.created'] });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);

    const contact = await a.post('/v1/host/openwop-app/crm/contacts', { name: 'Webhook Target' });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);

    // Fire-and-forget dispatch — poll briefly for the enqueued delivery row.
    let found = false;
    for (let i = 0; i < 40 && !found; i++) {
      const claimed = await storage.claimDueWebhookDeliveries(`test-worker-${i}`, Date.now() + 1, 5000, 20);
      if (claimed.some((d) => d.subscriptionId === sub.body.webhookId && d.eventType === 'host.crm.contact.created')) found = true;
      else await new Promise((r) => setTimeout(r, 25));
    }
    expect(found).toBe(true);

    await a.del(`/v1/webhooks/${sub.body.webhookId}`);
  });
});

describe('crm events — webhook delivery ↔ triggered run correlation', () => {
  it('the delivered body eventId matches run.metadata.hostEvent.eventId for the same emit', async () => {
    const a = client();
    const { tenantId } = await signup(a);

    const sub = await a.post('/v1/webhooks', { url: 'https://example.com/openwop-test/crm-correlate', events: ['host.crm.contact.created'] });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    const binding = await a.post(BINDINGS, { eventType: 'host.crm.contact.created', workflowId });
    expect(binding.status, JSON.stringify(binding.body)).toBe(201);

    const contact = await a.post('/v1/host/openwop-app/crm/contacts', { name: 'Correlate Target' });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);

    // Collect both halves of the same emit: the delivery row's body eventId…
    let deliveredEventId: string | undefined;
    for (let i = 0; i < 40 && !deliveredEventId; i++) {
      const claimed = await storage.claimDueWebhookDeliveries(`corr-worker-${i}`, Date.now() + 1, 5000, 20);
      const row = claimed.find((d) => d.subscriptionId === sub.body.webhookId && d.eventType === 'host.crm.contact.created');
      if (row) deliveredEventId = (JSON.parse(row.payload) as { eventId?: string }).eventId;
      else await new Promise((r) => setTimeout(r, 25));
    }
    // …and the run the binding started.
    let runEventId: string | undefined;
    for (let i = 0; i < 40 && !runEventId; i++) {
      const runs = await storage.listRuns({ tenantId, limit: 50 });
      const run = runs.find((r) => (r.metadata as { hostEvent?: { bindingId?: string } } | undefined)?.hostEvent?.bindingId === binding.body.bindingId);
      runEventId = (run?.metadata as { hostEvent?: { eventId?: string } } | undefined)?.hostEvent?.eventId;
      if (!runEventId) await new Promise((r) => setTimeout(r, 25));
    }

    expect(deliveredEventId, 'delivered body carries the dispatcher eventId').toBeTruthy();
    expect(runEventId, 'triggered run carries the dispatcher eventId').toBeTruthy();
    // The correlation contract (ADR 0208 §1): ONE id across both fanouts.
    expect(deliveredEventId).toBe(runEventId);
    expect(deliveredEventId!.startsWith('hev:')).toBe(true);

    await a.del(`/v1/webhooks/${sub.body.webhookId}`);
    await a.del(`${BINDINGS}/${binding.body.bindingId}`);
  });
});

describe('crm events — binding dispatches a run', () => {
  it('a bound host.crm.contact.created binding starts a run stamped with metadata.hostEvent', async () => {
    const a = client();
    const { tenantId } = await signup(a);

    const binding = await a.post(BINDINGS, { eventType: 'host.crm.contact.created', workflowId });
    expect(binding.status, JSON.stringify(binding.body)).toBe(201);

    const contact = await a.post('/v1/host/openwop-app/crm/contacts', { name: 'Run Target' });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);

    let matched: RunRecord | undefined;
    for (let i = 0; i < 40 && !matched; i++) {
      const runs = await storage.listRuns({ tenantId, limit: 50 });
      matched = runs.find((r) => {
        const meta = r.metadata as { hostEvent?: { bindingId?: string } } | undefined;
        return meta?.hostEvent?.bindingId === binding.body.bindingId;
      });
      if (!matched) await new Promise((r) => setTimeout(r, 25));
    }
    expect(matched, 'expected a run stamped with metadata.hostEvent to appear').toBeTruthy();
    expect(matched?.workflowId).toBe(workflowId);

    await a.del(`${BINDINGS}/${binding.body.bindingId}`);
  });
});
