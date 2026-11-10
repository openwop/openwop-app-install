/**
 * ADR 1014 P5 (D7) — user-authored agents get revisions.
 *
 * Red when: an edit overwrites the agent with no way back to the old content; a
 * no-op edit mints a revision; a never-edited agent is not version `0` (that would
 * strand every deployment row written before this shipped); an old revision stops
 * resolving to its own content; with the flag on, an edit of a DEPLOYED user agent
 * goes live instead of arriving as a draft; retention deletes a revision a
 * deployment row names, or keeps other than the newest ten; a revision resolves
 * in another tenant that has an agent of the same id (user agent ids are
 * `user.<slug(persona)>`, so they repeat across tenants); or a deleted agent's
 * cached revision answers for a re-created agent of the same id.
 *
 * Sabotage-witnessed (grade-tests w83): minting on a no-op edit, dropping row
 * pins or the retention floor, non-canonical revision ids, registering a
 * restarted agent as `0`, dropping the purge or the registry's eviction on
 * delete, dropping the draft hook, serving the head over `stable`, a tenantless
 * revision key, and numbering the pre-edit record.
 * The concurrent-edit case is NOT a forced race (two HTTP PATCHes need not
 * interleave). The forced interleave (one-shot hold after the first CAS) is
 * witnessed by `tst-fib-gc1-revision-race.test.ts` (TST-FIB-GC1, fixed in #5559);
 * this case keeps the unforced end-to-end check of the same M1 claim.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';
import { enableToggle } from './planningHarness.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { resolveServedAgent } from '../src/host/agentServing.js';
import { REVISION_KEEP_NEWEST, currentRevision, getRevision } from '../src/host/userAgentRevisions.js';
import { hydrateUserAgentIntoRegistry } from '../src/routes/userAgents.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';

let server: http.Server;
let BASE = '';
let seq = 0;
interface Res<T = unknown> { status: number; body: T }
interface AgentBody { agentId: string; packVersion: string }
interface DeploymentRow { version: string; state: string }

function client() {
  let cookie = '';
  return async <T = unknown>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  };
}

async function owner(systemPrompt = 'v1') {
  const tenantId = `org:p5-${Date.now()}-${seq++}`;
  const call = client();
  expect((await call('POST', '/host/openwop-app/test/login', { email: `p5-${Date.now()}-${seq++}@acme.test`, tenantId })).status).toBe(201);
  expect((await call('POST', '/host/openwop-app/orgs', { name: 'P5' })).status).toBe(201);
  const agent = await call<AgentBody>('POST', '/host/openwop-app/agents', { persona: 'Reviser', modelClass: 'chat', systemPrompt });
  expect(agent.status, JSON.stringify(agent.body)).toBe(201);
  const agentId = agent.body.agentId;
  const edit = async (next: string): Promise<string> => {
    const r = await call<AgentBody>('PATCH', `/host/openwop-app/agents/${encodeURIComponent(agentId)}`, { systemPrompt: next });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.packVersion;
  };
  return { tenantId, call, agentId, edit, dep: `/agents/${encodeURIComponent(agentId)}/deployments` };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_AGENT_DEPLOYMENT = 'on';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await enableToggle('users', 'on');
}, 60_000);
afterAll(async () => {
  delete process.env.OPENWOP_AGENT_DEPLOYMENT;
  delete process.env.OPENWOP_AGENT_VERSIONS;
  await new Promise<void>((res) => server.close(() => res()));
});

describe('ADR 1014 P5 — an edit is a revision, and the old content stays', () => {
  it('a never-edited agent is 0; real edits count up; a no-op edit does not', async () => {
    const o = await owner();
    expect((await o.call<DeploymentRow[]>('GET', o.dep)).body.map((r) => r.version)).toEqual(['0']);
    expect(await o.edit('v2')).toBe('1');
    expect(await o.edit('v2'), 'same content, same revision').toBe('1');
    expect(await o.edit('v3')).toBe('2');
    const registry = getAgentRegistry();
    expect((await registry.resolve(o.agentId, o.tenantId, '0'))?.systemPrompt).toBe('v1');
    expect((await registry.resolve(o.agentId, o.tenantId, '1'))?.systemPrompt).toBe('v2');
    expect((await registry.resolve(o.agentId, o.tenantId))?.systemPrompt, 'the head').toBe('v3');
    expect(await registry.resolve(o.agentId, 'some-other-tenant', '0'), 'never across tenants').toBeNull();
    // A second tenant whose agent has the SAME id (same persona) and was never edited.
    const b = await owner('b-v1');
    expect(b.agentId).toBe(o.agentId);
    expect(await registry.resolve(b.agentId, b.tenantId, '1'), 'A\u2019s revision 1 never answers for B').toBeNull();
    expect((await registry.resolve(b.agentId, b.tenantId, '0'))?.systemPrompt).toBe('b-v1');
    expect((await registry.resolve(o.agentId, o.tenantId, '1'))?.systemPrompt, 'A is unchanged').toBe('v2');
  });

  it('flag on: an edit of a deployed agent is a draft, and chat keeps the deployed revision', async () => {
    const o = await owner();
    // Deploy revision 0 on stable (pause + resume materializes the row).
    expect((await o.call('POST', o.dep, { version: '0', transition: 'pause' })).status).toBe(200);
    expect((await o.call('POST', o.dep, { version: '0', transition: 'promote' })).status).toBe(200);
    process.env.OPENWOP_AGENT_VERSIONS = 'on';
    try {
      expect(await o.edit('edited')).toBe('1');
      const rows = (await o.call<DeploymentRow[]>('GET', o.dep)).body;
      expect(rows.find((r) => r.version === '1')?.state).toBe('draft');
      expect((await resolveServedAgent(o.agentId, o.tenantId, 'conv-1'))?.systemPrompt, 'stable still serves 0').toBe('v1');
    } finally {
      delete process.env.OPENWOP_AGENT_VERSIONS;
    }
  });

  it('retention keeps the newest ten and any revision a deployment row names', async () => {
    const o = await owner();
    expect((await o.call('POST', o.dep, { version: '0', transition: 'pause' })).status).toBe(200); // row names 0
    for (let i = 1; i <= REVISION_KEEP_NEWEST + 3; i += 1) await o.edit(`v${i + 1}`);
    expect(await getRevision(o.tenantId, o.agentId, '0'), 'named by a row').not.toBeNull();
    expect(await getRevision(o.tenantId, o.agentId, '1')).toBeNull();
    // The boundary: 13 is the head, so 4..13 are the newest ten and 3 is the first dropped.
    expect(await getRevision(o.tenantId, o.agentId, '3'), 'one past the newest ten').toBeNull();
    expect(await getRevision(o.tenantId, o.agentId, '4'), 'the oldest of the newest ten').not.toBeNull();
    expect(await getRevision(o.tenantId, o.agentId, String(REVISION_KEEP_NEWEST + 3))).not.toBeNull();
  });

  it('a first no-op edit mints nothing, and only canonical revision ids resolve', async () => {
    const o = await owner();
    expect(await o.edit('v1'), 'same content as created').toBe('0');
    expect(await o.edit('v2')).toBe('1');
    expect(await getRevision(o.tenantId, o.agentId, '01')).toBeNull();
  });

  it('a restarted instance registers the same revision for the same content (review H2)', async () => {
    const o = await owner();
    await o.edit('v2');
    await o.edit('v3');
    const registry = getAgentRegistry();
    registry.remove(o.agentId, o.tenantId); // as after a restart: nothing cached
    expect(await hydrateUserAgentIntoRegistry(hostExtStorage(), o.agentId, o.tenantId)).toBe(true);
    const head = await registry.resolve(o.agentId, o.tenantId);
    expect(head?.packVersion).toBe('2');
    expect(head?.systemPrompt).toBe('v3');
  });

  it('concurrent edits number exactly the content that was stored (review M1)', async () => {
    const o = await owner();
    await Promise.all([o.edit('a'), o.edit('b')]);
    const rev = await currentRevision(o.tenantId, o.agentId);
    const stored = await hostExtStorage().getUserAgent(o.tenantId, o.agentId);
    expect((await getRevision(o.tenantId, o.agentId, rev))?.systemPrompt).toBe(stored?.systemPrompt);
    expect((await getRevision(o.tenantId, o.agentId, '0'))?.systemPrompt, 'revision 0 is the original').toBe('v1');
  });

  it('a deleted agent leaves no revision or deployment behind (review M2)', async () => {
    const o = await owner();
    expect((await o.call('POST', o.dep, { version: '0', transition: 'pause' })).status).toBe(200);
    await o.edit('v2');
    await o.edit('v3');
    // Revision 1 is now a cached, non-head entry in the registry's versioned map.
    expect((await getAgentRegistry().resolve(o.agentId, o.tenantId, '1'))?.systemPrompt).toBe('v2');
    expect((await o.call('DELETE', `/host/openwop-app/agents/${encodeURIComponent(o.agentId)}`)).status).toBe(204);
    expect(await getRevision(o.tenantId, o.agentId, '0')).toBeNull();
    expect(await getRevision(o.tenantId, o.agentId, '1')).toBeNull();
    expect(await currentRevision(o.tenantId, o.agentId)).toBe('0');
    expect(await getAgentRegistry().resolve(o.agentId, o.tenantId, '1')).toBeNull();
    // Re-created with the same id (same persona): the old revision 1 must not answer for it.
    const again = await o.call<AgentBody>('POST', '/host/openwop-app/agents', { persona: 'Reviser', modelClass: 'chat', systemPrompt: 'fresh' });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.agentId).toBe(o.agentId);
    expect((await getAgentRegistry().resolve(o.agentId, o.tenantId))?.systemPrompt).toBe('fresh');
    expect(await getAgentRegistry().resolve(o.agentId, o.tenantId, '1'), 'no cached revision of the deleted agent').toBeNull();
    // The deleted agent's deployment rows (the paused 0, the edit drafts) went with it.
    const left = (await o.call<DeploymentRow[]>('GET', o.dep)).body;
    expect(left.map((r) => [r.version, r.state]), 'only the new agent\u2019s unstored baseline').toEqual([['0', 'active']]);
  });

  it('flag off: an edit of a deployed agent is still minted as a draft, so it can be promoted (review M3)', async () => {
    const o = await owner();
    expect((await o.call('POST', o.dep, { version: '0', transition: 'pause' })).status).toBe(200);
    expect(await o.edit('v2')).toBe('1');
    const rows = (await o.call<DeploymentRow[]>('GET', o.dep)).body;
    expect(rows.find((r) => r.version === '1')?.state).toBe('draft');
  });
});
