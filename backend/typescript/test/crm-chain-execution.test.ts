/**
 * CRMGAP-12 — execute `crm-ops.route-new-lead` END TO END: the REAL expanded
 * definition (loader → `expandChain`), the REAL node implementations
 * (`packs/feature.crm.nodes/index.mjs`), the REAL `ctx.features.crm` surface,
 * and the REAL executor (`executeRun`, via the production host-event-binding
 * dispatch path — `POST /crm/contacts` → `crmMutated` → `emitHostEvent` →
 * the bound workflow starts through `startWorkflowRun`). Mirrors the
 * `cms.localize-and-submit` execution-test precedent (`cms-chain-execution.
 * test.ts`) but drives the REAL scheduler/executor rather than a harness
 * mini-scheduler, so this also pins the trigger-node output-threading
 * contract end to end: `core.trigger.event`'s `outputs.payload` (the
 * `{entityType, entityId}` ids-only shape `host.crm.contact.created` carries,
 * CRMGAP-16-stripped) must reach `feature.crm.nodes.update-contact-owner` as
 * `entityId` — a single-edge, single-key `{input: payload}` port map that the
 * executor's `runOneNode` unwraps back to the raw value (`executor.ts`'s
 * "Back-compat" unwrap, NOT limited to source nodes) before the node's own
 * `contactId ?? entityId` fallback reads it.
 *
 * Registers the chain's expansion as a real workflow (`registerWorkflow` —
 * the same registry `POST /v1/host/openwop-app/workflows` writes to) so the
 * production dispatch path can resolve + execute it exactly as it would for
 * an operator-bound chain.
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
import { createHostEventBinding } from '../src/host/hostEventDispatcher.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

let BASE: string;
let server: http.Server;
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
  const crm = getToggleDefault('crm');
  if (crm) await saveConfig({ ...crm, status: 'on' }, 'test');
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T = any> { status: number; body: T }
interface Client {
  get: (p: string) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
}
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
  const tenantId = `org:crmchain-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `crmchain-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}
const c = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}${suffix}`;

describe('crm-ops.route-new-lead — end-to-end execution (CRMGAP-12)', () => {
  it('a host.crm.contact.created event, dispatched through the REAL executor, assigns the owner and creates the follow-up task', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();

    const found = getChain('crm-ops.route-new-lead');
    expect(found, 'crm-ops.route-new-lead chain must be loaded at boot').toBeTruthy();
    const ownerId = 'user:sales-owner-1';
    const taskTitle = 'Follow up with the new chain-test lead';
    const expanded = expandChain(found!.chain, { params: { ownerId, orgId, taskTitle } });
    registerWorkflow(expanded);

    const binding = await createHostEventBinding({
      tenantId,
      eventType: 'host.crm.contact.created',
      workflowId: expanded.workflowId,
      createdBy: 'test',
    });

    // The trigger: a real contact create through the real route (same
    // `crmMutated` → `emitHostEvent` path production uses).
    const contact = await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Chain Lead', email: 'chainlead@newco.test' });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);
    const contactId = contact.body.contactId as string;

    // Poll for the triggered run to reach a terminal state.
    let run: RunRecord | undefined;
    for (let i = 0; i < 80 && (!run || run.status === 'pending' || run.status === 'running'); i++) {
      const runs = await storage.listRuns({ tenantId, limit: 50 });
      run = runs.find((r) => (r.metadata as { hostEvent?: { bindingId?: string } } | undefined)?.hostEvent?.bindingId === binding.bindingId);
      if (!run || run.status === 'pending' || run.status === 'running') await new Promise((res) => setTimeout(res, 25));
    }
    expect(run, 'expected the bound workflow to start a run').toBeTruthy();
    expect(run?.status, `run did not complete cleanly: ${JSON.stringify(run)}`).toBe('completed');

    // The chain's node-output threading actually delivered the contactId:
    // owner assigned…
    const updated = await owner.get(`/v1/host/openwop-app/crm/contacts/${contactId}`);
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.owner, 'update-contact-owner must have received the triggered contactId (entityId fallback)').toBe(ownerId);

    // …and the follow-up task landed in the target org.
    const tasks = await owner.get(c(orgId, '/tasks'));
    expect(tasks.status, JSON.stringify(tasks.body)).toBe(200);
    const followUp = tasks.body.tasks.find((t: { title: string }) => t.title === taskTitle);
    expect(followUp, `expected a follow-up task titled "${taskTitle}"`).toBeTruthy();
  });
});
