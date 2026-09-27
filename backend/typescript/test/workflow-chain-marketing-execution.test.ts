/**
 * marketing workflow-chain pack — REAL execution (ADR 0149, RFC 0013).
 *
 * Mirrors the `crm-ops`/`csm-ops`/`exec-ops` execution precedents
 * (`crm-chain-execution.test.ts`, `workflow-chain-csm-ops-execution.test.ts`,
 * `workflow-chain-exec-ops-execution.test.ts`) and the `cms.localize-and-
 * submit` AI-node precedent (`cms-chain-execution.test.ts`).
 *
 * MODE CHOSEN (per chain), and WHY:
 *
 * `marketing.campaign-launch` is the pick for the BUG-B (org-scoping) proof —
 * it fans a CRM read (`audience`) and a CMS read (`page`) into a human review
 * gate. Two describes cover it with two different, complementary modes:
 *
 *   1. REAL EXECUTOR (`POST /v1/runs`, polled, inspected via `GET /v1/runs/
 *      {runId}/debug-bundle`) — every `core.ai.chatCompletion` node in this
 *      pack omits `provider`/`model` (they're chain TEMPLATES; an operator
 *      wires a live provider on install/activate — same fact
 *      `cms-chain-execution.test.ts` and `workflow-chain-exec-ops-
 *      execution.test.ts` document), so a real run genuinely CANNOT complete
 *      past the first AI node. Per the `exec-ops` precedent this test asserts
 *      the HONEST FAILURE contract (`status:'failed'`, `error.code:
 *      'provider_not_supported'`) rather than forcing completion — but proves
 *      the thing that matters most: `audience` (`feature.crm.nodes.list-
 *      companies`) and `page` (`feature.cms.nodes.list-pages`) are BOTH
 *      independent, non-AI root reads that run for real before the AI nodes
 *      ever get scheduled, so their `node.completed` events in the real
 *      debug-bundle show the ACTUAL seeded CRM company + CMS page — the BUG-B
 *      fix, proved against the real executor, not a harness.
 *
 *   2. A MINI-SCHEDULER (`walkChain` below) — the SAME technique
 *      `cms-chain-execution.test.ts` uses for the same "no provider
 *      configured" problem: real node implementations
 *      (`packs/feature.crm.nodes`, `packs/feature.cms.nodes`,
 *      `packs/core.openwop.ai` (`chatCompletion`), `packs/vendor.myndhyve.
 *      chat` (`core.chat.approvalGate`, the ACTUAL typeId this pack authors
 *      against — not the unrelated built-in `core.approvalGate` in
 *      `bootstrap/nodes.ts`)), the REAL `ctx.features` surfaces over seeded
 *      data, and the REAL `ctx.suspend` primitive (`executor/suspendSignal.js`
 *      `makeSuspendFn`/`SuspendSignal` — not faked, the actual mechanism the
 *      executor itself uses to turn a suspend call into a `{status:
 *      'suspended'}` outcome). The ONLY fake is `ctx.callAI` for the two
 *      `copy`/`creative` AI nodes. This walks the FULL chain past the AI
 *      nodes — impossible for a real run — reaching `review`
 *      (`core.chat.approvalGate`) for real. This is what proves BUG-A: with
 *      the fix, `review`'s built inputs carry `copy`/`creative`/`page` on
 *      THREE DISTINCT ports (not the shared default `'input'` port the
 *      scheduler's `buildNodeInputs` would otherwise clobber down to one),
 *      and the walk reaches a genuine terminal state — SUSPENDED at the human
 *      gate, never auto-launching — exactly like `csm-ops.renewal-risk`'s
 *      real-executor suspend, just reached through the harness because an AI
 *      node sits upstream of the gate here.
 *
 * BUGS FOUND + FIXED AT THE ROOT (`examples/workflow-chain-packs/marketing/
 * pack.json`):
 *
 * 1. Multi-fan-in port collision (the SAME defect class as `csm-ops.health-
 *    from-crm` / `exec-ops.*`, see those precedents' doc comments for the
 *    full mechanism): THREE instances, all in this pack, all now fixed with
 *    explicit dot-notation target ports:
 *      - `campaign-launch`'s `review` node (3 inbound: `copy`, `creative`,
 *        `page`) → `review.copy` / `review.creative` / `review.page`.
 *      - `ad-optimization`'s `log` node (2 inbound: `autoApply`,
 *        `applyReviewed`) → `log.autoApply` / `log.applyReviewed`.
 *      - `content-repurposing`'s `review` node (3 inbound: `linkedin`,
 *        `xthread`, `newsletter`) → `review.linkedin` / `review.xthread` /
 *        `review.newsletter`.
 *    The whole pack was re-scanned for any OTHER un-flagged instance (any
 *    node with 2+ inbound edges lacking dot-notation ports): these three are
 *    exhaustive — every other multi-edge point in this pack is a FAN-OUT
 *    (one source, several distinct single-inbound targets), which
 *    `buildNodeInputs` never clobbers.
 *
 * 2. Missing `orgId` parameter (the SAME defect class as `exec-ops.daily-
 *    briefing`/`board-update`/`meeting-prep`): `campaign-launch`'s `audience`
 *    node (`feature.crm.nodes.list-companies`) and `page` node (`feature.cms.
 *    nodes.list-pages`) both had an EMPTY `config` and the chain declared no
 *    `orgId` parameter at all. Verified BOTH scoping requirements
 *    independently rather than assuming they match: `feature.crm.nodes.
 *    list-companies` calls `ctx.features.crm.listCompanies({orgId, ...})`
 *    and `feature.cms.nodes.list-pages` calls `ctx.features.cms.
 *    listPages({orgId})` — same exact-match `orgId` shape in this instance,
 *    but reached by reading each node impl (`packs/feature.crm.nodes/
 *    index.mjs`, `packs/feature.cms.nodes/index.mjs`) rather than assumed.
 *    With no way to supply an org, both reads were unconditionally empty on
 *    every real run, for every tenant, forever. Fixed by declaring `orgId` as
 *    a required chain parameter and wiring `config: {"orgId":
 *    "{{params.orgId}}"}` into both nodes (the `crm-ops`/`csm-ops`/`exec-ops`
 *    convention). Both execution tests below would fail (`companies: []` /
 *    `pages: []`) against the pre-fix wiring.
 *
 * The two defects this file previously recorded as "OUT OF SCOPE — found, NOT
 * fixed" are now BOTH fixed. Recorded here because the second one shows a
 * documented defect is easy to under-estimate:
 *
 *  3. `ad-optimization`'s `guard` (`core.flow.if`) shipped an EMPTY `config`,
 *     so `ifNode` threw on the missing predicate. ADR 0498 §Open items (#2671)
 *     added the predicate — which stopped the throw but NOT the defect: the
 *     inbound edge was portless, so it landed on `input` while `ifNode` reads
 *     `ctx.inputs.value`. The predicate evaluated `undefined` and the node took
 *     `else` on every run, leaving `autoApply` unreachable. Three other shipped
 *     chains had the identical shape. Fixed by pointing the edge at the port
 *     the node reads (`diagnose.content -> guard.value`); proven behaviorally in
 *     `chain-branch-node-execution.test.ts` and ratcheted in
 *     `chain-branch-node-reachability.test.ts`.
 *
 *  4. `content-repurposing`'s `newsletter` node (`feature.email.nodes.render`)
 *     had no `orgId`/`templateId` wiring, so the render always 404'd. This was
 *     the same config-vs-inputs defect as `feature.kb.nodes.rag` (#2692): the
 *     node reads `ctx.inputs.*`, and node-level `inputs` + `{{params.*}}`
 *     (ADR 0237) is exactly the mechanism for it — `support.kb-answer`'s
 *     `retrieve` node already did it. Fixed by declaring the two params and
 *     wiring `inputs`.
 *
 * The multi-fan-in wiring fix for both `log` and `content-repurposing`'s
 * `review` remains verified structurally below (the expanded DAG edges land on
 * distinct ports).
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
  const crm = getToggleDefault('crm');
  if (crm) await saveConfig({ ...crm, status: 'on' }, 'test');
  const cms = getToggleDefault('cms');
  if (cms) await saveConfig({ ...cms, status: 'on' }, 'test');
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
  const tenantId = `org:mktgchain-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `mktgchain-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: (org.body as { orgId: string }).orgId, tenantId };
}
const crmPath = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}${suffix}`;
const cmsPath = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${suffix}`;

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

describe('marketing.campaign-launch — real executor, honest failure at the AI node, BUG-B proof', () => {
  it('seeds a real CRM company + real CMS page, reads BOTH for real (org-scoped), then fails cleanly at copy/creative (no AI provider configured)', async () => {
    const { owner, orgId } = await ownerOrg();

    const company = await owner.post(crmPath(orgId, '/companies'), { name: 'Northwind Ads Co' });
    expect(company.status, JSON.stringify(company.body)).toBe(201);
    const companyId = (company.body as { companyId: string }).companyId;

    const page = await owner.post(cmsPath(orgId, '/pages'), { title: 'Product Launch Landing', sections: [{ type: 'hero', data: { heading: 'Launch' } }] });
    expect(page.status, JSON.stringify(page.body)).toBe(201);
    const pageId = (page.body as { pageId: string }).pageId;
    // `ctx.features.cms.listPages` only returns PUBLISHED pages (`feature.cms/
    // surface.ts`'s documented contract) — publish it so `feature.cms.nodes.
    // list-pages` can actually see it.
    const publish = await owner.post(cmsPath(orgId, `/pages/${pageId}/publish`));
    expect(publish.status, JSON.stringify(publish.body)).toBe(200);

    const found = getChain('marketing.campaign-launch');
    expect(found, 'marketing.campaign-launch chain must be loaded at boot').toBeTruthy();
    const params = { brief: 'Q3 launch for the analytics add-on', orgId };
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

    // BUG-B fix proof: the audience (CRM) + page (CMS) reads are org-scoped
    // and see the REAL seeded records, not an empty list.
    const audienceOutputs = completedOutputs(events, 'audience');
    const companies = audienceOutputs.companies as Array<{ companyId: string }>;
    expect(companies.map((c) => c.companyId)).toContain(companyId);

    const pageOutputs = completedOutputs(events, 'page');
    const pages = pageOutputs.pages as Array<{ pageId: string }>;
    expect(pages.map((p) => p.pageId)).toContain(pageId);

    // Failed at copy or creative (both AI, no provider) — never reached the
    // review gate or launch.
    const failedEvent = events.find((e) => e.type === 'node.failed');
    expect(failedEvent?.nodeId?.endsWith('_copy') || failedEvent?.nodeId?.endsWith('_creative')).toBe(true);
    expect(events.some((e) => e.nodeId?.endsWith('_review'))).toBe(false);
    expect(events.some((e) => e.nodeId?.endsWith('_launch'))).toBe(false);
  });
});

/* ─── mini-scheduler: real node impls, real ctx.suspend, ONLY ctx.callAI faked ─── */

