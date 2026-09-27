/**
 * ADR 0393 Phase 2 — inbound webhook, ROUTE-level over a mocked GitHub broker:
 * HMAC gate (401 on bad/absent signature), ping ack, branch filter, skip-self
 * idempotency (actor marker + version tiebreak), redelivered-delivery no-op,
 * a full APPLY through the governed CAS write, the fail-closed basis check →
 * fallback branch (the A5 conflict class — the canvas moved past the repo's
 * last-synced version), invalid-model → fallback (typed rejection, canvas
 * untouched), and toggle-off honesty (404 — a lingering GitHub webhook cannot
 * keep mutating a tenant that turned code-sync off).
 */
import http from 'node:http';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

interface GhCall { method: string; url: string; body?: Record<string, unknown> }
const ghCalls: GhCall[] = [];
let ghResponder: (method: string, url: string) => { status: number; json: Record<string, unknown> };

vi.mock('../src/host/brokeredEgress.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/brokeredEgress.js')>();
  return {
    ...actual,
    brokeredFetch: vi.fn(async (_deps: unknown, opts: { method?: string; url: string; body?: string }) => {
      const method = opts.method ?? 'GET';
      ghCalls.push({ method, url: opts.url, ...(opts.body ? { body: JSON.parse(opts.body) as Record<string, unknown> } : {}) });
      const r = ghResponder(method, opts.url);
      return { outcome: 'sent', res: { status: r.status, json: async () => r.json } };
    }),
  };
});

const { createApp } = await import('../src/index.js');
const { saveConfig } = await import('../src/host/featureToggles/service.js');
const { getToggleDefault } = await import('../src/host/featureToggles/registry.js');
const { createCanvasForTenant, getCanvasForTenant } = await import('../src/host/canvasSurface.js');

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'app-builder', 'code-sync']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
}

const STATE = { name: 'S', screens: [{ id: 'home', name: 'Home', isInitial: true, components: [] }] };
const AB = (orgId: string) => `/v1/host/openwop-app/app-builder/orgs/${encodeURIComponent(orgId)}`;
const HOOK = (webhookId: string) => `/v1/host/openwop-app/app-builder-sync/webhook/${encodeURIComponent(webhookId)}`;

