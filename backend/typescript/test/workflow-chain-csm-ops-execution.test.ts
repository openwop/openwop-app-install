/**
 * csm-ops workflow-chain pack — REAL execution (ADR 0212, RFC 0013).
 *
 * Mirrors the `crm-ops.route-new-lead` precedent (`crm-chain-execution.
 * test.ts`): the REAL expanded definition (loader → `expandChain`), the REAL
 * node implementations (`packs/feature.csm.nodes` + `packs/feature.crm.nodes`),
 * the REAL `ctx.features.csm`/`ctx.features.crm` surfaces, and the REAL
 * executor (`executeRun`, dispatched off `POST /v1/runs` — csm-ops chains are
 * on-demand, not host-event-triggered, so this drives the direct run-start
 * path rather than the host-event-binding path CRMGAP-12 covered).
 *
 * BUG FOUND + FIXED AT THE ROOT (pack.json wiring): `csm-ops.health-from-crm`'s
 * `health-write` node has TWO inbound edges (`deals`, `tasks`) that named
 * neither a `sourceOutput` nor a `targetInput`. The scheduler's
 * `buildNodeInputs` (executor/scheduler.ts) writes each edge's value to the
 * SAME default port key `'input'` in edge-array order — so the second edge
 * (`tasks`) silently clobbered the first (`deals`) before the node ever saw
 * it. Worse, because the resulting `inputsByPort` then collapsed to exactly
 * one key (`'input'`), the executor's "Back-compat" single-key unwrap
 * (executor.ts) flattened it to the tasks node's raw `{tasks:[...]}` output —
 * so `feature.csm.nodes.health-set` read `ctx.inputs.tasks` (present) but
 * `ctx.inputs.deals` was silently `undefined`, and `computeHealthFromCrm`
 * defaulted the missing side to `[]`. The account's open-deal count (and the
 * `openDeals` weight) was DROPPED from every real run of this chain — the
 * documented ADR 0212 §3 formula never actually ran as specified. Fixed by
 * naming explicit dot-notation ports on both edges (`deals.deals` →
 * `health-write.deals`, `tasks.tasks` → `health-write.tasks`), which the
 * scheduler resolves to their own distinct output/input keys — the SAME
 * multi-fan-in disambiguation `crm-ops.route-new-lead`'s single-edge chains
 * never needed to exercise. See `examples/workflow-chain-packs/csm-ops/
 * pack.json`. This test would have failed (`healthFactors[0].value` = 0, not
 * 1) against the pre-fix wiring.
 *
 * SECOND BUG FOUND + FIXED AT THE ROOT (ADR 0582 §1, WF-CSM-1): the SAME pack's
 * `csm-ops.renewal-risk` had a human approval gate that did not gate the
 * effect. `core.chat.approvalGate` returns `status:'success'` on REJECT as well
 * as on approve (`packs/vendor.myndhyve.chat/index.mjs` — `approved` is just an
 * output field), so the unconditioned `review → follow-up` edge ran the CRM
 * write on BOTH decisions: a rejected renewal review still created the
 * follow-up task, on a chain declared `side-effectful` whose description
 * promised "On approval, creates one follow-up task". Fixed with the RFC 0134
 * wire-form condition `{type:'truthy',left:'approved'}` on that edge plus a
 * `falsy`-conditioned `core.fail` (`gate-reject`) so a rejection fails the run
 * typed — the same shape `features/kicktodo-creator/builtinWorkflows.ts:57-60`
 * documents. `gate-reject` is declared BEFORE `follow-up` in `dag.nodes` on
 * purpose: `expandChain` picks the LAST terminal node as `outputRole:'primary'`
 * (`workflowChainPackLoader.ts`), and the chain's declared output is `task`.
 * The reject/approve pair at the bottom of this file is the witness; before it,
 * the renewal-risk block stopped at the gate and NEITHER leg had ever run.
 *
 * THIRD (WF-CSM-2): both renewal-risk edges were bare, so `buildNodeInputs`
 * wrote the deals to the default `input` port and the executor's single-key
 * unwrap flattened it — `core.chat.approvalGate` reads `inputs.artifact`, so
 * the reviewer was asked to flag at-risk renewals over an EMPTY card. Fixed by
 * port-qualifying exactly as `health-from-crm` already does
 * (`open-deals.deals → review.artifact`); witnessed in `csm-packs.test.ts`
 * against the REAL expanded definition + the REAL `buildNodeInputs`.
 *
 * Sabotage-witnessed (w7 /grade-tests): the `health-write` fan-in edge made bare
 * again (run fails on a partial fan-in) · the `truthy approved` condition removed
 * from `review → follow-up` (REJECT creates the task) · `follow-up` wired off
 * `open-deals` ahead of the gate (REJECT finds a task).
 * NOT single-file-probeable: the gate's `action`/`decision` normalisation lives in
 * `packs/vendor.myndhyve.chat/index.mjs`, and editing that file without
 * regenerating `packs/.steward-manifest.json` makes the pack `untrusted` — every
 * renewal run then fails at the gate, which reds all legs for the wrong reason.
 * HONEST CEILING: `pollRun`/`resolveGate` poll run status every 25 ms — a run
 * settling in the background executor has no hook to await.
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
import { bareRunId } from './support/bareRunId.js';

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
  const csm = getToggleDefault('csm');
  if (csm) await saveConfig({ ...csm, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The host error envelope (`errorEnvelope.ts`). */
