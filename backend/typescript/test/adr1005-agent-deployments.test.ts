/**
 * ADR 1005 — RFC 0082 `agents.deployment` on this host, driven through the real
 * routes the way `v2-deployment-lifecycle` and `v2-deployment-eval-gate` drive
 * them: list → run the channel fixture (R1) → a low-scope promote → illegal
 * pause/deprecate of the draft → promote draft→test→staged→active on `stable`
 * at 100 → run again (R2 resolves the candidate) → replay R1 (re-reads R1's
 * version) → adjust-canary → rollback → the next cut's preconditions hold.
 * Plus the eval gate, tenant isolation, the advertisement switch and the
 * registration rule for a channel-bearing `agent` ref.
 *
 * Red when (each sabotage-witnessed, /grade-tests w81): the facet answers while
 * switched off; the key lane stops requiring the literal `deploy:*`; promote
 * skips a step or `pause` is legal from draft; rollback points at itself; the
 * canary draw or the canary write is dropped; a replay fork re-resolves its
 * channel instead of re-reading its parent's pin; the next cut gets no fresh
 * draft; a failed, missing or another tenant's eval run promotes; an applied
 * transition loses its management run, its `authorization.decided` or its
 * `transitionRunId`; the wire switch ignores the vendored schema; registration
 * drops or stops validating the node's `agent` binding.
 *
 * Double guards, recorded: the facet-off fail-closed run is held by
 * `agentChannelPin` (`agentChannelsServed()`) AND `resolveChannel`'s facet check
 * (witnessed as a held pair); the tenant boundary of a listing is the
 * `listByPrefix(tenant::…)` key AND the re-check filter (one probe breaks both).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { agentsCapability } from '../src/routes/discovery.js';
import { scopesSupported } from '../src/host/protocolAuthorization.js';
import { listFixtureSuiteIds } from '../src/host/evals/fixtureSuites.js';
import { listLoadedConformanceFixtures } from '../src/host/index.js';
import { targetState } from '../src/features/agent-deployments/service.js';
import { resetTransitionRunIdWire, transitionRunIdOnWire } from '../src/features/agent-deployments/wire.js';

const TENANT_A = 'adr1005-tenant-a';
const TENANT_B = 'adr1005-tenant-b';
const KEY_A = 'adr1005-key-a-0123456789abcdef';
const KEY_B = 'adr1005-key-b-0123456789abcdef';
// The isolation case's own tenants, so no other case's transitions reach it.
const KEY_C = 'adr1005-key-c-0123456789abcdef';
const KEY_D = 'adr1005-key-d-0123456789abcdef';
const AGENT = 'core.conformance.channel-agent';
const SCRIPTED = 'core.conformance.agents.scripted';
const FIXTURE = 'conformance-agent-channel-dispatch';
const DEP = `/agents/${AGENT}/deployments`;
let LOW = '';
let NARROW = '';
let server: http.Server;
let ORIGIN = '';

interface Res<T = ErrBody> { status: number; body: T; challenge: string }
interface ErrBody { error?: string; message?: string; details?: Record<string, unknown> }
type Rec = { agentId: string; version: string; state: string; channels?: string[]; canaryPercent?: number; rollbackPointer?: string; transitionRunId?: string };
interface RunBody { runId: string; status?: string }
interface EventsBody { events?: Array<{ type: string; payload: Record<string, unknown> }> }
let wfSeq = 0;

async function call<T = ErrBody>(key: string, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'openwop-version': '2' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T, challenge: res.headers.get('www-authenticate') ?? '' };
}

const list = async (key = KEY_A, path = DEP): Promise<Rec[]> => {
  const r = await call<Rec[]>(key, 'GET', path);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const recordOf = (all: Rec[], version: string): Rec | undefined => all.find((r) => r.version === version);
const activeOn = (all: Rec[], channel: string): string[] => all.filter((r) => r.state === 'active' && (r.channels ?? []).includes(channel)).map((r) => r.version);

/** Run settle: no hook to await, so poll the real condition (bounded; fails naming the run). */
async function terminal(runId: string): Promise<string> {
  return vi.waitFor(async () => {
    const r = await call<RunBody | undefined>(KEY_A, 'GET', `/runs/${encodeURIComponent(runId)}`);
    const s = String(r.body?.status ?? '');
    if (!['completed', 'failed', 'cancelled'].includes(s)) throw new Error(`run ${runId} never settled (at '${s}')`);
    return s;
  }, { timeout: 10_000, interval: 25 });
}

