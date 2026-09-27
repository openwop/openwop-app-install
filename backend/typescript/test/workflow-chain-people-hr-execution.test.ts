/**
 * people-hr workflow-chain pack — REAL execution (ADR 0149, RFC 0013).
 *
 * Structural coverage already exists (`workflow-chain-adr0149-clusters.test.ts`,
 * owned by another session — not touched here). This adds REAL-executor +
 * real-node-implementation coverage for all three chains.
 *
 * MODE CHOSEN (per chain), determined by actually tracing node order — not
 * assumed:
 *
 *   - `people-hr.onboarding`: the root node is `plan` (`core.ai.chatCompletion`,
 *     no `provider`/`model` — a chain-pack TEMPLATE, exactly like every other
 *     workflow-chain pack; an operator wires a live provider on install). `plan`
 *     sits BEFORE `approve` (the gate) and before every connector node, so the
 *     REAL executor fails at `plan` before it can ever reach the gate or the
 *     connectors. Mode: real-executor HONEST FAILURE (mirrors
 *     `workflow-chain-exec-ops-execution.test.ts`) — `error.code ===
 *     'provider_not_supported'`, nothing downstream ever runs.
 *   - `people-hr.offboarding`: the three roots (`deprovision`, `accessTickets`,
 *     `finalPay`) are NOT AI nodes — they run in parallel, feed `handoff`
 *     (AI), which gates `attest` (the approval gate). `accessTickets`
 *     (`core.openwop.connectors.ticket-transition`) and `finalPay`
 *     (`core.openwop.connectors.hris-action`) degrade gracefully
 *     (`connected:false`) with NO Connection configured — the documented
 *     ADR 0186 contract (`capability-dispatch-hris.test.ts` /
 *     `capability-dispatch-ticketing.test.ts`). `deprovision`
 *     (`core.openwop.http.openapi-call`) is NOT a connector-capability node —
 *     it never reads `config.connectionRef` at all (that field is
 *     presentational pre-flight metadata only, see
 *     `workflowChainPackLoader.ts` §`chainRequirements`); it requires an
 *     operator-wired `ctx.inputs.openapi` document that no chain-pack ships,
 *     so it ALWAYS fails with `error.code: 'CONFIG_INVALID'` (`packs/
 *     core.openwop.http/index.mjs`'s `openapiCall`, wrapped cleanly by the
 *     pack loader's try/catch, `packs/tarballLoader.ts`, which preserves the
 *     thrown `.code`). Since `deprovision` is the ONLY one of the three roots
 *     that can fail, the terminal state is DETERMINISTIC even though all
 *     three race in parallel. Mode: real-executor HONEST FAILURE — this is
 *     the PRIMARY "genuine terminal state" test: it proves the two REAL
 *     connector nodes' graceful degrade end-to-end via the real executor,
 *     and that the run cleanly fails at `deprovision`, never reaching
 *     `handoff`/`attest`.
 *   - `people-hr.pto-routing`: the two roots (`policy`, an AI node, and
 *     `calendar`, an `openapi-call` node with the SAME unwired-doc limitation
 *     as `deprovision`) BOTH always fail — a genuine race with no
 *     deterministic single failing node, so this file does not add a
 *     real-executor run for it (would be flaky by construction). Its
 *     multi-fan-in port fix (`approve`, see below) is still proven directly.
 *
 * BUG FOUND + FIXED AT THE ROOT (`examples/workflow-chain-packs/people-hr/
 * pack.json`) — BUG PATTERN A, the SAME defect class as `csm-ops.health-
 * from-crm` (`workflow-chain-csm-ops-execution.test.ts`) and `exec-ops`
 * (`workflow-chain-exec-ops-execution.test.ts`): three multi-fan-in nodes
 * named neither `sourceOutput` nor `targetInput` on ANY of their inbound
 * edges, so the scheduler's `buildNodeInputs` (`executor/scheduler.ts`)
 * wrote every edge's value to the SAME default port key `'input'` in
 * edge-array order — the last edge silently clobbered the rest before the
 * node ever saw them:
 *
 *   1. `people-hr.onboarding`'s `track` (3 inbound: `itProvision`, `hris`,
 *      `tickets`) — the onboarding-completion AI summary would have silently
 *      dropped 2 of its 3 real data sources on every run.
 *   2. `people-hr.offboarding`'s `handoff` (3 inbound: `deprovision`,
 *      `accessTickets`, `finalPay`) — same defect on the knowledge-handoff
 *      summary.
 *   3. `people-hr.pto-routing`'s `approve` (2 inbound: `policy`, `calendar`)
 *      — same defect on the manager-approval gate's upstream context.
 *
 * Fixed with explicit dot-notation target ports on every affected edge
 * (`itProvision.itProvision`→`track.itProvision`, etc. — see pack.json diff),
 * which the scheduler resolves to distinct output/input keys. The WHOLE pack
 * was re-scanned for any OTHER un-flagged multi-inbound node; these three are
 * exhaustive (every other node in the pack has at most one inbound edge).
 *
 * Proof strategy for BUG PATTERN A: none of the three fixed nodes is
 * REACHABLE via the real executor (each sits downstream of an AI node OR an
 * unwired `openapi-call` node that always fails first — see MODE CHOSEN
 * above), so — mirroring how `exec-ops`'s test documents its own fan-in fix
 * without being able to observe it end-to-end — this file instead calls the
 * REAL scheduler function at the exact site of the bug, `buildNodeInputs`
 * (`executor/scheduler.ts`), against the REAL expanded (post-fix) chain
 * definition, with real/representative upstream outputs. This is a STRONGER,
 * more direct proof than exec-ops could manage: it exercises the exact
 * production code the defect lived in, and (for `track`) additionally proves
 * the REAL `core.ai.chatCompletion` node (`packs/core.openwop.ai/index.mjs`'s
 * `toMessages`) actually serializes all 3 recovered sources into the prompt
 * it would send a real model. Each proof also runs the SAME real inputs
 * through a simulated PRE-FIX edge shape (no `targetInput`) to show the
 * regression these tests guard against: collapse to a single `'input'` key,
 * last-edge-wins.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getChain, expandChain } from '../src/host/workflowChainPackLoader.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { buildGraph, buildNodeInputs } from '../src/executor/scheduler.js';
import type { AiCallRequest, AiCallResult, NodeContext } from '../src/executor/types.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
  // people-hr's nodes (core.ai.*, core.chat.approvalGate, core.openwop.http.*,
  // core.openwop.connectors.*, core.openwop.integration.*) are all always-on
  // core/pack surfaces — none read a toggle-gated `ctx.features.<id>` (unlike
  // crm/csm/cms), so no other toggle needs enabling.

  // `core.ai.chatCompletion` is a PACK node (packs/core.openwop.ai), resolved
  // asynchronously on first miss (nodeRegistry.ts's `resolve`), unlike the
  // built-in `core.openwop.connectors.*` nodes registered synchronously in
  // bootstrap/nodes.ts. Pre-resolve it once so the fan-in proof tests below
  // can use the synchronous `getNodeRegistry().get(...)` the same way
  // `capability-dispatch-hris.test.ts` does for the built-ins.
  await getNodeRegistry().resolve('core.ai.chatCompletion');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const sc = getSetCookies(res.headers);
    for (const c of sc as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

let n = 0;
async function ownerOrg(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:hrchain-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `hrchain-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}

interface RunSnapshot { status: string; error?: { code: string; message: string } }
async function pollRun(owner: Client, runId: string): Promise<RunSnapshot> {
  let snap: RunSnapshot = { status: 'pending' };
  for (let i = 0; i < 80; i++) {
    const r = await owner.get(`/v1/runs/${runId}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    snap = r.body as RunSnapshot;
    if (snap.status === 'completed' || snap.status === 'failed' || snap.status === 'cancelled' || snap.status.startsWith('waiting')) break;
    await new Promise((res) => setTimeout(res, 25));
  }
  return snap;
}

interface BundleEvent { type?: string; nodeId?: string; payload?: Record<string, unknown> }
async function bundleEvents(owner: Client, runId: string): Promise<BundleEvent[]> {
  const b = await owner.get(`/v1/runs/${runId}/debug-bundle`);
  expect(b.status, JSON.stringify(b.body)).toBe(200);
  return (b.body.events as BundleEvent[]) ?? [];
}
function completedOutputs(events: BundleEvent[], nodeSuffix: string): Record<string, unknown> {
  const ev = events.find((e) => e.type === 'node.completed' && e.nodeId?.endsWith(`_${nodeSuffix}`));
  expect(ev, `expected a node.completed event for node "${nodeSuffix}": ${JSON.stringify(events.map((e) => ({ type: e.type, nodeId: e.nodeId })))}`).toBeTruthy();
  return (ev!.payload!.outputs as Record<string, unknown>) ?? {};
}

/* ─── mini-scheduler / direct-node-call helpers (bug-pattern-A proofs) ──── */

