/**
 * ADR 0726 — a PERSONAL workspace (`user:<sha256[:32]>`, the tenant every
 * signed-in user lands in) at the HTTP boundary under major 2: every bound id
 * leaves projected (`user~3A…/<opaque>`), the projected AND the raw spelling
 * resolve on the accept path, `owner.tenant` is grammar-valid on the events
 * read, and a foreign personal tenant is still 403.
 *
 * No conformance scenario has ever run under a tenant outside the grammar —
 * `default` fits — which is how this stayed invisible until the payload audit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/index.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { projectBoundId } from '../src/host/boundIdProjection.js';

const H = 'a'.repeat(32);
const PERSONAL = `user:${H}`;
const WIRE = `user~3A${H}`;
let server: http.Server; let base = '';
// A REAL user row: the verifier resolves the session against it, and a
// personal tenant is implicitly owned only when `personalTenant === tenantId`.
const cookieFor = async (tenant: string, principalId: string): Promise<string> => {
  const user = await upsertFromPrincipal({ tenantId: tenant, principalId, source: 'oidc' });
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: tenant, tier: 'user', userId: user.userId, personalTenant: tenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
};
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function req(method: string, path: string, cookie: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'OpenWOP-Version': '2', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text(); let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text };
}

describe('ADR 0726 — personal workspace on the major-2 wire', () => {
  let me = '';
  beforeAll(async () => { me = await cookieFor(PERSONAL, 'oidc:me'); });
  it('POST /runs binds the runId under the PROJECTED personal tenant (it used to leave bare)', async () => {
    const r = await req('POST', '/runs', me, { workflowId: 'conformance-noop', inputs: {} });
    expect(r.status, r.text.slice(0, 200)).toBe(201);
    expect(String(r.json.runId)).toMatch(new RegExp(`^${WIRE}/[A-Za-z0-9._~-]{16,128}$`));
  });
  it('GET /runs/{~-projected} and GET /runs/{raw user:x%2Fopaque} both resolve the SAME run; a foreign personal tenant is 403', async () => {
    const created = await req('POST', '/runs', me, { workflowId: 'conformance-noop', inputs: {} });
    const bound = created.json.runId as string; const opaque = bound.split('/')[1]!;
    const a = await req('GET', `/runs/${projectBoundId(bound)}`, me);
    expect(a.status, a.text.slice(0, 200)).toBe(200); expect(a.json.runId).toBe(bound);
    const b = await req('GET', `/runs/${encodeURIComponent(`${PERSONAL}/${opaque}`)}`, me);
    expect(b.status, 'raw spelling accepted through the overlap: ' + b.text.slice(0, 160)).toBe(200); expect(b.json.runId).toBe(bound);
    const other = await cookieFor(`user:${'b'.repeat(32)}`, 'oidc:other');
    const c = await req('GET', `/runs/${projectBoundId(bound)}`, other);
    expect(c.status).toBe(403); expect(c.json?.error).toBe('id_tenant_mismatch');
  });
  it('the events read carries a grammar-valid owner.tenant / owner.subject.tenant', async () => {
    const created = await req('POST', '/runs', me, { workflowId: 'conformance-noop', inputs: {} });
    const bound = created.json.runId as string;
    const ev = await req('GET', `/runs/${projectBoundId(bound)}/events/poll`, me);
    expect(ev.status, ev.text.slice(0, 200)).toBe(200);
    const started = (ev.json.events as Array<{ type: string; payload: any }>).find((e) => e.type === 'run.started');
    expect(started, 'run.started on the read').toBeDefined();
    expect(started!.payload.owner?.tenant).toBe(WIRE);
    expect(started!.payload.owner?.subject?.tenant).toBe(WIRE);
  });
});
