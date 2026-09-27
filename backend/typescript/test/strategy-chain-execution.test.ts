/**
 * STRAT-A1 (grade-code) — execute the three `vendor.openwop-app.workflows.strategy`
 * chains END TO END: the REAL expanded definitions (loader → expandChain), the
 * REAL `feature.strategy.nodes` implementations, and the REAL
 * `ctx.features.strategy` surface over a booted app.
 *
 * ── ADR 0597 §1: three instrument defects this harness carried ───────────────
 *
 * 1. It stubbed `feature.notifications.nodes.notify` through a CATCH-ALL and
 *    asserted only `notifications.length > 0`. The chains' whole deliverable is
 *    the digest BODY, and the body was never bound (SPC-16 / SPWF-1) — so the
 *    assertion pinned the defect as the guarantee and would have stayed green
 *    forever. The notify node now runs FOR REAL and the assertion reads the
 *    persisted notification row's `message`.
 * 2. It built node inputs from EDGES ONLY, ignoring declared `node.inputs` —
 *    the exact blind spot `91e398f52`'s commit message claimed to have fixed.
 *    `buildCtxInputs` below now mirrors `executor.ts:726-736` (edge-derived
 *    inputs, single-`input` unwrap, then `node.inputs` merged on top,
 *    fixture-wins), and `resolveConfig`'s hand-rolled `{{params.*}}`
 *    re-substitution is GONE — the config a node sees is what `expandChain`
 *    actually froze, so a freeze failure surfaces here instead of being papered
 *    over.
 * 3. It ran `runChain('strategy.board-pack', { orgId }, …)` — supplying by hand
 *    the one param the only production caller (`applyCadenceConfig`) never
 *    supplies. Mechanism tested, wiring not. The cadence lane is now driven
 *    through `PUT /strategy/cadence` and the definition that was ACTUALLY
 *    registered is what runs.
 *
 * Only `core.ai.chatCompletion` is stubbed (a real LLM call is not a test).
 * Every other node — strategy AND notifications — resolves through the
 * trust-gated pack lane, not a direct `import()`.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { loadWorkflowChainPacks, getChain, expandChain, findUnfilledExpansionParams, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import { getRegisteredWorkflowAsync } from '../src/host/workflowsRegistry.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { resolveDeclaredInputs, buildNodeCtxInputs } from '../src/executor/nodeCtxInputs.js';
import { ensureLocalPacksMounted } from '../src/bootstrap/mountLocalPacks.js';
import { classifyPackDir } from '../src/host/packTrust.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { listCheckIns } from '../src/features/strategy/checkIns.js';
import { listDocuments } from '../src/features/documents/documentsService.js';
import type { NodeContext, WorkflowDefinition } from '../src/executor/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

let BASE: string;
let server: http.Server;
type NodeResult = { status: string; outputs?: Record<string, unknown>; error?: unknown };

/**
 * The ONLY stub. `core.ai.chatCompletion` returns the shape the real node
 * returns (`content`, no `output` port) — which is precisely what makes the
 * portless-edge defect reproducible here.
 */
const AI_CONTENT = 'Synthesized memo: 2 key results are stale.';
async function aiStub(): Promise<NodeResult> {
  return { status: 'success', outputs: { content: AI_CONTENT, usage: {}, finishReason: 'stop', model: 'stub' } };
}

/**
 * Resolve a node the way the RUNTIME does: through the registry, whose miss
 * path is `bootstrap/nodePackResolver` → `packs/tarballLoader.loadPackFromManifest`
 * → `host/packTrust.classifyPackDir`. A pack that is not dispatchable gets a
 * refusal stub instead of its code, and that is exactly what this harness used
 * to bypass by `import()`ing `packs/feature.strategy.nodes/index.mjs` directly.
 * "The pack has tests" is not "the pack is reachable in production".
 */