function makeCtx(over: Partial<NodeContext>): NodeContext {
  const base: NodeContext = {
    runId: 'run_1', nodeId: 'n1', tenantId: 'demo', inputs: {}, configurable: {},
    attempt: 1, secrets: {}, emit: async () => ({ eventId: 'e1', sequence: 1 }),
  };
  return { ...base, ...over };
}
/** ctx.connectors double resolving to "no provider connected" — the same
 *  no-Connection-configured double `capability-dispatch-hris.test.ts` /
 *  `capability-dispatch-ticketing.test.ts` use to prove the graceful degrade. */
const noProviderConnectors = {
  resolveForCapability: async () => null,
  resolveAllForCapability: async () => [],
  invoke: async () => ({ ok: false, status: 0, error: 'should_not_call' }),
};
/** Resolve `{{inputs.name}}` config tokens from the run params — expandChain
 *  renames `{{params.*}}` → `{{inputs.*}}`; the executor resolves them from
 *  the per-run variable bag at execution. Mirrors `cms-chain-execution.
 *  test.ts`'s `resolveConfig`. */
function resolveConfig(config: Record<string, unknown> | undefined, params: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config ?? {}).map(([k, v]) => [
    k,
    typeof v === 'string' ? v.replace(/\{\{inputs\.([a-zA-Z0-9_]+)\}\}/g, (_m, name: string) => params[name] ?? '') : v,
  ]));
}

