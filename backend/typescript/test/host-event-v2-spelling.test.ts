/**
 * ADR 0792 (NP-V2-10) — host events keep their in-process v1 names, and:
 *
 *  - a MAJOR-2 webhook subscriber receives the grammar-valid `openwop-app.…`
 *    spelling in every place the name appears (body `type`, the synthetic
 *    `runId`, and the delivery-row event type the worker puts in both headers);
 *  - a MAJOR-1 subscriber is byte-identical to before;
 *  - a subscription or binding may name the event in EITHER spelling;
 *  - P3: `host.webhook.response` (a RUN event) reads on major 2 as a registered
 *    vendor type instead of failing `500 event_type_unmapped`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { deliverHostExtEvent } from '../src/routes/webhooks.js';
import { emitHostEvent } from '../src/host/hostEventDispatcher.js';

let BASE: string;
let server: http.Server;
let app: Express;
let storage: Storage;
let workflowId: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  // ADR 0892: CRM is opt-in; the binding fixture emits a CRM event.
  { const d = getToggleDefault('crm'); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const wellKnown = (await (await fetch(`${BASE}/.well-known/openwop`)).json()) as { fixtures?: string[] };
  workflowId = wellKnown.fixtures?.[0] ?? 'openwop-app.uppercase';
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const LEGACY = 'host.crm.contact.created';
const V2 = 'openwop-app.crm.contact-created';

describe('webhook delivery projects the host-event name per protocol major (ADR 0792)', () => {
  // ADR 0812 P3c-0 — the major-1 subscription leg is deleted: a v1 subscription is not
  // delivered once v1 retires (ADR 0812 decision 2), so only the two major-2 legs remain.
  it('major 2 gets the v2 spelling everywhere; both spellings subscribe', async () => {
    const tenantId = `t-hev2-${Date.now()}`;
    const now = new Date().toISOString();
    const subs = [
      { subscriptionId: `s2-${tenantId}`, events: [LEGACY], protocolMajor: 2 as const },
      { subscriptionId: `s3-${tenantId}`, events: [V2], protocolMajor: 2 as const },
    ];
    for (const s of subs) {
      await storage.insertWebhook({
        subscriptionId: s.subscriptionId, tenantId, url: 'https://example.test/hook', events: s.events, secret: 'x'.repeat(32), createdAt: now,
        protocolMajor: s.protocolMajor,
      } as Parameters<Storage['insertWebhook']>[0]);
    }
    await deliverHostExtEvent({ type: LEGACY, tenantId, payload: { contactId: 'c1' } });
    const rows = await storage.listWebhookDeliveries({ subscriptionIds: subs.map((s) => s.subscriptionId) });
    const bySub = new Map(rows.map((r) => [r.subscriptionId, r]));
    expect(bySub.size, 'both subscriptions matched, including the v2-spelled one').toBe(2);

    for (const sub of [subs[0]!, subs[1]!]) {
      const row = bySub.get(sub.subscriptionId)!;
      expect(row.eventType, 'the worker puts this in both delivery headers').toBe(V2);
      expect(row.payload, 'no legacy spelling anywhere in a major-2 body').not.toContain(LEGACY);
      expect(row.payload).toContain(V2);
    }
  });
});

describe('the ONE egress serializer keeps the codemap precedence (ADR 0792 review)', () => {
  it('host.webhook.response leaves a major-2 webhook as openwop-app.webhook-response, matching what a v2 poll reads', async () => {
    const tenantId = `t-hev2p-${Date.now()}`;
    const now = new Date().toISOString();
    const subs = [
      { subscriptionId: `w1-${tenantId}`, events: ['*'] },
      { subscriptionId: `w2-${tenantId}`, events: ['openwop-app.webhook-response'] },
      { subscriptionId: `w3-${tenantId}`, events: ['openwop-app.webhook.response'] }, // the host-rule spelling must NOT match
    ];
    for (const s of subs) {
      await storage.insertWebhook({ subscriptionId: s.subscriptionId, tenantId, url: 'https://example.test/hook', events: s.events, secret: 'x'.repeat(32), createdAt: now, protocolMajor: 2 } as Parameters<Storage['insertWebhook']>[0]);
    }
    // deliverHostExtEvent reaches the same enqueueDelivery every run event uses.
    await deliverHostExtEvent({ type: 'host.webhook.response', tenantId, payload: {} });
    const rows = await storage.listWebhookDeliveries({ subscriptionIds: subs.map((s) => s.subscriptionId) });
    const bySub = new Map(rows.map((r) => [r.subscriptionId, r]));
    expect(bySub.has(subs[2]!.subscriptionId), 'the host-rule spelling is not a subscribable name for this run event').toBe(false);
    for (const sub of [subs[0]!, subs[1]!]) {
      const row = bySub.get(sub.subscriptionId);
      expect(row?.eventType).toBe('openwop-app.webhook-response');
      expect(row?.payload).toContain('"type":"openwop-app.webhook-response"');
    }
  });
});

describe('a binding may name the event in its v2 spelling (ADR 0792)', () => {
  it('a v2-spelled binding fires on the emitted in-process name', async () => {
    let cookie = '';
    const tenantId = `org:hev2-${Date.now()}`;
    const login = await fetch(`${BASE}/host/openwop-app/test/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `hev2-${Date.now()}@acme.test`, tenantId }),
    });
    for (const c of getSetCookies(login.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    const bound = await fetch(`${BASE}/host/openwop-app/host-events/bindings`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ eventType: V2, workflowId }),
    });
    expect(bound.status, await bound.clone().text()).toBe(201);
    const bindingId = ((await bound.json()) as { bindingId: string }).bindingId;

    await emitHostEvent({ type: LEGACY, tenantId, payload: { contactId: 'c2' } });
    let matched: RunRecord | undefined;
    for (let i = 0; i < 40 && !matched; i++) {
      const runs = await storage.listRuns({ tenantId, limit: 50 });
      matched = runs.find((r) => (r.metadata as { hostEvent?: { bindingId?: string } } | undefined)?.hostEvent?.bindingId === bindingId);
      if (!matched) await new Promise((r) => setTimeout(r, 25));
    }
    expect(matched, 'the v2-spelled binding started its workflow').toBeTruthy();
  });

  it('the bindings route still refuses a name that is neither host.… nor openwop-app.…', async () => {
    const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `hev2b-${Date.now()}@acme.test`, tenantId: `org:hev2b-${Date.now()}` }),
    });
    let cookie = '';
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    const bad = await fetch(`${BASE}/host/openwop-app/host-events/bindings`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ eventType: 'run.completed', workflowId }),
    });
    expect(bad.status).toBe(400);
  });
});

describe('P3 — host.webhook.response reads on major 2 (ADR 0792)', () => {
  it('a seeded log holding it is served under the registered vendor org', async () => {
    const V2H = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };
    const seed = await fetch(`${BASE}/conformance/seams/sample/event-log/seed`, {
      method: 'POST', headers: V2H,
      body: JSON.stringify({
        eventLogSchemaVersion: 2, status: 'completed',
        events: [
          { sequence: 0, type: 'run.started', payload: { workflowId: 'conformance-noop' } },
          { sequence: 1, type: 'host.webhook.response', nodeId: 'w', payload: { status: 200 } },
          { sequence: 2, type: 'run.completed', payload: {} },
        ],
      }),
    });
    expect(seed.status, await seed.clone().text()).toBeLessThan(300);
    const { runId } = (await seed.json()) as { runId: string };
    const read = await fetch(`${BASE}/runs/${encodeURIComponent(runId)}/events/poll?timeout=1`, { headers: V2H });
    expect(read.status, await read.clone().text()).toBe(200);
    const body = (await read.json()) as { events?: Array<{ type: string }> } | Array<{ type: string }>;
    const types = (Array.isArray(body) ? body : body.events ?? []).map((e) => e.type);
    expect(types).toContain('openwop-app.webhook-response');
    expect(types).not.toContain('host.webhook.response');
  });
});
