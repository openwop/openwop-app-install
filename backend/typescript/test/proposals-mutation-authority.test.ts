/**
 * ADR 0736 (PROPC-MUTATE-AUTHZ) — mutating a proposal needs authority.
 *
 * `assertCanApply` gated exactly one action. revise/reject/archive read only
 * `tenantOf(req)` and the id, so ANY member of the tenant could swap the
 * `artifact` of a proposal someone else raised — and `artifact` is "the byte
 * image last persisted … installed verbatim at apply" (`types.ts:46`). The
 * applied thing need not be the reviewed thing.
 *
 * The surface is UNADVERTISED BUT REACHABLE: `feature.ts:6-9` serves it
 * unconditionally and `OPENWOP_PROPOSALS_ENABLED` gates only the capability
 * advertisement (`discovery.ts:1872`). The `routes.ts` header claimed production
 * 404s these; it does not, and this ADR corrects it.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { putProposal, getProposal } from '../src/features/proposals/proposalsService.js';
import type { Proposal } from '../src/features/proposals/types.js';

const P = '/v1/host/openwop-app/proposals';
let server: http.Server;
let ORIGIN = '';
let WS = '';
let n = 0;

interface C { userId: string; get: (p: string) => Promise<any>; patch: (p: string, b?: unknown) => Promise<any>; del: (p: string) => Promise<any>; post: (p: string, b?: unknown) => Promise<any> }

async function loginTo(tenantId: string, who: string): Promise<C> {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${ORIGIN}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  const r = await call('POST', '/v1/host/openwop-app/test/login', { email: `${who}-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return {
    userId: r.body.user.userId,
    get: (p) => call('GET', p), patch: (p, b) => call('PATCH', p, b),
    del: (p) => call('DELETE', p), post: (p, b) => call('POST', p, b),
  };
}

/** A draft proposal, optionally owned by a specific principal. */
async function seed(principal?: string): Promise<string> {
  const id = `wg:auth-${n++}`;
  const row: Proposal = {
    id, kind: 'prompt-template', state: 'draft',
    title: 'Original title',
    artifact: { template: 'ORIGINAL', variables: [] },
    provenance: { sourceRunIds: ['r1'] },
    duplicateOf: null,
    owner: { tenant: WS, ...(principal ? { principal } : {}) },
    createdAt: new Date().toISOString(),
  };
  await putProposal(row);
  return id;
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_PROPOSALS_ENABLED = 'true';
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { ORIGIN = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const ws = await createWorkspace({ name: 'proposals-authz', ownerSubject: 'oidc:prop-founder' });
  WS = ws.orgId ?? ws.tenantId;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0736 D1 — a caller without workspace:write cannot mutate', () => {
  it('revise, reject and archive are all 403, and the artifact is untouched', async () => {
    const id = await seed();
    const viewer = await loginTo(WS, 'viewer');
    await createMember({ orgId: WS, tenantId: WS, displayName: 'V', subject: viewer.userId, roles: ['viewer'] });

    const revise = await viewer.patch(`${P}/${id}`, { title: 'HIJACKED', artifact: { template: 'SWAPPED' } });
    expect(revise.status, `a viewer revised a proposal: ${JSON.stringify(revise.body)}`).toBe(403);
    expect((await viewer.post(`${P}/${id}/reject`)).status).toBe(403);
    expect((await viewer.del(`${P}/${id}`)).status).toBe(403);

    const row = await getProposal(WS, id);
    expect(row?.artifact?.template, 'the refused revise must not have written').toBe('ORIGINAL');
    expect(row?.state).toBe('draft');
  });
});

describe('ADR 0736 D2 — a writer cannot mutate SOMEONE ELSE\'S proposal', () => {
  it('a different principal is refused with `not-proposer`, and the artifact survives', async () => {
    const owner = await loginTo(WS, 'owner');
    const other = await loginTo(WS, 'other');
    await createMember({ orgId: WS, tenantId: WS, displayName: 'O', subject: owner.userId, roles: ['editor'] });
    await createMember({ orgId: WS, tenantId: WS, displayName: 'X', subject: other.userId, roles: ['editor'] });
    const id = await seed(owner.userId);

    const r = await other.patch(`${P}/${id}`, { artifact: { template: 'SWAPPED' } });
    expect(r.status, `another writer swapped the artifact: ${JSON.stringify(r.body)}`).toBe(403);
    expect(JSON.stringify(r.body)).toContain('not-proposer');
    expect((await getProposal(WS, id))?.artifact?.template).toBe('ORIGINAL');
  });

  it('...and the PROPOSER may revise their own (the gate has an exit)', async () => {
    const owner = await loginTo(WS, 'owner2');
    await createMember({ orgId: WS, tenantId: WS, displayName: 'O2', subject: owner.userId, roles: ['editor'] });
    const id = await seed(owner.userId);
    const r = await owner.patch(`${P}/${id}`, { title: 'Revised by the proposer' });
    expect(r.status, `the proposer was refused their own row: ${JSON.stringify(r.body)}`).toBe(200);
    expect((await getProposal(WS, id))?.title).toBe('Revised by the proposer');
  });
});

describe('ADR 0736 D3 — the two deliberate exits', () => {
  it('a row with NO owner.principal stays mutable by any writer (else the seeder is stranded)', async () => {
    const writer = await loginTo(WS, 'writer');
    await createMember({ orgId: WS, tenantId: WS, displayName: 'W', subject: writer.userId, roles: ['editor'] });
    const id = await seed(); // no principal — the demo-seeder shape
    const r = await writer.patch(`${P}/${id}`, { title: 'Adopted' });
    expect(r.status, `an ownerless proposal was stranded: ${JSON.stringify(r.body)}`).toBe(200);
  });

  it('host:members:manage overrides ownership (an admin must be able to archive a departed member\'s row)', async () => {
    const departed = await loginTo(WS, 'departed');
    const admin = await loginTo(WS, 'admin');
    await createMember({ orgId: WS, tenantId: WS, displayName: 'D', subject: departed.userId, roles: ['editor'] });
    await createMember({ orgId: WS, tenantId: WS, displayName: 'A', subject: admin.userId, roles: ['admin'] });
    const id = await seed(departed.userId);
    const r = await admin.del(`${P}/${id}`);
    expect(r.status, `an admin could not archive a departed member's row: ${JSON.stringify(r.body)}`).toBe(200);
  });
});

describe('ADR 0736 D4 — reads stay open (the omission is a decision)', () => {
  it('a viewer can still list and fetch within their own tenant', async () => {
    const id = await seed();
    const viewer = await loginTo(WS, 'reader');
    await createMember({ orgId: WS, tenantId: WS, displayName: 'R', subject: viewer.userId, roles: ['viewer'] });
    expect((await viewer.get(P)).status).toBe(200);
    const one = await viewer.get(`${P}/${id}`);
    expect(one.status).toBe(200);
    expect(one.body?.id).toBe(id);
  });

  it('an unknown id is 404 for a writer — the gate did not turn a miss into a 403', async () => {
    const writer = await loginTo(WS, 'w404');
    await createMember({ orgId: WS, tenantId: WS, displayName: 'W4', subject: writer.userId, roles: ['editor'] });
    expect((await writer.patch(`${P}/wg:no-such-row`, { title: 'x' })).status).toBe(404);
  });
});