/* ═══════════════════════ real-executor: honest failure ═══════════════════ */

describe('people-hr.offboarding — end-to-end execution (real executor, honest failure)', () => {
  it('degrades ticketing + HRIS for real (no Connection configured), fails cleanly at the unwired M365 connector, and never reaches handoff/attest', async () => {
    const { owner } = await ownerOrg();
    const found = getChain('people-hr.offboarding');
    expect(found, 'people-hr.offboarding chain must be loaded at boot').toBeTruthy();
    const params = { employeeName: 'Jamie Offboard', ticketingBaseUrl: '', accessTicketKey: '', closeTransitionId: '' };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);

    const create = await owner.post('/v1/runs', { workflowId: expanded.workflowId, inputs: params });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;

    const snap = await pollRun(owner, runId);
    expect(snap.status).toBe('failed');
    expect(snap.error?.code).toBe('CONFIG_INVALID');

    const events = await bundleEvents(owner, runId);
    // The two REAL connector nodes ran for real and degraded gracefully — no
    // Connection is configured for this tenant, so both report `connected:false`
    // yet complete successfully (ADR 0186's documented contract).
    expect(completedOutputs(events, 'accessTickets')).toMatchObject({ connected: false, transitioned: false });
    expect(completedOutputs(events, 'finalPay')).toMatchObject({ connected: false, applied: false });

    // `deprovision` is the only node that can fail — `core.openwop.http.
    // openapi-call` never reads `config.connectionRef` (presentational
    // pre-flight metadata only); it requires an operator-wired
    // `ctx.inputs.openapi` document no chain-pack ships.
    const failedEvent = events.find((e) => e.type === 'node.failed');
    expect(failedEvent?.nodeId?.endsWith('_deprovision')).toBe(true);

    // Never reached the AI handoff summary or the compliance-attestation gate.
    expect(events.some((e) => e.nodeId?.endsWith('_handoff'))).toBe(false);
    expect(events.some((e) => e.nodeId?.endsWith('_attest'))).toBe(false);
  });
});

