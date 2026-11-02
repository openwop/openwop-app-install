/**
 * ADR 1005 P3a — the operator promotion policy (D12) and the approval gate that
 * answers `202` (D13, RFC 0254 §D), resolved through the ordinary interrupt
 * route by the host-run hand-off (D14). Driven over HTTP with real sessions:
 * an owner sets policy, admin A asks, admin B decides, an editor cannot ask.
 *
 * Red when: a gated promote writes the record before anyone approves; the
 * requester can approve their own promotion; a deployer can remove the gate
 * (policy write below `host:org:manage`); an accepted approval applies against
 * stale state instead of re-checking; a rejection changes the record; a second
 * request queues behind an open one; or the management run can be forked.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';
import { enableToggle } from './planningHarness.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { sweepExpiredApprovalGates } from '../src/executor/approvalGateTimeout.js';

let server: http.Server;
let BASE = '';
let seq = 0;

interface Res { status: number; body: any }
interface Client { userId: string; call(method: string, path: string, body?: unknown): Promise<Res> }

function client(): Omit<Client, 'userId'> {
  let cookie = '';
  return {
    async call(method, path, body) {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'openwop-version': '2', ...(cookie ? { cookie } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    },
  };
}

async function signIn(tenantId: string): Promise<Client> {
  const c = client();
  const r = await c.call('POST', '/host/openwop-app/test/login', { email: `p3a-${Date.now()}-${seq++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { ...c, userId: r.body.user.userId as string };
}

/** An org tenant: owner (policy), admins A and B (deploy + decide), an editor (decide only). */
async function team() {
  const tenantId = `org:p3a-${Date.now()}-${seq++}`;
  const owner = await signIn(tenantId);
  const org = await owner.call('POST', '/host/openwop-app/orgs', { name: 'Deployers' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId as string;
  const member = async (roles: string[]): Promise<Client> => {
    const c = await signIn(tenantId);
    const r = await owner.call('POST', `/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: c.userId, roles });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    return c;
  };
  const adminA = await member(['admin']);
  const adminB = await member(['admin']);
  const editor = await member(['editor']);
  const agent = await owner.call('POST', '/host/openwop-app/agents', { persona: 'Deployable', modelClass: 'chat', systemPrompt: 'v1' });
  expect(agent.status, JSON.stringify(agent.body)).toBe(201);
  const agentId = agent.body.agentId as string;
  return { tenantId, owner, adminA, adminB, editor, agentId, dep: `/agents/${encodeURIComponent(agentId)}/deployments`, policy: `/host/openwop-app/agent-deployments/${encodeURIComponent(agentId)}/policy` };
}

type Team = Awaited<ReturnType<typeof team>>;
const versionOf = async (t: Team): Promise<{ version: string; state: string }> => {
  const r = await t.adminA.call('GET', t.dep);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body[0];
};
/** The flat host envelope and the v2 envelope carry `details` at different depths; the claim is the reason, not the envelope. */
const detailsOf = (b: any): Record<string, unknown> | undefined => b?.details ?? b?.error?.details;
const runIdOf = (wireRunId: string): string => encodeURIComponent(wireRunId);
const eventsOf = async (c: Client, wireRunId: string): Promise<Array<{ type: string; payload: Record<string, unknown> }>> => {
  const r = await c.call('GET', `/runs/${runIdOf(wireRunId)}/events/poll?fromSeq=-1&limit=200`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.events;
};
const runStatus = async (c: Client, wireRunId: string): Promise<{ status: string; error?: { code: string } }> =>
  (await c.call('GET', `/runs/${runIdOf(wireRunId)}`)).body;
const decide = (c: Client, wireRunId: string, action: 'accept' | 'reject'): Promise<Res> =>
  c.call('POST', `/runs/${runIdOf(wireRunId)}/interrupts/deployment-approval`, { resumeValue: { action } });

/** Pause the serving baseline, then ask to bring it back: the promote D13 gates. */
async function gatedResume(t: Team): Promise<{ version: string; runId: string }> {
  const { version } = await versionOf(t);
  const paused = await t.adminA.call('POST', t.dep, { version, transition: 'pause' });
  expect(paused.status, JSON.stringify(paused.body)).toBe(200);
  const asked = await t.adminA.call('POST', t.dep, { version, transition: 'promote' });
  expect(asked.status, JSON.stringify(asked.body)).toBe(202);
  return { version, runId: asked.body.transitionRunId as string };
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
  await new Promise<void>((res) => server.close(() => res()));
});

describe('D12 — who may set the promotion policy', () => {
  it('an admin can read it but not change it; the owner can; a reserved agent is fixed', async () => {
    const t = await team();
    const read = await t.adminA.call('GET', t.policy);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toEqual({ agentId: t.agentId, fixed: false, revision: 0, policy: {} });

    const byAdmin = await t.adminA.call('PUT', t.policy, { approval: { onActivate: true } });
    expect(byAdmin.status).toBe(403);
    expect(detailsOf(byAdmin.body)).toMatchObject({ requiredScope: 'host:org:manage' });

    const byOwner = await t.owner.call('PUT', t.policy, { approval: { onActivate: true }, requiredEval: { requiredPassScore: 0.8 } });
    expect(byOwner.status, JSON.stringify(byOwner.body)).toBe(200);
    expect(byOwner.body).toMatchObject({ revision: 1, policy: { approval: { onActivate: true }, requiredEval: { requiredPassScore: 0.8 } } });

    expect((await t.owner.call('PUT', t.policy, { approval: { onActivate: false } })).status).toBe(400);
    expect((await t.owner.call('PUT', t.policy, { gate: true })).status).toBe(400);

    const reserved = await t.owner.call('PUT', '/host/openwop-app/agent-deployments/core.conformance.agents.scripted/policy', {});
    expect(reserved.status).toBe(403);
    expect(detailsOf(reserved.body)).toMatchObject({ reason: 'policy_fixed' });
    const reservedRead = await t.adminA.call('GET', '/host/openwop-app/agent-deployments/core.conformance.agents.scripted/policy');
    expect(reservedRead.body).toMatchObject({ fixed: true, policy: { requiredEval: {} } });
  });
});

describe('D13 — a gated promote answers 202 and writes nothing until a second person accepts', () => {
  it('without a policy the promote applies at once (the P1 behaviour)', async () => {
    const t = await team();
    const { version } = await versionOf(t);
    expect((await t.adminA.call('POST', t.dep, { version, transition: 'pause' })).status).toBe(200);
    const back = await t.adminA.call('POST', t.dep, { version, transition: 'promote' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.state).toBe('active');
  });

  it('202 → suspended run, record unchanged; the requester cannot accept; another admin can, and it applies', async () => {
    const t = await team();
    expect((await t.owner.call('PUT', t.policy, { approval: { onActivate: true } })).status).toBe(200);
    const { version, runId } = await gatedResume(t);

    // Nothing written: still paused, and the run waits on its approval.
    expect((await versionOf(t)).state).toBe('paused');
    expect((await runStatus(t.adminA, runId)).status).toBe('waiting-input');
    const before = (await eventsOf(t.adminA, runId)).map((e) => e.type);
    expect(before).toEqual(expect.arrayContaining(['authorization.decided', 'node.suspended', 'interrupt.requested']));
    expect(before.some((x) => x.startsWith('deployment.'))).toBe(false);

    // One open approval per version.
    const again = await t.adminA.call('POST', t.dep, { version, transition: 'promote' });
    expect(again.status).toBe(409);
    expect(detailsOf(again.body)).toMatchObject({ reason: 'approval_pending' });

    // Separation of duties, refused before the claim: the gate stays open.
    const self = await decide(t.adminA, runId, 'accept');
    expect(self.status).toBe(403);
    expect(detailsOf(self.body)).toMatchObject({ reason: 'self_approval' });
    expect((await runStatus(t.adminA, runId)).status).toBe('waiting-input');

    const ok = await decide(t.adminB, runId, 'accept');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = await versionOf(t);
    expect(after.state).toBe('active');
    expect((after as { transitionRunId?: string }).transitionRunId).toBe(runId);
    expect((await runStatus(t.adminA, runId)).status).toBe('completed');
    const types = (await eventsOf(t.adminA, runId)).map((e) => e.type);
    expect(types.indexOf('interrupt.resolved')).toBeGreaterThan(-1);
    // The v2 read spells it `deployment.state-changed`; the apply follows the decision on the same run.
    expect(types.slice(types.indexOf('interrupt.resolved') + 1)).toEqual(['deployment.state-changed']);
  });

  it('an editor may decide but not ask; a reject (even the requester withdrawing) changes nothing and frees the version', async () => {
    const t = await team();
    expect((await t.owner.call('PUT', t.policy, { approval: { onActivate: true } })).status).toBe(200);
    const { version } = await versionOf(t);
    expect((await t.editor.call('POST', t.dep, { version, transition: 'pause' })).status, 'an editor cannot deploy').toBe(403);

    const { runId } = await gatedResume(t);
    const withdrawn = await decide(t.adminA, runId, 'reject');
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect((await versionOf(t)).state).toBe('paused');
    const run = await runStatus(t.adminA, runId);
    expect(run.status).toBe('failed');
    expect(run.error?.code).toBe('approval_rejected');

    const second = await t.adminA.call('POST', t.dep, { version, transition: 'promote' });
    expect(second.status, 'the rejected approval no longer holds the version').toBe(202);
    const byEditor = await decide(t.editor, second.body.transitionRunId as string, 'accept');
    expect(byEditor.status, JSON.stringify(byEditor.body)).toBe(200);
    expect((await versionOf(t)).state).toBe('active');
  });

  it('an accepted approval is checked again against the policy as it is now', async () => {
    const t = await team();
    expect((await t.owner.call('PUT', t.policy, { approval: { onActivate: true } })).status).toBe(200);
    const { runId } = await gatedResume(t);
    // While it waited, the owner started requiring eval evidence the request never cited.
    expect((await t.owner.call('PUT', t.policy, { approval: { onActivate: true }, requiredEval: {} })).status).toBe(200);
    expect((await decide(t.adminB, runId, 'accept')).status).toBe(200);
    expect((await versionOf(t)).state).toBe('paused');
    const run = await runStatus(t.adminA, runId);
    expect(run.status).toBe('failed');
    expect(run.error?.code).toBe('eval_gate_unmet');
  });

  it('the management run cannot be forked, paused or resumed', async () => {
    const t = await team();
    expect((await t.owner.call('PUT', t.policy, { approval: { onActivate: true } })).status).toBe(200);
    const { runId } = await gatedResume(t);
    for (const verb of ['fork', 'pause', 'resume']) {
      const r = await t.adminA.call('POST', `/runs/${runIdOf(runId)}:${verb}`, {});
      expect(r.status, `${verb}: ${JSON.stringify(r.body)}`).toBe(409);
      expect(detailsOf(r.body)).toMatchObject({ reason: 'management_run_not_forkable' });
    }
  });

  it('a cancelled approval run releases the version (it is never held forever)', async () => {
    const t = await team();
    expect((await t.owner.call('PUT', t.policy, { approval: { onActivate: true } })).status).toBe(200);
    const { version, runId } = await gatedResume(t);
    const cancelled = await t.adminA.call('POST', `/runs/${runIdOf(runId)}/cancel`, {});
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBeLessThan(300);
    expect((await runStatus(t.adminA, runId)).status).toBe('cancelled');
    expect((await versionOf(t)).state).toBe('paused');
    const again = await t.adminA.call('POST', t.dep, { version, transition: 'promote' });
    expect(again.status, JSON.stringify(again.body)).toBe(202);
  });

  it('asking with your own API key and approving in your session is still self-approval', async () => {
    const t = await team();
    expect((await t.owner.call('PUT', t.policy, { approval: { onActivate: true } })).status).toBe(200);
    const { version } = await versionOf(t);
    const key = (await issueApiKey({ tenantId: t.tenantId, name: 'deployer', createdBy: t.adminA.userId, scopes: ['runs:read', 'deploy:*', 'packs:publish'] })).token;
    const viaKey = (method: string, path: string, body?: unknown) => fetch(`${BASE}${path}`, {
      method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'openwop-version': '2' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    expect((await viaKey('POST', t.dep, { version, transition: 'pause' })).status).toBe(200);
    const asked = await viaKey('POST', t.dep, { version, transition: 'promote' });
    expect(asked.status).toBe(202);
    const runId = ((await asked.json()) as { transitionRunId: string }).transitionRunId;
    const self = await decide(t.adminA, runId, 'accept');
    expect(self.status, JSON.stringify(self.body)).toBe(403);
    expect(detailsOf(self.body)).toMatchObject({ reason: 'self_approval' });
    expect((await decide(t.adminB, runId, 'accept')).status).toBe(200);
    expect((await versionOf(t)).state).toBe('active');
  });

  it('raising a canary share is gated too; lowering it is not', async () => {
    const t = await team();
    expect((await t.owner.call('PUT', t.policy, { approval: { onActivate: true } })).status).toBe(200);
    const { version } = await versionOf(t);
    const down = await t.adminA.call('POST', t.dep, { version, transition: 'adjust-canary', canaryPercent: 10 });
    expect(down.status, JSON.stringify(down.body)).toBe(200);
    const up = await t.adminA.call('POST', t.dep, { version, transition: 'adjust-canary', canaryPercent: 90 });
    expect(up.status, JSON.stringify(up.body)).toBe(202);
    expect((await versionOf(t) as { canaryPercent?: number }).canaryPercent).toBe(10);
    expect((await decide(t.adminB, up.body.transitionRunId as string, 'accept')).status).toBe(200);
    expect((await versionOf(t) as { canaryPercent?: number }).canaryPercent).toBe(90);
  });

  it('an undecided approval expires as rejected after a week and frees the version (RFC 0093)', async () => {
    const t = await team();
    expect((await t.owner.call('PUT', t.policy, { approval: { onActivate: true } })).status).toBe(200);
    const { version, runId } = await gatedResume(t);
    const sixDays = await sweepExpiredApprovalGates(hostExtStorage(), Date.now() + 6 * 24 * 3600 * 1000);
    expect((await runStatus(t.adminA, runId)).status, `not yet (${sixDays} swept)`).toBe('waiting-input');
    await sweepExpiredApprovalGates(hostExtStorage(), Date.now() + 8 * 24 * 3600 * 1000);
    const run = await runStatus(t.adminA, runId);
    expect(run.status).toBe('failed');
    expect(run.error?.code).toBe('approval_rejected');
    expect((await versionOf(t)).state).toBe('paused');
    expect((await t.adminA.call('POST', t.dep, { version, transition: 'promote' })).status).toBe(202);
  });
});
