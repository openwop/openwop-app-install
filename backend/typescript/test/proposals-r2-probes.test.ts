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
 *
 * Every refusal is asserted by code + reason (or message), never by status alone:
 * on this host EVERY apply that clears state and binding ends `409
 * proposal_not_installable`, so a bare 409 cannot tell a held transition from a
 * missing installer (PRB-2 was vacuous that way), and the apply route's read gate
 * is backed by its `packs:publish` gate (PROP2CD-3 now names `workspace:read`).
 * PRB-8 reads the RAW store: `getProposal` and the list hide the demo id by
 * design (D8), so reading through them could not see a re-seeded demo row.
 * PRB-11: without an acting person the WS case is double-guarded (the tool's own
 * check AND `assertTenantScope`'s no-subject refusal); the personal-workspace
 * case is the one only the tool's check protects.
 * Sabotages each guard reverted alone: /grade-tests 8f W5 probes 8fw5g6-r2-*.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { eraseSubjectProposals } from '../src/features/proposals/erasure.js';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { agentsCapability } from '../src/routes/discovery.js';
import { putProposal, getProposal, __test, type ProposalView } from '../src/features/proposals/proposalsService.js';
import { PROPOSALS_LIST_TOOL_ID } from '../src/features/proposals/agentTools.js';
import type { Proposal, ProposalState } from '../src/features/proposals/types.js';
import type { ProposalsFacet } from '../src/features/proposals/capability.js';

const P = '/host/openwop-app/proposals';
let server: http.Server;
let ORIGIN = '';
let WS = '';
let n = 0;

interface ErrBody { error: string; message: string; details?: Record<string, unknown> }
interface Res<T = ErrBody> { status: number; body: T }
interface C {
  userId: string;
  get: <T = ErrBody>(p: string) => Promise<Res<T>>;
  patch: <T = ErrBody>(p: string, b?: unknown) => Promise<Res<T>>;
  del: <T = ErrBody>(p: string, b?: unknown) => Promise<Res<T>>;
  post: <T = ErrBody>(p: string, b?: unknown) => Promise<Res<T>>;
}
/** The `assertTenantScope` refusal (`accessControlService.ts` assertTenantScope) — the read gate's. */
const NO_READ = { error: 'forbidden_scope', message: 'Missing required scope: workspace:read', details: { requiredScope: 'workspace:read' } };
const conflict = (state: string, action: string) => ({ error: 'conflict', details: { reason: 'proposal_state_conflict', state, action } });

async function loginTo(tenantId: string, who: string): Promise<C> {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${ORIGIN}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: (await res.json()) as T };
  };
  const r = await call<{ user: { userId: string } }>('POST', '/host/openwop-app/test/login', { email: `${who}-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return {
    userId: r.body.user.userId,
    get: <T = ErrBody>(p: string) => call<T>('GET', p), patch: <T = ErrBody>(p: string, b?: unknown) => call<T>('PATCH', p, b),
    del: <T = ErrBody>(p: string, b?: unknown) => call<T>('DELETE', p, b), post: <T = ErrBody>(p: string, b?: unknown) => call<T>('POST', p, b),
  };
}

async function seed(state: ProposalState, principal?: string, tenant = WS, kind: Proposal['kind'] = 'prompt-template'): Promise<string> {
  const id = `wg:r2-${n++}`;
  const row: Proposal = {
    id, kind, state,
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
    const seen = await admin.get<ProposalView>(`${P}/${id}`);
    expect(typeof seen.body.revision, 'the read must expose the binding').toBe('number');
    const r = await admin.post(`${P}/${id}/apply`, { revision: seen.body.revision, artifactDigest: seen.body.artifactDigest });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body).toMatchObject(conflict('rejected', 'apply'));
    expect((await getProposal(WS, id))?.state).toBe('rejected');
  });
  it('PRB-2 an ARCHIVED proposal cannot be applied', async () => {
    const id = await seed('archived');
    const seen = await admin.get<ProposalView>(`${P}/${id}`);
    expect(typeof seen.body.revision, 'the read must expose the binding').toBe('number');
    const r = await admin.post(`${P}/${id}/apply`, { revision: seen.body.revision, artifactDigest: seen.body.artifactDigest });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    // NOT `proposal_not_installable`: the transition table refuses before the installer lookup.
    expect(r.body).toMatchObject(conflict('archived', 'apply'));
    expect((await getProposal(WS, id))?.state).toBe('archived');
  });
  it('PRB-3 an APPLIED proposal cannot be rejected', async () => {
    const id = await seed('applied');
    const r = await admin.post(`${P}/${id}/reject`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body).toMatchObject(conflict('applied', 'reject'));
    expect((await getProposal(WS, id))?.state).toBe('applied');
  });
  it('PRB-4 an APPLIED proposal cannot be archived', async () => {
    const id = await seed('applied');
    const r = await admin.del(`${P}/${id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.message, 'the refusal must read as English').toBe('This proposal is applied, so it cannot be archived.');
    expect(r.body).toMatchObject(conflict('applied', 'archive'));
    expect((await getProposal(WS, id))?.state).toBe('applied');
  });
  it('PRB-5 a REJECTED proposal cannot be revised back open', async () => {
    const id = await seed('rejected', editor.userId);
    const r = await editor.patch(`${P}/${id}`, { title: 'reopened' });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body).toMatchObject(conflict('rejected', 'revise'));
    expect((await getProposal(WS, id))?.state).toBe('rejected');
    expect((await getProposal(WS, id))?.title).toBe('Original');
  });
});

