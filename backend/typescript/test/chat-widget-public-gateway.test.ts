/**
 * ADR 0127 Phase 2b/2d/3 — the UNAUTHENTICATED public widget gateway (origin-allowlisted,
 * token-gated, PUB-1 CORS). Breaks if the public config leaks the token/tenant, if an
 * off-allowlist or absent Origin/Referer is served, if an unknown token is not a uniform
 * 404, if a bad message or an exhausted cap reaches dispatch, or if a public path
 * grants CORS credentials.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { provisionWidget } from '../src/features/chat-widget/widgetService.js';

let server: http.Server;
let BASE: string;
let TOKEN = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const w = await provisionWidget('t-widget', 'org-w', 'admin', { agentId: 'vendor.openwop-app.code-exec.agents.default', allowedDomains: ['acme.com'] });
  TOKEN = w.token;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const get = (path: string, headers: Record<string, string> = {}): Promise<Response> => fetch(`${BASE}${path}`, { headers });
const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
interface ErrBody { error?: string; details?: Record<string, unknown> }
/** The status AND the canonical envelope's code — a status alone could come from an
 *  unrelated layer (Express's no-route 404, the per-IP limiter, the dispatch). */
const expectError = async (res: Response, status: number, code: string): Promise<ErrBody> => {
  expect(res.status).toBe(status);
  const body = (await res.json()) as ErrBody;
  expect(body.error).toBe(code);
  return body;
};

describe('public widget gateway', () => {
  it('serves the PUBLIC config to an allowed origin (no token/tenant leaked)', async () => {
    const res = await get(`/host/openwop-app/public/widget/config?token=${TOKEN}`, { origin: 'https://app.acme.com' });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.agentId).toBe('vendor.openwop-app.code-exec.agents.default');
    expect(body.token).toBeUndefined();   // no credential leak
    expect(body.tenantId).toBeUndefined(); // no tenant leak
  });

  it('403s an origin NOT on the allowlist (default-deny)', async () => {
    await expectError(await get(`/host/openwop-app/public/widget/config?token=${TOKEN}`, { origin: 'https://evil.com' }), 403, 'forbidden');
  });

  it('403s with no Origin/Referer (default-deny)', async () => {
    await expectError(await get(`/host/openwop-app/public/widget/config?token=${TOKEN}`), 403, 'forbidden');
  });

  it('admits an allowlisted Referer when Origin is absent (the Origin/Referer fallback)', async () => {
    const ok = await get(`/host/openwop-app/public/widget/config?token=${TOKEN}`, { referer: 'https://app.acme.com/pricing' });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Record<string, unknown>).agentId).toBe('vendor.openwop-app.code-exec.agents.default');
    await expectError(await get(`/host/openwop-app/public/widget/config?token=${TOKEN}`, { referer: 'https://evil.com/x' }), 403, 'forbidden');
  });

  it('404s an unknown token (uniform — no existence oracle)', async () => {
    await expectError(await get('/host/openwop-app/public/widget/config?token=wgt_nope', { origin: 'https://acme.com' }), 404, 'not_found');
  });

  // PUB-1: the embed runs on arbitrary customer domains, so the public endpoints must
  // reflect ANY origin for NON-credentialed CORS even when an explicit OPENWOP_CORS_ORIGINS
  // allowlist is set (the allowlist gates only the credentialed cookie/SSE path).
  it('PUB-1: reflects an arbitrary origin (non-credentialed) even with an explicit CORS allowlist', async () => {
    process.env.OPENWOP_CORS_ORIGINS = 'https://only-this.example.com'; // does NOT include acme
    try {
      const res = await get(`/host/openwop-app/public/widget/config?token=${TOKEN}`, { origin: 'https://app.acme.com' });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('https://app.acme.com'); // reflected, not blocked
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();              // NEVER credentials on a public endpoint
      // The JSON POST preflight (OPTIONS) is also granted so the browser's preflight succeeds.
      const pre = await fetch(`${BASE}/host/openwop-app/public/widget/message`, {
        method: 'OPTIONS', headers: { origin: 'https://app.acme.com', 'access-control-request-method': 'POST' },
      });
      expect(pre.status).toBe(204);
      expect(pre.headers.get('access-control-allow-origin')).toBe('https://app.acme.com');
    } finally {
      delete process.env.OPENWOP_CORS_ORIGINS;
    }
  });
});

