/**
 * CC-CHAIN-1 (ADR 1111 P2) — `marketing.campaign-launch` launches through the
 * governed ad step, and a run with no ad account completes with the document
 * handoff instead of failing at `launch`.
 *
 * Observed on app.openwop.dev (build 373d4863a, 2026-11-11, Campaign Studio
 * acceptance): the operator approved the consolidated review and the run failed at
 * `launch`, a `core.openwop.http.openapi-call` with `connectionRef: google-ads` and
 * no wired OpenAPI document. It threw `CONFIG_INVALID: openapi doc missing paths`
 * every time, connected or not, and the approved copy was lost with the run.
 *
 * Owner decisions (user, 2026-11-14): Q1 — launch via the EXISTING governed
 * `feature.campaign-channels.nodes.publish-ad-variants` (PAUSED create through
 * `ctx.ads.publishAd`; no account or connection ⇒ the ADR 0166 document handoff;
 * spend threshold ⇒ approval). Q2 — no connection ⇒ the run completes via that
 * handoff. The chain's `copy` step is now a structured-output step that emits the
 * node's `ad_variants` draft shape, the draft is what the reviewer approves (it is
 * the gate's `artifact`), and `launch` takes it FROM THE GATE on the one
 * `truthy approved` edge — no mapping node.
 *
 * How it runs: the expanded chain is walked through the REAL scheduler pieces
 * (`evaluateTrigger` for control flow, `buildNodeInputs` + `buildNodeCtxInputs` +
 * `resolveDeclaredInputs` for inputs, `interpolateRunInputs` for config), with the
 * REAL node implementations from `packs/` and the REAL feature surfaces of a booted
 * app (CRM, CMS, documents). Only two seams stand in: `ctx.callAI` (no provider in
 * a test) and the gate's `ctx.suspend`, which returns the reviewer's decision.
 * A real-executor run cannot get past the AI nodes without a provider key — see
 * `workflow-chain-marketing-execution.test.ts`.
 *
 * Red on main: `launch` is `core.openwop.http.openapi-call`; the structural case
 * fails on the typeId, and the walk fails because `copy` returns free text that
 * never becomes an `ad_variants` draft (and openapi-call has no document).
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { getChain, expandChain } from '../src/host/workflowChainPackLoader.js';
import { buildGraph, buildNodeInputs, evaluateTrigger, freshSnapshot } from '../src/executor/scheduler.js';
import { buildNodeCtxInputs, resolveDeclaredInputs } from '../src/executor/nodeCtxInputs.js';
import { interpolateRunInputs } from '../src/executor/runInputInterpolation.js';
import { getDocument, listVersions } from '../src/features/documents/documentsService.js';

type NodeResult = { status: string; outputs?: Record<string, unknown>; error?: { code?: string; message?: string } };
type NodeImpl = (ctx: Record<string, unknown>) => Promise<NodeResult>;

// Typed dynamic imports (the accessibility-nodes pattern): the packs ship no declaration files.
async function packNodes(pack: string): Promise<Record<string, NodeImpl>> {
  const url = new URL(`../../../packs/${pack}/index.mjs`, import.meta.url);
  return ((await import(path.resolve(fileURLToPath(url)))) as { nodes: Record<string, NodeImpl> }).nodes;
}

const CHAIN = 'marketing.campaign-launch';
const LAUNCH_TYPE = 'feature.campaign-channels.nodes.publish-ad-variants';
const APPROVE = { action: 'approve', decidedBy: 'user:reviewer' };
const REJECT = { action: 'reject', decidedBy: 'user:reviewer', comment: 'Not this one.' };
const AD_DRAFT = {
  platformSets: [{
    platform: 'Google',
    variants: [{ headline: 'Analytics, added', description: 'See every funnel step in one place.', cta: 'Start free' }],
  }],
};

let BASE = '';
let server: http.Server;
let impls: Record<string, NodeImpl> = {};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'crm', 'cms', 'documents', 'campaign-channels']) {
    const def = getToggleDefault(id);
    if (def) await saveConfig({ ...def, status: 'on' }, 'test');
  }
  impls = {
    ...(await packNodes('feature.crm.nodes')),
    ...(await packNodes('feature.cms.nodes')),
    ...(await packNodes('core.openwop.ai')),
    ...(await packNodes('vendor.myndhyve.chat')),
    ...(await packNodes('feature.campaign-channels.nodes')),
    // The rejected branch ends at core.flow.noop.
    ...(await packNodes('core.openwop.flow')),
  };
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

let n = 0;
async function ownerOrg(): Promise<{ orgId: string; tenantId: string }> {
  const tenantId = `org:ccchain1-${Date.now()}-${n++}`;
  let cookie = '';
  const post = async (p: string, body: unknown): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${BASE}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  const login = await post('/host/openwop-app/test/login', { email: `ccchain1-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { orgId: (org.body as { orgId: string }).orgId, tenantId };
}

/** The ONE faked host primitive besides the reviewer: a schema'd call (the
 *  structured `copy` step) answers with the ad_variants draft, a free-form call
 *  (`creative`) with text. */
