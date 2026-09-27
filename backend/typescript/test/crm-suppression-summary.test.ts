/**
 * CRM suppression-cause analytics (ADR 0251 — the ADR 0241 §Deferred
 * "bounce/complaint analytics" open item). A read PROJECTION over the same rows
 * `listSuppressions` returns:
 *   - grouped by reason (the cause) + a coarse source bucket from the actor;
 *   - counts + timestamps only, NO addresses (no PII in the summary);
 *   - surfaced via an authed route + a chat-drivable CRM node (no new dashboard).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { addSuppression, suppressionSummary, __clearSuppressions } from '../src/features/crm/suppressionService.js';

type NodeFn = (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }>;

const T = 'crm-suppression-test';
let BASE: string;
let server: http.Server;
let crmNodes: Record<string, NodeFn>;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  // createApp initializes host-ext persistence (the DurableCollection store).
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
  // @ts-expect-error — untyped .mjs pack module (loaded the way the runtime does)
  crmNodes = (await import('../../../packs/feature.crm.nodes/index.mjs')).nodes;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0251 — suppression summary projection', () => {
  beforeEach(async () => { await __clearSuppressions(); });

  it('groups by reason (the cause) + coarse source bucket, counts only, newest timestamp', async () => {
    await addSuppression(T, 'a@x.com', 'bounced', 'webhook:sendgrid', 'hard');
    await addSuppression(T, 'b@x.com', 'bounced', 'webhook:sendgrid:soft-escalation', 'soft n=5/5');
    await addSuppression(T, 'c@x.com', 'complaint', 'webhook:postmark', 'spam');
    await addSuppression(T, 'd@x.com', 'unsubscribed', 'campaign:cmp-1', 'unsub');
    await addSuppression(T, 'e@x.com', 'manual', 'user:admin', 'manual add');

    const s = await suppressionSummary(T);
    expect(s.total).toBe(5);
    expect(s.byReason).toEqual({ bounced: 2, complaint: 1, unsubscribed: 1, manual: 1 });
    // Source buckets: soft-escalation is distinct from an immediate hard webhook bounce.
    const bySource = Object.fromEntries(s.bySource.map((r) => [r.source, r.count]));
    expect(bySource).toEqual({ webhook: 2, 'soft-escalation': 1, campaign: 1, user: 1 });
    expect(s.bySource[0]).toEqual({ source: 'webhook', count: 2 }); // highest first
    expect(s.newestAt).not.toBeNull();
    expect(JSON.stringify(s)).not.toContain('@x.com'); // no addresses leak
  });

  it('is empty-safe (zeroed reasons, null newest)', async () => {
    const s = await suppressionSummary(T);
    expect(s).toEqual({ total: 0, byReason: { unsubscribed: 0, bounced: 0, complaint: 0, manual: 0 }, bySource: [], newestAt: null });
  });

  it('the CRM node wraps the surface method', async () => {
    await addSuppression(T, 'n@x.com', 'bounced', 'webhook:sendgrid', 'hard');
    const ctx = { features: { crm: { listCompanies: () => {}, suppressionSummary: async () => ({ summary: await suppressionSummary(T) }) } }, config: {}, inputs: {} };
    const out = await crmNodes['feature.crm.nodes.suppression-summary'](ctx);
    expect(out.status).toBe('success');
    const summary = out.outputs?.summary as { total: number; byReason: Record<string, number> };
    expect(summary.total).toBe(1);
    expect(summary.byReason.bounced).toBe(1);
  });
});

describe('ADR 0251 — suppression summary route (auth + toggle gate)', () => {
  const enableCrm = async (status: 'on' | 'off'): Promise<void> => {
    const def = getToggleDefault('crm');
    if (def) await saveConfig({ ...def, status }, 'test');
  };

  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };

  it('returns the grouped summary for the caller tenant; toggle-off is gated', async () => {
    await enableCrm('on');
    const login = await call('POST', '/v1/host/openwop-app/test/login', { email: `sup-${Date.now()}@acme.test`, tenantId: `org:sup-${Date.now()}` });
    expect(login.status).toBe(201);

    await call('POST', '/v1/host/openwop-app/crm/suppressions', { email: 'one@acme.test', reason: 'bounced' });
    await call('POST', '/v1/host/openwop-app/crm/suppressions', { email: 'two@acme.test', reason: 'manual' });

    const r = await call('GET', '/v1/host/openwop-app/crm/suppressions/summary');
    expect(r.status).toBe(200);
    expect(r.body.summary.total).toBe(2);
    expect(r.body.summary.byReason.bounced).toBe(1);
    expect(r.body.summary.byReason.manual).toBe(1);

    await enableCrm('off');
    const gated = await call('GET', '/v1/host/openwop-app/crm/suppressions/summary');
    expect(gated.status).toBe(404);
    await enableCrm('on');
  });
});