async function nodeImpl(typeId: string): Promise<(ctx: unknown) => Promise<NodeResult>> {
  if (typeId === 'core.ai.chatCompletion') return aiStub;
  const mod = await getNodeRegistry().resolve(typeId);
  expect(mod, `${typeId} did not resolve through the trust-gated pack lane`).toBeTruthy();
  return (ctx) => mod!.execute(ctx as NodeContext) as Promise<NodeResult>;
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['strategy', 'documents', 'notifications']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: [join(REPO_ROOT, 'examples', 'workflow-chain-packs')] });
  expect(errors).toEqual([]);
  // Mirror this repo's `packs/` into the per-worker OPENWOP_PACK_DIR
  // (`test/setup/isolatePackDir.ts`) so the boot-installed node-pack resolver
  // can find them — the `notifications-node-surface.test.ts` reachability
  // precedent. Per-worker dir ⇒ no shared `~/.openwop-packs` contention.
  ensureLocalPacksMounted();
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
    patch: (p: string, b?: unknown) => call('PATCH', p, b),
    put: (p: string, b?: unknown) => call('PUT', p, b),
  };
}

let n = 0;
async function ownerOrg(): Promise<{ owner: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const tenantId = `org:schx-${Date.now()}-${n++}`;
  const owner = client();
  expect((await owner.post('/v1/host/openwop-app/test/login', { email: `schx-${Date.now()}-${n++}@acme.test`, tenantId })).status).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}

/**
 * ADR 0597 §Correction 9 — NOT a mirror any more. `buildCtxInputs` used to be a
 * hand-written copy of the executor's rule, and §1 had already fixed it once
 * (it was edge-only, ignoring `node.inputs`). The repaired copy still only had
 * the LAST half: the single-`input` unwrap and the fixture-wins merge, with no
 * RESOLUTION — no `{{inputs.X}}` whole-token bag lookup, no `{type:'variable'}`,
 * no `{type:'static'|'literal'}` PortValue unwrap.
 *
 * It was faithful only ACCIDENTALLY: non-deferred `expandChain` freezes tokens,
 * and no strategy node declares a PortValue descriptor today. The first chain
 * node using a produced-variable input or a deferred expansion would get a raw
 * descriptor object here and a resolved value in production — a green test over
 * a broken chain, the exact class §1 exists to prevent.
 *
 * So the harness now calls the SAME functions the executor calls. A test double
 * that models the executor is a second implementation of the executor.
 */
function buildCtxInputs(node: WorkflowDefinition['nodes'][number], inputsByPort: Record<string, unknown>, variableBag?: Record<string, unknown>): unknown {
  return buildNodeCtxInputs(inputsByPort, resolveDeclaredInputs(node.inputs, variableBag));
}

/**
 * Walk an EXPANDED definition in node order with `buildNodeInputs` port
 * semantics. `node.config` is used VERBATIM — whatever `expandChain` froze —
 * so an unfrozen `{{params.X}}` shows up as the node's own validation failure
 * instead of being re-substituted by the harness.
 */
async function runDefinition(
  def: WorkflowDefinition,
  tenantId: string,
  actingUserId?: string,
): Promise<Record<string, { status: string; outputs: Record<string, unknown> }>> {
  const runId = `run:${def.workflowId}`;
  const features = buildFeatureSurfaces({ tenantId, runId, ...(actingUserId ? { actingUserId } : {}) });
  const outputs = new Map<string, Record<string, unknown>>();
  const results: Record<string, { status: string; outputs: Record<string, unknown> }> = {};
  for (const node of def.nodes) {
    const inputsByPort: Record<string, unknown> = {};
    for (const e of def.edges ?? []) {
      if (e.targetNodeId !== node.nodeId) continue;
      const src = outputs.get(e.sourceNodeId);
      if (src === undefined) continue;
      const sourcePort = e.sourceOutput ?? 'output';
      inputsByPort[e.targetInput ?? 'input'] = Object.prototype.hasOwnProperty.call(src, sourcePort) ? src[sourcePort] : src;
    }
    const impl = await nodeImpl(node.typeId);
    const result = await impl({ inputs: buildCtxInputs(node, inputsByPort), config: node.config ?? {}, features, runId });
    const short = node.nodeId.slice(node.nodeId.lastIndexOf('_') + 1);
    results[short] = result as { status: string; outputs: Record<string, unknown> };
    if (result.status !== 'success') break;
    outputs.set(node.nodeId, result.outputs ?? {});
  }
  return results;
}