async function pinOf(runId: string): Promise<Record<string, unknown> | undefined> {
  const r = await call<EventsBody | undefined>(KEY_A, 'GET', `/runs/${encodeURIComponent(runId)}/events/poll?fromSeq=-1&limit=1000`);
  const events = r.body?.events ?? [];
  return events.find((e) => e.type === 'agent.invocation-started' || e.type === 'agent.invocation.started')?.payload;
}

async function runFixture(): Promise<{ runId: string; version: unknown }> {
  const c = await call<RunBody>(KEY_A, 'POST', '/runs', { workflowId: FIXTURE });
  expect([201, 202], JSON.stringify(c.body)).toContain(c.status);
  const runId = c.body.runId;
  expect(await terminal(runId)).toBe('completed');
  return { runId, version: (await pinOf(runId))?.resolvedAgentVersion };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AGENT_DEPLOYMENT = 'on';
  process.env.OPENWOP_CONFORMANCE_EVAL_FIXTURES = 'true';
  process.env.OPENWOP_API_KEYS = `${KEY_A}:${TENANT_A},${KEY_B}:${TENANT_B},${KEY_C}:adr1005-tenant-c,${KEY_D}:adr1005-tenant-d`;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { ORIGIN = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  // The suite's low-scope key: a separate tenant, scopes with no deploy:* (conformance/run.ts).
  LOW = (await issueApiKey({ tenantId: 'adr1005-low', name: 'low', createdBy: 'user:adr1005', scopes: ['runs:read', 'proposals:read', 'proposals:write'] })).token;
  NARROW = (await issueApiKey({ tenantId: TENANT_A, name: 'pause-only', createdBy: 'user:adr1005', scopes: ['runs:read', 'deploy:pause'] })).token;
}, 60_000);
afterAll(async () => {
  delete process.env.OPENWOP_AGENT_DEPLOYMENT;
  delete process.env.OPENWOP_CONFORMANCE_EVAL_FIXTURES;
  await new Promise<void>((res) => server.close(() => res()));
});

describe('the advertisement (ADR 1005 D1)', () => {
  it('advertises the facet and lists both fixtures while switched on', () => {
    expect(agentsCapability().deployment).toEqual({
      channels: ['stable', 'canary', 'latest'], canary: true, rollback: true,
      states: ['draft', 'test', 'staged', 'active', 'paused', 'deprecated', 'rolled-back'],
    });
    expect(listLoadedConformanceFixtures()).toContain(FIXTURE);
    expect(listFixtureSuiteIds()).toContain('conformance-eval-gate-failing');
    expect(scopesSupported()).toContain('deploy:*');
    // RFC 0254: one literal scope, not a family.
    expect(scopesSupported().filter((x) => x.startsWith('deploy:'))).toEqual(['deploy:*']);
  });

  it('switched off: no facet, both fixtures withheld, no deploy scopes, both routes 404', async () => {
    process.env.OPENWOP_AGENT_DEPLOYMENT = 'off';
    try {
      expect(agentsCapability().deployment).toBeUndefined();
      expect(listLoadedConformanceFixtures()).not.toContain(FIXTURE);
      expect(listFixtureSuiteIds()).not.toContain('conformance-eval-gate-failing');
      expect(scopesSupported().some((s) => s.startsWith('deploy:'))).toBe(false);
      const unadvertised = { family: 'agents', facet: 'deployment' };
      const listed = await call(KEY_A, 'GET', DEP);
      expect(listed.status).toBe(404);
      expect(listed.body.details).toEqual(unadvertised);
      const low = await call(LOW, 'POST', DEP, { version: '1.0.1', transition: 'promote' });
      expect(low.status, 'unadvertised before any scope check').toBe(404);
      expect(low.body.details).toEqual(unadvertised);
      // A channel-bound node fails closed instead of running at an arbitrary version.
      const c = await call<RunBody>(KEY_A, 'POST', '/runs', { workflowId: FIXTURE });
      expect(await terminal(c.body.runId)).toBe('failed');
    } finally {
      process.env.OPENWOP_AGENT_DEPLOYMENT = 'on';
    }
  });
});

