/**
 * CDP-F audit-chain verify route (ADR 0301) —
 *   GET /v1/host/openwop-app/cdp/audit-chain/verify
 * Toggle-gated (cdp OFF ⇒ 404), admin-gated (a non-admin acting member ⇒ 403),
 * tenant-scoped: reports the tenant's chain intact / brokenAt.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { recordConsent } from '../src/features/consent/consentService.js';
import { __tamperEntryForTest } from '../src/host/auditChainService.js';

let BASE: string; let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u = getToggleDefault('users'); if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: any }
function client() {
  let cookie = '';
  const call = async (m: string, p: string, b?: unknown, headers: Record<string, string> = {}): Promise<Res> => {
    const res = await fetch(`${BASE}${p}`, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const mm = /(__session=[^;]+)/.exec(c); if (mm) cookie = mm[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return {
    get: (p: string, headers?: Record<string, string>) => call('GET', p, undefined, headers),
    post: (p: string, b?: unknown) => call('POST', p, b),
  };
}
let n = 0;
async function ownerOn(tenantId: string) {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `ac-${Date.now()}-${n++}@a.test`, tenantId });
  expect(r.status).toBe(201);
  return c;
}
const setToggle = async (id: string, s: 'on' | 'off') => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: s }, 'test'); };
const VERIFY = '/v1/host/openwop-app/cdp/audit-chain/verify';

describe('CDP-F audit-chain verify route', () => {
  it('is toggle-gated (cdp OFF ⇒ 404)', async () => {
    await setToggle('cdp', 'off');
    const c = await ownerOn(`org:ac-off-${Date.now()}`);
    expect((await c.get(VERIFY)).status).toBe(404);
    await setToggle('cdp', 'on');
  });

  it('an owner sees ok:true after a consent change, and brokenAt after tampering', async () => {
    await setToggle('cdp', 'on');
    const tenantId = `org:ac-ok-${Date.now()}`;
    const c = await ownerOn(tenantId);
    // Seed a consent change → a consent.change entry lands on this tenant's chain.
    await recordConsent({ tenantId, subjectKey: 'sub-x', categories: { analytics: true }, source: 'test' });

    const ok = await c.get(VERIFY);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.length).toBeGreaterThanOrEqual(1); // genesis (0) + at least the consent append (1)

    // Tamper the consent entry (seq 1) in the store → verify now reports it broken.
    await __tamperEntryForTest(tenantId, 1, (e) => ({ ...e, payload: { subjectKey: 'HACKED' } }));
    const broken = await c.get(VERIFY);
    expect(broken.status).toBe(200);
    expect(broken.body.ok).toBe(false);
    expect(broken.body.brokenAt).toBe(1);
  });

  it('is admin-gated (a non-admin acting member ⇒ 403)', async () => {
    await setToggle('cdp', 'on');
    const c = await ownerOn(`org:ac-403-${Date.now()}`);
    // An act-as header for a member that has no role resolves to zero roles ⇒ 403.
    const r = await c.get(VERIFY, { 'x-openwop-act-as': 'mem:nobody' });
    expect(r.status).toBe(403);
  });
});