const runChain = async (chainId: string, params: Record<string, unknown>, tenantId: string) =>
  runDefinition(expandChain(getChain(chainId)!.chain, { params }), tenantId);

/** The notification rows this tenant actually received (the durable inbox). */
async function inbox(tenantId: string) {
  return __hostExtStorage()!.listNotifications({ tenantId, limit: 200 });
}

/** A measured, active strategy with one sourced KR (crm-deal-total) and one unsourced. */
async function activeMeasuredStrategy(owner: ReturnType<typeof client>, orgId: string): Promise<string> {
  const s = (await owner.post('/v1/host/openwop-app/strategy', {
    orgId, title: 'Chain plan',
    objectives: [{ title: 'Grow', keyResults: [
      { title: 'Sourced ARR', measure: { kind: 'currency', baseline: 0, target: 100, source: { kind: 'crm-deal-total', orgId } } },
      { title: 'Unsourced NPS', measure: { kind: 'numeric', baseline: 0, target: 60 } },
    ] }],
  })).body;
  await owner.patch(`/v1/host/openwop-app/strategy/${s.id}`, { status: 'active' });
  return s.id;
}

/**
 * REACHABILITY (ADR 0597 §1). Every prior strategy pack test `import()`ed the
 * pack module directly, so none of them could tell a dispatchable pack from a
 * revoked one. This is the one assertion that can.
 */
describe('the strategy node pack is REACHABLE through the trust gate', () => {
  it('is dispatchable and its nodes resolve through the registry, not a direct import', async () => {
    const verdict = classifyPackDir(join(REPO_ROOT, 'packs', 'feature.strategy.nodes'), { noCache: true });
    expect(verdict.dispatchable, `not dispatchable (${verdict.tier}: ${verdict.reason}) ⇒ every strategy node is a refusal stub`).toBe(true);
    for (const typeId of ['feature.strategy.nodes.get-health', 'feature.strategy.nodes.create-board-memo', 'feature.notifications.nodes.notify']) {
      expect(await getNodeRegistry().resolve(typeId), typeId).toBeTruthy();
    }
  });
});

describe('strategy chains — end-to-end execution (STRAT-A1)', () => {
  it('metric-sync writes CONFIRMED check-ins ONLY for sourced KRs (fail-closed for the rest)', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const sid = await activeMeasuredStrategy(owner, orgId);
    // Two paid CRM deals ⇒ commerce/crm revenue the sync reads.
    for (const amount of [40, 30]) {
      const pipe = (await owner.post(`/v1/host/openwop-app/crm/orgs/${orgId}/pipelines`, { name: `P${amount}` })).body;
      await owner.post(`/v1/host/openwop-app/crm/orgs/${orgId}/deals`, { title: `D${amount}`, amount, pipelineId: pipe.pipelineId, stageId: pipe.stages?.[0]?.stageId });
    }

    const results = await runChain('strategy.metric-sync', {}, tenantId);
    expect(results.sync?.status).toBe('success');
    const synced = results.sync?.outputs.synced as Array<{ krId: string; value: number }>;
    // Fail-closed by OMISSION: the sync only ever visits KRs with a configured
    // source — the unsourced KR is never a candidate (not "skipped").
    expect(synced).toHaveLength(1);            // only the sourced KR
    expect(synced[0]!.value).toBe(70);         // 40 + 30 paid deals

    // Exactly one CONFIRMED check-in (not proposed), on the SOURCED KR only —
    // the unsourced KR got no write, which is the fail-closed invariant.
    const checkIns = await listCheckIns(tenantId, sid);
    expect(checkIns).toHaveLength(1);
    expect(checkIns[0]!.status).toBe('confirmed');
    expect(checkIns[0]!.origin).toBe('sync');
    expect(checkIns[0]!.krId).toBe(synced[0]!.krId);
  });

  it('board-pack persists a board-update Document via create-board-memo', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    await activeMeasuredStrategy(owner, orgId);
    const before = (await listDocuments(tenantId, orgId, {})).length;
    const results = await runChain('strategy.board-pack', { orgId }, tenantId);
    expect(results.health?.status).toBe('success');
    expect(results.persist?.status).toBe('success');
    expect(results.persist?.outputs.persisted).toBe(true);
    const docs = await listDocuments(tenantId, orgId, {});
    expect(docs.length).toBe(before + 1);
    expect(docs.some((d) => d.kind === 'board-update')).toBe(true);
  });

  it("weekly-checkin's list-stale-krs surfaces the measured KRs with no recent check-in", async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    await activeMeasuredStrategy(owner, orgId);
    const results = await runChain('strategy.weekly-checkin', { staleDays: 14 }, tenantId);
    expect(results.stale?.status).toBe('success');
    const stale = results.stale?.outputs.staleKrs as Array<{ krTitle: string }>;
    expect(stale.length).toBeGreaterThanOrEqual(2); // both measured KRs are stale (no check-ins yet)
    expect(stale.map((k) => k.krTitle)).toContain('Sourced ARR');
  });
});