describe('the lifecycle walk (v2-deployment-lifecycle)', () => {
  it('drives the whole cut and leaves the next cut its preconditions', async () => {
    // Preconditions: one active on stable at 100/absent, and a draft.
    const list0 = await list();
    for (const r of list0) expect(r.agentId).toBe(AGENT);
    const incumbent = activeOn(list0, 'stable');
    expect(incumbent).toEqual(['1.0.0']);
    expect(recordOf(list0, '1.0.0')?.canaryPercent ?? 100).toBe(100);
    const draft = list0.find((r) => r.state === 'draft')!.version;

    const r1 = await runFixture();
    expect(r1.version).toBe('1.0.0');
    expect((await pinOf(r1.runId))?.resolvedChannel).toBe('stable');

    // 0082.scope-fail-closed — 403, record unchanged.
    const low = await call(LOW, 'POST', DEP, { version: draft, transition: 'promote', toState: 'test' });
    expect(low.status).toBe(403);
    // Refused on the KEY lane, before membership or any load: the RFC 0200 challenge names the verb's scope.
    expect(low.challenge).toContain('insufficient_scope');
    expect(low.challenge).toContain('scope="deploy:*"');
    expect(low.body.error).toBe('forbidden');
    // `deploy:*` is one literal scope (RFC 0254): a key holding `deploy:pause` holds nothing.
    const narrow = await call(NARROW, 'POST', DEP, { version: draft, transition: 'promote' });
    expect(narrow.status).toBe(403);
    expect(narrow.challenge).toContain('insufficient_scope');
    expect(recordOf(await list(), draft)?.state).toBe('draft');

    // 0082.transition-illegal-refused
    for (const t of ['pause', 'deprecate']) {
      const r = await call(KEY_A, 'POST', DEP, { version: draft, transition: t });
      expect(r.status, t).toBe(409);
      // RFC 0254 §A. Registered in the pinned v2 error registry since 2.46.35: bare.
      expect(r.body.error).toBe('deployment_state_conflict');
      expect(r.body.details).toMatchObject({ state: 'draft', transition: t });
    }
    // Promote moves exactly one step.
    const jump = await call(KEY_A, 'POST', DEP, { version: draft, transition: 'promote', toState: 'active' });
    expect(jump.status).toBe(409);
    expect(jump.body.error).toBe('deployment_state_conflict');
    expect(jump.body.details).toMatchObject({ state: 'draft', transition: 'promote' });
    expect(recordOf(await list(), draft)).toEqual(recordOf(list0, draft));

    // 0082.transition-legal
    for (const toState of ['test', 'staged', 'active']) {
      const last = toState === 'active';
      // The suite sends no `toState` on the first step (RFC 0254 fixture delta).
      const r = await call<Rec>(KEY_A, 'POST', DEP, { version: draft, transition: 'promote', ...(toState === 'test' ? {} : { toState }), ...(last ? { channel: 'stable', canaryPercent: 100 } : {}) });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ agentId: AGENT, version: draft, state: toState });
    }
    const walked = await list();
    expect(activeOn(walked, 'stable').sort()).toEqual(['1.0.0', draft].sort());

    // 0082.replay-pin-reread — R2 resolves the candidate, the replay of R1 still 1.0.0.
    const r2 = await runFixture();
    expect(r2.version).toBe(draft);
    const fork = await call<RunBody>(KEY_A, 'POST', `/runs/${encodeURIComponent(r1.runId)}:fork`, { mode: 'replay' });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    await terminal(fork.body.runId);
    expect((await pinOf(fork.body.runId))?.resolvedAgentVersion).toBe('1.0.0');

    // 0082.canary-adjusted
    const canary = await call<Rec>(KEY_A, 'POST', DEP, { version: draft, transition: 'adjust-canary', canaryPercent: 50 });
    expect(canary.status).toBe(200);
    expect(canary.body.canaryPercent).toBe(50);
    expect(recordOf(await list(), draft)?.canaryPercent).toBe(50);

    // 0082.rollback-pointer
    const rb = await call<Rec>(KEY_A, 'POST', DEP, { version: draft, transition: 'rollback', reason: 'conformance' });
    expect(rb.status, JSON.stringify(rb.body)).toBe(200);
    expect(rb.body).toMatchObject({ state: 'rolled-back', rollbackPointer: '1.0.0' });
    const after = await list();
    expect(recordOf(after, '1.0.0')?.state).toBe('active');

    // RFC 0254 fixture delta — pause the version active on stable, then promote it back.
    const paused = await call<Rec>(KEY_A, 'POST', DEP, { version: '1.0.0', transition: 'pause' });
    expect(paused.status).toBe(200);
    expect(paused.body.state).toBe('paused');
    const resumed = await call<Rec>(KEY_A, 'POST', DEP, { version: '1.0.0', transition: 'promote' });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(resumed.body.state).toBe('active');

    // The next cut: exactly one active on stable at 100/absent, and a fresh draft.
    const next = await list();
    expect(activeOn(next, 'stable')).toEqual(['1.0.0']);
    expect(recordOf(next, '1.0.0')?.canaryPercent ?? 100).toBe(100);
    // The first promote of draft 1.0.1 left no draft, so the next patch was minted.
    const fresh = next.find((r) => r.state === 'draft');
    expect(draft).toBe('1.0.1');
    expect(fresh?.version).toBe('1.0.2');
    expect((await runFixture()).version).toBe('1.0.0');
  }, 60_000);

  it('a transition by a principal in another tenant sees nothing of tenant A', async () => {
    // Tenant C transitions first, in this case, so a leak has something to show.
    const promoted = await call<Rec>(KEY_C, 'POST', DEP, { version: '1.0.1', transition: 'promote' });
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
    expect((await list(KEY_C)).map((r) => [r.version, r.state])).toEqual([['1.0.0', 'active'], ['1.0.1', 'test'], ['1.0.2', 'draft']]);
    // Tenant D sees only its own seed: no `test` row and no 1.0.2.
    expect((await list(KEY_D)).map((r) => [r.version, r.state])).toEqual([['1.0.0', 'active'], ['1.0.1', 'draft']]);
  });

  it('refuses a malformed body, an unknown version and the reserved agent ids', async () => {
    const bad = async (body: Record<string, unknown>, field: string): Promise<void> => {
      const r = await call(KEY_A, 'POST', DEP, body);
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.error).toBe('validation_error');
      expect(r.body.details?.field).toBe(field);
    };
    await bad({ version: '1.0.0', transition: 'launch' }, 'transition');
    await bad({ version: '1.0.0', transition: 'adjust-canary', canaryPercent: 101 }, 'canaryPercent');
    await bad({ version: '1.0.0', transition: 'promote', extra: 1 }, 'extra');
    const unknown = await call(KEY_A, 'POST', DEP, { version: '9.9.9', transition: 'promote' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.details).toEqual({ agentId: AGENT, version: '9.9.9' });
    // A missing agent is "not found", never "unadvertised".
    for (const path of ['/agents/roster/deployments', '/agents/no.such.agent/deployments']) {
      const r = await call(KEY_A, 'GET', path);
      expect(r.status, path).toBe(404);
      expect(r.body.error, path).toBe('not_found');
      expect(r.body.details?.facet, path).toBeUndefined();
    }
  });
});