describe('people-hr.onboarding — end-to-end execution (real executor, honest failure)', () => {
  it('fails cleanly at the un-configured planning AI node — never reaches the approval gate or any connector', async () => {
    const { owner } = await ownerOrg();
    const found = getChain('people-hr.onboarding');
    expect(found, 'people-hr.onboarding chain must be loaded at boot').toBeTruthy();
    const params = { newHireName: 'Riley Onboard', newHireEmail: 'riley.onboard@acme.test', role: 'Engineer', ticketingBaseUrl: '', ticketProject: 'HR' };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);

    const create = await owner.post('/v1/runs', { workflowId: expanded.workflowId, inputs: params });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;

    const snap = await pollRun(owner, runId);
    expect(snap.status).toBe('failed');
      // §Correction (P3): this asserted `provider_not_supported`, which PINNED THE
      // BUG AS EXPECTED BEHAVIOUR — the chain had no `provider` in its AI node
      // config, so the run died with `Provider "undefined"`. The suite called that
      // "fails cleanly". Now the chain freezes a real provider at expansion, so a
      // credential-less test tenant fails one step LATER and honestly:
      // `byok_required` — configure a key — instead of naming a provider that
      // never existed.
    expect(snap.error?.code).toBe('byok_required');

    const events = await bundleEvents(owner, runId);
    const failedEvent = events.find((e) => e.type === 'node.failed');
    expect(failedEvent?.nodeId?.endsWith('_plan')).toBe(true);
    expect(events.some((e) => e.type === 'node.completed' || e.type === 'node.failed')).toBe(true);
    // The `plan` node is the sole root — nothing else in the chain ever ran.
    // ADR 0622 D3 — `invite-host` sits behind `approve` like the three provisioners.
    for (const suffix of ['approve', 'itProvision', 'hris', 'tickets', 'invite-host', 'track', 'notify']) {
      expect(events.some((e) => e.nodeId?.endsWith(`_${suffix}`)), `${suffix} must not have run`).toBe(false);
    }
  });
});

/* ═══════════════ BUG PATTERN A regression proofs (buildNodeInputs) ═══════ */

