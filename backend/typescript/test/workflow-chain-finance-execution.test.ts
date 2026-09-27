/**
 * finance workflow-chain pack — REAL execution (ADR 0149, RFC 0013).
 *
 * Mirrors the `crm-ops`/`csm-ops`/`exec-ops`/`marketing` execution precedents
 * (`crm-chain-execution.test.ts`, `workflow-chain-csm-ops-execution.test.ts`,
 * `workflow-chain-exec-ops-execution.test.ts`, `workflow-chain-marketing-
 * execution.test.ts`) and the `cms.localize-and-submit` AI-node precedent
 * (`cms-chain-execution.test.ts`).
 *
 * `finance.month-end-close` is the pick — it's the ONLY one of the three
 * finance chains with more than one chain-entry node (`checklist` + `docs`,
 * feeding a fan-in `variance` node), so it's the only chain where a real run
 * does genuine upstream work before the AI-provider wall, AND the only chain
 * that hit the multi-fan-in defect. `finance.invoice-ap` and `finance.
 * expense-approval` both lead with a SOLE `core.ai.chatCompletion` node with
 * no upstream reads at all — a real run of either fails at node 1 with zero
 * side effects to assert, so (mirroring the `marketing` precedent's choice to
 * concentrate on `campaign-launch`) they get no dedicated execution test here.
 *
 * MODE CHOSEN, and WHY — two complementary modes, same chain:
 *
 *   1. REAL EXECUTOR (`POST /v1/runs`, polled, inspected via `GET /v1/runs/
 *      {runId}/debug-bundle`). Every `core.ai.chatCompletion` node in this
 *      pack omits `provider`/`model` (a chain TEMPLATE — an operator wires a
 *      live provider on install/activate, the same fact `cms-chain-
 *      execution.test.ts`/`workflow-chain-exec-ops-execution.test.ts`/
 *      `workflow-chain-marketing-execution.test.ts` document), so a real run
 *      genuinely cannot complete past `checklist`. This test asserts the
 *      HONEST FAILURE contract (`status:'failed'`, `error.code:
 *      'provider_not_supported'`) rather than forcing completion — but proves
 *      the thing that matters: `docs` (`feature.kb.nodes.rag`) is an
 *      independent, non-AI chain-entry node that runs for real, in parallel
 *      with `checklist`, and its `node.completed` event in the real debug-
 *      bundle carries REAL citations from a REAL seeded KB document — the
 *      BUG-2 fix below, proved against the real executor, not a harness.
 *
 *   2. A MINI-SCHEDULER (`walkChain` below) — the SAME technique `cms-chain-
 *      execution.test.ts`/`workflow-chain-marketing-execution.test.ts` use for
 *      the same "no BYOK credential in a test tenant" problem: the REAL node
 *      implementations (`packs/core.openwop.ai` `chatCompletion`,
 *      `packs/feature.kb.nodes` `rag`, `packs/vendor.myndhyve.chat`
 *      `core.chat.approvalGate`), the REAL `ctx.features.kb` surface over
 *      seeded data, and the REAL `ctx.suspend` primitive (`executor/
 *      suspendSignal.js`'s `makeSuspendFn`/`SuspendSignal` — not faked, the
 *      actual mechanism the executor itself uses to turn a suspend call into
 *      a `{status:'suspended'}` outcome). The ONLY fake is `ctx.callAI` for
 *      `checklist`/`variance`. This walks past the AI nodes — impossible for
 *      a real run — reaching `chase` (`core.chat.approvalGate`) for real.
 *      This is what proves BUG-1: with the fix, `variance`'s built inputs
 *      carry `checklist`/`docs` on TWO DISTINCT ports (not the shared default
 *      `'input'` port the scheduler's `buildNodeInputs` would otherwise
 *      clobber down to one, with the second edge silently winning), and the
 *      walk reaches a genuine terminal state — SUSPENDED at the human gate,
 *      never auto-launching — exactly like `csm-ops.renewal-risk`'s real-
 *      executor suspend, just reached through the harness because an AI node
 *      sits upstream of the gate here.
 *
 * BUGS FOUND + FIXED AT THE ROOT (`examples/workflow-chain-packs/finance/
 * pack.json`):
 *
 * 1. Multi-fan-in port collision (the SAME defect class as `csm-ops.health-
 *    from-crm`/`exec-ops.*`/`marketing.*`, see those precedents' doc comments
 *    for the full mechanism): `finance.month-end-close`'s `variance` node has
 *    two inbound edges (`checklist`, `docs`) that named neither `sourceOutput`
 *    nor `targetInput` — the scheduler's `buildNodeInputs` (executor/
 *    scheduler.ts) would write BOTH to the shared default port key `'input'`,
 *    the second edge (`docs`) silently clobbering the first (`checklist`), and
 *    the executor's single-key "Back-compat" unwrap would then flatten that
 *    to `docs`'s raw output object alone — `checklist`'s checklist content
 *    would never reach the variance prompt on any real run. Fixed with
 *    explicit dot-notation target ports: `checklist` → `variance.checklist`,
 *    `docs` → `variance.docs`. Re-scanned the WHOLE pack for any OTHER
 *    un-flagged instance (any node with 2+ inbound edges lacking dot-notation
 *    ports): this is the only one — `invoice-ap` and `expense-approval` are
 *    both single-inbound-edge chains throughout, and `variance`'s own two
 *    downstream edges (`variance`→`chase`, `chase`→`report`) are each
 *    single-inbound.
 *
 * 2. Missing `orgId`/`collectionId`/`query` parameters on `docs` (an
 *    org-scoping-style defect — no BUG PATTERN B instance was specifically
 *    flagged for finance, but this is the same class: an org/tenant-scoped
 *    feature surface read with no way to supply the scope). Verified the
 *    underlying node's exact contract by reading `packs/feature.kb.nodes/
 *    index.mjs`'s `rag()`: it reads `orgId`/`collectionId`/`query` from
 *    `ctx.inputs` ONLY — it never reads `ctx.config` (unlike `feature.crm.
 *    nodes`, whose helpers merge config+inputs — verified independently
 *    rather than assumed). `docs` is a chain-ENTRY node (no inbound edges),
 *    so per `buildNodeInputs`'s `ins.length === 0 → {input: runInputs}` +
 *    the executor's single-key back-compat unwrap, `ctx.inputs` for a
 *    chain-entry node is ALWAYS the run's top-level params object VERBATIM —
 *    node `config` templating (`{{params.X}}`) is resolved into `config`,
 *    never `inputs`, so it can never reach `rag()` for this node no matter
 *    how it's templated. The pre-fix chain declared only `period`, so
 *    `orgId`/`collectionId`/`query` were always `''` — `feature.kb.nodes.
 *    rag`'s `ensureKb`+`kb.rag` call would either 404 (`not_found`, no
 *    collection resolvable from an empty-string key) or, if by chance one
 *    were configured, 400 (`validation_error`, `query` required) — the `docs`
 *    node could never succeed, on any real run, for any tenant, ever. Fixed
 *    by declaring `orgId`/`collectionId`/`query` as required top-level chain
 *    parameters (NOT node `config` — that would be silently inert for this
 *    specific node/graph-position combination, the key difference from the
 *    `exec-ops`/`marketing` BUG-2 fix, which wires `config: {"orgId":
 *    "{{params.orgId}}"}` into NON-entry or config-reading nodes). Both
 *    tests below would fail (`docs` node.failed / empty citations) against
 *    the pre-fix wiring.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { getChain, expandChain } from '../src/host/workflowChainPackLoader.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { makeSuspendFn, SuspendSignal } from '../src/executor/suspendSignal.js';

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
  // `kb` has no toggleDefault (ADR 0010/0024 graduation — always-on; see
  // `features/kb/feature.ts`), so no toggle call is needed for it.
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = unknown> { status: number; body: T }
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
  const tenantId = `org:financechain-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `financechain-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: (org.body as { orgId: string }).orgId, tenantId };
}
const kbPath = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}${suffix}`;

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
  return ((b.body as { events?: BundleEvent[] }).events) ?? [];
}
function completedOutputs(events: BundleEvent[], nodeSuffix: string): Record<string, unknown> {
  const ev = events.find((e) => e.type === 'node.completed' && e.nodeId?.endsWith(`_${nodeSuffix}`));
  expect(ev, `expected a node.completed event for node "${nodeSuffix}": ${JSON.stringify(events.map((e) => ({ type: e.type, nodeId: e.nodeId })))}`).toBeTruthy();
  return (ev!.payload!.outputs as Record<string, unknown>) ?? {};
}

describe('finance.month-end-close — real executor, honest failure at checklist, BUG-2 proof', () => {
  it('seeds a real KB doc, reads it for real (org-scoped, BUG-2 fix), then fails cleanly at checklist (no AI provider configured)', async () => {
    const { owner, orgId } = await ownerOrg();

    const col = await owner.post(kbPath(orgId, '/collections'), { name: 'Close Support Docs' });
    expect(col.status, JSON.stringify(col.body)).toBe(201);
    const collectionId = (col.body as { collectionId: string }).collectionId;
    const doc = await owner.post(kbPath(orgId, `/collections/${encodeURIComponent(collectionId)}/documents`), {
      title: 'June close support doc',
      text: 'Month-end close supporting documents include the bank reconciliation, the AP subledger tie-out, and the payroll accrual review for the period.',
    });
    expect(doc.status, JSON.stringify(doc.body)).toBe(201);

    const found = getChain('finance.month-end-close');
    expect(found, 'finance.month-end-close chain must be loaded at boot').toBeTruthy();
    const params = { period: '2026-06', orgId, collectionId, query: 'month-end close supporting documents' };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);

    const create = await owner.post('/v1/runs', { workflowId: expanded.workflowId, inputs: params });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = (create.body as { runId: string }).runId;

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

    // BUG-2 fix proof: `docs` is a chain-entry node — without orgId/
    // collectionId/query declared as top-level run params it would 404 (no
    // collection resolvable) or 400 (empty query) on every real run. With the
    // fix it does a REAL org-scoped KB read and finds the REAL seeded doc.
    const docsOutputs = completedOutputs(events, 'docs');
    const citations = docsOutputs.citations as Array<{ documentId: string; title: string }>;
    expect(citations.length).toBeGreaterThan(0);
    expect(citations.some((c) => c.title === 'June close support doc')).toBe(true);
    expect(docsOutputs.augmentedPrompt).toContain('bank reconciliation');

    // checklist is where it fails — never silently skipped.
    const failedEvent = events.find((e) => e.type === 'node.failed');
    expect(failedEvent?.nodeId?.endsWith('_checklist')).toBe(true);
    // variance (the fan-in node BUG-1 fixes) never runs — a real run can
    // never reach an AI-gated fan-in node without a configured provider (same
    // limitation `workflow-chain-exec-ops-execution.test.ts`/`workflow-chain-
    // marketing-execution.test.ts` document). BUG-1's fix is proved separately
    // below via the mini-scheduler, which walks past the AI wall for real.
    expect(events.some((e) => e.nodeId?.endsWith('_variance'))).toBe(false);
    expect(events.some((e) => e.nodeId?.endsWith('_chase'))).toBe(false);
    expect(events.some((e) => e.nodeId?.endsWith('_report'))).toBe(false);
  });
});

/* ─── mini-scheduler: real node impls, real ctx.suspend, ONLY ctx.callAI faked ─── */

