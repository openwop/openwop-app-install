/**
 * ADR 0617 D3 — `people-hr.offboarding` 1.1.0: the SCIM-leaver lane + the gated
 * host-deprovision step, pinned STRUCTURALLY (this file), and the chain's
 * build determinism + manual-run terminal state (unchanged by the rewire).
 *
 * What is pinned and why:
 *   - `trigger` (`core.trigger.event`, `eventName: {{params.triggerEventName}}`,
 *     defaulting to `host.users.user.deactivated` — ADR 0683)
 *     is the SOLE root, wired to the three parallel entry nodes on a NAMED port
 *     (`trigger`) — the shape every other event chain in the corpus uses; the
 *     `handoff` fan-in (3 named ports, `workflow-chain-people-hr-execution.test.ts`)
 *     is untouched;
 *   - `deprovision-host` (`feature.users.nodes.deactivate`) has EXACTLY ONE
 *     inbound edge — `attest` `{truthy approved}` — and is reachable ONLY behind
 *     the gate (a second, unconditional trigger edge would be a structural gate
 *     escape under `workflow-chain-effect-reject-witness.test.ts`);
 *   - `attest.decision → notify.message` stays UNCONDITIONAL (NOTIFY_OF_OUTCOME);
 *   - `notify` remains the chain's primary terminal (the loader marks the LAST
 *     terminal `primary`; inserting the new node before `notify` keeps the
 *     declared `attestation` output where it was);
 *   - `{{params.userId}}` is LIVE (it appears in a node config) and `userId` is a
 *     declared, optional parameter;
 *   - `buildChainBackedDefinition` twice ⇒ byte-identical (deterministic
 *     expansion — no clock/random in the added nodes);
 *   - a MANUAL run (no triggerData) reaches the SAME terminal state it did
 *     before the rewire: it fails at the unwired M365 `deprovision` connector
 *     (`CONFIG_INVALID`) and never reaches `attest`/`deprovision-host` — stated
 *     honestly rather than claimed as "completes" (no chain-pack run of this
 *     chain has ever completed in this host; see the execution test's MODE note).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { getChain, expandChain } from '../src/host/workflowChainPackLoader.js';
import { buildChainBackedDefinition } from '../src/host/chainBackedWorkflows.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';

const CHAIN = 'people-hr.offboarding';
let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('people-hr.offboarding 1.1.0 — structure (ADR 0617 D3)', () => {
  const entry = () => getChain(CHAIN)!;

  it('pack + chain versions bumped with the behavioural change', () => {
    // Pack 1.4.0 → 1.5.0 templated the trigger binding (ADR 0683): the event
    // belongs to the installing host, not the pack.
    // Pack 1.3.0 → 1.4.0 carried the ADR 0622 D3 onboarding rewire; this
    // chain's own version stays at its ADR 0617 D3 bump.
    expect(entry().packVersion).toBe('1.5.0');
    expect(entry().chain.version).toBe('1.2.0');
  });

  it('`trigger` is the SOLE root, a core.trigger.event on host.users.user.deactivated, feeding the three entry nodes on a named port', () => {
    const { dag } = entry().chain;
    const trigger = dag.nodes.find((n) => n.id === 'trigger')!;
    expect(trigger.typeId).toBe('core.trigger.event');
    // ADR 0683 — the binding is TEMPLATED. The pack no longer names the event;
    // it declares a parameter and the installing host supplies the value. The
    // assertion moves with it: the token is what the pack carries, and the
    // param's DEFAULT is what this host resolves it to. Asserting the literal
    // here would be re-pinning the thing the ADR removed.
    expect((trigger.config as { eventName?: string }).eventName).toBe('{{params.triggerEventName}}');
    const param = (entry().chain.parameters as { properties?: Record<string, { default?: unknown }> })
      .properties?.triggerEventName;
    expect(param?.default, 'the default is what makes an existing install keep working')
      .toBe('host.users.user.deactivated');
    const edges = dag.edges ?? [];
    const roots = dag.nodes.filter((n) => !edges.some((e) => e.to.split('.')[0] === n.id)).map((n) => n.id);
    expect(roots).toEqual(['trigger']);
    expect(edges.filter((e) => e.from === 'trigger.payload').map((e) => e.to).sort()).toEqual(['accessTickets.trigger', 'deprovision.trigger', 'finalPay.trigger']);
    // the handoff fan-in is untouched: three named ports, no trigger edge
    expect(edges.filter((e) => e.to.startsWith('handoff.')).map((e) => e.to).sort()).toEqual(['handoff.accessTickets', 'handoff.deprovision', 'handoff.finalPay']);
  });

  it('`deprovision-host` has EXACTLY ONE inbound edge — attest {truthy approved} — and no outbound; notify stays unconditional', () => {
    const { dag } = entry().chain;
    const node = dag.nodes.find((n) => n.id === 'deprovision-host')!;
    expect(node.typeId).toBe('feature.users.nodes.deactivate');
    const edges = dag.edges ?? [];
    const inbound = edges.filter((e) => e.to.split('.')[0] === 'deprovision-host');
    expect(inbound).toEqual([{ from: 'attest', to: 'deprovision-host', condition: { type: 'truthy', left: 'approved' } }]);
    expect(edges.filter((e) => e.from.split('.')[0] === 'deprovision-host')).toEqual([]);
    const notifyIn = edges.filter((e) => e.to.split('.')[0] === 'notify');
    expect(notifyIn).toEqual([{ from: 'attest.decision', to: 'notify.message' }]);
  });

  it('`userId` is a declared OPTIONAL parameter and {{params.userId}} is LIVE in the host step\'s config', () => {
    const { chain } = entry();
    const params = chain.parameters as { required?: string[]; properties: Record<string, { default?: unknown }> };
    expect(params.properties.userId).toBeTruthy();
    expect(params.required ?? []).not.toContain('userId');
    expect(params.properties.userId!.default).toBe('');
    const node = chain.dag.nodes.find((n) => n.id === 'deprovision-host')!;
    expect((node.config as { userId?: string }).userId).toBe('{{params.userId}}');
  });

  it('expansion keeps `notify` as the primary terminal and freezes the param into the host step (Path A)', () => {
    const def = expandChain(entry().chain, { params: { employeeName: 'Sam', userId: 'user:abc' } });
    const primary = def.nodes.filter((n) => n.outputRole === 'primary');
    expect(primary.map((n) => n.nodeId.replace(/^.*_/, ''))).toEqual(['notify']);
    const host = def.nodes.find((n) => n.nodeId.endsWith('_deprovision-host'))!;
    expect((host.config as { userId?: string }).userId).toBe('user:abc');
    expect(JSON.stringify(def.nodes)).not.toContain('{{params');
    // A manual instantiation with the param unset freezes to '' — the node's typed
    // refusal (never a silent success) is what catches it (users-surface-authz).
    const bare = expandChain(entry().chain, { params: { employeeName: 'Sam' } });
    expect((bare.nodes.find((n) => n.nodeId.endsWith('_deprovision-host'))!.config as { userId?: string }).userId).toBe('');
  });

  it('buildChainBackedDefinition twice ⇒ byte-identical (deterministic expansion)', () => {
    expect(JSON.stringify(buildChainBackedDefinition(CHAIN))).toBe(JSON.stringify(buildChainBackedDefinition(CHAIN)));
    const a = expandChain(entry().chain, { params: { employeeName: 'Sam' } });
    const b = expandChain(entry().chain, { params: { employeeName: 'Sam' } });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('people-hr.onboarding 1.1.0 — structure (ADR 0622 D3): invite-host behind approve, into the track fan-in', () => {
  const ONB = 'people-hr.onboarding';
  const entry = () => getChain(ONB)!;

  it('pack + chain versions bumped with the behavioural change', () => {
    expect(entry().packVersion).toBe('1.5.0');
    expect(entry().chain.version).toBe('1.1.0');
  });

  it('`invite-host` (feature.orgs.nodes.invite) has EXACTLY ONE inbound edge — approve {truthy approved} — and ONE outbound into track on its own port', () => {
    const { dag } = entry().chain;
    const node = dag.nodes.find((n) => n.id === 'invite-host')!;
    expect(node.typeId).toBe('feature.orgs.nodes.invite');
    const edges = dag.edges ?? [];
    expect(edges.filter((e) => e.to.split('.')[0] === 'invite-host')).toEqual([{ from: 'approve', to: 'invite-host', condition: { type: 'truthy', left: 'approved' } }]);
    expect(edges.filter((e) => e.from.split('.')[0] === 'invite-host')).toEqual([{ from: 'invite-host', to: 'track.inviteHost' }]);
    // The provisioning fan-in: four named ports, one per source (BUG PATTERN A stays fixed).
    expect(edges.filter((e) => e.to.startsWith('track.')).map((e) => e.to).sort()).toEqual(['track.hris', 'track.inviteHost', 'track.itProvision', 'track.tickets']);
    // The reject branch is untouched: only `gate-reject` hangs off {falsy approved}.
    expect(edges.filter((e) => e.from === 'approve' && e.condition?.type === 'falsy').map((e) => e.to)).toEqual(['gate-reject']);
  });

  it('`newHireEmail` is a declared REQUIRED parameter, `orgId` optional (default ""), both LIVE in the host step\'s config', () => {
    const { chain } = entry();
    const params = chain.parameters as { required?: string[]; properties: Record<string, { default?: unknown }> };
    expect(params.required).toEqual(['newHireName', 'newHireEmail']);
    expect(params.properties.orgId!.default).toBe('');
    const node = chain.dag.nodes.find((n) => n.id === 'invite-host')!;
    expect(node.config).toEqual({ email: '{{params.newHireEmail}}', role: 'viewer', orgId: '{{params.orgId}}' });
  });

  it('expansion keeps `notify` as the sole primary terminal and freezes the params into the host step (Path A)', () => {
    const def = expandChain(entry().chain, { params: { newHireName: 'Sam', newHireEmail: 'sam@acme.test' } });
    expect(def.nodes.filter((n) => n.outputRole === 'primary').map((n) => n.nodeId.replace(/^.*_/, ''))).toEqual(['notify']);
    const host = def.nodes.find((n) => n.nodeId.endsWith('_invite-host'))!;
    expect(host.config).toEqual({ email: 'sam@acme.test', role: 'viewer', orgId: '' });
    expect(JSON.stringify(def.nodes)).not.toContain('{{params');
    // Unset required param: the whole-value token vanishes (no marker for a
    // whole-value position) — the node's typed refusal is what catches it.
    const bare = expandChain(entry().chain, { params: { newHireName: 'Sam' } });
    expect((bare.nodes.find((n) => n.nodeId.endsWith('_invite-host'))!.config as { email?: string }).email).toBeUndefined();
  });

  it('buildChainBackedDefinition twice ⇒ byte-identical (deterministic expansion)', () => {
    expect(JSON.stringify(buildChainBackedDefinition(ONB))).toBe(JSON.stringify(buildChainBackedDefinition(ONB)));
    const a = expandChain(entry().chain, { params: { newHireName: 'Sam', newHireEmail: 'sam@acme.test' } });
    const b = expandChain(entry().chain, { params: { newHireName: 'Sam', newHireEmail: 'sam@acme.test' } });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('people-hr.offboarding 1.1.0 — a MANUAL run (no triggerData) reaches the pre-rewire terminal state', () => {
  it('the trigger passes through (payload:null), the three entry nodes still run, and the run fails at the unwired M365 connector — never reaching attest / deprovision-host', async () => {
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
      return { status: res.status, body: await res.json().catch(() => undefined) };
    };
    const login = await call('POST', '/v1/host/openwop-app/test/login', { email: `offb-host-${Date.now()}@acme.test`, tenantId: `org:offb-host-${Date.now()}` });
    expect(login.status).toBe(201);

    const params = { employeeName: 'Jamie Offboard', ticketingBaseUrl: '', accessTicketKey: '', closeTransitionId: '', userId: '' };
    const expanded = expandChain(getChain(CHAIN)!.chain, { params });
    registerWorkflow(expanded);
    const create = await call('POST', '/v1/runs', { workflowId: expanded.workflowId, inputs: params });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;

    let snap: { status: string; error?: { code?: string } } = { status: 'pending' };
    for (let i = 0; i < 200; i++) {
      snap = (await call('GET', `/v1/runs/${runId}`)).body;
      if (['completed', 'failed', 'cancelled'].includes(snap.status)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(snap.status).toBe('failed');
    expect(snap.error?.code).toBe('CONFIG_INVALID');

    const bundle = await call('GET', `/v1/runs/${runId}/debug-bundle`);
    expect(bundle.status, JSON.stringify(bundle.body)).toBe(200);
    const list = (bundle.body.events as Array<{ type: string; nodeId?: string }>) ?? [];
    const completed = list.filter((e) => e.type === 'node.completed').map((e) => e.nodeId ?? '');
    expect(completed.some((id) => id.endsWith('_trigger')), 'the trigger entry node completes on a manual run').toBe(true);
    expect(completed.some((id) => id.endsWith('_accessTickets'))).toBe(true);
    expect(completed.some((id) => id.endsWith('_finalPay'))).toBe(true);
    const failed = list.find((e) => e.type === 'node.failed');
    expect(failed?.nodeId?.endsWith('_deprovision')).toBe(true);
    expect(list.some((e) => e.nodeId?.endsWith('_attest'))).toBe(false);
    expect(list.some((e) => e.nodeId?.endsWith('_deprovision-host'))).toBe(false);
  });
});