describe('PRB-6 — apply never claims an install that did not happen', () => {
  it('apply of a draft does not report `installed:` and does not flip the row to applied', async () => {
    // ADR 0972 P2: `prompt-template` has an installer now, so the probe uses a kind
    // that still has none.
    const id = await seed('draft', undefined, WS, 'agent-pack');
    const before = await admin.get<ProposalView>(`${P}/${id}`);
    const r = await admin.post(`${P}/${id}/apply`, { revision: before.body.revision, artifactDigest: before.body.artifactDigest });
    expect(JSON.stringify(r.body), 'apply claimed an install').not.toContain('installed:');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'conflict', details: { reason: 'proposal_not_installable', kind: 'agent-pack' } });
    const after = await getProposal(WS, id);
    expect(after?.state).toBe('draft');
    expect(after?.activation).toBeUndefined();
  });
});

describe('PRB-7 — apply binds to the revision the reviewer saw', () => {
  it('a revise between the read and the click makes the apply stale (409), never silently applied', async () => {
    const id = await seed('draft', editor.userId);
    const seen = await admin.get<ProposalView>(`${P}/${id}`);
    expect(typeof seen.body.revision, 'the read must expose the revision it shows').toBe('number');
    expect(typeof seen.body.artifactDigest).toBe('string');
    const swap = await editor.patch(`${P}/${id}`, { artifact: { template: 'SWAPPED' }, revision: seen.body.revision });
    expect(swap.status, JSON.stringify(swap.body)).toBe(200);
    const r = await admin.post(`${P}/${id}/apply`, { revision: seen.body.revision, artifactDigest: seen.body.artifactDigest });
    expect(r.status).toBe(409);
    // The CURRENT revision comes back so the client can re-show and re-ask.
    expect(r.body).toMatchObject({ error: 'conflict', details: { reason: 'proposal_stale', revision: seen.body.revision + 1 } });
  });
  it('an apply naming no revision is refused (400), not applied blind', async () => {
    const id = await seed('draft');
    const r = await admin.post(`${P}/${id}/apply`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body).toMatchObject({ error: 'validation_error', details: { fields: ['revision', 'artifactDigest'] } });
  });
});

describe('PRB-8 — listing writes nothing', () => {
  it('GET /proposals in a fresh workspace seeds no demo row', async () => {
    const ws = await createWorkspace({ name: 'proposals-r2-fresh', ownerSubject: 'oidc:prop-r2-fresh' });
    const t = ws.orgId ?? ws.tenantId;
    const u = await loginTo(t, 'fresh');
    await createMember({ orgId: t, tenantId: t, displayName: 'F', subject: u.userId, roles: ['viewer'] });
    const r = await u.get<{ proposals: ProposalView[] }>(P);
    expect(r.status).toBe(200);
    expect(r.body.proposals).toEqual([]);
    // The RAW store, not `getProposal`/the list: both hide the demo id by design (D8).
    expect(await __test.collection.listByPrefix(`${t}::`)).toEqual([]);
  });
});

describe('PRB-9/10 — reads need workspace:read and validate their filters', () => {
  it('PRB-9 a caller with no role in the workspace cannot list or read', async () => {
    const id = await seed('draft');
    const stranger = await loginTo(WS, 'stranger');
    const list = await stranger.get(P);
    expect(list.status).toBe(403);
    expect(list.body).toMatchObject(NO_READ);
    const one = await stranger.get(`${P}/${id}`);
    expect(one.status).toBe(403);
    expect(one.body).toMatchObject(NO_READ);
  });
  it('PRB-10 an unknown state filter is a 400, not an empty list', async () => {
    const state = await admin.get(`${P}?state=live`);
    expect(state.status).toBe(400);
    expect(state.body).toMatchObject({ error: 'validation_error', details: { field: 'state' } });
    const kind = await admin.get(`${P}?kind=rule`);
    expect(kind.status).toBe(400);
    expect(kind.body).toMatchObject({ error: 'validation_error', details: { field: 'kind' } });
  });
});

