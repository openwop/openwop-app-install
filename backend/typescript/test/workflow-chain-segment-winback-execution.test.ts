/**
 * campaign-journeys.segment-winback — REAL execution (ADR 0255 / RFC 0126).
 *
 * The installable chain that closes ADR 0255: a saved CRM segment → the
 * `segment-members` source → the `segment-winback-plan` supervisor → the REAL
 * `core.dispatch` fanning ONE child workflow out over every member, each child
 * receiving its OWN contactId (RFC 0126 per-item input, advertised honest-on now
 * that RFC 0126 is Accepted / openwop#826).
 *
 * Proves what #1279's node-level end-to-end could NOT:
 *  1. the chain EXPANDS to a valid definition on the real host — exercising the
 *     real capability gating (`core.dispatch` fanOutPolicy 'parallel' + wait-all/
 *     collect join, all advertised) and the CHAINX-5 fix that preserves node-level
 *     `inputs` through expansion;
 *  2. a live HTTP run resolves a REAL 3-contact segment and fans out 3 children,
 *     each with its own contactId + the shared params — the whole chain on the
 *     real executor, not a synthetic supervisor payload.
 *
 * The per-member child is a `core.noop` STUB (registered as the `childWorkflowId`)
 * so children terminate immediately — the real `re-engage-contact` child suspends
 * at its sign-off gate, which a wait-all parent would (correctly) await forever;
 * the child's own end-to-end path is proven separately by
 * `workflow-chain-campaign-journeys-execution.test.ts`.
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
import type { WorkflowDefinition } from '../src/executor/types.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  // RFC 0126 is Accepted → perItemInput is advertised by default; be explicit so
  // this witness is env-order-independent within the shared worker.
  delete process.env.OPENWOP_DISPATCH_PER_ITEM_INPUT;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const crm = getToggleDefault('crm');
  if (crm) await saveConfig({ ...crm, status: 'on' }, 'test');
  const cj = getToggleDefault('campaign-journeys');
  if (cj) await saveConfig({ ...cj, status: 'on' }, 'test');
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
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

let n = 0;
async function ownerOrg(): Promise<{ owner: Client; orgId: string }> {
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `swb-${Date.now()}-${n++}@acme.test`, tenantId: `org:swb-${Date.now()}-${n++}` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}

interface RunSnapshot { status: string; error?: { code: string; message: string } }
async function pollRun(owner: Client, runId: string): Promise<RunSnapshot> {
  let snap: RunSnapshot = { status: 'pending' };
  for (let i = 0; i < 120; i++) {
    const r = await owner.get(`/v1/runs/${runId}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    snap = r.body as RunSnapshot;
    if (['completed', 'failed', 'cancelled'].includes(snap.status) || snap.status.startsWith('waiting')) break;
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

describe('campaign-journeys.segment-winback — expansion validity (server-free)', () => {
  it('loads at boot and expands to a valid definition on the real host (real capability gating + CHAINX-5 inputs)', () => {
    const found = getChain('campaign-journeys.segment-winback');
    expect(found, 'campaign-journeys.segment-winback chain must be loaded at boot').toBeTruthy();
    // expandChain re-validates its own output through validateWorkflowDefinition,
    // which enforces core.dispatch capability gating (fanOutPolicy/joinMode/
    // onChildFailure MUST be advertised). A throw here would mean the chain wires
    // a mode this host does not honor.
    const expanded = expandChain(found!.chain, { params: { childWorkflowId: 'wf.stub.child', fromAddress: 'news@acme.test', orgId: 'o1' } });

    const byType = (t: string) => expanded.nodes.find((nd) => nd.typeId === t);
    const segment = byType('feature.campaign-journeys.nodes.segment-members');
    const plan = byType('feature.campaign-journeys.nodes.segment-winback-plan');
    const dispatch = byType('core.dispatch');
    expect(segment, 'segment-members source node').toBeTruthy();
    expect(plan, 'segment-winback-plan supervisor node').toBeTruthy();
    expect(dispatch, 'core.dispatch fan-out node').toBeTruthy();

    // The supervisor's per-child inputs come from config (frozen), NOT node.inputs —
    // childWorkflowId + shared params are all in config; contactId per member arrives
    // on the segment→plan edge at run time.
    expect((plan!.config as Record<string, unknown>).childWorkflowId).toBe('wf.stub.child');
    expect((plan!.config as Record<string, unknown>).fromAddress).toBe('news@acme.test');
    expect((plan!.config as Record<string, unknown>).subject).toBe('We saved your spot'); // default applied
    // The dispatch node is a parallel wait-all/collect fan-out.
    expect((dispatch!.config as Record<string, unknown>).fanOutPolicy).toBe('parallel');

    // Wiring: segment.contactIds → plan.contactIds ; plan → dispatch (whole payload).
    const edge = (fromT: string, toT: string) => {
      const fromId = byType(fromT)!.nodeId; const toId = byType(toT)!.nodeId;
      return (expanded.edges ?? []).find((e) => e.sourceNodeId === fromId && e.targetNodeId === toId);
    };
    const segToPlan = edge('feature.campaign-journeys.nodes.segment-members', 'feature.campaign-journeys.nodes.segment-winback-plan');
    expect(segToPlan, 'segment → plan edge').toBeTruthy();
    expect(segToPlan!.sourceOutput).toBe('contactIds');
    expect(segToPlan!.targetInput).toBe('contactIds');
    expect(edge('feature.campaign-journeys.nodes.segment-winback-plan', 'core.dispatch'), 'plan → dispatch edge').toBeTruthy();
  });
});

describe('campaign-journeys.segment-winback — live fan-out over a real segment (HTTP)', () => {
  it('resolves a 3-contact segment and fans out 3 children, each with its own contactId + shared params', async () => {
    const { owner, orgId } = await ownerOrg();

    // 1) three real contacts + a segment that resolves to all of them (no filters).
    const contactIds: string[] = [];
    for (const name of ['Quiet A', 'Quiet B', 'Quiet C']) {
      const c = await owner.post('/v1/host/openwop-app/crm/contacts', { name, email: `${name.replace(/\s/g, '').toLowerCase()}@acme.test` });
      expect(c.status, JSON.stringify(c.body)).toBe(201);
      contactIds.push(c.body.contactId as string);
    }
    const seg = await owner.post('/v1/host/openwop-app/crm/segments', { name: 'All quiet', filters: [] });
    expect(seg.status, JSON.stringify(seg.body)).toBe(201);
    const segmentId = seg.body.segmentId as string;

    // 2) register the per-member child STUB (core.noop echoes its inputs → the
    //    per-contact contactId surfaces in the child's node output).
    const childWorkflowId = `wf.stub-reengage-${Date.now()}`;
    const stub: WorkflowDefinition = {
      workflowId: childWorkflowId,
      metadata: { name: 'Stub Re-engage' },
      variables: [],
      nodes: [{ nodeId: 'echo', typeId: 'core.noop', config: {} }],
      edges: [],
    } as unknown as WorkflowDefinition;
    registerWorkflow(stub);

    // 3) install the segment-winback chain bound to the stub child + shared params.
    const found = getChain('campaign-journeys.segment-winback');
    const expanded = expandChain(found!.chain, { params: { childWorkflowId, fromAddress: 'news@acme.test', orgId } });
    registerWorkflow(expanded);

    // 4) run it — segmentId rides the run inputs (the segment-members source node).
    const create = await owner.post('/v1/runs', { workflowId: expanded.workflowId, inputs: { segmentId } });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const snap = await pollRun(owner, create.body.runId as string);
    expect(snap.status, `parent should complete (stub children terminate immediately): ${JSON.stringify(snap)}`).toBe('completed');

    // 5) the parent dispatched exactly 3 children, all of the stub workflow.
    const events = await bundleEvents(owner, create.body.runId as string);
    const dispatched = events.filter((e) => e.type === 'node.dispatched');
    expect(dispatched, `expected 3 node.dispatched: ${JSON.stringify(dispatched.map((e) => e.payload))}`).toHaveLength(3);
    expect(dispatched.every((e) => e.payload?.childWorkflowId === childWorkflowId)).toBe(true);

    // 6) each child ran with its OWN contactId (RFC 0126 per-item input) — read the
    //    stub's echoed output off each child's bundle. Proves distinct per-member inputs.
    const childContactIds = new Set<string>();
    for (const d of dispatched) {
      const childRunId = d.payload!.childRunId as string;
      const childEvents = await bundleEvents(owner, childRunId);
      const echo = childEvents.find((e) => e.type === 'node.completed' && e.nodeId?.endsWith('echo'));
      expect(echo, `child ${childRunId} should have a completed echo node`).toBeTruthy();
      const out = echo!.payload!.outputs as Record<string, unknown>;
      expect(out.fromAddress, 'shared param forwarded to child').toBe('news@acme.test');
      expect(out.orgId).toBe(orgId);
      childContactIds.add(out.contactId as string);
    }
    expect(childContactIds).toEqual(new Set(contactIds)); // one child per member, distinct contactIds
  });
});
