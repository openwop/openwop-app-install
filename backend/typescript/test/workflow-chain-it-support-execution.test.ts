/**
 * it-support workflow-chain pack — REAL execution (ADR 0149/0208, RFC 0013).
 *
 * Structural coverage already exists (`workflow-chain-it-support.test.ts`:
 * expand + KNOWN_TYPEIDS, owned by another session — not touched here). This
 * adds REAL-execution coverage for the pack's one chain, `it-support.
 * incident-triage`.
 *
 * MODE CHOSEN: `classify` (`core.ai.structuredOutput`) is the chain's FIRST
 * node and has no `provider`/`model` configured — driving it through the REAL
 * executor would fail with `provider_not_supported` at node 1, before the
 * router/kb/connector wiring this chain exists to exercise ever runs (the same
 * "entry-node AI gate" shape `inbox.*` hits — see that file's doc comment).
 * So, mirroring `cms-chain-execution.test.ts`'s mini-scheduler precedent, this
 * drives `classify` and `route` (ONLY — the two nodes needed to prove real
 * branch-selection) directly through their REAL node implementations
 * (`packs/core.openwop.ai/index.mjs`'s `structuredOutput`, `packs/
 * core.openwop.flow/index.mjs`'s `routerNode`) with `ctx.callAI` faked (the
 * chain's designed provider-injection seam — an operator wires a live
 * provider at install/activate time) and `sourceOutput`/`targetInput` port
 * semantics replicated by hand, exactly as the chain's own edges declare
 * (`classify.data` → `route.value`). This proves ADR 0201 real conditional
 * routing end to end: a "major" alert routes to the human-approval branch, a
 * "routine" alert routes to the KB/ticket branch — genuinely driven by the
 * router's `core.flow.router` predicate evaluation, not asserted structurally.
 *
 * For the MAJOR branch this test stops at the `route` output (does not invoke
 * `core.chat.approvalGate` — the house convention, pinned by `csm-ops.
 * renewal-risk`'s execution test, is to prove a chain SUSPENDS at a human gate
 * rather than force it through; `approvalGate`'s real implementation requires
 * `ctx.suspend`, which only the real executor's suspend/resume machinery
 * provides — out of reach for a hand-rolled mini-scheduler, and unnecessary
 * here since `route`'s own output already proves the major branch was
 * selected).
 *
 * For the ROUTINE branch this test drives one step further, into the REAL
 * `feature.kb.nodes.rag` node (over a REAL, booted `ctx.features.kb` surface)
 * — and pins a genuine, found-but-NOT-fixed bug (below) that makes it always
 * throw on every real run of this chain, today.
 *
 * BUG FIXED AT THE ROOT (`examples/workflow-chain-packs/it-support/
 * pack.json`): `summary`'s two inbound edges (`ticket`, `stakeholders`) named
 * neither `sourceOutput` nor `targetInput` — the same multi-fan-in port-
 * collision class documented in `workflow-chain-csm-ops-execution.test.ts` /
 * `workflow-chain-exec-ops-execution.test.ts` / `workflow-chain-data-ops-
 * execution.test.ts`. VERIFIED: unlike those chains, `ticket` and
 * `stakeholders` sit on MUTUALLY EXCLUSIVE branches of the same router (only
 * one of `kbArticle`→`ticket` or `majorApprove`→`stakeholders` ever
 * completes in a given run — the scheduler's `evaluateTrigger`/`evaluateCondition`
 * mark a false-conditioned branch's nodes `skipped`, not `completed`, and
 * `buildNodeInputs` only contributes a `completed` source's edge — ADR 0208),
 * so this specific instance does NOT actually collide in single-branch
 * execution today. Fixed anyway (`{"from":"ticket","to":"summary.ticket"}`,
 * `{"from":"stakeholders","to":"summary.stakeholders"}`) per the task brief's
 * instruction to re-verify and fix every known instance defensively — a future
 * change to the router's fan-in semantics (e.g. a non-exclusive multi-label
 * `mode`) would otherwise silently reintroduce the clobber.
 *
 * FIXED (was: "BUG FOUND, NOT FIXED"). `kbArticle` (`feature.kb.nodes.rag`)
 * reads `orgId`/`collectionId`/`query` from `ctx.inputs`, never `ctx.config` —
 * and the chain wired the query through `config`, so every real invocation hit
 * `mustGetCollection(tenantId, '', '')` and threw `not_found`. The KB step could
 * not complete as shipped.
 *
 * The old rationale for leaving it — that closing the gap "needs either a new
 * shipped reshape-ports node or a change to `classify`'s output schema, both
 * beyond a wiring-only pack.json fix" — was WRONG, and stale in two ways.
 * Node-level `inputs` with `{{params.*}}` is exactly that mechanism, three
 * in-tree chains already used it (`knowledge.policy-qa`,
 * `knowledge.compliance-review`, `finance.month-end-close`), and ADR 0237 merges
 * declared inputs OVER edge-derived ones, so `kbArticle`'s inbound edge — the
 * stated blocker — does not block it. The fix was: two required params
 * (`orgId`, `collectionId`, mirroring `policy-qa`) plus the `inputs` block.
 *
 * The pin also cost coverage: three more chains shipped the identical defect
 * with NO test at all (`lighthouse.rfp-response`, `marketing.content-brief`,
 * `support.kb-answer`), because a documented failure reads like a handled one.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { createCollection, ingestDocument } from '../src/features/kb/kbService.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { getChain, expandChain } from '../src/host/workflowChainPackLoader.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

type WorkflowNodeDefinition = WorkflowDefinition['nodes'][number];


let BASE: string;
let server: http.Server;
type PackNode = (ctx: Record<string, unknown>) => Promise<{ status: string; outputs: Record<string, unknown>; error?: unknown }>;
let structuredOutputNode: PackNode;
let routerNode: PackNode;
let ragNode: PackNode;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
  const kb = getToggleDefault('kb');
  if (kb) await saveConfig({ ...kb, status: 'on' }, 'test');

  structuredOutputNode = ((await import('../../../packs/core.openwop.ai/index.mjs')) as { structuredOutput: typeof structuredOutputNode }).structuredOutput;
  routerNode = ((await import('../../../packs/core.openwop.flow/index.mjs')) as { routerNode: typeof routerNode }).routerNode;
  // @ts-expect-error — feature.kb.nodes ships no declaration file (untyped .mjs)
  ragNode = ((await import('../../../packs/feature.kb.nodes/index.mjs')) as { rag: typeof ragNode }).rag;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client(): { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

let n = 0;
async function ownerOrg(): Promise<{ owner: ReturnType<typeof client>; tenantId: string }> {
  const tenantId = `org:itschain-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `itschain-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { owner, tenantId };
}

function nodeBySuffix(nodes: readonly WorkflowNodeDefinition[], suffix: string): WorkflowNodeDefinition {
  const found = nodes.find((n2) => n2.nodeId.endsWith(`_${suffix}`));
  expect(found, `expected a node ending in _${suffix}`).toBeTruthy();
  return found!;
}

describe('it-support.incident-triage — real conditional routing (ADR 0201)', () => {
  it('a major-severity alert routes to the human-approval branch, NOT the routine KB/ticket branch', async () => {
    const found = getChain('it-support.incident-triage');
    expect(found, 'it-support.incident-triage chain must be loaded at boot').toBeTruthy();
    const params = { alert: 'prod database is down for every customer', ticketingBaseUrl: '', ticketProject: 'OPS' };
    const def = expandChain(found!.chain, { params });

    const classifyNode = nodeBySuffix(def.nodes, 'classify');
    const routeNode = nodeBySuffix(def.nodes, 'route');

    const classified = await structuredOutputNode({
      inputs: {},
      config: classifyNode.config,
      callAI: async () => ({ data: { severity: 'major' } }),
    });
    expect(classified.status).toBe('success');
    expect((classified.outputs.data as { severity: string }).severity).toBe('major');

    // Replicates the chain's own `classify.data` → `route.value` edge port
    // semantics (sourceOutput='data', targetInput='value').
    const routed = await routerNode({ inputs: { value: classified.outputs.data }, config: routeNode.config });
    expect(routed.status).toBe('success');
    expect(routed.outputs.branches).toEqual(['major']);
    // The router genuinely evaluated the predicate — it did NOT fall through
    // to the routine branch, and it did not select both.
    expect(routed.outputs.branches).not.toContain('routine');
  });

  it('a routine-severity alert routes to the KB/ticket branch, NOT the human-approval branch — and the KB step RESOLVES', async () => {
    const { tenantId } = await ownerOrg();

    // §Correction — this test used to assert `not_found` and call that "the
    // honest, reproducible current behavior". It was pinning a defect: the
    // chain's KB step could not complete as shipped, and the pin is why nobody
    // swept for siblings (three more chains had the identical wiring and NO
    // test at all). The fix is a pack.json wiring change after all — see below.
    const ORG = 'org-it-support';
    const col = await createCollection(tenantId, ORG, 'u1', { name: 'Runbooks' });
    await ingestDocument(tenantId, ORG, 'u1', col.collectionId, {
      title: 'VPN client troubleshooting',
      text: 'If the VPN client will not connect, reset the adapter and re-enrol the certificate.',
    });

    const found = getChain('it-support.incident-triage');
    const params = {
      alert: "one user's VPN client won't connect",
      ticketingBaseUrl: '', ticketProject: 'OPS',
      orgId: ORG, collectionId: col.collectionId,
    };
    const def = expandChain(found!.chain, { params });

    const classifyNode = nodeBySuffix(def.nodes, 'classify');
    const routeNode = nodeBySuffix(def.nodes, 'route');
    const kbArticleNode = nodeBySuffix(def.nodes, 'kbArticle');

    const classified = await structuredOutputNode({
      inputs: {},
      config: classifyNode.config,
      callAI: async () => ({ data: { severity: 'routine' } }),
    });
    const routed = await routerNode({ inputs: { value: classified.outputs.data }, config: routeNode.config });
    expect(routed.status).toBe('success');
    expect(routed.outputs.branches).toEqual(['routine']);
    expect(routed.outputs.branches).not.toContain('major');

    // The expanded node carries the params on its `inputs` — the mechanism the
    // old docblock claimed did not exist ("needs a new shipped reshape-ports
    // node"). It does: ADR 0237 resolves node-level `inputs` and merges them
    // OVER the edge-derived ones (`executor.ts` — "fixture wins on conflict"),
    // which is why an inbound edge does not block this.
    const declared = (kbArticleNode.inputs ?? {}) as Record<string, unknown>;
    expect(declared.orgId, 'the chain must bind orgId onto ctx.inputs').toBe(ORG);
    expect(declared.collectionId).toBe(col.collectionId);
    expect(declared.query).toBe(params.alert);

    // Reproduce the executor's merge exactly: edge-derived inputs first, the
    // node's declared inputs on top. `kbArticle` is the ONLY fixed chain with an
    // inbound edge, so this is the case that proves the semantics rather than
    // assuming them.
    const merged = { ...(routed.outputs as Record<string, unknown>), ...declared };
    const features = buildFeatureSurfaces({ tenantId, runId: 'run:it-support-probe' });
    const out = await ragNode({ inputs: merged, config: kbArticleNode.config, features });

    expect(out.status, 'the KB step must complete — it threw not_found as shipped').toBe('success');
    expect(typeof out.outputs.augmentedPrompt).toBe('string');
    expect(out.outputs.augmentedPrompt, 'the seeded runbook should ground the answer').toContain('VPN');
  });
});
