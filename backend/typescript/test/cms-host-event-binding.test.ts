/**
 * ADR 0592 §4 (CMSLWF-1 Blocker) — the six `host.cms.page.*` events are
 * offered on the operator event-binding surface, but CMS emitted straight
 * into `deliverHostExtEvent`, BYPASSING the ADR 0208 dispatcher whose
 * binding-match + `startWorkflowRun` leg is the only auto-start lane — so a
 * binding on any CMS event was accepted, listed, and silently never fired.
 *
 * Witnesses (the mechanism-vs-wiring lesson — witness the WIRING):
 *   - bind `host.cms.page.published` to a real workflow → publish a page →
 *     a run starts, stamped with `metadata.hostEvent.bindingId`;
 *   - the reroute must not DOUBLE-deliver webhooks: exactly ONE delivery row
 *     for the published event (the dispatcher's webhook leg rides the same
 *     `deliverHostExtEvent` seam CMS used to call directly).
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
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
  const wellKnown = (await (await fetch(`${BASE}/.well-known/openwop`)).json()) as { fixtures?: string[] };
  workflowId = wellKnown.fixtures?.[0] ?? 'openwop-app.uppercase';
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

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
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
async function ownerOrg(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:cmsbind-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `cmsbind-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}
const u = (orgId: string, s = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;
const BINDINGS = '/v1/host/openwop-app/host-events/bindings';

describe('host.cms.page.* rides the ADR 0208 dispatcher (ADR 0592 §4)', () => {
  it('a binding on host.cms.page.published starts the bound workflow when a page publishes', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();

    const binding = await owner.post(BINDINGS, { eventType: 'host.cms.page.published', workflowId });
    expect(binding.status, JSON.stringify(binding.body)).toBe(201);

    const created = await owner.post(u(orgId, '/pages'), { title: 'Bind me', sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
    expect(created.status).toBe(201);
    const pub = await owner.post(u(orgId, `/pages/${created.body.pageId}/publish`));
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);

    let matched: RunRecord | undefined;
    for (let i = 0; i < 40 && !matched; i++) {
      const runs = await storage.listRuns({ tenantId, limit: 50 });
      matched = runs.find((r) => {
        const meta = r.metadata as { hostEvent?: { bindingId?: string } } | undefined;
        return meta?.hostEvent?.bindingId === binding.body.bindingId;
      });
      if (!matched) await new Promise((r) => setTimeout(r, 25));
    }
    expect(matched, 'expected the CMS publish to start the bound workflow (metadata.hostEvent stamped)').toBeTruthy();
    expect(matched?.workflowId).toBe(workflowId);

    await owner.del(`${BINDINGS}/${binding.body.bindingId}`);
  });

  it('the reroute delivers each webhook exactly ONCE (no double delivery through the dispatcher leg)', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const sub = await owner.post('/v1/webhooks', { url: 'https://hooks.example.test/cms-once', events: ['host.cms.page.published'], tenantId });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);

    const created = await owner.post(u(orgId, '/pages'), { title: 'Once', sections: [] });
    const pub = await owner.post(u(orgId, `/pages/${created.body.pageId}/publish`));
    expect(pub.status).toBe(200);

    // Collect every delivery row enqueued for this subscription+page.
    const mine: string[] = [];
    for (let i = 0; i < 40; i++) {
      const claimed = await storage.claimDueWebhookDeliveries(`once-worker-${i}`, Date.now() + 1, 5000, 50);
      for (const d of claimed) {
        if (d.subscriptionId === sub.body.webhookId && d.eventType === 'host.cms.page.published' && d.payload.includes(created.body.pageId)) {
          mine.push(d.deliveryId);
        }
      }
      if (mine.length > 0) {
        // one settle round to catch a hypothetical second enqueue
        await new Promise((r) => setTimeout(r, 100));
        const extra = await storage.claimDueWebhookDeliveries('once-worker-final', Date.now() + 1, 5000, 50);
        for (const d of extra) {
          if (d.subscriptionId === sub.body.webhookId && d.eventType === 'host.cms.page.published' && d.payload.includes(created.body.pageId)) {
            mine.push(d.deliveryId);
          }
        }
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(new Set(mine).size, `deliveries: ${JSON.stringify(mine)}`).toBe(1);
  });
});
