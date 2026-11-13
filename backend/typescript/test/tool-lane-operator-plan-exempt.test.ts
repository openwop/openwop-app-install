/**
 * The chat tool lane honours the listed operator's person-level plan exemption
 * (ADR 0419 correction 2026-10-02, ADR 0819 §1) — and reports a plan refusal as
 * a plan refusal.
 *
 * Observed live on app.openwop.dev (build a1d1dccb7, 2026-11-11 19:10Z): the
 * listed superadmin made a fresh workspace on the `free` plan. The Campaign
 * Brief HTTP routes answered 200 (`toggleSubjectOf(req)` sets `planExempt`), but
 * in chat the Strategist's `campaign-brief.get-brief` / `.validate` /
 * `.generate-kernel` and the Campaign Strategist's `campaign-orchestration.run`
 * all returned `feature_disabled`: each tool resolved `{ tenantId, userId }`
 * with no exemption, so `resolveOne` applied the workspace's plan. The model was
 * then told "not enabled for this workspace" and asked the user to flip a toggle.
 *
 * Seam: `createScopedAgentToolProvider`, the ONE composer the chat loop and the
 * realtime voice bridge build tool scopes through, with the scope fields the
 * chat loop reads off `run.metadata` (`actingUserId`, `personalTenant`,
 * `planExempt`). The stamp itself is pinned at `POST /v1/runs` below.
 *
 * Controls: a customer in the same free workspace is still refused, now as
 * `not_entitled`; a stamped flag whose person is no longer listed is refused
 * (re-checked at use time); an entitled workspace passes; toggle-off is still
 * `feature_disabled` for the operator too.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createScopedAgentToolProvider, type AgentToolCallScope } from '../src/host/agentToolProvider.js';
import { __seedBundleGrant } from '../src/features/billing/billingService.js';
import { CAMPAIGN_BRIEF_GET_TOOL_ID, CAMPAIGN_BRIEF_VALIDATE_TOOL_ID } from '../src/features/campaign-brief/agentTools.js';
import { CAMPAIGN_ORCH_RUN_TOOL_ID } from '../src/features/campaign-orchestration/agentTools.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { fromWireRunId } from '../src/host/v2Ids.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { KERNEL_WORKFLOW_ID } from '../src/features/campaign-brief/intelWorkflows.js';
import { startWorkflowRun } from '../src/host/runStarter.js';
import { getEventLog } from '../src/executor/eventLog.js';
import { toWireRunId } from '../src/host/v2Ids.js';

const OPERATOR_PERSONAL = 'user:operator-0001';
const CUSTOMER_PERSONAL = 'user:customer-0001';
const FREE_WS = 'ws:free-workspace-0001';
const PAID_WS = 'ws:paid-workspace-0001';

let server: http.Server;
let BASE = '';
let storage: Storage;
let hostSuite: HostAdapterSuite;
let operatorBriefId = '';
const saved: Record<string, string | undefined> = {};
const ENV = {
  OPENWOP_STORAGE_DSN: 'memory://',
  OPENWOP_SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
  OPENWOP_TEST_AUTH_ENABLED: 'true',
  OPENWOP_SUPERADMIN_TENANTS: OPERATOR_PERSONAL,
  OPENWOP_BILLING_BUNDLE_PRICES: JSON.stringify({ price_mktg: 'marketing' }),
  OPENWOP_BILLING_PLAN_FEATURES: JSON.stringify({ free: ['billing'], pro: ['billing'] }),
};

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  hostSuite = app.locals.hostSuite as HostAdapterSuite;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['campaign-brief', 'campaign-orchestration', 'campaign-channels', 'billing']) {
    const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  // A REAL brief the operator may write, so a tool call gets past not_found to
  // the gates behind it (the orchestration child gate, the run start).
  const opOrg = await createOrg({ tenantId: FREE_WS, createdBy: 'operator-0001', name: 'Op Co', ownerSubject: 'operator-0001' });
  operatorBriefId = (await createBrief(FREE_WS, opOrg.orgId, 'operator-0001', { name: 'Operator Launch', productName: 'Acme' })).id;
  await __seedBundleGrant(PAID_WS, 'marketing', { status: 'active', stripeSubscriptionId: 'sub_mktg', stripeStatus: 'active', updatedAt: new Date().toISOString() });
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((res) => server.close(() => res()));
});

function call(scope: Omit<AgentToolCallScope, 'runId'>, name: string, input: Record<string, unknown>) {
  return createScopedAgentToolProvider({ runId: 'run-test', ...scope }).executeTool({ name, input });
}
const operator = (tenantId: string) => ({ tenantId, actingUserId: 'operator-0001', personalTenant: OPERATOR_PERSONAL, planExempt: true });
const customer = (tenantId: string) => ({ tenantId, actingUserId: 'customer-0001', personalTenant: CUSTOMER_PERSONAL });
const errorOf = (r: { content: string }) => (JSON.parse(r.content) as { error?: string }).error;

/** Past the feature gate: the missing brief answers as missing, not as a gate. */
function expectPastGate(getBrief: { content: string; isError?: boolean }, run: { content: string; isError?: boolean }) {
  expect(getBrief.isError, getBrief.content).toBeFalsy();
  expect(JSON.parse(getBrief.content)).toMatchObject({ brief: null });
  expect(errorOf(run), run.content).toBe('not_found');
}