// ADR 0127 Phase 2d — the visitor dispatch. These assert the FAIL-CLOSED gates that
// fire BEFORE any LLM call (so no managed key is needed): unknown token → 404, bad
// origin → 403, bad input → 400/413, caps exceeded → 429.
describe('public widget dispatch (POST /widget/message) — fail-closed gates', () => {
  const MSG = '/host/openwop-app/public/widget/message';

  it('404s an unknown token (uniform)', async () => {
    await expectError(await post(MSG, { token: 'wgt_nope', message: 'hi' }, { origin: 'https://acme.com' }), 404, 'not_found');
  });

  it('403s an origin NOT on the allowlist', async () => {
    await expectError(await post(MSG, { token: TOKEN, message: 'hi' }, { origin: 'https://evil.com' }), 403, 'forbidden');
  });

  it('403s with no Origin/Referer (default-deny)', async () => {
    await expectError(await post(MSG, { token: TOKEN, message: 'hi' }), 403, 'forbidden');
  });

  it('400s a missing/empty message (valid token + origin)', async () => {
    const body = await expectError(await post(MSG, { token: TOKEN, message: '   ' }, { origin: 'https://acme.com' }), 400, 'validation_error');
    expect(body.details?.field).toBe('message');
  });

  it('413s an over-long message', async () => {
    const huge = 'x'.repeat(4001);
    const body = await expectError(await post(MSG, { token: TOKEN, message: huge }, { origin: 'https://acme.com' }), 413, 'validation_error');
    expect(body.details?.field).toBe('message');
  });

  it('429s when the per-session turn cap is exhausted (caps gate fires before dispatch)', async () => {
    const capped = await provisionWidget('t-widget', 'org-w', 'admin', { agentId: 'vendor.openwop-app.code-exec.agents.default', allowedDomains: ['acme.com'], caps: { maxTurnsPerSession: 1 } });
    // First turn consumes the cap — `checkWidgetTurn` increments BEFORE dispatch, so
    // the count sticks regardless of the (keyless) LLM outcome.
    const first = await post(MSG, { token: capped.token, message: 'hi', sessionId: 's-cap' }, { origin: 'https://acme.com' });
    expect(first.status).not.toBe(429); // the first turn is within the cap
    // Second turn on the same session → turn_cap → 429, denied before any dispatch.
    const res = await post(MSG, { token: capped.token, message: 'hi', sessionId: 's-cap' }, { origin: 'https://acme.com' });
    const body = await expectError(res, 429, 'rate_limited');
    expect(body.details?.reason).toBe('turn_cap'); // the CAP, not the per-IP limiter or the provider
  });
});

// ADR 0127 Phase 3 — the embed snippet. It is static (token read at runtime), so it
// serves unconditionally; the SECURITY surface is: JS content-type, textContent-only
// (no innerHTML → XSS-safe on the host page), and no secret baked in.
describe('public widget embed.js (Phase 3)', () => {
  it('serves vanilla JS with the JS content-type + cache header', async () => {
    const res = await get('/host/openwop-app/public/widget/embed.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/javascript/);
    expect(res.headers.get('cache-control') ?? '').toMatch(/max-age/);
  });
  it('is XSS-safe (textContent, never innerHTML) + wires the 2b/2d endpoints + no baked secret', async () => {
    const js = await (await get('/host/openwop-app/public/widget/embed.js')).text();
    expect(js).toContain('textContent');
    expect(js).not.toContain('innerHTML');
    expect(js).toContain('/widget/message');
    expect(js).toContain('data-token'); // token read at runtime, not baked
    expect(js).not.toMatch(/wgt_[a-zA-Z0-9]/); // no real token baked into the static snippet
  });
});
