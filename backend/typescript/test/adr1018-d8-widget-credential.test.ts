/**
 * ADR 1018 D8 — a public widget answers on the owner's own model key; the platform's
 * managed key is for a tenant listed in `OPENWOP_SUPERADMIN_TENANTS` only. ONE resolver
 * (`resolveWidgetCredential`) decides at create, PATCH and the public message turn.
 *
 * Breaks if:
 *  - a non-superadmin tenant with no own key can create a widget, or keep one serving
 *    through a PATCH (create/PATCH must 400 with `widget_byok_required`, naming the field);
 *  - turning a widget OFF is refused (it spends nothing);
 *  - a superadmin tenant, or any tenant with its own key, is refused;
 *  - a public turn for a refused widget reaches ANY dispatch (managed fallback), claims a
 *    cap, or leaves no log line naming the reason;
 *  - a BYOK widget's turn runs on the managed key instead of the tenant's own key;
 *  - a bound key that stops resolving falls back to managed, even for a superadmin.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';

const { managedCalls, byokCalls, toolRounds } = vi.hoisted(() => ({
  managedCalls: [] as Array<{ tenantId: string }>,
  byokCalls: [] as Array<{ provider: string; apiKey: string }>,
  toolRounds: [] as Array<{ lane: string; provider?: string; apiKey?: string }>,
}));
vi.mock('../src/providers/managedProvider.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/providers/managedProvider.js')>();
  return {
    ...real,
    dispatchManagedChat: vi.fn(async (req: { tenantId: string }) => {
      managedCalls.push({ tenantId: req.tenantId });
      return { provider: 'openwop-free', model: 'openwop-free', completion: 'managed-reply', usage: { inputTokens: 1, outputTokens: 1 } };
    }),
    dispatchManagedToolsRound: vi.fn(async () => { toolRounds.push({ lane: 'managed' }); return { text: 'managed-round', toolUses: [], finishReason: 'length' }; }),
  };
});
vi.mock('../src/aiProviders/aiProvidersHost.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/aiProviders/aiProvidersHost.js')>();
  return {
    ...real,
    toolsRoundDispatcher: (provider: string) => async (req: { apiKey: string }) => {
      toolRounds.push({ lane: 'byok', provider, apiKey: req.apiKey });
      return { text: 'byok-round', toolUses: [], finishReason: 'content_filter' };
    },
  };
});
vi.mock('../src/providers/dispatch.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/providers/dispatch.js')>();
  return {
    ...real,
    dispatchChat: vi.fn(async (req: { provider: string; apiKey: string }) => {
      byokCalls.push({ provider: req.provider, apiKey: req.apiKey });
      return { completion: 'byok-reply', usage: { inputTokens: 1, outputTokens: 1 } };
    }),
  };
});

import { createApp } from '../src/index.js';
import { resolveWidgetCredential, widgetToolsRound } from '../src/features/chat-widget/widgetCredential.js';
import { setChatByokConfig } from '../src/host/chatByokConfig.js';
import { removeSecret, setSecret } from '../src/byok/secretResolver.js';
import { listSelectableProviderIds, getDefaultModel } from '../src/providers/catalog.js';

let BASE: string;
let server: http.Server;
const AGENT = 'vendor.openwop-app.code-exec.agents.default';
const PRIOR_SUPERADMINS = process.env.OPENWOP_SUPERADMIN_TENANTS;
const NOW = '2026-10-31T00:00:00.000Z';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  if (PRIOR_SUPERADMINS === undefined) delete process.env.OPENWOP_SUPERADMIN_TENANTS; else process.env.OPENWOP_SUPERADMIN_TENANTS = PRIOR_SUPERADMINS;
  await new Promise<void>((res) => server.close(() => res()));
});
beforeEach(() => { managedCalls.length = 0; byokCalls.length = 0; toolRounds.length = 0; delete process.env.OPENWOP_SUPERADMIN_TENANTS; });

const superadmins = (...tenants: string[]): void => { process.env.OPENWOP_SUPERADMIN_TENANTS = tenants.join(','); };

/** A real stored key, bound as the workspace's active chat key (ADR 0517). */
async function bindOwnKey(tenantId: string): Promise<{ ref: string; key: string; provider: string }> {
  const provider = listSelectableProviderIds()[0]!;
  const ref = `byok:${provider}:widget-d8`;
  const key = `sk-widget-d8-${tenantId}`;
  await setSecret(ref, key, { tenantId });
  await setChatByokConfig({ tenantId }, { provider, model: getDefaultModel(provider), credentialRef: ref }, NOW);
  return { ref, key, provider };
}