type NodeResult = { status: string; outputs?: Record<string, unknown>; error?: unknown };
type NodeImpl = (ctx: Record<string, unknown>) => Promise<NodeResult>;
type NodeImpls = Record<string, NodeImpl>;

let miniNodes: NodeImpls;
beforeAll(async () => {
  // @ts-expect-error — untyped .mjs pack module (loaded the way the runtime does)
  const crmMod = (await import('../../../packs/feature.crm.nodes/index.mjs')) as { nodes: NodeImpls };
  // @ts-expect-error — untyped .mjs pack module (loaded the way the runtime does)
  const cmsMod = (await import('../../../packs/feature.cms.nodes/index.mjs')) as { nodes: NodeImpls };
  const aiMod = (await import('../../../packs/core.openwop.ai/index.mjs')) as { nodes: NodeImpls };
  // @ts-expect-error — untyped .mjs pack module (loaded the way the runtime does)
  const chatMod = (await import('../../../packs/vendor.myndhyve.chat/index.mjs')) as { nodes: NodeImpls };
  miniNodes = { ...crmMod.nodes, ...cmsMod.nodes, ...aiMod.nodes, ...chatMod.nodes };
});

/** Resolve `{{inputs.name}}` config tokens from the run params — the harness
 *  equivalent of the executor's per-run variable interpolation (`cms-chain-
 *  execution.test.ts`'s `resolveConfig`). */