describe('chat tool lane — the listed operator is not paywalled in any workspace', () => {
  it('operator in a FREE workspace passes the campaign-brief and campaign-orchestration gates', async () => {
    const get = await call(operator(FREE_WS), CAMPAIGN_BRIEF_GET_TOOL_ID, { briefId: 'cb-missing' });
    const validate = await call(operator(FREE_WS), CAMPAIGN_BRIEF_VALIDATE_TOOL_ID, { briefId: 'cb-missing' });
    const run = await call(operator(FREE_WS), CAMPAIGN_ORCH_RUN_TOOL_ID, { briefId: 'cb-missing' });
    expectPastGate(get, run);
    expect(validate.isError, validate.content).toBeFalsy();
    expect(JSON.parse(validate.content)).toMatchObject({ valid: false, note: 'Brief not found, or you lack read access to it.' });
  });

  it('control: a customer in the SAME free workspace is refused, as a PLAN refusal', async () => {
    const get = await call(customer(FREE_WS), CAMPAIGN_BRIEF_GET_TOOL_ID, { briefId: 'cb-missing' });
    const run = await call(customer(FREE_WS), CAMPAIGN_ORCH_RUN_TOOL_ID, { briefId: 'cb-missing' });
    expect(errorOf(get), get.content).toBe('not_entitled');
    expect(errorOf(run), run.content).toBe('not_entitled');
  });

  it('control: a stamped flag grants nothing once the person is no longer listed', async () => {
    const stale = { ...customer(FREE_WS), planExempt: true };
    const get = await call(stale, CAMPAIGN_BRIEF_GET_TOOL_ID, { briefId: 'cb-missing' });
    expect(errorOf(get), get.content).toBe('not_entitled');
    const run = await call(stale, CAMPAIGN_ORCH_RUN_TOOL_ID, { briefId: 'cb-missing' });
    expect(errorOf(run), run.content).toBe('not_entitled');
  });

  it('operator + a REAL brief: campaign-orchestration.run passes the channel-child gate and the run-start gate', async () => {
    const run = await call(operator(FREE_WS), CAMPAIGN_ORCH_RUN_TOOL_ID, { briefId: operatorBriefId });
    expect(run.isError, run.content).toBeFalsy();
    const body = JSON.parse(run.content) as { runId?: string; briefId?: string };
    expect(body.briefId).toBe(operatorBriefId);
    expect(typeof body.runId).toBe('string');
    const started = await storage.getRun(body.runId!);
    expect(started?.metadata).toMatchObject({ planExempt: true, personalTenant: OPERATOR_PERSONAL });
  });

  it('control: an entitled workspace passes for a customer', async () => {
    const get = await call(customer(PAID_WS), CAMPAIGN_BRIEF_GET_TOOL_ID, { briefId: 'cb-missing' });
    const run = await call(customer(PAID_WS), CAMPAIGN_ORCH_RUN_TOOL_ID, { briefId: 'cb-missing' });
    expectPastGate(get, run);
  });

  it('control: toggle OFF is still feature_disabled, operator included', async () => {
    const d = getToggleDefault('campaign-brief')!;
    await saveConfig({ ...d, status: 'off' }, 'test');
    try {
      const get = await call(operator(FREE_WS), CAMPAIGN_BRIEF_GET_TOOL_ID, { briefId: 'cb-missing' });
      expect(errorOf(get), get.content).toBe('feature_disabled');
    } finally {
      await saveConfig({ ...d, status: 'on' }, 'test');
    }
  });
});