describe('PRB-11 — the agent tool shares the route predicate', () => {
  const run = (scope: { actingUserId?: string }) =>
    createAgentToolProvider({ tenantId: WS, runId: 'run-prb11', ...scope }).executeTool({ name: PROPOSALS_LIST_TOOL_ID, input: {} });
  it('without an acting person the tool returns nothing', async () => {
    await seed('draft');
    const r = await run({});
    expect(JSON.parse(r.content)).toEqual({ proposals: [] });
  });
  it('for a person with no role in the workspace the tool returns nothing', async () => {
    await seed('draft');
    const r = await run({ actingUserId: 'user:nobody-here' });
    expect(JSON.parse(r.content)).toEqual({ proposals: [] });
  });
  it('without an acting person the tool returns nothing, even in a personal workspace', async () => {
    const personal = 'user:prb11-personal';
    await seed('draft', undefined, personal);
    const r = await createAgentToolProvider({ tenantId: personal, runId: 'run-prb11p', personalTenant: personal })
      .executeTool({ name: PROPOSALS_LIST_TOOL_ID, input: {} });
    expect(JSON.parse(r.content)).toEqual({ proposals: [] });
  });
  it('for a member it lists', async () => {
    const id = await seed('draft');
    const r = await run({ actingUserId: editor.userId });
    const out = JSON.parse(r.content) as { proposals: ProposalView[] };
    expect(out.proposals.map((p) => p.id)).toContain(id);
  });
});

describe('PRB-12 — advertisement follows what apply can do', () => {
  it('agents.proposals advertises exactly the kinds that have an installer', () => {
    // ADR 0972 P2: before the 2.46.21 pin no kind had one and the facet was absent.
    // Now `prompt-template` does; the three kinds without an installer stay unlisted.
    const prev = process.env.OPENWOP_PROPOSALS_ENABLED;
    process.env.OPENWOP_PROPOSALS_ENABLED = 'true';
    try {
      const facet = agentsCapability().proposals as ProposalsFacet | undefined;
      expect(facet?.artifactKinds).toEqual(['prompt-template']);
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_PROPOSALS_ENABLED; else process.env.OPENWOP_PROPOSALS_ENABLED = prev;
    }
  });
});

describe('closing grade-code (PROP2CD-1..4)', () => {
  it('PROP2CD-1 one stored artifact JCS refuses does not 500 the list', async () => {
    const id = await seed('draft');
    const row = (await getProposal(WS, id))!;
    await putProposal({ ...row, artifact: { template: 'bad \ud800 surrogate' } });
    const r = await admin.get<{ proposals: ProposalView[] }>(P);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.proposals.find((p) => p.id === id)?.artifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/); // ADR 0972 D7 — the RFC 0249 form
  });
  it('PROP2CD-2 a non-string title is a 400, not silently dropped', async () => {
    const id = await seed('draft', editor.userId);
    const r = await editor.patch(`${P}/${id}`, { title: 123 });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body).toMatchObject({ error: 'validation_error', details: { field: 'title' } });
    expect((await getProposal(WS, id))?.state).toBe('draft');
  });
  it('PROP2CD-3 a caller with no role learns nothing from a by-id write, not even existence', async () => {
    const stranger = await loginTo(WS, 'stranger-2');
    for (const id of ['wg:does-not-exist', await seed('draft')]) {
      // The READ gate's refusal by name: the mutate and apply gates also answer 403,
      // so a status alone could not tell which gate refused.
      for (const res of [
        await stranger.patch(`${P}/${id}`, { title: 'x' }),
        await stranger.post(`${P}/${id}/reject`, {}),
        await stranger.del(`${P}/${id}`),
        await stranger.post(`${P}/${id}/apply`, { revision: 0, artifactDigest: 'x' }),
      ]) {
        expect(res.status, `${id}: ${JSON.stringify(res.body)}`).toBe(403);
        expect(res.body, id).toMatchObject(NO_READ);
      }
    }
  });
  it('PROP2CD-4 an erasure that keeps losing the CAS is reported as a failure, not dropped', async () => {
    await seed('draft', 'user:cas-loser');
    const spy = vi.spyOn(DurableCollection.prototype, 'compareAndSwap').mockResolvedValue(false);
    try {
      await expect(eraseSubjectProposals(WS, 'user:cas-loser')).rejects.toThrow(/still name the subject/);
    } finally {
      spy.mockRestore();
    }
  });
});