/**
 * SPC-16 / SPWF-1. The deliverable of every cadence chain is the digest BODY.
 * `notify` reads `ctx.inputs.message`; a PORTLESS terminal edge binds the AI
 * node's whole outputs map under port `input` instead, so `message` was never
 * bound and every notification shipped title-only while reporting
 * `emitted:true`. The old assertion (`notifications.length > 0`) could not see
 * it. This one reads the persisted row.
 */
describe('every cadence chain DELIVERS its digest, not just a title', () => {
  for (const [chainId, params, terminal] of [
    ['strategy.weekly-checkin', { staleDays: 14 }, 'deliver'],
    ['strategy.metric-sync', {}, 'deliver'],
  ] as const) {
    it(`${chainId} emits a notification whose body carries the composed text`, async () => {
      const { owner, orgId, tenantId } = await ownerOrg();
      await activeMeasuredStrategy(owner, orgId);
      const results = await runChain(chainId, params, tenantId);
      expect(results[terminal]?.status, JSON.stringify(results)).toBe('success');
      expect(results[terminal]?.outputs.emitted).toBe(true);
      const rows = await inbox(tenantId);
      expect(rows.length).toBeGreaterThan(0);
      const row = rows[0]!;
      expect(row.title, 'the title was always bound — it is the BODY that was not').toBeTruthy();
      expect(row.message ?? '').toBe(AI_CONTENT);
    });
  }

  it('board-pack delivers the memo body alongside the persisted Document', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    await activeMeasuredStrategy(owner, orgId);
    const results = await runChain('strategy.board-pack', { orgId }, tenantId);
    expect(results.persist?.outputs.persisted).toBe(true);
    expect(results.deliver?.outputs.emitted).toBe(true);
    const rows = await inbox(tenantId);
    expect(rows[0]?.message ?? '').toBe(AI_CONTENT);
  });
});

/**
 * SPC-1 / SPWF-2. The ONLY production caller of the cadence chains is
 * `applyCadenceConfig`, reached through `PUT /strategy/cadence`. It never
 * supplied `strategy.board-pack`'s REQUIRED `orgId`, so every scheduled fire
 * errored at `create-board-memo` after a 200 OK. The old test passed `{orgId}`
 * by hand — mechanism tested, wiring not. This drives the real route and runs
 * the definition that was actually registered.
 */
