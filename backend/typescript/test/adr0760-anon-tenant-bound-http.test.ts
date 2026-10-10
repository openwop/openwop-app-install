/**
 * ADR 0760 (issue #4169) — an ANONYMOUS tenant (`anon:<sid>`, minted per visitor
 * by `cookieSession.ts`) at the HTTP boundary under major 2: the run id leaves
 * BOUND (`anon:<sid>/<opaque>`, `identity.md` §5 — "a host MUST NOT return a
 * bare v1 id in a major-2 response"), the path-projected, the raw and the legacy
 * BARE spellings all resolve for the owner, and another visitor is refused.
 *
 * ADR 0704 left these ids bare; `@openwop/cli`'s v2 audit (openwop-cli#46)
 * measured it live. The sibling for personal workspaces is
 * `adr0726-personal-tenant-http.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { mintAnonSession, signSession } from '../src/middleware/cookieSession.js';
import { projectBoundId } from '../src/host/boundIdProjection.js';

let server: http.Server; let base = '';
const anonCookie = (): { cookie: string; tenant: string } => {
  const s = mintAnonSession();
  return { cookie: `__session=${signSession(s)}`, tenant: s.tenantId };
};
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
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

describe('ADR 0760 — anonymous tenant on the major-2 wire', () => {
  it('POST /runs and GET /runs return the run id BOUND to the anon tenant (it used to be bare)', async () => {
    const me = anonCookie();
    const created = await req('POST', '/runs', me.cookie, { workflowId: 'conformance-noop', inputs: {} });
    expect(created.status, created.text.slice(0, 200)).toBe(201);
    const bound = String(created.json.runId);
    expect(bound.startsWith(`${me.tenant}/`), `bound to ${me.tenant}: ${bound}`).toBe(true);
    expect(bound).toMatch(/^anon:[A-Za-z0-9._~-]{1,128}\/[A-Za-z0-9._~-]{16,128}$/);

    const list = await req('GET', '/runs', me.cookie);
    expect(list.status, list.text.slice(0, 200)).toBe(200);
    const ids = ((list.json.runs ?? list.json.items ?? []) as Array<{ runId: string }>).map((r) => r.runId);
    expect(ids, 'the list carries the bound form').toContain(bound);
    expect(ids.every((id) => id.includes('/')), `no bare id in a major-2 list: ${ids.join(',')}`).toBe(true);
  });

  it('the projected, raw and decoded spellings all resolve for the owner; another visitor is refused', async () => {
    const me = anonCookie();
    const created = await req('POST', '/runs', me.cookie, { workflowId: 'conformance-noop', inputs: {} });
    const bound = created.json.runId as string;

    const projected = await req('GET', `/runs/${projectBoundId(bound)}`, me.cookie);
    expect(projected.status, projected.text.slice(0, 200)).toBe(200);
    expect(projected.json.runId).toBe(bound);

    const raw = await req('GET', `/runs/${encodeURIComponent(bound)}`, me.cookie);
    expect(raw.status, 'raw anon:x%2Fopaque accepted: ' + raw.text.slice(0, 160)).toBe(200);

    // The DECODED spelling, which is what a `%2F`-decoding proxy (Firebase Hosting)
    // forwards: `/runs/anon:<sid>/<opaque>`. `protocolVersion.ts` DECODED_BOUND_ID
    // admitted no `anon:` prefix, so through the public origin this was a route-miss
    // 404 while every other tenant's decoded id resolved (ADR 0812 P2b).
    const decoded = await req('GET', `/runs/${bound}`, me.cookie);
    expect(decoded.status, 'decoded anon:x/opaque accepted: ' + decoded.text.slice(0, 160)).toBe(200);
    expect(decoded.json.runId).toBe(bound);
    const decodedForeign = await req('GET', `/runs/${bound}`, anonCookie().cookie);
    expect(decodedForeign.status, 'the decoded spelling meets the same tenant guard').toBe(403);

    // ADR 0812 P3c-0: the "legacy BARE spelling still resolves" half was deleted —
    // a bare id on a major-2 path was admitted only while 1.x was served.

    const other = anonCookie();
    const foreign = await req('GET', `/runs/${projectBoundId(bound)}`, other.cookie);
    expect(foreign.status).toBe(403);
    expect(foreign.json?.error).toBe('id_tenant_mismatch');
  });

  it('`:fork` of an anonymous run: the op splits off a tenant that itself contains `:`, and the 201 carries BOUND ids', async () => {
    const me = anonCookie();
    const created = await req('POST', '/runs', me.cookie, { workflowId: 'conformance-noop', inputs: {} });
    const bound = created.json.runId as string;
    for (let i = 0; i < 50; i++) {
      const s = await req('GET', `/runs/${projectBoundId(bound)}`, me.cookie);
      if (['completed', 'failed', 'cancelled'].includes(String(s.json?.status))) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const fork = await req('POST', `/runs/${projectBoundId(bound)}:fork`, me.cookie, { mode: 'replay' });
    expect(fork.json?.error, 'the tenant guard must not misread `anon:` + `:fork`').not.toBe('id_tenant_mismatch');
    expect(fork.status, fork.text.slice(0, 200)).toBe(201);
    expect(String(fork.json.runId).startsWith(`${me.tenant}/`), `forked runId bound: ${fork.json.runId}`).toBe(true);
    expect(fork.json.sourceRunId).toBe(bound);
  });
});

