/**
 * exec-ops workflow-chain pack — REAL execution (ADR 0149, RFC 0013).
 *
 * Structural coverage already exists (`workflow-chain-exec-ops.test.ts`:
 * expand + KNOWN_TYPEIDS, owned by another session — not touched here). This
 * adds REAL-executor coverage for all three chains: the real expanded
 * definition, the real `feature.crm`/`feature.analytics` node implementations
 * and `ctx.features` surfaces reading REAL seeded data, and the real
 * `core.openwop.connectors.*` capability-resolution surface (which degrades
 * gracefully — `connected:false` — when no Connection is configured, exactly
 * as `capability-dispatch-*.test.ts` documents for `erp-action`/
 * `calendar-list-events`).
 *
 * MODE CHOSEN (per chain): every exec-ops chain's `core.ai.chatCompletion`
 * node config omits `provider`/`model` (they're workflow-chain-pack
 * TEMPLATES — an operator wires a live provider when installing/activating
 * the chain, exactly why `cms-chain-execution.test.ts` drives its AI node
 * through a hand-rolled mini-scheduler with `ctx.callAI` faked rather than
 * the real executor). There is no established real-EXECUTOR fake-callAI seam
 * (the mock provider's `programMock` queue is conformance-only plumbing, and
 * chain configs never set `provider:'mock'`), so per the task brief this test
 * asserts the HONEST FAILURE contract instead of forcing completion: every
 * chain runs every upstream read node for REAL (proving the real CRM/
 * analytics/connector wiring), then fails cleanly at its first AI node with
 * `error.code === 'provider_not_supported'` — the canonical, reproducible
 * "this node genuinely cannot run without a configured provider" contract,
 * pinned here so a future regression (e.g. a default leaking through, or the
 * error code silently changing) is caught.
 *
 * BUGS FOUND + FIXED AT THE ROOT (`examples/workflow-chain-packs/exec-ops/
 * pack.json`):
 *
 * 1. Multi-fan-in port collision (the SAME defect class as `csm-ops.health-
 *    from-crm`, see `workflow-chain-csm-ops-execution.test.ts`): `brief`
 *    (3 inbound edges), `dossier` (2), and `draft` (3) all named neither
 *    `sourceOutput` nor `targetInput` on their fan-in edges, so the
 *    scheduler's `buildNodeInputs` (executor/scheduler.ts) clobbered every
 *    edge but the LAST into the shared default port key `'input'`, and the
 *    executor's single-key "Back-compat" unwrap then flattened it to just
 *    that one upstream node's raw output — silently dropping the other 1-2
 *    data sources from the prompt payload every real run would have built.
 *    Fixed with explicit dot-notation target ports (`brief.pipeline`/
 *    `brief.metrics`/`brief.tasks`, `dossier.calendar`/`dossier.company`,
 *    `draft.kpis`/`draft.pipeline`/`draft.finance`) so each source lands on
 *    its own key.
 *
 * 2. Missing `orgId` parameter: `daily-briefing` and `board-update` read
 *    `feature.crm.nodes.list-deals`/`list-tasks` with an EMPTY node `config`
 *    and no `orgId` in the chain's declared `parameters` at all — and
 *    `meeting-prep`'s `feature.crm.nodes.get-company` node had the same gap
 *    (`config` set `companyId` but never `orgId`). All three nodes' org-
 *    scoping is an EXACT match against `Deal.orgId`/`Task.orgId`/
 *    `Company.orgId` (`features/crm/entities/*.ts`) — with no way to supply
 *    an org, the pipeline/tasks reads were unconditionally empty and the
 *    company read unconditionally `null`, on every real run, for every
 *    tenant, forever; none of "Daily Executive Briefing," "Board / Investor
 *    Update," or "Meeting Prep" could ever actually see real CRM data
 *    despite reading everywhere else in the chain successfully. Fixed by
 *    declaring `orgId` as a required parameter on all three chains and
 *    wiring `config: {"orgId": "{{params.orgId}}"}` into the affected nodes
 *    (matching the `crm-ops`/`csm-ops` convention). This test's assertions
 *    on `pipeline`/`tasks` node outputs would have failed (`deals: []`) pre-
 *    fix.
 *
 * 3. §WF-ANL-2 (WORKFLOWS-ASSESSMENT 2026-08-18) — THE ANALYTICS ASSERTION
 *    IN THIS FILE WAS VACUOUS, and that is how bug (2)'s analytics twin
 *    shipped. `expect(completedOutputs(events,'metrics').summary)
 *    .toBeTruthy()` passes on `{}` — an EMPTY summary object is truthy — so
 *    it could never discriminate `summarize(tenantId, orgId)` from
 *    `summarize(tenantId, '')`. Its CRM siblings three lines away assert
 *    `.length).toBe(1)`. Both analytics assertions now seed a REAL event for
 *    the org and assert its content. Root cause fixed in
 *    `packs/feature.analytics.nodes/index.mjs` (the node read
 *    `ctx.inputs.orgId` only, while RFC 0013 Path A freezes
 *    `{{params.orgId}}` into `config`) plus the two chains that bound nothing.
 *
 *    WHAT THOSE TWO ASSERTIONS DO **NOT** DISCRIMINATE, stated rather than
 *    left to be assumed: the three runs below create `/v1/runs` WITH
 *    `inputs: params`, and the scheduler seeds a root node's inputs from the
 *    run's — so `orgId` also arrives via `ctx.inputs` and a node reading ONLY
 *    `ctx.inputs` still passes them. MEASURED by sabotage. They discriminate a
 *    node/surface that returns an empty or null summary, and nothing about the
 *    config lane. The `WF-ANL-1` describe block below holds that variable
 *    properly by running with `inputs: {}` — the Path A / scheduled-trigger
 *    shape — and IS red against the pre-fix node.
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
import { recordEvent } from '../src/features/analytics/analyticsService.js';

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
  const analytics = getToggleDefault('analytics');
  if (analytics) await saveConfig({ ...analytics, status: 'on' }, 'test');
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
  const tenantId = `org:execops-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `execops-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}
const c = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}${suffix}`;

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

describe('exec-ops.daily-briefing — real reads, honest missing-credential failure', () => {
  it('reads real pipeline + tasks (org-scoped) and real analytics, then fails cleanly at the AI node (no BYOK credential)', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const deal = await owner.post(c(orgId, '/deals'), { title: 'Open pipeline deal' });
    expect(deal.status, JSON.stringify(deal.body)).toBe(201);
    const task = await owner.post(c(orgId, '/tasks'), { title: 'Chase renewal' });
    expect(task.status, JSON.stringify(task.body)).toBe(201);
    // WF-ANL-2 — a REAL analytics row for THIS org, so the node's org scope is
    // observable in its output instead of being asserted away as truthy.
    await recordEvent({ tenantId, orgId, raw: { type: 'pageview', path: '/pricing' } });

    const found = getChain('exec-ops.daily-briefing');
    expect(found, 'exec-ops.daily-briefing chain must be loaded at boot').toBeTruthy();
    const params = { orgId, focusAreas: 'pipeline risk' };
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
    // BUG-2 fix proof: the pipeline/tasks reads are org-scoped and see the
    // REAL seeded deal/task, not an empty list.
    expect((completedOutputs(events, 'pipeline').deals as unknown[]).length).toBe(1);
    expect((completedOutputs(events, 'tasks').tasks as unknown[]).length).toBe(1);
    // WF-ANL-2 — CONTENT, not truthiness: `{}` is truthy, so the old
    // `.toBeTruthy()` passed over `summarize(tenantId, '')`. Asserted the way
    // the CRM siblings above are.
    const metrics = completedOutputs(events, 'metrics').summary as { total: number; byType: Record<string, number>; topPaths: { path: string }[] };
    expect(metrics.total).toBe(1);
    expect(metrics.byType.pageview).toBe(1);
    expect(metrics.topPaths.map((p) => p.path)).toEqual(['/pricing']);
    // The AI node is where it fails — never silently skipped or reached
    // 'deliver'.
    const failedEvent = events.find((e) => e.type === 'node.failed');
    expect(failedEvent?.nodeId?.endsWith('_brief')).toBe(true);
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId?.endsWith('_deliver'))).toBe(false);
  });
});

describe('WF-ANL-1 — RFC 0013 Path A: the org must reach the analytics node through CONFIG', () => {
  it('the frozen chain config carries the org when the run supplies NO inputs at all', async () => {
    // WHY THIS IS A SEPARATE TEST, and why the assertions above could not be it.
    // The other runs in this file create `/v1/runs` WITH `inputs: params`, and
    // the scheduler seeds a root node's inputs from the run's — so `orgId`
    // arrives via `ctx.inputs` and a node reading ONLY `ctx.inputs` still works.
    // RFC 0013 **Path A** — the `…/workflows/from-chain` default, and what a
    // SCHEDULED trigger fires — freezes `{{params.orgId}}` into the node's
    // `config` at expansion and starts the run with nothing. That is the lane
    // where `ctx.inputs.orgId` is undefined, `summarize(tenantId, '')` matches
    // no rows, and the node returns an EMPTY summary as `status:'success'` for
    // an LLM to write a digest over. Run with `inputs: {}` to hold exactly that
    // variable; the CRM sibling beside it has always merged config and is the
    // control.
    const { owner, orgId, tenantId } = await ownerOrg();
    const deal = await owner.post(c(orgId, '/deals'), { title: 'Path A deal' });
    expect(deal.status, JSON.stringify(deal.body)).toBe(201);
    await owner.post(c(orgId, '/tasks'), { title: 'Path A task' });
    await recordEvent({ tenantId, orgId, raw: { type: 'pageview', path: '/path-a' } });

    const found = getChain('exec-ops.daily-briefing');
    expect(found).toBeTruthy();
    const expanded = expandChain(found!.chain, { params: { orgId, focusAreas: 'pipeline risk' } });
    registerWorkflow(expanded);
    const create = await owner.post('/v1/runs', { workflowId: expanded.workflowId, inputs: {} });
    expect(create.status, JSON.stringify(create.body)).toBe(201);

    const runId = create.body.runId as string;
    await pollRun(owner, runId);
    const events = await bundleEvents(owner, runId);
    // CONTROL: the CRM node reads the same frozen config and sees the deal.
    expect((completedOutputs(events, 'pipeline').deals as unknown[]).length).toBe(1);
    // SUBJECT: FAILS against a node that reads `ctx.inputs.orgId` only —
    // `total` is 0 and `topPaths` is empty, reported as success.
    const metrics = completedOutputs(events, 'metrics').summary as { total: number; topPaths: { path: string }[] };
    expect(metrics.total, 'the analytics node must read orgId from ctx.config too').toBe(1);
    expect(metrics.topPaths.map((p) => p.path)).toEqual(['/path-a']);
  });

  it('board-update\'s KPI node binds the org too (it bound NOTHING — a separate defect from the node merge)', async () => {
    // Two independent halves, so each needs its own assertion: the node merge
    // (above) and the CHAIN BINDING. `exec-ops.board-update`'s `kpis` node
    // shipped `config: {}` while its CRM sibling three lines away bound
    // `{{params.orgId}}` correctly — so even a fixed node had nothing to read.
    const { owner, orgId, tenantId } = await ownerOrg();
    await recordEvent({ tenantId, orgId, raw: { type: 'conversion', name: 'board-signup' } });

    const found = getChain('exec-ops.board-update');
    expect(found).toBeTruthy();
    const expanded = expandChain(found!.chain, { params: { period: '2026-06', audience: 'the board', orgId } });
    registerWorkflow(expanded);
    const create = await owner.post('/v1/runs', { workflowId: expanded.workflowId, inputs: {} });
    expect(create.status, JSON.stringify(create.body)).toBe(201);

    const runId = create.body.runId as string;
    await pollRun(owner, runId);
    const events = await bundleEvents(owner, runId);
    const kpis = completedOutputs(events, 'kpis').summary as { total: number; byType: Record<string, number> };
    expect(kpis.total, 'exec-ops.board-update must bind config.orgId on its KPI node').toBe(1);
    expect(kpis.byType.conversion).toBe(1);
  });
});

describe('exec-ops.meeting-prep — real reads, honest missing-credential failure', () => {
  it('reads the real attendee company + degrades the calendar read gracefully (no Connection configured), then fails cleanly at the AI node', async () => {
    const { owner, orgId } = await ownerOrg();
    const company = await owner.post(c(orgId, '/companies'), { name: 'Northwind' });
    expect(company.status, JSON.stringify(company.body)).toBe(201);
    const companyId = company.body.companyId as string;

    const found = getChain('exec-ops.meeting-prep');
    expect(found, 'exec-ops.meeting-prep chain must be loaded at boot').toBeTruthy();
    const params = { orgId, attendeeCompanyId: companyId, meetingContext: 'renewal check-in', timeMin: '' };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);

    const create = await owner.post('/v1/runs', { workflowId: expanded.workflowId, inputs: params });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;

    const snap = await pollRun(owner, runId);
    expect(snap.status).toBe('failed');
    expect(snap.error?.code).toBe('byok_required');

    const events = await bundleEvents(owner, runId);
    expect(completedOutputs(events, 'company').company).toMatchObject({ companyId, name: 'Northwind' });
    // No calendar Connection is configured in this test tenant — the
    // capability-resolution surface degrades to a graceful "not wired"
    // success (capability-dispatch-calendar.test.ts's documented contract),
    // never a throw.
    expect(completedOutputs(events, 'calendar')).toMatchObject({ connected: false, events: [] });

    const failedEvent = events.find((e) => e.type === 'node.failed');
    expect(failedEvent?.nodeId?.endsWith('_dossier')).toBe(true);
  });
});

describe('exec-ops.board-update — real reads, honest missing-credential failure', () => {
  it('reads real pipeline (org-scoped) + real KPIs + degrades the ERP connector gracefully, then fails cleanly at the AI node — never reaching the exec-review gate', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const deal = await owner.post(c(orgId, '/deals'), { title: 'Q2 enterprise deal' });
    expect(deal.status, JSON.stringify(deal.body)).toBe(201);
    await recordEvent({ tenantId, orgId, raw: { type: 'conversion', name: 'signup' } });

    const found = getChain('exec-ops.board-update');
    expect(found, 'exec-ops.board-update chain must be loaded at boot').toBeTruthy();
    const params = { period: '2026-06', audience: 'the board', orgId };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);

    const create = await owner.post('/v1/runs', { workflowId: expanded.workflowId, inputs: params });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;

    const snap = await pollRun(owner, runId);
    expect(snap.status).toBe('failed');
    expect(snap.error?.code).toBe('byok_required');

    const events = await bundleEvents(owner, runId);
    // BUG-2 fix proof again, for board-update's own `pipeline` node.
    expect((completedOutputs(events, 'pipeline').deals as unknown[]).length).toBe(1);
    // WF-ANL-2 — same vacuity, same fix, on board-update's own analytics node.
    const kpis = completedOutputs(events, 'kpis').summary as { total: number; byType: Record<string, number> };
    expect(kpis.total).toBe(1);
    expect(kpis.byType.conversion).toBe(1);
    // No ERP Connection configured — erp-action recommends nothing, applies
    // nothing (ADR 0186 slice 5's documented graceful-degrade contract).
    expect(completedOutputs(events, 'finance')).toMatchObject({ connected: false, applied: false });

    const failedEvent = events.find((e) => e.type === 'node.failed');
    expect(failedEvent?.nodeId?.endsWith('_draft')).toBe(true);
    // Never reached the exec-review approval gate.
    expect(events.some((e) => e.nodeId?.endsWith('_review'))).toBe(false);
  });
});