const callAI = async (args: unknown): Promise<{ content?: string; data?: unknown }> =>
  typeof args === 'object' && args !== null && 'responseSchema' in args && args.responseSchema !== undefined
    ? { data: AD_DRAFT }
    : { content: 'A split-screen of before and after dashboards.' };

interface Walk {
  states: Record<string, string>;
  results: Record<string, NodeResult>;
  inputs: Record<string, unknown>;
}

/**
 * Walk the expanded chain to quiescence. Control flow is the real
 * `evaluateTrigger` (a false-conditioned edge skips its target); a node's ctx
 * inputs are built exactly as `executor.ts` builds them.
 */
async function walk(
  params: Record<string, string>,
  opts: { features: Record<string, unknown>; resume: Record<string, unknown>; ads: Record<string, unknown>; runId: string },
): Promise<Walk> {
  const def = expandChain(getChain(CHAIN)!.chain, { params });
  const graph = buildGraph(def);
  const snap = freshSnapshot(def);
  const runInputs = { brief: params.brief };
  const bare = (id: string): string => id.slice(id.lastIndexOf('_') + 1);
  const results: Record<string, NodeResult> = {};
  const inputs: Record<string, unknown> = {};
  const vars = new Map<string, unknown>();

  for (let pass = 0; pass <= def.nodes.length + 2; pass += 1) {
    let moved = false;
    for (const node of def.nodes) {
      const state = snap.nodeState.get(node.nodeId);
      if (state !== 'pending' && state !== 'ready') continue;
      const verdict = evaluateTrigger(node.nodeId, graph, snap);
      if (verdict === 'skip') { snap.nodeState.set(node.nodeId, 'skipped'); moved = true; continue; }
      if (verdict !== 'ready') continue;
      const impl = impls[node.typeId];
      expect(impl, `no node implementation for ${node.typeId}`).toBeTypeOf('function');
      const ctxInputs = buildNodeCtxInputs(
        buildNodeInputs(node.nodeId, graph, snap, runInputs),
        resolveDeclaredInputs(node.inputs, {}),
      );
      inputs[bare(node.nodeId)] = ctxInputs;
      const result = await impl!({
        runId: opts.runId,
        nodeId: node.nodeId,
        inputs: ctxInputs,
        config: interpolateRunInputs((node.config ?? {}) as Record<string, unknown>, runInputs),
        features: opts.features,
        ads: opts.ads,
        callAI,
        variables: { get: (k: string) => vars.get(k), set: (k: string, v: unknown) => { vars.set(k, v); } },
        chat: { emitCard: async () => undefined },
        suspend: async () => opts.resume,
      });
      results[bare(node.nodeId)] = result;
      if (result.status === 'success') {
        snap.nodeState.set(node.nodeId, 'completed');
        snap.nodeOutputs.set(node.nodeId, result.outputs ?? {});
      } else {
        snap.nodeState.set(node.nodeId, 'failed');
      }
      moved = true;
    }
    if (!moved) break;
  }
  return { states: Object.fromEntries(def.nodes.map((nd) => [bare(nd.nodeId), String(snap.nodeState.get(nd.nodeId))])), results, inputs };
}

/** An ads seam that records every call. With no ad account the step must never
 *  reach it; with one, it answers the adapter's documented `no_connection`. */
function recordingAds(): { ads: Record<string, unknown>; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return { calls, ads: { publishAd: async (args: Record<string, unknown>) => { calls.push(args); return { outcome: 'no_connection' }; } } };
}

const record = (v: unknown, what: string): Record<string, unknown> => {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  throw new Error(`${what} is not an object: ${JSON.stringify(v)}`);
};

