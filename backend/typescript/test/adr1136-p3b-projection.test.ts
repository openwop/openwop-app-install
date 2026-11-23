/**
 * ADR 1136 P3b (D8) — the session read the trajectory viewer renders never
 * carries a typed value. A URL leaves the row as origin and path only: a query
 * string or fragment can carry what the person typed (a search box, a token in a
 * redirect). The open take-over and the person's own sign-in step are projected
 * with the host the browser reported, never a value.
 *
 * Proven twice with a known typed string: on `projectSession` directly, and
 * through the real `GET …/sessions/:id` route a member's browser calls.
 *
 * Sabotage witness: return `st.action.url` unchanged in projectSession → red in
 * both the direct case and the route case.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { projectSession, shownUrl } from '../src/features/computer-use/routes.js';
import { putSession, type CuSession } from '../src/features/computer-use/sessionStore.js';

const TYPED = 'hunter2-typed-value';
const row = (over: Partial<CuSession> = {}): CuSession => ({
  sessionId: `cu:p3b-${Math.random().toString(36).slice(2)}`, tenantId: 't', orgId: 'o', status: 'awaiting_takeover', task: 'Track my order',
  startUrl: `https://shop.example.com/search?q=${TYPED}#frag`,
  allowedOrigins: ['https://shop.example.com'],
  steps: [
    { action: { actionId: 'a1', kind: 'navigate', url: `https://shop.example.com/orders?token=${TYPED}`, description: 'Orders' }, tier: 'observe', decidedBy: 'auto', at: '2026-11-18T10:00:00.000Z' },
    // The step completeTakeover records when the person signs in themselves.
    { action: { actionId: 'takeover-1', kind: 'credential', url: 'https://login.example.com', description: 'Password' }, tier: 'commit', decidedBy: 'human', approvalInterruptId: 'i1', at: '2026-11-18T10:02:00.000Z' },
  ],
  pendingAction: { actionId: 'a2', kind: 'submit', url: `https://shop.example.com/track?id=${TYPED}#${TYPED}`, description: 'Track' },
  takeover: { n: 2, reason: 'credential', origin: 'https://login.example.com', label: 'Password', raisedAt: '2026-11-18T10:00:00.000Z', expiresAt: '2026-11-18T10:15:00.000Z' },
  createdBy: 'user:a', createdAt: '2026-11-18T10:00:00.000Z', updatedAt: '2026-11-18T10:00:00.000Z',
  ...over,
} as CuSession);

describe('ADR 1136 P3b — the trajectory projection', () => {
  it('every URL is origin and path only; the typed value never leaves the row', () => {
    const p = projectSession(row()) as Record<string, any>;
    expect(p.startUrl).toBe('https://shop.example.com/search');
    expect(p.steps[0].url).toBe('https://shop.example.com/orders');
    expect(p.pendingAction.url).toBe('https://shop.example.com/track');
    expect(JSON.stringify(p)).not.toContain(TYPED);
    expect(JSON.stringify(p)).not.toContain('#frag');
  });

  it('projects the open take-over and the sign-in step with the reported host and no value', () => {
    const p = projectSession(row()) as Record<string, any>;
    expect(p.takeover).toEqual({ n: 2, reason: 'credential', origin: 'https://login.example.com', label: 'Password', expiresAt: '2026-11-18T10:15:00.000Z' });
    expect(p.steps[1]).toMatchObject({ kind: 'credential', decidedBy: 'human', url: 'https://login.example.com/' });
    expect(projectSession(row({ takeover: undefined, status: 'running' }))).not.toHaveProperty('takeover');
  });

  it('a non-web or unparsable URL is omitted, not passed through', () => {
    expect(shownUrl('javascript:alert(1)')).toBeUndefined();
    expect(shownUrl('not a url')).toBeUndefined();
    expect(shownUrl(undefined)).toBeUndefined();
    expect(shownUrl('http://a.example/x?y=1')).toBe('http://a.example/x');
  });
});

describe('ADR 1136 P3b — GET …/sessions/:id, the route the viewer calls', () => {
  let server: http.Server;
  let BASE = '';
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    delete process.env.OPENWOP_DEMO_MODE;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr1136-p3b', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    for (const id of ['computer-use', 'users']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  }, 120_000);
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  it('the response a member reads carries no typed value, and the sign-in step names only its host', async () => {
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; text: string; json: Record<string, any> }> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
      const text = await res.text();
      let json: Record<string, any> = {};
      try { json = JSON.parse(text) as Record<string, any>; } catch { /* non-JSON */ }
      return { status: res.status, text, json };
    };
    const tenantId = `org:cu-p3b-${Date.now()}`;
    expect((await call('POST', '/host/openwop-app/test/login', { email: `p3b-${Date.now()}@acme.test`, tenantId })).status).toBe(201);
    const orgId = (await call('POST', '/host/openwop-app/orgs', { name: 'P3b' })).json.orgId as string;
    expect(orgId).toBeTruthy();
    const s = row({ tenantId, orgId });
    await putSession(s);

    const got = await call('GET', `/host/openwop-app/computer-use/orgs/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(s.sessionId)}`);
    expect(got.status).toBe(200);
    expect(got.json.session.steps, 'the route returned the seeded session').toHaveLength(2);
    expect(got.text).not.toContain(TYPED);
    expect(got.json.session.steps[1]).toMatchObject({ kind: 'credential', decidedBy: 'human', url: 'https://login.example.com/' });

    const list = await call('GET', `/host/openwop-app/computer-use/orgs/${encodeURIComponent(orgId)}/sessions`);
    expect(list.status).toBe(200);
    expect((list.json.sessions as Array<{ sessionId: string }>).some((x) => x.sessionId === s.sessionId), 'the list includes it').toBe(true);
    expect(list.text).not.toContain(TYPED);
  }, 60_000);
});
