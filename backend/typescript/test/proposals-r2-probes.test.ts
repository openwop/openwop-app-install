/**
 * Feature loop round 2, row 53 — the proposals (RFC 0096) probes.
 *
 * Every probe here was RED on `b0ff69efa` before the fix:
 *   - the lifecycle had no transition table, so a rejected or archived proposal
 *     could still be applied, and an applied one could be rejected or archived;
 *   - `apply` returned `installed:<kind>:<id>:<digest>` and set `state: applied`
 *     although nothing was installed anywhere;
 *   - `apply` read no revision, so it applied whatever was stored when the click
 *     landed, not what the reviewer saw;
 *   - `GET /proposals` wrote a demo proposal into every tenant that listed;
 *   - the reads checked no scope, and the agent tool answered without a person;
 *   - `agents.proposals` was advertised although `apply` could never install.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { agentsCapability } from '../src/routes/discovery.js';
import { putProposal, getProposal } from '../src/features/proposals/proposalsService.js';
import { PROPOSALS_LIST_TOOL_ID } from '../src/features/proposals/agentTools.js';
import type { Proposal, ProposalState } from '../src/features/proposals/types.js';

const P = '/host/openwop-app/proposals';
let server: http.Server;
let ORIGIN = '';
let WS = '';
let n = 0;

interface Res { status: number; body: any }
interface C { userId: string; get: (p: string) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; del: (p: string, b?: unknown) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> }

async function loginTo(tenantId: string, who: string): Promise<C> {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${ORIGIN}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  const r = await call('POST', '/host/openwop-app/test/login', { email: `${who}-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return {
    userId: r.body.user.userId,
    get: (p) => call('GET', p), patch: (p, b) => call('PATCH', p, b),
    del: (p, b) => call('DELETE', p, b), post: (p, b) => call('POST', p, b),
  };
}

async function seed(state: ProposalState, principal?: string, tenant = WS): Promise<string> {
  const id = `wg:r2-${n++}`;
  const row: Proposal = {
    id, kind: 'prompt-template', state,
    title: 'Original', artifact: { template: 'ORIGINAL', variables: [] },
    provenance: { sourceRunIds: ['r1'] }, duplicateOf: null,
    owner: { tenant, ...(principal ? { principal } : {}) },
    ...(state === 'applied' ? { activation: { approvalId: null, installedArtifactRef: 'installed:x' } } : {}),
    createdAt: new Date().toISOString(),
  };
  await putProposal(row);
  return id;
}

let admin: C;
let editor: C;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_PROPOSALS_ENABLED = 'true';
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { ORIGIN = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const ws = await createWorkspace({ name: 'proposals-r2', ownerSubject: 'oidc:prop-r2-founder' });
  WS = ws.orgId ?? ws.tenantId;
  admin = await loginTo(WS, 'admin');
  editor = await loginTo(WS, 'editor');
  await createMember({ orgId: WS, tenantId: WS, displayName: 'A', subject: admin.userId, roles: ['admin'] });
  await createMember({ orgId: WS, tenantId: WS, displayName: 'E', subject: editor.userId, roles: ['editor'] });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('PRB-1..5 — the lifecycle holds (no resurrection, no rewriting an applied record)', () => {
  it('PRB-1 a REJECTED proposal cannot be applied', async () => {
    const id = await seed('rejected');
    const seen = await admin.get(`${P}/${id}`);
    const r = await admin.post(`${P}/${id}/apply`, { revision: seen.body.revision ?? 0, artifactDigest: seen.body.artifactDigest ?? '' });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(JSON.stringify(r.body)).toContain('proposal_state_conflict');
    expect((await getProposal(WS, id))?.state).toBe('rejected');
  });
  it('PRB-2 an ARCHIVED proposal cannot be applied', async () => {
    const id = await seed('archived');
    const seen = await admin.get(`${P}/${id}`);
    const r = await admin.post(`${P}/${id}/apply`, { revision: seen.body.revision ?? 0, artifactDigest: seen.body.artifactDigest ?? '' });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect((await getProposal(WS, id))?.state).toBe('archived');
  });
  it('PRB-3 an APPLIED proposal cannot be rejected', async () => {
    const id = await seed('applied');
    const r = await admin.post(`${P}/${id}/reject`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect((await getProposal(WS, id))?.state).toBe('applied');
  });
  it('PRB-4 an APPLIED proposal cannot be archived', async () => {
    const id = await seed('applied');
    const r = await admin.del(`${P}/${id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body?.message, 'the refusal must read as English').toBe('This proposal is applied, so it cannot be archived.');
    expect((await getProposal(WS, id))?.state).toBe('applied');
  });
  it('PRB-5 a REJECTED proposal cannot be revised back open', async () => {
    const id = await seed('rejected', editor.userId);
    const r = await editor.patch(`${P}/${id}`, { title: 'reopened' });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect((await getProposal(WS, id))?.state).toBe('rejected');
  });
});

describe('PRB-6 — apply never claims an install that did not happen', () => {
  it('apply of a draft does not report `installed:` and does not flip the row to applied', async () => {
    const id = await seed('draft');
    const before = await admin.get(`${P}/${id}`);
    const r = await admin.post(`${P}/${id}/apply`, { revision: before.body.revision, artifactDigest: before.body.artifactDigest });
    expect(JSON.stringify(r.body), 'apply claimed an install').not.toContain('installed:');
    expect(r.status).toBe(409);
    expect(r.body?.details?.reason ?? r.body?.error?.details?.reason ?? JSON.stringify(r.body)).toContain('not_installable');
    const after = await getProposal(WS, id);
    expect(after?.state).toBe('draft');
    expect(after?.activation).toBeUndefined();
  });
});

describe('PRB-7 — apply binds to the revision the reviewer saw', () => {
  it('a revise between the read and the click makes the apply stale (409), never silently applied', async () => {
    const id = await seed('draft', editor.userId);
    const seen = await admin.get(`${P}/${id}`);
    expect(typeof seen.body.revision, 'the read must expose the revision it shows').toBe('number');
    expect(typeof seen.body.artifactDigest).toBe('string');
    const swap = await editor.patch(`${P}/${id}`, { artifact: { template: 'SWAPPED' }, revision: seen.body.revision });
    expect(swap.status, JSON.stringify(swap.body)).toBe(200);
    const r = await admin.post(`${P}/${id}/apply`, { revision: seen.body.revision, artifactDigest: seen.body.artifactDigest });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('proposal_stale');
  });
  it('an apply naming no revision is refused (400), not applied blind', async () => {
    const id = await seed('draft');
    const r = await admin.post(`${P}/${id}/apply`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(400);
  });
});

describe('PRB-8 — listing writes nothing', () => {
  it('GET /proposals in a fresh workspace seeds no demo row', async () => {
    const ws = await createWorkspace({ name: 'proposals-r2-fresh', ownerSubject: 'oidc:prop-r2-fresh' });
    const t = ws.orgId ?? ws.tenantId;
    const u = await loginTo(t, 'fresh');
    await createMember({ orgId: t, tenantId: t, displayName: 'F', subject: u.userId, roles: ['viewer'] });
    const r = await u.get(P);
    expect(r.status).toBe(200);
    expect(r.body.proposals).toEqual([]);
    expect(await getProposal(t, 'demo-reviewable-learning')).toBeNull();
  });
});

describe('PRB-9/10 — reads need workspace:read and validate their filters', () => {
  it('PRB-9 a caller with no role in the workspace cannot list or read', async () => {
    const id = await seed('draft');
    const stranger = await loginTo(WS, 'stranger');
    expect((await stranger.get(P)).status).toBe(403);
    expect((await stranger.get(`${P}/${id}`)).status).toBe(403);
  });
  it('PRB-10 an unknown state filter is a 400, not an empty list', async () => {
    expect((await admin.get(`${P}?state=live`)).status).toBe(400);
    expect((await admin.get(`${P}?kind=rule`)).status).toBe(400);
  });
});

describe('PRB-11 — the agent tool shares the route predicate', () => {
  const run = (scope: { actingUserId?: string }) =>
    createAgentToolProvider({ tenantId: WS, runId: 'run-prb11', ...scope }).executeTool({ name: PROPOSALS_LIST_TOOL_ID, input: {} });
  it('without an acting person the tool returns nothing', async () => {
    await seed('draft');
    const r = await run({});
    expect(JSON.parse(r.content).proposals ?? []).toEqual([]);
  });
  it('for a person with no role in the workspace the tool returns nothing', async () => {
    await seed('draft');
    const r = await run({ actingUserId: 'user:nobody-here' });
    expect(JSON.parse(r.content).proposals ?? []).toEqual([]);
  });
  it('without an acting person the tool returns nothing, even in a personal workspace', async () => {
    const personal = 'user:prb11-personal';
    await seed('draft', undefined, personal);
    const r = await createAgentToolProvider({ tenantId: personal, runId: 'run-prb11p', personalTenant: personal })
      .executeTool({ name: PROPOSALS_LIST_TOOL_ID, input: {} });
    expect(JSON.parse(r.content).proposals ?? []).toEqual([]);
  });
  it('for a member it lists', async () => {
    await seed('draft');
    const r = await run({ actingUserId: editor.userId });
    expect((JSON.parse(r.content).proposals as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('PRB-12 — advertisement follows what apply can do', () => {
  it('agents.proposals is not advertised while no artifact kind has an installer', () => {
    process.env.OPENWOP_PROPOSALS_ENABLED = 'true';
    expect(agentsCapability().proposals).toBeUndefined();
  });
});

describe('closing grade-code (PROP2CD-1..4)', () => {
  it('PROP2CD-1 one stored artifact JCS refuses does not 500 the list', async () => {
    const id = await seed('draft');
    const row = (await getProposal(WS, id))!;
    await putProposal({ ...row, artifact: { template: 'bad \ud800 surrogate' } });
    const r = await admin.get(P);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body.proposals as Array<{ id: string; artifactDigest: string }>).find((p) => p.id === id)?.artifactDigest).toMatch(/^[0-9a-f]{64}$/);
  });
  it('PROP2CD-2 a non-string title is a 400, not silently dropped', async () => {
    const id = await seed('draft', editor.userId);
    const r = await editor.patch(`${P}/${id}`, { title: 123 });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect((await getProposal(WS, id))?.state).toBe('draft');
  });
  it('PROP2CD-3 a caller with no role learns nothing from a by-id write, not even existence', async () => {
    const stranger = await loginTo(WS, 'stranger-2');
    for (const id of ['wg:does-not-exist', await seed('draft')]) {
      expect((await stranger.patch(`${P}/${id}`, { title: 'x' })).status).toBe(403);
      expect((await stranger.post(`${P}/${id}/reject`, {})).status).toBe(403);
      expect((await stranger.del(`${P}/${id}`)).status).toBe(403);
      expect((await stranger.post(`${P}/${id}/apply`, { revision: 0, artifactDigest: 'x' })).status).toBe(403);
    }
  });
  it('PROP2CD-4 an erasure that keeps losing the CAS is reported as a failure, not dropped', async () => {
    const { vi } = await import('vitest');
    const { DurableCollection } = await import('../src/host/hostExtPersistence.js');
    const { eraseSubjectProposals } = await import('../src/features/proposals/erasure.js');
    await seed('draft', 'user:cas-loser');
    const spy = vi.spyOn(DurableCollection.prototype, 'compareAndSwap').mockResolvedValue(false);
    try {
      await expect(eraseSubjectProposals(WS, 'user:cas-loser')).rejects.toThrow(/still name the subject/);
    } finally {
      spy.mockRestore();
    }
  });
});