describe('CC-CHAIN-1 — marketing.campaign-launch wiring (structural)', () => {
  it('launch is the governed ad step, fed only from the gate on a truthy-approved edge, with no openapi-call left', () => {
    const def = expandChain(getChain(CHAIN)!.chain, { params: { brief: 'b', orgId: 'o' } });
    expect(def.nodes.some((nd) => nd.typeId === 'core.openwop.http.openapi-call')).toBe(false);
    const launch = def.nodes.find((nd) => nd.nodeId.endsWith('_launch'));
    expect(launch?.typeId).toBe(LAUNCH_TYPE);
    const review = def.nodes.find((nd) => nd.nodeId.endsWith('_review'))!;
    const inbound = (def.edges ?? []).filter((e) => e.targetNodeId === launch!.nodeId);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.sourceNodeId).toBe(review.nodeId);
    expect(inbound[0]!.sourceOutput).toBe('artifact');
    expect(inbound[0]!.targetInput).toBe('draft');
    // Conditioned (approve-only); the reject leg is proven behaviourally below.
    expect(inbound[0]!.condition).toBeTruthy();
  });
});

describe('CC-CHAIN-1 — an unlinked run reaches launch and completes with the document handoff', () => {
  it('approve with no ad account: launch hands the approved copy off as a draft document and never calls the ads seam', async () => {
    const { orgId, tenantId } = await ownerOrg();
    const runId = 'run:ccchain1-unlinked';
    const features = buildFeatureSurfaces({ tenantId, runId });
    const { ads, calls } = recordingAds();

    const w = await walk({ brief: 'Q3 launch for the analytics add-on', orgId }, { features, resume: APPROVE, ads, runId });

    // The reviewer saw the exact draft that is launched.
    expect(record(w.inputs.review, 'review inputs').artifact).toEqual(AD_DRAFT);
    expect(w.results.review?.outputs?.approved).toBe(true);

    expect(w.states.launch, JSON.stringify(w.results.launch)).toBe('completed');
    expect(w.states['gate-reject']).toBe('skipped');
    // Nothing failed anywhere: the run completes.
    expect(Object.entries(w.states).filter(([, s]) => s !== 'completed' && s !== 'skipped')).toEqual([]);
    expect(calls, 'no ad account: the governed step must not attempt a dispatch').toEqual([]);

    const doc = record(w.results.launch?.outputs?.document, 'launch document');
    const stored = await getDocument(tenantId, orgId, String(doc.documentId));
    expect(stored?.kind).toBe('campaign-ad-copy');
    expect(stored?.status).toBe('draft');
    const versions = await listVersions(tenantId, orgId, String(doc.documentId));
    expect(versions).toHaveLength(1);
    expect(String(versions[0]!.content)).toContain('| Analytics, added | See every funnel step in one place. | Start free |');
  });

  it('approve with an ad account but no connection: the chain params reach the ads seam, and its no_connection falls back to the handoff', async () => {
    const { orgId, tenantId } = await ownerOrg();
    const runId = 'run:ccchain1-noconn';
    const features = buildFeatureSurfaces({ tenantId, runId });
    const { ads, calls } = recordingAds();

    const w = await walk(
      { brief: 'Q3 launch', orgId, adAccountId: '1234567890', platform: 'google', briefId: 'brief-q3' },
      { features, resume: APPROVE, ads, runId },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ platform: 'google', adAccountId: '1234567890', briefId: 'brief-q3', copy: { headline: 'Analytics, added' } });
    expect(w.states.launch, JSON.stringify(w.results.launch)).toBe('completed');
    const doc = record(w.results.launch?.outputs?.document, 'launch document');
    expect((await getDocument(tenantId, orgId, String(doc.documentId)))?.kind).toBe('campaign-ad-copy');
  });

  it('reject: launch is skipped and the run still completes through the rejected branch', async () => {
    const { orgId, tenantId } = await ownerOrg();
    const runId = 'run:ccchain1-reject';
    const features = buildFeatureSurfaces({ tenantId, runId });
    const { ads, calls } = recordingAds();

    const w = await walk({ brief: 'Q3 launch', orgId }, { features, resume: REJECT, ads, runId });

    expect(w.states.launch).toBe('skipped');
    expect(w.states['gate-reject']).toBe('completed');
    expect(calls).toEqual([]);
  });
});