describe('the cadence lane registers a RUNNABLE definition (wiring, not mechanism)', () => {
  it('refuses to schedule board-pack with no orgId, and schedules a runnable one when given it', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    await activeMeasuredStrategy(owner, orgId);

    // A chain with an unsatisfied REQUIRED param must fail at SAVE time — the
    // human act with a caller to fail loudly at — never silently every night.
    const blind = await owner.put('/v1/host/openwop-app/strategy/cadence', {
      boardPack: { enabled: true, cron: '0 8 * * 1' },
    });
    expect(blind.status, JSON.stringify(blind.body)).toBe(400);

    const ok = await owner.put('/v1/host/openwop-app/strategy/cadence', {
      boardPack: { enabled: true, cron: '0 8 * * 1', params: { orgId } },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    const slug = (await import('node:crypto')).createHash('sha256').update(tenantId).digest('hex').slice(0, 10);
    const def = await getRegisteredWorkflowAsync(`wf.strategy-board-pack.cadence-${slug}`);
    expect(def, 'the cadence lane registered nothing to fire').toBeTruthy();

    const results = await runDefinition(def!, tenantId);
    expect(results.persist?.status, JSON.stringify(results.persist)).toBe('success');
    expect(results.persist?.outputs.persisted).toBe(true);
    expect(results.deliver?.outputs.emitted).toBe(true);
  });

  /**
   * The FALSIFICATION, pinned so nobody "simplifies" the save-time refusal back
   * into it. The workflows grade prescribed `expandChain(chain, {deferred:true})`
   * "matching the seeder" as the cure for SPWF-2. It is a NO-OP for this
   * failure, twice over:
   *   1. `deferredConfig` still calls `substituteTokensDeep` for a non-liftable
   *      key, so a whole-value `{{params.orgId}}` in CONFIG freezes to
   *      `undefined` and the key vanishes — deferral only defers `inputs`.
   *   2. `collectUnresolved` is skipped entirely in deferred mode, so
   *      `metadata.unresolvedParams` is EMPTY — adopting the prescription would
   *      have silently made the save-time guard vacuous as well.
   */
  it('deferred expansion does NOT rescue an unsupplied required param (the prescribed cure was a no-op)', () => {
    const chain = getChain('strategy.board-pack')!.chain;
    const deferred = expandChain(chain, { deferred: true });
    const persist = deferred.nodes.find((n) => n.typeId === 'feature.strategy.nodes.create-board-memo')!;
    expect(((persist.config ?? {}) as Record<string, unknown>).orgId, 'deferral froze orgId to undefined exactly as expansion-time mode does').toBeUndefined();
    expect(findUnfilledExpansionParams(deferred), 'deferred mode records nothing, so the save-time guard would go blind').toEqual([]);
    // …while the mode the cadence lane actually uses DOES report it.
    expect(findUnfilledExpansionParams(expandChain(chain, { params: {} })).map((u) => u.param)).toContain('orgId');
  });

  it('weekly-checkin needs no params and its registered definition runs clean', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    await activeMeasuredStrategy(owner, orgId);
    const ok = await owner.put('/v1/host/openwop-app/strategy/cadence', {
      weeklyCheckin: { enabled: true, cron: '0 9 * * 1' },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const slug = (await import('node:crypto')).createHash('sha256').update(tenantId).digest('hex').slice(0, 10);
    const def = await getRegisteredWorkflowAsync(`wf.strategy-weekly-checkin.cadence-${slug}`);
    expect(def).toBeTruthy();
    const results = await runDefinition(def!, tenantId);
    expect(results.deliver?.outputs.emitted).toBe(true);
    expect((await inbox(tenantId))[0]?.message ?? '').toBe(AI_CONTENT);
  });
});

/**
 * ADR 0597 §Correction 9 — the harness/executor drift surface, closed and pinned.
 *
 * These are the three shapes the hand-written mirror silently got WRONG, and
 * they are asserted through the SAME functions the executor calls. If anyone
 * re-hand-writes `buildCtxInputs`, this is what goes red — the mirror looked
 * right for exactly as long as no chain used any of them.
 */
describe('ADR 0597 §Correction 9 — node inputs resolve through the executor\'s own rule', () => {
  const node = (inputs: Record<string, unknown>): WorkflowDefinition['nodes'][number] =>
    ({ id: 'n', typeId: 'x', inputs } as unknown as WorkflowDefinition['nodes'][number]);

  it('resolves a {type:static} PortValue descriptor instead of passing the descriptor through', () => {
    const out = buildCtxInputs(node({ message: { type: 'static', value: 'the body' } }), {}, {}) as Record<string, unknown>;
    expect(out.message, 'a raw {type,value} object would reach the node instead of the value').toBe('the body');
  });

  it('resolves a {type:variable} reference against the run variable bag', () => {
    const out = buildCtxInputs(node({ message: { type: 'variable', variableName: 'digest' } }), {}, { digest: 'from the bag' }) as Record<string, unknown>;
    expect(out.message).toBe('from the bag');
  });

  it('resolves a whole {{inputs.X}} token to the RAW bag value, type preserved', () => {
    const payload = { rows: [1, 2, 3] };
    const out = buildCtxInputs(node({ message: '{{inputs.body}}', mixed: 'for {{inputs.period}}' }), {}, { body: payload, period: 'Q3' }) as Record<string, unknown>;
    expect(out.message, 'string substitution would stringify this to "[object Object]"').toBe(payload);
    expect(out.mixed, 'mixed text must still interpolate').toBe('for Q3');
  });

  it('keeps the single-`input` unwrap and fixture-wins merge the mirror DID have', () => {
    expect(buildCtxInputs(node({}), { input: { a: 1 } })).toEqual({ a: 1 });
    expect(buildCtxInputs(node({ a: 'fixture' }), { input: { a: 'edge', b: 2 } })).toEqual({ a: 'fixture', b: 2 });
  });
});

/**
 * ADR 0597 §Correction 2 (HIGH-2 + MEDIUM-6) — the refusal must not leave the
 * thing it refused half-built.
 *
 * §5's save-time refusal fixed "200 + a job that errors every fire". It did not
 * fix the FAMILY: `applyCadenceConfig` still `put` the config BEFORE the loop
 * that throws, and reconciled entries one at a time inside it. So a 400 left
 * behind a config that CLAIMS the schedule is enabled with no job to run it —
 * strictly LESS observable than the bug it replaced, which at least left a run
 * row — plus, for every key processed before the failing one, a registered
 * workflow, an ownership record (it shows in the builder gallery) and a live
 * cron job.
 *
 * `weeklyCheckin` is first in `CHAINS`, so it is the one that gets built and
 * stranded. That ordering is the whole reproduction.
 */
describe('ADR 0597 §Correction 2 — a refused cadence PUT persists NOTHING', () => {
  const cadenceOf = async (tenantId: string) => (await import('../src/features/strategy/cadence.js')).getCadenceConfig(tenantId);
  const jobsOf = async (tenantId: string) => (await import('../src/host/schedulingService.js')).listJobs(tenantId);
  const slugOf = async (tenantId: string) => (await import('node:crypto')).createHash('sha256').update(tenantId).digest('hex').slice(0, 10);

  it('leaves no config, no workflow, no ownership and no job when one entry is unschedulable', async () => {
    const { owner, tenantId } = await ownerOrg();
    const slug = await slugOf(tenantId);

    // weeklyCheckin is satisfiable and is processed FIRST; boardPack needs an
    // `orgId` nothing supplies and throws. One PUT, two entries, 400.
    const refused = await owner.put('/v1/host/openwop-app/strategy/cadence', {
      weeklyCheckin: { enabled: true, cron: '0 9 * * 1' },
      boardPack: { enabled: true, cron: '0 8 * * 1' },
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);

    // 1. The config the caller was told was REJECTED must not be readable back.
    const readBack = await owner.get('/v1/host/openwop-app/strategy/cadence');
    expect(readBack.status).toBe(200);
    expect(readBack.body.config, 'a refused PUT persisted the schedule it refused').toBeNull();
    expect(await cadenceOf(tenantId), 'the durable row survived the refusal').toBeNull();

    // 2. Nothing was half-reconciled for the entry that came BEFORE the failure.
    expect(await getRegisteredWorkflowAsync(`wf.strategy-weekly-checkin.cadence-${slug}`),
      'a 400 still registered a workflow for the entry processed first').toBeFalsy();
    const { listOwned } = await import('../src/host/workflowOwnership.js');
    expect((await listOwned(tenantId)).map((o) => o.workflowId),
      'a 400 still published the workflow into the builder gallery').not.toContain(`wf.strategy-weekly-checkin.cadence-${slug}`);
    expect((await jobsOf(tenantId)).map((j) => j.jobId),
      'a 400 still registered a live cron job').toEqual([]);
  });

  /**
   * ADR 0597 §Correction 10 — the PREMISE of §Correction 1's fallback, pinned.
   *
   * `surface.ts` scopes a run's cross-org link reads to `scope.actingUserId`
   * and falls back to tenant-wide when there isn't one. That fallback is only
   * correct because a cadence fire genuinely HAS no acting human: `registerJob`
   * here passes no `metadata`, and `scheduleDaemon` forwards `actingUserId`
   * only from `job.metadata`. If anyone ever attributes cadence jobs to their
   * configuring owner, every scheduled digest silently narrows to that person's
   * org reads — and the only thing saying otherwise today is a comment.
   */
  it('a cadence job carries NO acting-user attribution — the premise §Correction 1 relies on', async () => {
    const { owner, tenantId } = await ownerOrg();
    const slug = await slugOf(tenantId);
    expect((await owner.put('/v1/host/openwop-app/strategy/cadence', {
      weeklyCheckin: { enabled: true, cron: '0 9 * * 1' },
    })).status).toBe(200);

    const job = (await jobsOf(tenantId)).find((j) => j.jobId === `strategy-cadence:weeklyCheckin:${slug}`);
    expect(job, 'no job was registered ⇒ the assertion below is vacuous').toBeTruthy();
    // The owner IS recorded — as the authority the run carries (`ownerUserId`),
    // which is a different field from the one `executor.ts` stamps onto
    // `BundleScope.actingUserId`. That distinction is the whole point.
    expect(job!.ownerUserId, 'the schedule lost its owning authority').toBeTruthy();
    expect((job!.metadata ?? {}).actingUserId,
      'a cadence fire now carries an acting human, so the surface will scope every scheduled digest to their org reads').toBeUndefined();
  });

  /**
   * The one refusal `registerJob` can still produce, hoisted into the validate
   * phase. `jobIdFor` is `sha256(tenantId)[0..10]`, so this needs a 40-bit
   * tenant-slug collision — rare, and worth catching rather than shrugging at,
   * because `deleteJob` is jobId-keyed: left in the write phase, a DISABLE would
   * have reached into the colliding tenant's job.
   */
  it('refuses BEFORE writing when the deterministic job id belongs to another tenant', async () => {
    const { owner, tenantId } = await ownerOrg();
    const slug = await slugOf(tenantId);
    const { registerJob } = await import('../src/host/schedulingService.js');
    const squatted = `strategy-cadence:weeklyCheckin:${slug}`;
    expect((await registerJob({ jobId: squatted, tenantId: 'org:someone-else', cronExpr: '0 3 * * *' })).ok).toBe(true);

    const refused = await owner.put('/v1/host/openwop-app/strategy/cadence', {
      weeklyCheckin: { enabled: true, cron: '0 9 * * 1' },
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(await cadenceOf(tenantId), 'a refused PUT persisted the config anyway').toBeNull();
    expect(await getRegisteredWorkflowAsync(`wf.strategy-weekly-checkin.cadence-${slug}`)).toBeFalsy();
    const { getJob } = await import('../src/host/schedulingService.js');
    expect((await getJob(squatted))?.tenantId, "the other tenant's job was overwritten").toBe('org:someone-else');
  });

  it('MATCHED POSITIVE CONTROL — the same two entries, both satisfiable, DO all get built', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const slug = await slugOf(tenantId);
    const ok = await owner.put('/v1/host/openwop-app/strategy/cadence', {
      weeklyCheckin: { enabled: true, cron: '0 9 * * 1' },
      boardPack: { enabled: true, cron: '0 8 * * 1', params: { orgId } },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await cadenceOf(tenantId))?.boardPack?.enabled).toBe(true);
    expect(await getRegisteredWorkflowAsync(`wf.strategy-weekly-checkin.cadence-${slug}`)).toBeTruthy();
    expect(await getRegisteredWorkflowAsync(`wf.strategy-board-pack.cadence-${slug}`)).toBeTruthy();
    expect((await jobsOf(tenantId)).map((j) => j.jobId).sort())
      .toEqual([`strategy-cadence:boardPack:${slug}`, `strategy-cadence:weeklyCheckin:${slug}`]);
  });
});