describe('the deployment-management run (RFC 0254 §D)', () => {
  it('an applied transition names a run carrying authorization.decided and the deployment event; a refusal makes none', async () => {
    resetTransitionRunIdWire(true);
    try {
      const all = await list(KEY_B);
      const draft = all.find((r) => r.state === 'draft')!.version;
      const r = await call<Rec>(KEY_B, 'POST', DEP, { version: draft, transition: 'promote' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const runId = r.body.transitionRunId ?? '';
      expect(runId).not.toBe('');
      expect(recordOf(await list(KEY_B), draft)?.transitionRunId).toBe(runId);
      const ev = await call<EventsBody>(KEY_B, 'GET', `/runs/${encodeURIComponent(runId)}/events/poll?fromSeq=-1&limit=100`);
      expect(ev.status, JSON.stringify(ev.body)).toBe(200);
      const types = (ev.body.events ?? []).map((e) => e.type);
      expect(types).toContain('authorization.decided');
      expect(types).toContain('deployment.promoted');
      // Another tenant cannot read it: a tenant-bound id names the wrong tenant (identity.md §5).
      const foreign = await call(KEY_A, 'GET', `/runs/${encodeURIComponent(runId)}/events/poll?fromSeq=-1&limit=100`);
      expect(foreign.status, JSON.stringify(foreign.body)).toBe(403);
      expect(foreign.body.error).toBe('id_tenant_mismatch');
      // A refused transition leaves the record's run pointer alone.
      expect((await call(KEY_B, 'POST', DEP, { version: draft, transition: 'deprecate' })).status).toBe(409);
      expect(recordOf(await list(KEY_B), draft)?.transitionRunId).toBe(runId);
    } finally {
      resetTransitionRunIdWire();
    }
  });

  it('the vendored 2.46.35 schema seats transitionRunId, so the wire switch is on', () => {
    // Reads the real vendored schemas/v2/agent-deployment.schema.json, not a forced value.
    resetTransitionRunIdWire();
    expect(transitionRunIdOnWire()).toBe(true);
  });

  it('with the switch off (a pre-2.46.35 pin) the closed record carries no transitionRunId', async () => {
    resetTransitionRunIdWire(false);
    try {
      for (const r of await list(KEY_B)) expect(Object.keys(r)).not.toContain('transitionRunId');
    } finally {
      resetTransitionRunIdWire();
    }
  });
});

describe('the eval gate (v2-deployment-eval-gate, ADR 1005 D7)', () => {
  async function failedEvalRun(key = KEY_A): Promise<string> {
    const c = await call<RunBody>(key, 'POST', '/runs', { mode: 'eval', evalSuiteRef: 'https://conformance.openwop.dev/eval-suites/conformance-eval-gate-failing', agentId: SCRIPTED });
    expect([201, 202], JSON.stringify(c.body)).toContain(c.status);
    expect(await terminal(c.body.runId)).toBe('completed');
    const s = await call<{ passed?: boolean }>(key, 'GET', `/runs/${encodeURIComponent(c.body.runId)}/eval-summary`);
    expect(s.body.passed).toBe(false);
    return c.body.runId;
  }
  const SDEP = `/agents/${SCRIPTED}/deployments`;

  it('a promote citing a failed eval run is 422 eval_gate_unmet, record unchanged', async () => {
    const before = (await list(KEY_A, SDEP)).find((r) => ['draft', 'test', 'staged'].includes(r.state))!;
    const evalRunId = await failedEvalRun();
    const r = await call(KEY_A, 'POST', SDEP, { version: before.version, transition: 'promote', evalRunId });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.error).toBe('eval_gate_unmet');
    expect(recordOf(await list(KEY_A, SDEP), before.version)).toEqual(before);
  }, 60_000);

  it('the policy requires evidence: a promote with none is refused too', async () => {
    const r = await call(KEY_A, 'POST', SDEP, { version: '1.0.0', transition: 'promote' });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('eval_gate_unmet');
    expect(r.body.details).toEqual({ reason: 'eval_required' });
  });

  it('another tenant\'s eval run is refused exactly like one that does not exist', async () => {
    // identity.md tenant rule / RFC 0252 §C single refusal (7e's condition on RFC 0254):
    // same status, code and details, so "another tenant's run" is indistinguishable
    // from "no such run". The cited id is not echoed.
    const wireId = await failedEvalRun();
    const bare = wireId.includes('/') ? wireId.slice(wireId.indexOf('/') + 1) : wireId;
    await list(KEY_B, SDEP);
    const ask = (evalRunId: string) => call(KEY_B, 'POST', SDEP, { version: '1.0.0', transition: 'promote', evalRunId });
    const shape = (r: Res, sent: string) => {
      expect(r.status).toBe(422);
      expect(r.body.error).toBe('eval_gate_unmet');
      expect(r.body.details, sent).toEqual({ reason: 'eval_run_not_found' });
      return JSON.stringify(r.body);
    };
    const missing = '00000000-0000-4000-8000-000000000000';
    const ref = shape(await ask(missing), missing);
    expect(shape(await ask(bare), bare), 'a bare id of tenant A\'s run').toBe(ref);
    expect(shape(await ask(wireId), wireId), 'tenant A\'s tenant-bound id').toBe(ref);
  }, 60_000);
});

describe('registration keeps and validates the agent binding (ADR 1005 D5)', () => {
  const def = (agent: Record<string, unknown>) => ({
    workflowId: `adr1005.wf.${(wfSeq += 1)}`, name: 'channel', version: '1.0',
    nodes: [{ nodeId: 'a', typeId: 'core.identity', name: 'a', position: { x: 0, y: 0 }, config: {}, inputs: {}, agent }],
    edges: [], triggers: [{ id: 'manual', type: 'manual', enabled: true }], variables: [],
  });

  it('refuses version AND channel together', async () => {
    const r = await call(KEY_A, 'POST', '/host/openwop-app/workflows', def({ agentId: AGENT, version: '1.0.0', channel: 'stable' }));
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.details?.field).toBe('nodes[0].agent');
  });

  it('refuses a channel while the facet is off, accepts it while on', async () => {
    process.env.OPENWOP_AGENT_DEPLOYMENT = 'off';
    try {
      const off = await call(KEY_A, 'POST', '/host/openwop-app/workflows', def({ agentId: AGENT, channel: 'stable' }));
      expect(off.status, JSON.stringify(off.body)).toBe(400);
      expect(off.body.details?.field).toBe('nodes[0].agent.channel');
    } finally {
      process.env.OPENWOP_AGENT_DEPLOYMENT = 'on';
    }
    const body = def({ agentId: AGENT, channel: 'stable' });
    const r = await call(KEY_A, 'POST', '/host/openwop-app/workflows', body);
    expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
    // The binding survives registration and the run is pinned.
    const run = await call<RunBody>(KEY_A, 'POST', '/runs', { workflowId: body.workflowId });
    expect(await terminal(run.body.runId)).toBe('completed');
    expect((await pinOf(run.body.runId))?.resolvedChannel).toBe('stable');
  });
});

describe('the transition table (ADR 1005 D3)', () => {
  it('promotes one step at a time, resumes a paused version, and refuses the rest', () => {
    expect(targetState('draft', { transition: 'promote' })).toBe('test');
    expect(targetState('staged', { transition: 'promote', toState: 'active' })).toBe('active');
    expect(targetState('paused', { transition: 'promote' })).toBe('active');
    expect(() => targetState('draft', { transition: 'promote', toState: 'active' })).toThrow(/cannot/);
    expect(() => targetState('rolled-back', { transition: 'rollback' })).toThrow(/cannot/);
    expect(() => targetState('deprecated', { transition: 'promote' })).toThrow(/cannot/);
    expect(targetState('active', { transition: 'adjust-canary' })).toBe('active');
  });
});
