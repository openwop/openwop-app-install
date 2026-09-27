/**
 * data-ops workflow-chain pack — REAL execution (ADR 0200/0201, RFC 0013).
 *
 * Structural coverage already exists (`workflow-chain-data-ops.test.ts`: expand +
 * typeIds, owned by another session — not touched here). This adds REAL-executor
 * coverage for two chains: `data-ops.rollup` (the documented multi-fan-in bug) and
 * `data-ops.content-router` (ADR 0201 real conditional routing).
 *
 * MODE CHOSEN — `data-ops.rollup`: its `digest` node is `core.ai.chatCompletion`
 * with no `provider`/`model` configured (every example chain-pack template ships
 * this way — an operator wires a live provider at install/activate time), so per
 * the established `exec-ops`/`csm-ops` convention this drives the REAL executor to
 * a genuine `completed` state for every upstream node, then asserts the HONEST
 * FAILURE contract at the AI node (`error.code === 'provider_not_supported'`)
 * rather than forcing completion.
 *
 * MODE CHOSEN — `data-ops.content-router`: no AI/connector node sits in the path
 * (`core.flow.router` → `feature.notifications.nodes.notify`, which
 * degrades gracefully to `connected:false`-style `{sent:false, error:
 * 'notification_not_connected'}` with no push provider configured — the same
 * documented graceful-degrade contract `capability-dispatch-*.test.ts` pins for
 * connector nodes), so this drives the REAL executor to genuine `completed` for
 * all three routing scenarios (high / low / normal-by-default), asserting via the
 * debug bundle that ONLY the matching branch's node actually fired.
 *
 * BUGS FOUND + FIXED AT THE ROOT (`examples/workflow-chain-packs/data-ops/
 * pack.json`):
 *
 * 1. Multi-fan-in port collision (the same defect class documented in
 *    `workflow-chain-csm-ops-execution.test.ts` / `workflow-chain-exec-ops-
 *    execution.test.ts`): `data-ops.rollup`'s `digest` node has TWO inbound
 *    edges (`total`, `list`) that named neither `sourceOutput` nor `targetInput`.
 *    The scheduler's `buildNodeInputs` (executor/scheduler.ts) wrote both edges'
 *    values to the SAME default port key `'input'` in edge-array order, so the
 *    second edge (`list`) silently clobbered the first (`total`) before the
 *    executor's single-key "Back-compat" unwrap (executor.ts) flattened the
 *    result to just `list`'s raw `{text, count}` output — `total`'s `{result,
 *    count}` (the actual summed amount the digest prompt is supposed to lead
 *    with) was silently DROPPED on every real run. Fixed with explicit
 *    dot-notation target ports (`digest.total`, `digest.list`) so each source
 *    lands on its own key. Verified via a throwaway probe: pre-fix, only one of
 *    the two upstream node outputs survived to reach `digest`'s ctx.inputs (the
 *    AI node fails before completion regardless — no configured provider — so
 *    this fix is proven the same way `exec-ops` proves its analogous fixes: by
 *    asserting the UPSTREAM nodes' own outputs are individually correct real
 *    data, then that the run fails cleanly at the AI node rather than being
 *    silently mis-wired).
 *
 * 2. Dead `node.inputs` field + source-node flat-input key mismatch (a NEW defect
 *    class, distinct from the multi-fan-in pattern above — found while
 *    investigating why `content-router`'s routing never matched real record
 *    data). `expandChain` → `validateWorkflowDefinition` (`src/host/
 *    workflowDefinitionValidation.ts` line ~203) reconstructs every expanded node
 *    picking ONLY `nodeId`/`typeId`/`config`/`outputRole` — a chain-pack node's
 *    authored `inputs` field (e.g. `data-ops.rollup`'s `{"items":
 *    "{{params.items}}"}}`-style static port declarations) is UNCONDITIONALLY
 *    DROPPED at expansion time, regardless of shape (a raw `{{params.X}}` string
 *    OR the schema-valid `{type:'variable',variableName}` fixture shape — neither
 *    survives). For a node with ZERO incoming DAG edges (a "source" node), the
 *    scheduler falls back to `ctx.inputs = run.inputs` (the run's WHOLE flat
 *    params object — `buildNodeInputs`'s `{ input: runInputs }` + the executor's
 *    single-key back-compat unwrap). `data-ops.rollup`'s `total`/`list` nodes
 *    happen to work ONLY because their chain parameter is named `items`, which
 *    coincidentally matches the exact key `core.flow.aggregate-{numeric,text}`
 *    reads off `ctx.inputs.items` — the pack.json `"inputs"` declarations were
 *    always decorative dead weight. `data-ops.content-router`'s `route` node had
 *    NO such coincidence: `core.flow.router` reads `ctx.inputs.value`
 *    (`packs/core.openwop.flow/index.mjs`'s `routerNode`), but the chain's
 *    parameter was named `record` — so `ctx.inputs.value` was always `undefined`,
 *    every route predicate evaluated against `undefined`, NOTHING ever matched,
 *    and the chain silently fell through to `defaultLabel: "normal"` on EVERY
 *    run regardless of the record's actual field values. Verified via a
 *    throwaway probe: a record with `{priority:"high"}` routed to the `normal`
 *    branch pre-fix. Fixed by renaming the chain parameter `record` → `value`
 *    (matching the exact key the node's real implementation reads) — the same
 *    "flat top-level key must match" mechanism `total`/`list` already relied on,
 *    now made to actually work instead of coincidentally happening to. Re-probed
 *    post-fix: `{priority:"high"}` now correctly routes to `branches:["high"]`.
 *    The dead `"inputs"` declarations on both nodes were removed (replaced with
 *    `{}`) rather than left as a misleading no-op.
 *
 * 3. Same class as (2), plus a second layer: `data-ops.to-table`'s `table` node
 *    (`core.flow.aggregate-table`) needed BOTH `ctx.inputs.items` (same rename
 *    fix as above: `records` → `items`) AND `ctx.config.columns` as a REAL array.
 *    But `config.columns` was authored as the STRING template
 *    `"{{params.columns}}"`, and per-run config-token interpolation
 *    (`src/executor/runInputInterpolation.ts`'s `interpolateRunInputs`) is a
 *    STRING-only regex replace — a non-string variable value (the `columns`
 *    array) is coerced via `String(v)`, collapsing an array-of-objects into the
 *    literal text `"[object Object],[object Object]"`. `core.flow.aggregate-
 *    table` then throws `cols.map is not a function` on every real run,
 *    regardless of whether an operator ever supplied a custom `columns` value —
 *    even the schema `default` went through the same corrupting path. There is
 *    no config-side mechanism to thread a real array/object per-run value into a
 *    node's `config` (only `ctx.inputs`, and only via a real edge or the
 *    source-node flat-key coincidence above — neither of which
 *    `aggregate-table`'s config-only `columns` field can use). Fixed by dropping
 *    `columns` as a chain parameter entirely and hardcoding the node's
 *    `config.columns` to a literal array (name/value, matching the prior
 *    schema default) — the column set is no longer operator-customizable, but
 *    the chain now actually runs instead of always throwing. `data-ops.to-table`
 *    is not one of this file's two chosen chains (not required to have a
 *    dedicated execution test here), but the fix was verified with the same
 *    throwaway-probe method: pre-fix `cols.map is not a function`; post-fix the
 *    `table` node correctly produces `rows` from the real seeded items.
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
async function ownerOrg(): Promise<{ owner: Client; tenantId: string }> {
  const tenantId = `org:dataopschain-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `dataopschain-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { owner, tenantId };
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

describe('data-ops.rollup — real reads, honest missing-credential failure (fan-in fix)', () => {
  it('sums + formats the REAL items array (both upstream sources survive the digest fan-in), then fails cleanly at the AI node', async () => {
    const { owner } = await ownerOrg();

    const found = getChain('data-ops.rollup');
    expect(found, 'data-ops.rollup chain must be loaded at boot').toBeTruthy();
    const params = {
      items: [{ name: 'Widget', amount: 5 }, { name: 'Gadget', amount: 7 }],
      amountField: 'amount',
      lineTemplate: '- {{name}}: {{amount}}',
    };
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
    // Both fan-in sources completed with the REAL seeded data — proving the
    // digest fan-in fix didn't just move which single source survives, but
    // that each source's own node genuinely read the real items array.
    expect(completedOutputs(events, 'total')).toMatchObject({ result: 12, count: 2 });
    expect(completedOutputs(events, 'list')).toMatchObject({ text: '- Widget: 5\n- Gadget: 7', count: 2 });

    // The AI node is where it fails — never silently skipped or reached notify.
    const failedEvent = events.find((e) => e.type === 'node.failed');
    expect(failedEvent?.nodeId?.endsWith('_digest')).toBe(true);
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId?.endsWith('_notify'))).toBe(false);
  });
});

describe('data-ops.content-router — real conditional routing (ADR 0201, param-rename fix)', () => {
  async function runRouter(owner: Client, value: Record<string, unknown>): Promise<BundleEvent[]> {
    const found = getChain('data-ops.content-router');
    expect(found, 'data-ops.content-router chain must be loaded at boot').toBeTruthy();
    const params = { value, routeField: 'priority' };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);
    const create = await owner.post('/v1/runs', { workflowId: expanded.workflowId, inputs: params });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;
    const snap = await pollRun(owner, runId);
    expect(snap.status, `run did not complete cleanly: ${JSON.stringify(snap)}`).toBe('completed');
    return bundleEvents(owner, runId);
  }

  it('routes a high-priority record to the high branch ONLY (not normal/low)', async () => {
    const { owner } = await ownerOrg();
    const events = await runRouter(owner, { priority: 'high', title: 'urgent thing' });

    expect(completedOutputs(events, 'route')).toMatchObject({ branches: ['high'] });
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId?.endsWith('_high'))).toBe(true);
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId?.endsWith('_normal'))).toBe(false);
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId?.endsWith('_low'))).toBe(false);
  });

  it('routes a low-priority record to the low branch ONLY', async () => {
    const { owner } = await ownerOrg();
    const events = await runRouter(owner, { priority: 'low', title: 'whenever' });

    expect(completedOutputs(events, 'route')).toMatchObject({ branches: ['low'] });
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId?.endsWith('_low'))).toBe(true);
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId?.endsWith('_high'))).toBe(false);
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId?.endsWith('_normal'))).toBe(false);
  });

  it('falls through to the normal branch (defaultLabel) for an unmatched value', async () => {
    const { owner } = await ownerOrg();
    const events = await runRouter(owner, { priority: 'unmapped-value', title: 'shrug' });

    expect(completedOutputs(events, 'route')).toMatchObject({ branches: ['normal'] });
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId?.endsWith('_normal'))).toBe(true);
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId?.endsWith('_high'))).toBe(false);
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId?.endsWith('_low'))).toBe(false);
  });
});