interface ErrorBody { error: string; message?: string; details?: Record<string, unknown> }
interface Res<T> { status: number; body: T }
/** Typed per call at the JSON boundary — the one place a wire body becomes a product type. */
type Call = <T = ErrorBody>(p: string, b?: unknown) => Promise<Res<T>>;
interface Client { get: Call; post: Call; patch: Call }
interface TasksBody { tasks: Array<{ taskId: string; title: string; status: string }> }
function client(): Client {
  let cookie = '';
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

/** Resolve the run's ONE open interrupt with `resumeValue`, then poll to a
 *  terminal state. The RFC 0093 capability-token path (`POST /v1/interrupts/
 *  :token`) is the same one the chat's approval card uses. */
async function resolveGate(owner: Client, runId: string, resumeValue: unknown): Promise<RunSnapshot> {
  const ints = await owner.get<{ interrupts: Array<{ token: string; nodeId: string }> }>(`/host/openwop-app/runs/${bareRunId(runId)}/interrupts`);
  expect(ints.status, JSON.stringify(ints.body)).toBe(200);
  const interrupts = ints.body.interrupts;
  const gate = interrupts.find((i) => i.nodeId.includes('review'));
  expect(gate, `expected a pending interrupt for the review gate: ${JSON.stringify(interrupts)}`).toBeTruthy();
  const resolved = await owner.post(`/interrupts/${encodeURIComponent(gate!.token)}`, { resumeValue });
  expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
  // Poll to a TERMINAL state — `pollRun` breaks on `waiting-*` too, which after a
  // resume is a transient the resumed run passes straight through.
  let snap: RunSnapshot = { status: 'running' };
  for (let i = 0; i < 120; i++) {
    const r = await owner.get<RunSnapshot>(`/runs/${runId}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    snap = r.body;
    if (snap.status === 'completed' || snap.status === 'failed' || snap.status === 'cancelled') break;
    await new Promise((res) => setTimeout(res, 25));
  }
  return snap;
}

let n = 0;
async function ownerOrg(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:csmchain-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `csmchain-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}
const c = (orgId: string, suffix = ''): string => `/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}${suffix}`;

interface RunSnapshot { status: string }
async function pollRun(owner: Client, runId: string): Promise<RunSnapshot> {
  let snap: RunSnapshot = { status: 'pending' };
  for (let i = 0; i < 80; i++) {
    const r = await owner.get<RunSnapshot>(`/runs/${runId}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    snap = r.body;
    if (snap.status === 'completed' || snap.status === 'failed' || snap.status === 'cancelled' || snap.status.startsWith('waiting')) break;
    await new Promise((res) => setTimeout(res, 25));
  }
  return snap;
}

describe('csm-ops.health-from-crm — end-to-end execution (real executor, direct run-start)', () => {
  it('reads the linked company\'s open deals + org open tasks and writes healthScore/healthFactors/healthComputedAt via ctx.features.csm', async () => {
    const { owner, orgId } = await ownerOrg();

    const company = await owner.post<{ companyId: string }>(c(orgId, '/companies'), { name: 'Globex' });
    expect(company.status, JSON.stringify(company.body)).toBe(201);
    const companyId = company.body.companyId;

    // One OPEN deal (default stage) + one WON deal (excluded) for the linked company.
    const openDeal = await owner.post(c(orgId, '/deals'), { title: 'Renewal', companyId });
    expect(openDeal.status, JSON.stringify(openDeal.body)).toBe(201);
    const wonDeal = await owner.post(c(orgId, '/deals'), { title: 'Closed upsell', companyId, status: 'won' });
    expect(wonDeal.status, JSON.stringify(wonDeal.body)).toBe(201);
    // A distractor deal for a DIFFERENT company — proves the company scoping.
    const otherCompany = await owner.post<{ companyId: string }>(c(orgId, '/companies'), { name: 'Other Co' });
    const distractorDeal = await owner.post(c(orgId, '/deals'), { title: 'Unrelated', companyId: otherCompany.body.companyId });
    expect(distractorDeal.status).toBe(201);

    // One OPEN task + one DONE task (excluded) for the linked company.
    const openTask = await owner.post(c(orgId, '/tasks'), { title: 'Check-in call', companyId });
    expect(openTask.status, JSON.stringify(openTask.body)).toBe(201);
    const doneTaskCreate = await owner.post<{ taskId: string }>(c(orgId, '/tasks'), { title: 'Old task', companyId });
    expect(doneTaskCreate.status).toBe(201);
    const doneTask = await owner.patch<{ status: string }>(c(orgId, `/tasks/${encodeURIComponent(doneTaskCreate.body.taskId)}`), { status: 'done' });
    expect(doneTask.status, JSON.stringify(doneTask.body)).toBe(200);
    expect(doneTask.body.status).toBe('done');

    const csmAccount = await owner.post<{ accountId: string }>('/host/openwop-app/csm/accounts', {
      name: 'Globex — Account',
      crmRef: { orgId, companyId },
    });
    expect(csmAccount.status, JSON.stringify(csmAccount.body)).toBe(201);
    const accountId = csmAccount.body.accountId;

    const found = getChain('csm-ops.health-from-crm');
    expect(found, 'csm-ops.health-from-crm chain must be loaded at boot').toBeTruthy();
    const params = { orgId, companyId, accountId };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);

    const create = await owner.post<{ runId: string }>('/runs', { workflowId: expanded.workflowId, inputs: params });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId;

    const snap = await pollRun(owner, runId);
    expect(snap.status, `run did not complete cleanly: ${JSON.stringify(snap)}`).toBe('completed');

    const account = await owner.get<{ accounts: Array<{ accountId: string; healthScore?: number; healthFactors?: unknown; healthComputedAt?: string }> }>(`/host/openwop-app/csm/accounts`);
    expect(account.status, JSON.stringify(account.body)).toBe(200);
    const updated = account.body.accounts.find((a) => a.accountId === accountId);
    expect(updated, `expected account ${accountId} in the tenant's CSM accounts`).toBeTruthy();

    // 1 open deal (weight 8) + 1 open task (weight 3): 100 - 8 - 3 = 89.
    // The won deal, the done task, and the OTHER company's deal are all
    // excluded — proving both the status filter AND the company scoping
    // (the deals fan-in is already company-scoped server-side; the tasks
    // fan-in is filtered locally by companyId inside health-set).
    expect(updated!.healthScore).toBe(89);
    // ADR 0582 §16 — the trailing four are unweighted ATTRIBUTION COVERAGE
    // denominators (they cannot move the score); they make a measured zero
    // distinguishable from an unattributable one.
    expect(updated!.healthFactors).toEqual([
      { factor: 'openDeals', weight: 8, value: 1 },
      { factor: 'openTasks', weight: 3, value: 1 },
      { factor: 'dealsAttributed', weight: 0, value: 2 },
      { factor: 'dealsSeen', weight: 0, value: 2 },
      { factor: 'tasksAttributed', weight: 0, value: 2 },
      { factor: 'tasksSeen', weight: 0, value: 2 },
      // ADR 0882 D4 — a play's own tasks, reported and never scored.
      { factor: 'playTasksOpen', weight: 0, value: 0 },
    ]);
    expect(updated!.healthComputedAt, 'a computed write stamps healthComputedAt').toBeTruthy();
  });
});

describe('csm-ops.renewal-risk — end-to-end execution (real executor, suspends at the human gate)', () => {
  // The former "reads open deals then SUSPENDS at core.chat.approvalGate" case
  // was cut (w7 /grade-tests): every leg below re-asserts it — `startRenewalRisk`
  // requires the `waiting*` status, `resolveGate` requires the review interrupt,
  // and REJECT requires zero tasks afterwards. Wiring `follow-up` ahead of the
  // gate turned REJECT red as well as the cut case.
  // ADR 0582 §1 / WF-CSM-1 + WF-CSM-4. The original suspend-only case stopped at
  // the gate and never resumed, so before this pair NEITHER leg had ever executed — the
  // "human gate" was witnessed only up to the pause. `core.chat.approvalGate`
  // returns `status:'success'` on REJECT as well as approve (packs/
  // vendor.myndhyve.chat/index.mjs), so an unconditioned `review → follow-up`
  // edge runs the effect either way: a rejected renewal review still created
  // the CRM task, on a chain declared `side-effectful` whose own description
  // promised "On approval, creates one follow-up task".
  //
  // These two legs are the discriminator. Against the pre-fix pack.json the
  // REJECT leg finds ONE task (it should find zero).
  //
  // ── R2 CORRECTION (ADR 0582 §9). These witnesses used to resolve with
  // `{decision:'approved', approved:true}` — A SHAPE NO UI PRODUCES. Every
  // shipped surface sends `{action}` (ApprovalCard.tsx, defaultCards.tsx,
  // routes/reviews.ts), and the gate read `decision` ONLY, so on a real click
  // `approved` was always false and BOTH legs took the reject branch: the
  // approve path was never witnessed at all and the operator was told they had
  // rejected when they approved. The synthetic payload passed
  // `validateResumeValue` only because a chat gate's `interrupt.data` carries
  // no `actions` array, so the enum check early-returns.
  //
  // So these now resolve with the REAL UI payload. `LEGACY` keeps one case on
  // the `{decision}` shape so a direct `ctx.suspend` resolver still works.
  // Both action-shaped legs FAIL against the pre-fix gate.
  async function startRenewalRisk(): Promise<{ owner: Client; orgId: string; runId: string }> {
    const { owner, orgId } = await ownerOrg();
    const deal = await owner.post(c(orgId, '/deals'), { title: 'At-risk renewal' });
    expect(deal.status, JSON.stringify(deal.body)).toBe(201);
    const found = getChain('csm-ops.renewal-risk');
    expect(found, 'csm-ops.renewal-risk chain must be loaded at boot').toBeTruthy();
    const expanded = expandChain(found!.chain, { params: { orgId } });
    registerWorkflow(expanded);
    const create = await owner.post<{ runId: string }>('/runs', { workflowId: expanded.workflowId, inputs: { orgId } });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId;
    const snap = await pollRun(owner, runId);
    expect(snap.status.startsWith('waiting'), `run should suspend at the review gate, was ${JSON.stringify(snap)}`).toBe(true);
    return { owner, orgId, runId };
  }

  // The exact body `ApprovalCard.tsx` / `defaultCards.tsx` POST for each button.
  const UI_APPROVE = { action: 'approve' } as const;
  const UI_REJECT = { action: 'reject' } as const;

  it('REJECT (the real UI `{action:"reject"}`) ⇒ NO follow-up task, run terminates as a business outcome', async () => {
    const { owner, orgId, runId } = await startRenewalRisk();
    const snap = await resolveGate(owner, runId, UI_REJECT);
    // ADR 0582 §10 — a reviewer's legitimate "no" is an OUTCOME, not a run
    // failure. It used to hit `core.fail`, which made every routine rejection
    // degrade this workflow's fleet successRate (workflowFleetStats.ts counts
    // completed/(completed+failed) and excludes only debug/eval/draft runs).
    // The reject leg now lands on a labelled `core.flow.noop`, so the run
    // COMPLETES; the rejection stays auditable via the gate's own
    // `decision:'reject'` output in the run feed.
    expect(snap.status, `a rejected review must terminate the run, was ${JSON.stringify(snap)}`).toBe('completed');
    const tasks = await owner.get<TasksBody>(c(orgId, '/tasks'));
    expect(tasks.status, JSON.stringify(tasks.body)).toBe(200);
    expect(
      tasks.body.tasks.length,
      'a REJECTED renewal review must not create the CRM follow-up task',
    ).toBe(0);
  });

  it('APPROVE (the real UI `{action:"approve"}`) ⇒ exactly one follow-up task, run completes', async () => {
    const { owner, orgId, runId } = await startRenewalRisk();
    const snap = await resolveGate(owner, runId, UI_APPROVE);
    expect(snap.status, `an approved review must complete, was ${JSON.stringify(snap)}`).toBe('completed');
    const tasks = await owner.get<TasksBody>(c(orgId, '/tasks'));
    expect(tasks.status, JSON.stringify(tasks.body)).toBe(200);
    const rows = tasks.body.tasks;
    expect(
      rows,
      'the APPROVE leg must create the task — against the pre-fix gate this found ZERO, because `action` was never read and approve took the reject branch',
    ).toHaveLength(1);
    expect(rows[0]!.title).toBe('Follow up on at-risk renewal');
  });

  // Back-compat: a direct `ctx.suspend` resolver (and the legacy tests that
  // pin it) may still send `{decision}`. Keep one leg on that shape so the
  // normalisation cannot regress it. The payload is `{decision}` ALONE: it used
  // to also carry `approved: true`, and the gate's `approved === true` fallback
  // approves on that flag by itself — so the `decision` read was never what
  // this leg exercised.
  it('LEGACY `{decision:"approved"}` still approves', async () => {
    const { owner, orgId, runId } = await startRenewalRisk();
    const snap = await resolveGate(owner, runId, { decision: 'approved' });
    expect(snap.status, JSON.stringify(snap)).toBe('completed');
    const tasks = await owner.get<TasksBody>(c(orgId, '/tasks'));
    expect(tasks.body.tasks).toHaveLength(1);
    expect(tasks.body.tasks[0]!.title).toBe('Follow up on at-risk renewal');
  });
});
