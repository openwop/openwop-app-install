/**
 * ADR 0878 D8 — `service-desk.sla-escalation`, through the REAL loader and the
 * REAL executor. Honest-failure mode, the commerce-chain precedent: no BYOK key
 * here, so the run reads the real ticket and then fails at the AI node with
 * `byok_required` — proving the trigger→ticket wiring and that nothing reaches
 * `notify` without a summary. The addressed notification itself is pinned at the
 * surface (`notifyTicketTeam`), which the node only forwards to.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getChain, expandChain } from '../src/host/workflowChainPackLoader.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { createTicket } from '../src/features/service-desk/tickets.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'service-desk']) await saveConfig({ ...getToggleDefault(id)!, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }; // wire JSON
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}

interface BundleEvent { type?: string; nodeId?: string; payload?: Record<string, unknown> }
async function runToEnd(owner: ReturnType<typeof client>, workflowId: string, inputs: Record<string, unknown>): Promise<{ status: string; error?: { code: string }; events: BundleEvent[] }> {
  const create = await owner.post('/runs', { workflowId, inputs });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  const runId = create.body.runId as string;
  let snap: { status: string; error?: { code: string } } = { status: 'pending' };
  for (let i = 0; i < 80; i++) {
    snap = (await owner.get(`/runs/${runId}`)).body as typeof snap;
    if (snap.status === 'completed' || snap.status === 'failed' || snap.status === 'cancelled') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const events = ((await owner.get(`/runs/${runId}/debug-bundle`)).body.events as BundleEvent[]) ?? [];
  return { ...snap, events };
}

describe('ADR 0878 D8 — service-desk.sla-escalation', () => {
  it('loads, and its expansion routes the trigger payload and the summary to the right ports', () => {
    const found = getChain('service-desk.sla-escalation');
    expect(found, 'the chain must be loaded at boot').toBeTruthy();
    const a = expandChain(found!.chain, { params: {} });
    const b = expandChain(found!.chain, { params: {} });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // deterministic expansion
    const into = (suffix: string) => (a.edges ?? []).filter((e) => e.targetNodeId.endsWith(`_${suffix}`));
    expect(into('ticket').map((e) => e.targetInput)).toEqual(['event']);
    expect(into('notify').map((e) => e.targetInput).sort()).toEqual(['event', 'message']);
  });

  it('a manual run reads the REAL ticket, then fails honestly at the AI node — notify never runs', async () => {
    const owner = client();
    const tenantId = `org:sdchain-${Date.now()}`;
    expect((await owner.post('/host/openwop-app/test/login', { email: `sdchain-${Date.now()}@acme.test`, tenantId })).status).toBe(201);
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Support' })).body.orgId as string;
    const { ticket } = await createTicket({ tenantId, orgId, subject: 'Printer on fire', channel: 'manual', externalKey: 'chain-1', createdBy: 'system',
      firstMessage: { messageId: 'in-1', body: 'it is still on fire', author: 'contact:c1' } });
    const wf = expandChain(getChain('service-desk.sla-escalation')!.chain, { params: { ticketId: ticket.ticketId } });
    registerWorkflow(wf);
    const run = await runToEnd(owner, wf.workflowId, { ticketId: ticket.ticketId });
    expect(run.status).toBe('failed');
    expect(run.error?.code).toBe('openwop-app.byok_required');
    const read = run.events.find((e) => e.type === 'node.completed' && e.nodeId?.endsWith('_ticket'));
    expect((read?.payload?.outputs as { ticket?: { ticketId?: string; requester?: unknown } })?.ticket?.ticketId).toBe(ticket.ticketId);
    expect((read?.payload?.outputs as { ticket?: Record<string, unknown> }).ticket).not.toHaveProperty('requester');
    expect(run.events.some((e) => e.type === 'node.completed' && e.nodeId?.endsWith('_notify'))).toBe(false);
  });

  it('a ticket the run cannot read fails TYPED at the read — the AI is never asked to summarize nothing', async () => {
    const owner = client();
    const tenantId = `org:sdchain2-${Date.now()}`;
    expect((await owner.post('/host/openwop-app/test/login', { email: `sdchain2-${Date.now()}@acme.test`, tenantId })).status).toBe(201);
    const wf = expandChain(getChain('service-desk.sla-escalation')!.chain, { params: { ticketId: 'tkt-does-not-exist' } });
    registerWorkflow(wf);
    const run = await runToEnd(owner, wf.workflowId, { ticketId: 'tkt-does-not-exist' });
    expect(run.status).toBe('failed');
    const failed = run.events.find((e) => e.type === 'node.failed');
    expect(failed?.nodeId?.endsWith('_ticket'), JSON.stringify(failed)).toBe(true);
    expect(run.events.some((e) => e.nodeId?.endsWith('_summarize') && e.type === 'node.started')).toBe(false);
  });
});