describe('people-hr — BUG PATTERN A regression proof: multi-fan-in port collision', () => {
  it('people-hr.onboarding "track" merges itProvision + hris + tickets onto 3 distinct ports — and the real AI node sees all 3', async () => {
    const found = getChain('people-hr.onboarding');
    expect(found).toBeTruthy();
    const params = { newHireName: 'Riley Bug-A', newHireEmail: 'riley.buga@acme.test', role: 'Engineer', ticketingBaseUrl: '', ticketProject: 'HR' };
    const expanded = expandChain(found!.chain, { params });
    const graph = buildGraph(expanded);
    const nodeId = (suffix: string): string => expanded.nodes.find((nd) => nd.nodeId.endsWith(`_${suffix}`))!.nodeId;
    const configOf = (suffix: string): Record<string, unknown> | undefined =>
      expanded.nodes.find((nd) => nd.nodeId.endsWith(`_${suffix}`))!.config as Record<string, unknown> | undefined;

    // `itProvision` (core.openwop.http.openapi-call) cannot execute for real in
    // this harness — it requires an operator-wired `ctx.inputs.openapi`
    // document, a pack-external configuration gap unrelated to BUG PATTERN A
    // (see the file header). The fix under test is the PORT WIRING, which
    // `buildNodeInputs` applies identically no matter how the upstream output
    // was produced — a representative completed output stands in.
    const itProvisionOutput = { status: 201, headers: {}, body: { id: 'm365-user-42' }, url: 'https://graph.microsoft.com/v1.0/users', method: 'POST' };

    const hrisNode = getNodeRegistry().get('core.openwop.connectors.hris-action')!;
    const hrisResult = await hrisNode.execute(makeCtx({ config: resolveConfig(configOf('hris'), params), connectors: noProviderConnectors }));
    expect(hrisResult.status, JSON.stringify(hrisResult)).toBe('success');
    const hrisOutputs: Record<string, unknown> = hrisResult.status === 'success' ? ((hrisResult.outputs ?? {}) as Record<string, unknown>) : {};

    const ticketsNode = getNodeRegistry().get('core.openwop.connectors.ticket-create')!;
    const ticketsResult = await ticketsNode.execute(makeCtx({ config: resolveConfig(configOf('tickets'), params), connectors: noProviderConnectors }));
    expect(ticketsResult.status, JSON.stringify(ticketsResult)).toBe('success');
    const ticketsOutputs: Record<string, unknown> = ticketsResult.status === 'success' ? ((ticketsResult.outputs ?? {}) as Record<string, unknown>) : {};

    const snapshot = { order: [], nodeState: new Map<string, 'completed'>(), nodeOutputs: new Map<string, Record<string, unknown>>(), nodeErrors: new Map() };
    const sources: Array<[string, Record<string, unknown>]> = [
      ['itProvision', itProvisionOutput],
      ['hris', hrisOutputs],
      ['tickets', ticketsOutputs],
    ];
    for (const [suffix, output] of sources) {
      snapshot.nodeState.set(nodeId(suffix), 'completed');
      snapshot.nodeOutputs.set(nodeId(suffix), output);
    }

    // THE FIX under test: `buildNodeInputs` is the exact scheduler function
    // BUG PATTERN A broke (executor/scheduler.ts). With the pack.json dot-
    // notation ports, it resolves to 3 distinct keys — one per upstream source.
    const inputsByPort = buildNodeInputs(nodeId('track'), graph, snapshot, undefined);
    expect(Object.keys(inputsByPort).sort()).toEqual(['hris', 'itProvision', 'tickets']);
    expect(inputsByPort.itProvision).toEqual(itProvisionOutput);
    expect(inputsByPort.hris).toEqual(hrisOutputs);
    expect(inputsByPort.tickets).toEqual(ticketsOutputs);

    // Regression proof: the SAME real `buildNodeInputs` against a simulated
    // PRE-FIX edge shape (no `targetInput` at all — exactly what pack.json
    // shipped with before this fix) collapses all 3 onto the scheduler's
    // shared default port key, last-edge-wins: only `tickets` (the last of
    // the 3 edges) survives.
    const buggyGraph = buildGraph({
      ...expanded,
      edges: (expanded.edges ?? []).map((e) => (e.targetNodeId === nodeId('track') ? { ...e, targetInput: undefined } : e)),
    });
    const buggyInputs = buildNodeInputs(nodeId('track'), buggyGraph, snapshot, undefined);
    expect(Object.keys(buggyInputs)).toEqual(['input']);
    expect(buggyInputs.input).toEqual(ticketsOutputs); // itProvision + hris silently dropped, pre-fix

    // Downstream proof: the REAL core.ai.chatCompletion node (`toMessages`,
    // packs/core.openwop.ai/index.mjs) serializes a structured ctx.inputs
    // verbatim into the prompt — post-fix, all 3 sources actually reach the
    // model; pre-fix, 2 of the 3 would silently vanish from every real
    // onboarding-completion summary.
    const chatCompletionNode = getNodeRegistry().get('core.ai.chatCompletion')!;
    expect(chatCompletionNode, 'core.ai.chatCompletion must resolve (pre-resolved in beforeAll)').toBeTruthy();
    let capturedMessages: unknown;
    const fakeCallAI = async (req: AiCallRequest): Promise<AiCallResult> => {
      capturedMessages = req.messages;
      return { content: 'Onboarding complete.', usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const trackResult = await chatCompletionNode.execute(makeCtx({
      inputs: inputsByPort,
      config: resolveConfig(configOf('track'), params),
      callAI: fakeCallAI,
    }));
    expect(trackResult.status, JSON.stringify(trackResult)).toBe('success');
    const serialized = JSON.stringify(capturedMessages);
    expect(serialized).toContain('m365-user-42'); // itProvision's marker
    expect(serialized).toContain('connected'); // hris + tickets output shape
  });

  it('people-hr.offboarding "handoff" merges deprovision + accessTickets + finalPay onto 3 distinct ports', async () => {
    const found = getChain('people-hr.offboarding');
    expect(found).toBeTruthy();
    const params = { employeeName: 'Jamie Bug-A', ticketingBaseUrl: '', accessTicketKey: '', closeTransitionId: '' };
    const expanded = expandChain(found!.chain, { params });
    const graph = buildGraph(expanded);
    const nodeId = (suffix: string): string => expanded.nodes.find((nd) => nd.nodeId.endsWith(`_${suffix}`))!.nodeId;
    const configOf = (suffix: string): Record<string, unknown> | undefined =>
      expanded.nodes.find((nd) => nd.nodeId.endsWith(`_${suffix}`))!.config as Record<string, unknown> | undefined;

    // `deprovision` (core.openwop.http.openapi-call) — same unwired-doc
    // limitation as onboarding's `itProvision`; a representative output stands
    // in (see file header).
    const deprovisionOutput = { status: 204, headers: {}, body: null, url: 'https://graph.microsoft.com/v1.0/users/jamie', method: 'PATCH' };

    const accessTicketsNode = getNodeRegistry().get('core.openwop.connectors.ticket-transition')!;
    const accessTicketsResult = await accessTicketsNode.execute(makeCtx({ config: resolveConfig(configOf('accessTickets'), params), connectors: noProviderConnectors }));
    expect(accessTicketsResult.status, JSON.stringify(accessTicketsResult)).toBe('success');
    const accessTicketsOutputs: Record<string, unknown> = accessTicketsResult.status === 'success' ? ((accessTicketsResult.outputs ?? {}) as Record<string, unknown>) : {};

    const finalPayNode = getNodeRegistry().get('core.openwop.connectors.hris-action')!;
    const finalPayResult = await finalPayNode.execute(makeCtx({ config: resolveConfig(configOf('finalPay'), params), connectors: noProviderConnectors }));
    expect(finalPayResult.status, JSON.stringify(finalPayResult)).toBe('success');
    const finalPayOutputs: Record<string, unknown> = finalPayResult.status === 'success' ? ((finalPayResult.outputs ?? {}) as Record<string, unknown>) : {};

    const snapshot = { order: [], nodeState: new Map<string, 'completed'>(), nodeOutputs: new Map<string, Record<string, unknown>>(), nodeErrors: new Map() };
    const sources: Array<[string, Record<string, unknown>]> = [
      ['deprovision', deprovisionOutput],
      ['accessTickets', accessTicketsOutputs],
      ['finalPay', finalPayOutputs],
    ];
    for (const [suffix, output] of sources) {
      snapshot.nodeState.set(nodeId(suffix), 'completed');
      snapshot.nodeOutputs.set(nodeId(suffix), output);
    }

    const inputsByPort = buildNodeInputs(nodeId('handoff'), graph, snapshot, undefined);
    expect(Object.keys(inputsByPort).sort()).toEqual(['accessTickets', 'deprovision', 'finalPay']);
    expect(inputsByPort.deprovision).toEqual(deprovisionOutput);
    expect(inputsByPort.accessTickets).toEqual(accessTicketsOutputs);
    expect(inputsByPort.finalPay).toEqual(finalPayOutputs);

    // Regression proof — the pre-fix edge shape collapses to the last edge
    // (`finalPay`) only.
    const buggyGraph = buildGraph({
      ...expanded,
      edges: (expanded.edges ?? []).map((e) => (e.targetNodeId === nodeId('handoff') ? { ...e, targetInput: undefined } : e)),
    });
    const buggyInputs = buildNodeInputs(nodeId('handoff'), buggyGraph, snapshot, undefined);
    expect(Object.keys(buggyInputs)).toEqual(['input']);
    expect(buggyInputs.input).toEqual(finalPayOutputs); // deprovision + accessTickets silently dropped, pre-fix
  });

  it('people-hr.pto-routing "approve" merges policy + calendar onto 2 distinct ports — and preserves the real AI plan for the gate-preview artifact', async () => {
    const found = getChain('people-hr.pto-routing');
    expect(found).toBeTruthy();
    const params = { employeeName: 'Sam Bug-A', dates: '2026-07-14', hrisBaseUrl: '', workerId: '', timeOffType: '' };
    const expanded = expandChain(found!.chain, { params });
    const graph = buildGraph(expanded);
    const nodeId = (suffix: string): string => expanded.nodes.find((nd) => nd.nodeId.endsWith(`_${suffix}`))!.nodeId;
    const configOf = (suffix: string): Record<string, unknown> | undefined =>
      expanded.nodes.find((nd) => nd.nodeId.endsWith(`_${suffix}`))!.config as Record<string, unknown> | undefined;

    // `policy` (core.ai.chatCompletion) CAN run for real with a fake ctx.callAI
    // — its REAL output shape is exercised, unlike the other two proofs' AI
    // stand-in.
    const chatCompletionNode = getNodeRegistry().get('core.ai.chatCompletion')!;
    const policyResult = await chatCompletionNode.execute(makeCtx({
      config: resolveConfig(configOf('policy'), params),
      callAI: async (): Promise<AiCallResult> => ({ content: 'Eligible; low coverage risk.', usage: { inputTokens: 1, outputTokens: 1 } }),
    }));
    expect(policyResult.status, JSON.stringify(policyResult)).toBe('success');
    const policyOutputs: Record<string, unknown> = policyResult.status === 'success' ? ((policyResult.outputs ?? {}) as Record<string, unknown>) : {};

    // `calendar` (core.openwop.http.openapi-call) — same unwired-doc
    // limitation as the other two proofs' openapi-call node.
    const calendarOutput = { status: 200, headers: {}, body: { value: [] }, url: 'https://graph.microsoft.com/v1.0/me/calendarView', method: 'GET' };

    const snapshot = { order: [], nodeState: new Map<string, 'completed'>(), nodeOutputs: new Map<string, Record<string, unknown>>(), nodeErrors: new Map() };
    const sources: Array<[string, Record<string, unknown>]> = [
      ['policy', policyOutputs],
      ['calendar', calendarOutput],
    ];
    for (const [suffix, output] of sources) {
      snapshot.nodeState.set(nodeId(suffix), 'completed');
      snapshot.nodeOutputs.set(nodeId(suffix), output);
    }

    const inputsByPort = buildNodeInputs(nodeId('approve'), graph, snapshot, undefined);
    expect(Object.keys(inputsByPort).sort()).toEqual(['calendar', 'policy']);
    expect(inputsByPort.policy).toEqual(policyOutputs);
    expect(inputsByPort.calendar).toEqual(calendarOutput);
    expect((inputsByPort.policy as { content?: string }).content).toBe('Eligible; low coverage risk.');

    // Regression proof — the pre-fix edge shape collapses to the last edge
    // (`calendar`) only, silently dropping the AI policy assessment the
    // manager-approval gate's preview would have shown.
    const buggyGraph = buildGraph({
      ...expanded,
      edges: (expanded.edges ?? []).map((e) => (e.targetNodeId === nodeId('approve') ? { ...e, targetInput: undefined } : e)),
    });
    const buggyInputs = buildNodeInputs(nodeId('approve'), buggyGraph, snapshot, undefined);
    expect(Object.keys(buggyInputs)).toEqual(['input']);
    expect(buggyInputs.input).toEqual(calendarOutput);
  });
});