function resolveConfig(config: Record<string, unknown> | undefined, params: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config ?? {}).map(([k, v]) => [
    k,
    typeof v === 'string' ? v.replace(/\{\{inputs\.([a-zA-Z0-9_]+)\}\}/g, (_m, name: string) => params[name] ?? '') : v,
  ]));
}

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
 * built inputs in this harness are EXACTLY what the real executor would build.
 * `ctx.callAI` is the only faked host primitive; `ctx.suspend` is the REAL
 * `executor/suspendSignal.js` mechanism.
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
    if (inbound.length > 0 && !inbound.every((e) => state.get(e.sourceNodeId) === 'completed')) continue; // an upstream branch never completed (suspended/failed) — this node never becomes ready

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
        config: resolveConfig(node.config, params),
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

describe('marketing.campaign-launch — mini-scheduler (real crm/cms reads + real ctx.suspend, only ctx.callAI faked), BUG-A proof + suspended-at-gate', () => {
  it('review receives copy/creative/page on THREE DISTINCT ports (not clobbered) and the walk reaches a genuine suspended-at-gate terminal state', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();

    const company = await owner.post(crmPath(orgId, '/companies'), { name: 'Acme Ads Co' });
    expect(company.status, JSON.stringify(company.body)).toBe(201);
    const companyId = (company.body as { companyId: string }).companyId;

    const page = await owner.post(cmsPath(orgId, '/pages'), { title: 'Launch Landing Page', sections: [{ type: 'hero', data: { heading: 'Go' } }] });
    expect(page.status, JSON.stringify(page.body)).toBe(201);
    const pageId = (page.body as { pageId: string }).pageId;
    // `ctx.features.cms.listPages` only returns PUBLISHED pages — publish it
    // so `feature.cms.nodes.list-pages` can actually see it.
    const publish = await owner.post(cmsPath(orgId, `/pages/${pageId}/publish`));
    expect(publish.status, JSON.stringify(publish.body)).toBe(200);

    const features = buildFeatureSurfaces({ tenantId, runId: 'run:mktgchain-mini' });
    let aiCalls = 0;
    const callAI = async (): Promise<{ content: string }> => {
      aiCalls += 1;
      return { content: aiCalls === 1 ? 'COPY VARIANT A' : 'CREATIVE VARIANT B' };
    };

    const params = { brief: 'Q3 launch for the analytics add-on', orgId };
    const { results, inputsByShortId } = await walkChain('marketing.campaign-launch', params, { features, callAI });

    expect(results.audience?.status).toBe('success');
    const companies = results.audience?.outputs?.companies as Array<{ companyId: string }>;
    expect(companies.map((c) => c.companyId)).toContain(companyId);

    expect(results.page?.status).toBe('success');
    const pages = results.page?.outputs?.pages as Array<{ pageId: string }>;
    expect(pages.map((p) => p.pageId)).toContain(pageId);

    expect(results.copy?.status).toBe('success');
    expect(results.creative?.status).toBe('success');

    // BUG-A proof: review's built inputs carry copy/creative/page on THREE
    // DISTINCT ports. Pre-fix, all three edges named neither `sourceOutput`
    // nor `targetInput`, so `buildNodeInputs` wrote every one to the shared
    // default `'input'` key — the LAST edge in the array (`page`) would have
    // silently clobbered `copy`/`creative`, and `review` would never have
    // seen the ad copy or creative variants at all.
    const reviewInputs = inputsByShortId.review!;
    expect(Object.keys(reviewInputs).sort()).toEqual(['copy', 'creative', 'page']);
    expect((reviewInputs.copy as { content: string }).content).toBe('COPY VARIANT A');
    expect((reviewInputs.creative as { content: string }).content).toBe('CREATIVE VARIANT B');
    const reviewPages = (reviewInputs.page as { pages: Array<{ pageId: string }> }).pages;
    expect(reviewPages.map((p) => p.pageId)).toContain(pageId);

    // The chain SUSPENDS at the human gate via the REAL ctx.suspend/
    // SuspendSignal mechanism — never auto-launches past it.
    expect(results.review?.status).toBe('suspended');
    expect(results.launch).toBeUndefined();
  });
});