type NodeResult = { status: string; outputs?: Record<string, unknown>; error?: unknown };
type NodeImpl = (ctx: Record<string, unknown>) => Promise<NodeResult>;
type NodeImpls = Record<string, NodeImpl>;

let miniNodes: NodeImpls;
beforeAll(async () => {
  const aiMod = (await import('../../../packs/core.openwop.ai/index.mjs')) as { nodes: NodeImpls };
  // @ts-expect-error — untyped .mjs pack module (loaded the way the runtime does)
  const kbMod = (await import('../../../packs/feature.kb.nodes/index.mjs')) as { nodes: NodeImpls };
  // @ts-expect-error — untyped .mjs pack module (loaded the way the runtime does)
  const chatMod = (await import('../../../packs/vendor.myndhyve.chat/index.mjs')) as { nodes: NodeImpls };
  miniNodes = { ...aiMod.nodes, ...kbMod.nodes, ...chatMod.nodes };
});

interface WalkOutcome {
  results: Record<string, NodeResult>;
  /** The port-keyed inputs map BUILT for each node before invoking its impl —
   *  captured separately from `results` so a fan-in assertion doesn't depend
   *  on what a particular node impl happens to do with its inputs. */
  inputsByShortId: Record<string, Record<string, unknown>>;
}

/**
 * Walk the expanded chain definition with the SAME port semantics as the real
 * scheduler's `buildNodeInputs` (`executor/scheduler.ts`) + the SAME single-
 * key "Back-compat" unwrap as the real executor (`executor/executor.ts`,
 * `Object.keys(mergedInputsByPort).length === 1 && 'input' in
 * mergedInputsByPort`) — reproduced here, not approximated, so a fan-in node's
 * built inputs in this harness are EXACTLY what the real executor would
 * build. `ctx.callAI` is the only faked host primitive; `ctx.suspend` is the
 * REAL `executor/suspendSignal.js` mechanism (mirrors `workflow-chain-
 * marketing-execution.test.ts`'s `walkChain`).
 */