describe('in-run ctx.features — the run keeps the exemption it was launched under', () => {
  const brief = (scope: Parameters<typeof buildFeatureSurfaces>[0]) => buildFeatureSurfaces(scope)['campaign-brief']!;

  it('an operator-stamped run in a FREE workspace may use ctx.features.campaign-brief', async () => {
    const out = await brief({ ...operator(FREE_WS), runId: 'run-op' }).listBriefs!({}) as { briefs: Array<{ id: string }> };
    expect(out.briefs.map((b) => b.id)).toContain(operatorBriefId);
  });

  it('control: an unstamped run in the same workspace is refused, and so is a stamp whose person is not listed', async () => {
    await expect(brief({ ...customer(FREE_WS), runId: 'run-cu' }).listBriefs!({})).rejects.toMatchObject({ code: 'host_capability_disabled' });
    await expect(brief({ ...customer(FREE_WS), planExempt: true, runId: 'run-st' }).listBriefs!({})).rejects.toMatchObject({ code: 'host_capability_disabled' });
  });

  it('control: a stamp with no listed person behind it (no personal tenant, unlisted tenant) grants nothing', async () => {
    await expect(brief({ tenantId: FREE_WS, actingUserId: 'operator-0001', planExempt: true, runId: 'run-np' }).listBriefs!({})).rejects.toMatchObject({ code: 'host_capability_disabled' });
  });
});

describe('the stamp is decided at the creating request (POST /runs)', () => {
  async function login(tenantId: string): Promise<string> {
    const res = await fetch(`${BASE}/host/openwop-app/test/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `${tenantId.replace(/\W/g, '')}@acme.test`, tenantId }) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) return m[1]!; }
    throw new Error(`login for ${tenantId} set no session cookie (${res.status})`);
  }
  async function postRun(tenantId: string, metadata: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const cookie = await login(tenantId);
    const res = await fetch(`${BASE}/runs`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ workflowId: 'openwop-app.uppercase', inputs: {}, metadata }) });
    const body = await res.json() as { runId: string };
    expect(res.status, JSON.stringify(body)).toBe(201);
    const local = fromWireRunId(body.runId, tenantId);
    if (!local.ok) throw new Error(`run id ${body.runId} is not ${tenantId}'s`);
    return ((await storage.getRun(local.runId))!.metadata ?? {}) as Record<string, unknown>;
  }

  it('the listed operator\'s run is stamped', async () => {
    expect((await postRun(OPERATOR_PERSONAL)).planExempt).toBe(true);
  });

  it('control: a customer\'s run is not, and a client-supplied stamp is stripped', async () => {
    const meta = await postRun(CUSTOMER_PERSONAL, { planExempt: true });
    expect(meta.planExempt).toBeUndefined();
  });
});

// Scope: agentTools.ts only. surface.ts cross-feature reads are EXCLUDED on
// purpose and listed in ADR 1108 §5 (two live-path ones were moved to
// `tenantToggleSubject`); widen this when that list is worked down.
describe('ratchet — chat tools resolve feature access through the kit', () => {
  it('no agentTools.ts calls resolveOne directly (the subject that drops the exemption)', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join, relative } = await import('node:path');
    const SRC = join(__dirname, '..', 'src');
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p); else if (e.name === 'agentTools.ts') files.push(p);
      }
    };
    walk(SRC);
    expect(files.length).toBeGreaterThan(15); // the walk found the population, not an empty dir
    const offenders = files.filter((f) => /\bresolveOne\(/.test(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});

describe('run.metadata → executor bundle → ctx.features (a real run, not a hand-built scope)', () => {
  async function settle(runId: string): Promise<string> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const r = await storage.getRun(runId);
      if (r && !['pending', 'running'].includes(r.status)) return r.status;
      if (Date.now() > deadline) return r?.status ?? 'missing';
      await new Promise((res) => setTimeout(res, 50));
    }
  }

  it('the operator\'s Messaging-kernel run in a FREE workspace is not refused ctx.features.campaign-brief', async () => {
    const runId = await startWorkflowRun({ storage, hostSuite }, {
      tenantId: FREE_WS, workflowId: KERNEL_WORKFLOW_ID, inputs: { briefId: operatorBriefId },
      metadata: { actingUserId: 'operator-0001' }, personalTenant: OPERATOR_PERSONAL, planExempt: true,
    });
    expect(runId).toBeTruthy();
    await settle(runId!);
    const events = await getEventLog().list(runId!, { fromSeq: -1, limit: 1000 });
    // Not vacuous: the run reached its nodes (the live failure was at node 1, in 453 ms).
    expect(events.some((e) => e.type.startsWith('node.')), JSON.stringify(events.map((e) => e.type))).toBe(true);
    expect(JSON.stringify(events)).not.toContain('host_capability_disabled');
  });

  it('control: the same start for a customer is refused at the run-start gate (plan)', async () => {
    await expect(startWorkflowRun({ storage, hostSuite }, {
      tenantId: FREE_WS, workflowId: KERNEL_WORKFLOW_ID, inputs: { briefId: operatorBriefId },
      metadata: { actingUserId: 'customer-0001' }, personalTenant: CUSTOMER_PERSONAL, planExempt: true,
    })).rejects.toMatchObject({ name: 'WorkflowFeatureRefusedError' });
  });
});