let n = 0;
async function boundCanvas(): Promise<{ owner: Client; orgId: string; canvasId: string; tenantId: string; webhookId: string; secret: string }> {
  const tenantId = `org:test-ab-hook-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: `own-${Date.now()}-${n++}@acme.test`, tenantId });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.app-builder', name: 'S', initialState: STATE });
  const bound = await owner.put(`${AB(org.body.orgId)}/canvases/${canvas.canvasId}/sync-binding`, { owner: 'octo', repo: 'my-app', branch: 'main', target: 'html-css' });
  expect(bound.status, JSON.stringify(bound.body)).toBe(201);
  return { owner, orgId: org.body.orgId, canvasId: canvas.canvasId, tenantId, webhookId: bound.body.binding.webhookId, secret: bound.body.webhookSecret };
}

let d = 0;
async function sendHook(webhookId: string, secret: string | null, payload: unknown, opts?: { event?: string; delivery?: string }): Promise<Res> {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': opts?.event ?? 'push',
    'x-github-delivery': opts?.delivery ?? `dlv-${Date.now()}-${d++}`,
  };
  if (secret !== null) headers['x-hub-signature-256'] = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const res = await fetch(`${BASE}${HOOK(webhookId)}`, { method: 'POST', headers, body: raw });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');

/** GitHub responder serving a model + manifest at the pushed ref. */
function repoResponder(model: unknown, manifest: unknown): void {
  ghCalls.length = 0;
  ghResponder = (m, url) => {
    if (m === 'GET' && url.includes('/contents/app.model.json')) return { status: 200, json: { content: b64(model) } };
    if (m === 'GET' && url.includes('/contents/.openwop/generated.json')) return manifest === null ? { status: 404, json: {} } : { status: 200, json: { content: b64(manifest) } };
    if (m === 'POST' && url.endsWith('/git/refs')) return { status: 201, json: {} };
    return { status: 500, json: {} };
  };
}

const pushPayload = (over?: Record<string, unknown>) => ({
  ref: 'refs/heads/main',
  after: 'a'.repeat(40),
  head_commit: { id: 'a'.repeat(40), message: 'edit app.model.json by hand' },
  ...over,
});

describe('inbound webhook — auth + routing gates', () => {
  it('401s a bad/absent signature; 404s an unknown webhook id; acks ping', async () => {
    const { webhookId, secret } = await boundCanvas();
    expect((await sendHook(webhookId, 'wrong-secret', pushPayload())).status).toBe(401);
    expect((await sendHook(webhookId, null, pushPayload())).status).toBe(401);
    expect((await sendHook('does-not-exist', secret, pushPayload())).status).toBe(404);
    const ping = await sendHook(webhookId, secret, { zen: 'Design for failure.' }, { event: 'ping' });
    expect(ping.status).toBe(200);
    expect(ping.body.outcome).toBe('ack');
  });

  it('ignores pushes to a non-active branch', async () => {
    const { webhookId, secret } = await boundCanvas();
    const res = await sendHook(webhookId, secret, pushPayload({ ref: 'refs/heads/other' }));
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('ignored');
  });
});

describe('inbound webhook — idempotency (the ADR Phase 2 gate)', () => {
  it('skips our own echo (actor marker + matching version), no GitHub reads', async () => {
    const { webhookId, secret } = await boundCanvas();
    ghCalls.length = 0;
    const res = await sendHook(webhookId, secret, pushPayload({
      head_commit: { id: 'b'.repeat(40), message: 'Sync from OpenWOP App Builder\n\n[openwop-sync] model-version=1' },
    }));
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('skipped_self');
    expect(ghCalls.length).toBe(0); // ack'd and dropped — no build, no fetch
  });

  it('a REDELIVERED webhook (same delivery id) is a no-op duplicate ack', async () => {
    const { webhookId, secret, tenantId, canvasId } = await boundCanvas();
    const model = { name: 'FromGit', screens: [{ id: 'home', name: 'Home', isInitial: true, components: [] }] };
    repoResponder(model, { modelVersion: 1, paths: [] });
    const delivery = `dlv-redeliver-${Date.now()}`;
    const first = await sendHook(webhookId, secret, pushPayload(), { delivery });
    expect(first.body.outcome).toBe('applied');
    const canvasAfter = await getCanvasForTenant(tenantId, canvasId);
    const again = await sendHook(webhookId, secret, pushPayload(), { delivery });
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe('duplicate');
    // nothing changed on the second receipt
    expect((await getCanvasForTenant(tenantId, canvasId))!.version).toBe(canvasAfter!.version);
  });
});

describe('inbound webhook — apply + fail-closed rejections', () => {
  it('APPLIES a valid pushed model through the governed CAS write', async () => {
    const { webhookId, secret, tenantId, canvasId } = await boundCanvas();
    const model = { name: 'FromGit', screens: [{ id: 'home', name: 'Home', isInitial: true, components: [] }] };
    repoResponder(model, { modelVersion: 1, paths: [] });
    const res = await sendHook(webhookId, secret, pushPayload());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.outcome).toBe('applied');
    const canvas = await getCanvasForTenant(tenantId, canvasId);
    expect((canvas!.state as { name: string }).name).toBe('FromGit');
    expect(canvas!.version).toBe(2); // CAS advanced
  });

  it('basis mismatch (canvas moved past the repo) → fallback branch, canvas untouched', async () => {
    const { webhookId, secret, tenantId, canvasId } = await boundCanvas();
    const model = { name: 'Clobber', screens: [{ id: 'home', name: 'Home', isInitial: true, components: [] }] };
    repoResponder(model, { modelVersion: 99, paths: [] }); // stale basis
    const res = await sendHook(webhookId, secret, pushPayload());
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('fallback_basis');
    expect(typeof res.body.fallbackBranch).toBe('string');
    expect(res.body.fallbackBranch).toMatch(/^openwop-sync-\d+$/);
    // the fallback ref points at the pushed commit; the canvas is untouched
    const refCreate = ghCalls.find((c) => c.method === 'POST' && c.url.endsWith('/git/refs'));
    expect(refCreate?.body?.sha).toBe('a'.repeat(40));
    const canvas = await getCanvasForTenant(tenantId, canvasId);
    expect((canvas!.state as { name: string }).name).toBe('S');
    expect(canvas!.version).toBe(1);
  });

  it('an INVALID model is a typed rejection → fallback branch, never a partial apply', async () => {
    const { webhookId, secret, tenantId, canvasId } = await boundCanvas();
    const invalid = { name: 'Bad', screens: 'not-an-array' };
    repoResponder(invalid, { modelVersion: 1, paths: [] });
    const res = await sendHook(webhookId, secret, pushPayload());
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('fallback_invalid');
    const canvas = await getCanvasForTenant(tenantId, canvasId);
    expect((canvas!.state as { name: string }).name).toBe('S');
    expect(canvas!.version).toBe(1);
  });

  it('a missing manifest fails CLOSED (basis unknown → fallback, not apply)', async () => {
    const { webhookId, secret } = await boundCanvas();
    const model = { name: 'NoBasis', screens: [{ id: 'home', name: 'Home', isInitial: true, components: [] }] };
    repoResponder(model, null);
    const res = await sendHook(webhookId, secret, pushPayload());
    expect(res.body.outcome).toBe('fallback_basis');
  });
});

describe('inbound webhook — toggle honesty', () => {
  it('404s once the tenant turns code-sync off (a lingering webhook cannot mutate)', async () => {
    const { webhookId, secret } = await boundCanvas();
    const def = getToggleDefault('code-sync');
    if (def) await saveConfig({ ...def, status: 'off' }, 'test');
    try {
      expect((await sendHook(webhookId, secret, pushPayload())).status).toBe(404);
    } finally {
      if (def) await saveConfig({ ...def, status: 'on' }, 'test');
    }
  });
});