async function walkChain(
  chainId: string,
  params: Record<string, string>,
  deps: { features: Record<string, unknown>; callAI: (args: unknown) => Promise<{ content: string }> },
): Promise<WalkOutcome> {
  const chain = getChain(chainId)!.chain;
  const def = expandChain(chain, { params });
  const outputs = new Map<string, Record<string, unknown>>();
  const state = new Map<string, 'completed' | 'other'>();
  const results: Record<string, NodeResult> = {};
  const inputsByShortId: Record<string, Record<string, unknown>> = {};
  const shortId = (nodeId: string): string => nodeId.slice(nodeId.lastIndexOf('_') + 1);

  for (const node of def.nodes) {
    const inbound = (def.edges ?? []).filter((e) => e.targetNodeId === node.nodeId);
    if (inbound.length > 0 && !inbound.every((e) => state.get(e.sourceNodeId) === 'completed')) continue; // an upstream branch never completed — this node never becomes ready

    const builtInputs: Record<string, unknown> = {};
    if (inbound.length === 0) {
      builtInputs.input = params;
    } else {
      for (const e of inbound) {
        const src = outputs.get(e.sourceNodeId) ?? {};
        const sourcePort = e.sourceOutput ?? 'output';
        const targetPort = e.targetInput ?? 'input';
        builtInputs[targetPort] = Object.prototype.hasOwnProperty.call(src, sourcePort) ? src[sourcePort] : src;
      }
    }
    const shortNodeId = shortId(node.nodeId);
    inputsByShortId[shortNodeId] = builtInputs;
    const ctxInputs: unknown = Object.keys(builtInputs).length === 1 && 'input' in builtInputs ? builtInputs.input : builtInputs;

    const impl = miniNodes[node.typeId];
    expect(impl, `node impl for ${node.typeId}`).toBeTruthy();
    let result: NodeResult;
    try {
      result = await impl!({
        nodeId: node.nodeId,
        inputs: ctxInputs,
        config: node.config ?? {},
        features: deps.features,
        callAI: deps.callAI,
        suspend: makeSuspendFn(node.nodeId, undefined),
      });
    } catch (err) {
      if (err instanceof SuspendSignal) {
        result = { status: 'suspended' };
      } else {
        throw err;
      }
    }
    results[shortNodeId] = result;
    state.set(node.nodeId, result.status === 'success' ? 'completed' : 'other');
    if (result.status === 'success') outputs.set(node.nodeId, result.outputs ?? {});
  }
  return { results, inputsByShortId };
}