interface Res { status: number; body: Record<string, unknown> | undefined }
interface Client { call: (method: string, p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  return {
    call: async (method, path, body) => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
      return { status: res.status, body: res.status === 204 ? undefined : ((await res.json().catch(() => undefined)) as Record<string, unknown> | undefined) };
    },
  };
}
let n = 0;
async function workspace(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:d8-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.call('POST', '/host/openwop-app/test/login', { email: `d8-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.call('POST', '/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body!.orgId as string, tenantId };
}
const widgetsPath = (orgId: string): string => `/host/openwop-app/chat-widget/orgs/${encodeURIComponent(orgId)}/widgets`;
const create = (c: Client, orgId: string): Promise<Res> => c.call('POST', widgetsPath(orgId), { agentId: AGENT, allowedDomains: ['acme.com'] });
const visit = (token: string, message: string): Promise<Response> =>
  fetch(`${BASE}/host/openwop-app/public/widget/message`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://www.acme.com' }, body: JSON.stringify({ token, message, sessionId: 'dddddddd-8888-4888-8888-dddddddddddd' }) });

function expectByokRequired(res: Res): void {
  expect(res.status, JSON.stringify(res.body)).toBe(400);
  expect(res.body).toMatchObject({ error: 'validation_error', details: { field: 'credential', code: 'widget_byok_required' } });
}

describe('ADR 1018 D8 — the resolver', () => {
  it('no own key: refused for a tenant, managed only for a listed superadmin', async () => {
    expect(await resolveWidgetCredential('org:d8-plain')).toEqual({ kind: 'refused', reason: 'no_own_key' });
    superadmins('org:d8-admin');
    expect(await resolveWidgetCredential('org:d8-admin')).toEqual({ kind: 'managed', userFacingProvider: 'openwop-free' });
    expect(await resolveWidgetCredential('org:d8-plain')).toMatchObject({ kind: 'refused' });
  });

  it('a managed chat binding is still refused for a non-superadmin', async () => {
    await setChatByokConfig({ tenantId: 'org:d8-managed' }, { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'managed:openwop-free' }, NOW);
    expect(await resolveWidgetCredential('org:d8-managed')).toEqual({ kind: 'refused', reason: 'managed_binding' });
  });

  it('an own key resolves to byok with that key; a key that stops resolving is refused, never managed', async () => {
    const t = 'org:d8-own';
    const { ref, key, provider } = await bindOwnKey(t);
    expect(await resolveWidgetCredential(t)).toMatchObject({ kind: 'byok', provider, credentialRef: ref, apiKey: key });
    superadmins(t); // even a superadmin does not fall back
    await removeSecret(ref, { tenantId: t });
    expect(await resolveWidgetCredential(t)).toEqual({ kind: 'refused', reason: 'key_unavailable' });
  });
});

describe('ADR 1018 D8 — create', () => {
  it('a non-superadmin tenant with no own key is refused, naming the field', async () => {
    const { owner, orgId } = await workspace();
    expectByokRequired(await create(owner, orgId));
    const list = await owner.call('GET', widgetsPath(orgId));
    expect(list.body!.widgets).toEqual([]); // nothing was stored
  });

  it('a superadmin tenant may create on the managed key', async () => {
    const { owner, orgId, tenantId } = await workspace();
    superadmins(tenantId);
    expect((await create(owner, orgId)).status).toBe(201);
  });

  it('a tenant with its own key may create', async () => {
    const { owner, orgId, tenantId } = await workspace();
    await bindOwnKey(tenantId);
    expect((await create(owner, orgId)).status).toBe(201);
  });
});

describe('ADR 1018 D8 — PATCH', () => {
  /** A widget created while its tenant was a superadmin, then delisted. */
  async function delistedWidget(): Promise<{ owner: Client; orgId: string; tenantId: string; widgetId: string; token: string }> {
    const ws = await workspace();
    superadmins(ws.tenantId);
    const w = await create(ws.owner, ws.orgId);
    expect(w.status).toBe(201);
    delete process.env.OPENWOP_SUPERADMIN_TENANTS;
    const widget = w.body!.widget as { widgetId: string; token: string };
    return { ...ws, widgetId: widget.widgetId, token: widget.token };
  }

  it('a PATCH that keeps a non-superadmin widget serving is refused; turning it off is not', async () => {
    const { owner, orgId, widgetId } = await delistedWidget();
    expectByokRequired(await owner.call('PATCH', `${widgetsPath(orgId)}/${widgetId}`, { businessName: 'Acme' }));
    const off = await owner.call('PATCH', `${widgetsPath(orgId)}/${widgetId}`, { enabled: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expectByokRequired(await owner.call('PATCH', `${widgetsPath(orgId)}/${widgetId}`, { enabled: true }));
  });

  it('a superadmin, or a tenant with its own key, may PATCH', async () => {
    const a = await delistedWidget();
    superadmins(a.tenantId);
    expect((await a.owner.call('PATCH', `${widgetsPath(a.orgId)}/${a.widgetId}`, { businessName: 'Acme' })).status).toBe(200);
    const b = await delistedWidget();
    await bindOwnKey(b.tenantId);
    expect((await b.owner.call('PATCH', `${widgetsPath(b.orgId)}/${b.widgetId}`, { businessName: 'Acme' })).status).toBe(200);
  });
});

describe('ADR 1018 D8 — the public turn (fail-closed)', () => {
  it('a non-superadmin managed widget stops answering: no dispatch at all, and a log line names the reason', async () => {
    const ws = await workspace();
    superadmins(ws.tenantId);
    const w = await create(ws.owner, ws.orgId);
    delete process.env.OPENWOP_SUPERADMIN_TENANTS;
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; });
    let res: Response;
    try { res = await visit((w.body!.widget as { token: string }).token, 'hello'); } finally { spy.mockRestore(); }
    expect(res.status).toBe(503); // the embed's generic "could not respond"
    expect(managedCalls).toEqual([]);
    expect(byokCalls).toEqual([]);
    const refused = lines.filter((l) => l.includes('widget_credential_refused')).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ level: 'warn', reasonCode: 'widget_no_own_key' });
  });

  it('a superadmin widget answers on the managed key', async () => {
    const ws = await workspace();
    superadmins(ws.tenantId);
    const w = await create(ws.owner, ws.orgId);
    const res = await visit((w.body!.widget as { token: string }).token, 'hello');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: 'managed-reply' });
    expect(managedCalls).toEqual([{ tenantId: ws.tenantId }]);
    expect(byokCalls).toEqual([]);
  });

  it('a BYOK widget answers on the tenant\'s own key, never the managed key', async () => {
    const ws = await workspace();
    const { key, provider } = await bindOwnKey(ws.tenantId);
    const w = await create(ws.owner, ws.orgId);
    const res = await visit((w.body!.widget as { token: string }).token, 'hello');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: 'byok-reply' });
    expect(byokCalls).toEqual([{ provider, apiKey: key }]);
    expect(managedCalls).toEqual([]);
  });
});

describe('ADR 1018 D8 — the anon tool lane rides the same credential', () => {
  it('a byok credential runs its tool round on the tenant key; managed on the managed round', async () => {
    const t = 'org:d8-tools';
    const { key, provider } = await bindOwnKey(t);
    const own = await resolveWidgetCredential(t);
    if (own.kind === 'refused') throw new Error('expected an own key');
    // ADR 1011 — the stop reason survives both lanes, or the tool loop cannot read it.
    expect(await widgetToolsRound(t, own, [{ role: 'user', content: 'hi' }], [])).toMatchObject({ text: 'byok-round', finishReason: 'content_filter' });
    expect(await widgetToolsRound(t, { kind: 'managed', userFacingProvider: 'openwop-free' }, [{ role: 'user', content: 'hi' }], [])).toMatchObject({ text: 'managed-round', finishReason: 'length' });
    expect(toolRounds).toEqual([{ lane: 'byok', provider, apiKey: key }, { lane: 'managed' }]);
  });
});