describe('person-level stamp and the fork rule over HTTP', () => {
  const WS = 'ws:shared-person-level-0001';
  function client() {
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const h = res.headers as { getSetCookie?: () => string[] };
      for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };
    return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
  }
  const localOf = (wire: string, tenantId: string): string => { const r = fromWireRunId(wire, tenantId); if (!r.ok) throw new Error(wire); return r.runId; };

  it('an operator signed into a NON-listed shared workspace is stamped through their personal tenant; a customer forking that run is not', async () => {
    const op = client();
    // Learn the operator's real personal tenant, then list THAT (not the workspace).
    expect((await op.post('/host/openwop-app/test/login', { email: 'person-level-op@acme.test' })).status).toBe(201);
    const personal = (await op.get('/host/openwop-app/me/workspaces')).body.personal as string;
    expect(personal).toMatch(/^user:/);
    const before = process.env.OPENWOP_SUPERADMIN_TENANTS;
    process.env.OPENWOP_SUPERADMIN_TENANTS = `${OPERATOR_PERSONAL},${personal}`;
    try {
      expect((await op.post('/host/openwop-app/test/login', { email: 'person-level-op@acme.test', tenantId: WS, sharedWorkspace: true })).status).toBe(201);
      const me = (await op.get('/host/openwop-app/me/workspaces')).body;
      expect(me.personal).toBe(personal); // active = WS, personal = the listed one
      const made = await op.post('/runs', { workflowId: 'openwop-app.uppercase', inputs: {} });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const srcId = localOf(made.body.runId as string, WS);
      expect((await storage.getRun(srcId))!.metadata).toMatchObject({ planExempt: true });

      // Fork control: a customer in the same workspace forks the operator's run.
      const cu = client();
      expect((await cu.post('/host/openwop-app/test/login', { email: 'person-level-cu@acme.test', tenantId: WS })).status).toBe(201);
      // Fork from the source's own log, once it has finished writing it.
      for (let i = 0; i < 200 && ['pending', 'running'].includes((await storage.getRun(srcId))!.status); i++) await new Promise((r) => setTimeout(r, 25));
      const forked = await cu.post(`/runs/${encodeURIComponent(toWireRunId(srcId, WS))}:fork`, { fromSeq: 0, mode: 'replay' });
      expect(forked.status, JSON.stringify(forked.body)).toBe(201);
      const fork = await storage.getRun(localOf(forked.body.runId as string, WS));
      expect((fork!.metadata as Record<string, unknown>).planExempt).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.OPENWOP_SUPERADMIN_TENANTS; else process.env.OPENWOP_SUPERADMIN_TENANTS = before;
    }
  });
});