describe('marketing.ad-optimization / marketing.content-repurposing — pack.json wiring: multi-fan-in fix (structural)', () => {
  it('ad-optimization.log has two inbound edges landing on DISTINCT ports, not the shared default "input" key', () => {
    const found = getChain('marketing.ad-optimization');
    expect(found, 'marketing.ad-optimization chain must be loaded at boot').toBeTruthy();
    const def = expandChain(found!.chain, { params: {} });
    const logNode = def.nodes.find((n) => n.nodeId.endsWith('_log'));
    expect(logNode, 'expected a "log" node in the expanded definition').toBeTruthy();
    const inbound = (def.edges ?? []).filter((e) => e.targetNodeId === logNode!.nodeId);
    expect(inbound.length, 'log should have two inbound edges (autoApply, applyReviewed)').toBe(2);
    const ports = inbound.map((e) => e.targetInput);
    expect(ports.every((p): p is string => typeof p === 'string' && p.length > 0), `expected named ports, got ${JSON.stringify(ports)}`).toBe(true);
    expect(new Set(ports).size, 'pre-fix both edges landed on the shared default "input" port and clobbered each other').toBe(2);
  });

  it('content-repurposing.review has three inbound edges landing on DISTINCT ports, not the shared default "input" key', () => {
    const found = getChain('marketing.content-repurposing');
    expect(found, 'marketing.content-repurposing chain must be loaded at boot').toBeTruthy();
    const def = expandChain(found!.chain, { params: {} });
    const reviewNode = def.nodes.find((n) => n.nodeId.endsWith('_review'));
    expect(reviewNode, 'expected a "review" node in the expanded definition').toBeTruthy();
    const inbound = (def.edges ?? []).filter((e) => e.targetNodeId === reviewNode!.nodeId);
    expect(inbound.length, 'review should have three inbound edges (linkedin, xthread, newsletter)').toBe(3);
    const ports = inbound.map((e) => e.targetInput);
    expect(ports.every((p): p is string => typeof p === 'string' && p.length > 0), `expected named ports, got ${JSON.stringify(ports)}`).toBe(true);
    expect(new Set(ports).size, 'pre-fix all three edges landed on the shared default "input" port and clobbered each other').toBe(3);
  });
});
