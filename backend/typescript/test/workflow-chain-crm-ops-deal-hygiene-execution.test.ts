/**
 * crm-ops.deal-hygiene — REAL execution (RFC 0013, ADR 0208 §2).
 *
 * `crm-ops.route-new-lead` already has a real-executor test
 * (`crm-chain-execution.test.ts`, CRMGAP-12). This covers the pack's OTHER
 * chain: the approval-gated sweep. Same conventions (loader → `expandChain`,
 * `registerWorkflow`, the direct `POST /v1/runs` start path — this chain has
 * no `core.trigger.event` node, so it is on-demand/scheduled rather than
 * host-event-bound) but a DIFFERENT assertion shape: `deal-hygiene` is
 * designed to SUSPEND at `core.chat.approvalGate` and wait for a human to
 * pick which stale deals need a follow-up — it does not infer staleness
 * itself. The correct execution assertion is "the run suspends with a
 * pending interrupt at the review gate," not "the run completes."
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
  const crm = getToggleDefault('crm');
  if (crm) await saveConfig({ ...crm, status: 'on' }, 'test');
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
  const tenantId = `org:dealhygiene-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `dealhygiene-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}
const c = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}${suffix}`;

interface RunSnapshot { status: string }
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

describe('crm-ops.deal-hygiene — end-to-end execution (real executor, suspends at the human gate)', () => {
  it('reads open deals then SUSPENDS at core.chat.approvalGate — the reviewer picks staleness, the chain does not infer it', async () => {
    const { owner, orgId } = await ownerOrg();
    const deal = await owner.post(c(orgId, '/deals'), { title: 'Quiet since Q1' });
    expect(deal.status, JSON.stringify(deal.body)).toBe(201);

    const found = getChain('crm-ops.deal-hygiene');
    expect(found, 'crm-ops.deal-hygiene chain must be loaded at boot').toBeTruthy();
    const params = { orgId, staleDays: 21 };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);

    const create = await owner.post('/v1/runs', { workflowId: expanded.workflowId, inputs: params });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;

    const snap = await pollRun(owner, runId);
    expect(snap.status.startsWith('waiting'), `run should suspend at the review gate, was ${JSON.stringify(snap)}`).toBe(true);

    const ints = await owner.get(`/v1/host/openwop-app/runs/${runId}/interrupts`);
    expect(ints.status, JSON.stringify(ints.body)).toBe(200);
    const interrupts = ints.body.interrupts as Array<{ token: string; nodeId: string }>;
    const gate = interrupts.find((i) => i.nodeId.includes('review'));
    expect(gate, `expected a pending interrupt for the review gate: ${JSON.stringify(interrupts)}`).toBeTruthy();

    // The staleDays param rides the approval card as review context, not a
    // filtering condition — the card's title interpolates it (workflow
    // variable substitution, not a node input edge), so a leaked
    // `{{params.staleDays}}` literal would mean the chain's templating broke.
    const debug = await owner.get(`/v1/runs/${runId}/debug-bundle`);
    expect(debug.status, JSON.stringify(debug.body)).toBe(200);
    expect(JSON.stringify(debug.body)).not.toContain('{{params.staleDays}}');
    expect(JSON.stringify(debug.body)).not.toContain('{{inputs.staleDays}}');

    // No follow-up task exists yet — the suspend didn't silently fall through.
    const tasks = await owner.get(c(orgId, '/tasks'));
    expect(tasks.status, JSON.stringify(tasks.body)).toBe(200);
    expect((tasks.body.tasks as unknown[]).length).toBe(0);
  });
});