describe('finance.month-end-close — mini-scheduler (real KB read + real ctx.suspend, only ctx.callAI faked), BUG-1 proof + suspended-at-gate', () => {
  it('variance receives checklist/docs on TWO DISTINCT ports (not clobbered) and the walk reaches a genuine suspended-at-gate terminal state', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();

    const col = await owner.post(kbPath(orgId, '/collections'), { name: 'Variance KB' });
    expect(col.status, JSON.stringify(col.body)).toBe(201);
    const collectionId = (col.body as { collectionId: string }).collectionId;
    const doc = await owner.post(kbPath(orgId, `/collections/${encodeURIComponent(collectionId)}/documents`), {
      title: 'Payroll accrual variance note',
      text: 'The payroll accrual variance this period is driven by a late benefits invoice from the vendor.',
    });
    expect(doc.status, JSON.stringify(doc.body)).toBe(201);

    const features = buildFeatureSurfaces({ tenantId, runId: 'run:financechain-mini' });
    let aiCalls = 0;
    const callAI = async (): Promise<{ content: string }> => {
      aiCalls += 1;
      return { content: aiCalls === 1 ? 'CHECKLIST: reconcile bank, tie out AP subledger, review payroll accrual' : 'VARIANCE NOTE DRAFT' };
    };

    const params = { period: '2026-06', orgId, collectionId, query: 'payroll accrual variance' };
    const { results, inputsByShortId } = await walkChain('finance.month-end-close', params, { features, callAI });

    expect(results.checklist?.status).toBe('success');
    expect((results.checklist?.outputs?.content as string)).toContain('CHECKLIST');

    expect(results.docs?.status).toBe('success');
    const citations = results.docs?.outputs?.citations as Array<{ documentId: string; title: string }>;
    expect(citations.some((c) => c.title === 'Payroll accrual variance note')).toBe(true);

    // BUG-1 proof: variance's built inputs carry checklist/docs on TWO
    // DISTINCT ports. Pre-fix, both edges named neither `sourceOutput` nor
    // `targetInput`, so `buildNodeInputs` wrote both to the shared default
    // `'input'` key — the second edge in the array (`docs`) would have
    // silently clobbered `checklist`, and `variance` would never have seen
    // the checklist content at all.
    const varianceInputs = inputsByShortId.variance!;
    expect(Object.keys(varianceInputs).sort()).toEqual(['checklist', 'docs']);
    expect((varianceInputs.checklist as { content: string }).content).toContain('CHECKLIST');
    const varianceDocsCitations = (varianceInputs.docs as { citations: Array<{ title: string }> }).citations;
    expect(varianceDocsCitations.some((c) => c.title === 'Payroll accrual variance note')).toBe(true);

    expect(results.variance?.status).toBe('success');

    // The chain SUSPENDS at the human gate via the REAL ctx.suspend/
    // SuspendSignal mechanism — never auto-continues past it to `report`.
    expect(results.chase?.status).toBe('suspended');
    expect(results.report).toBeUndefined();
  });
});
