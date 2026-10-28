/**
 * research workflow-chain pack — REAL execution (RFC 0013, ADR 0190 Phase 5).
 *
 * CHAIN CHOSEN: `research.web-brief` (the pack's only chain). DAG:
 * `search` (core.web.search) → `synthesize` (core.ai.chatCompletion) →
 * `notify` (feature.notifications.nodes.notify).
 *
 * MODE CHOSEN: honest-failure via the REAL executor. The chain freezes a real
 * provider into `synthesize` at expansion (ADR 0903 P3) and the test tenant has
 * no BYOK credential, so the run runs `search` for REAL against the host's
 * `ctx.webResearch` surface — with every search / AI key cleared around the case,
 * that is the `engine: 'demo'` placeholder (`webResearchSurface.ts`), never a live
 * provider — and then fails cleanly at `synthesize` with
 * `error.code === 'openwop-app.byok_required'`, never reaching `notify`.
 *
 * §CORRECTION (/grade-tests 8f W5): `core.web.search` now executes the HOST node
 * (`src/bootstrap/nodes.ts` `webSearchNode`), not `packs/core.openwop.web-search`
 * as the history below says, and that node falls back to the first string input
 * (`findFirstStringValue`) when `query` is absent. So the `question`→`query`
 * rename this file witnessed is now DOUBLE-GUARDED: reverting it no longer fails
 * a run (8fw5g6-rs-query, sabotaging the pack, was vacuous). What this case can
 * still prove is that the host node threads the run's query through the search
 * surface (8fw5g6-rs-query-r2) and that its results reach the node outputs
 * (8fw5g6-rs-results).
 *
 * BUG FOUND + FIXED AT THE ROOT (`examples/workflow-chain-packs/research/
 * pack.json`):
 *
 * `search` (`core.web.search`, `packs/core.openwop.web-search/index.mjs`)
 * reads its query EXCLUSIVELY from `ctx.inputs.query` — it never merges
 * `ctx.config` (`function search(ctx) { const inputs = ctx.inputs ?? {};
 * const query = inputs.query; if (typeof query !== 'string' || ... ) throw
 * ...INVALID_INPUT` — no `ctx.config` fallback). `search` is the chain's
 * FIRST node (no incoming edge), so the real executor's scheduler
 * (`buildNodeInputs`, `executor/scheduler.ts`) gives it `ctx.inputs` = the
 * run's raw top-level `inputs` payload directly (the "Back-compat" single-
 * key unwrap in `executor/executor.ts`, which fires for any SOURCE node,
 * not just ones fed by a single edge). The chain's declared parameter was
 * named `question` (`parameters.properties.question`) — so every real run's
 * `inputs` bag was keyed `{question: "..."}`, and `ctx.inputs.query` was
 * ALWAYS `undefined`. `search` therefore threw `INVALID_INPUT` on the
 * very FIRST node of EVERY real run, unconditionally — the chain could
 * never execute a single node successfully, regardless of AI-provider
 * configuration. (The node's own static `inputs: {"query":
 * "{{params.question}}"}` field does not help either — `validateWorkflow-
 * Definition` strips an authored node's static `inputs` field entirely at
 * `expandChain` time; only `config` values survive to be interpolated by
 * `interpolateRunInputs` at run time — the SAME lesson the CMS/CRM-chain
 * precedents already document as "static node `inputs` are stripped.")
 *
 * Empirically verified pre/post-fix with a throwaway probe (`POST /v1/runs`
 * + inspect the debug-bundle): pre-fix, `search`'s `node.failed` event
 * carried `error.code: 'INVALID_INPUT'` on every run; post-fix, `search`
 * completes with real `{results, engine, query}` and the chain reaches the
 * SAME honest missing-credential failure every other template chain in this
 * session reaches.
 *
 * FIX: renamed the chain's declared parameter from `question` to `query`
 * (keeping the same user-facing description, "The question to research")
 * so the run's top-level `inputs` bag is keyed `query` — the ONLY key
 * `search` ever reads for a source node. Also added `query` to `search`'s
 * `config` (a harmless, unread-but-consistent duplicate matching the
 * config-carries-templated-values convention every other node in this
 * session's chains follows) and updated the `synthesize` node's
 * `systemPrompt` reference from `{{params.question}}` to `{{params.query}}`.
 * No structural test exists for this pack (`grep -rl research.web-brief
 * backend/typescript/test` was empty pre-fix), so the rename is safe.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

/** Search / AI keys the host could read: cleared per case, restored after (rule: no live provider). */
const PROVIDER_KEYS = ['OPENWOP_WEBSEARCH_API_KEY', 'OPENWOP_WEBSEARCH_ENGINE', 'OPENWOP_WEBSEARCH_BASE_URL', 'BRAVE_API_KEY', 'TAVILY_API_KEY', 'SERPAPI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENWOP_MOCK_PROVIDER_ENABLED'] as const;
const savedKeys = new Map<string, string | undefined>();
beforeEach(() => { for (const k of PROVIDER_KEYS) { savedKeys.set(k, process.env[k]); delete process.env[k]; } });
afterEach(() => { for (const k of PROVIDER_KEYS) { const v = savedKeys.get(k); if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

interface Res<T> { status: number; body: T }
interface Client { get: <T>(p: string) => Promise<Res<T>>; post: <T>(p: string, b?: unknown) => Promise<Res<T>> }
function client(): Client {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const sc = getSetCookies(res.headers);
    for (const c of sc as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: (await res.json()) as T };
  };
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b) };
}

let n = 0;
async function ownerLogin(): Promise<{ owner: Client; tenantId: string }> {
  const tenantId = `org:researchchain-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post<unknown>('/host/openwop-app/test/login', { email: `researchchain-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { owner, tenantId };
}

interface RunSnapshot { status: string; error?: { code: string; message: string } }
const POLLS = 80;
/** Poll until the run settles; THROWS (naming the run and the poll count) if it never does. */
async function pollRun(owner: Client, runId: string): Promise<RunSnapshot> {
  let snap: RunSnapshot = { status: 'pending' };
  for (let i = 0; i < POLLS; i++) {
    const r = await owner.get<RunSnapshot>(`/runs/${runId}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    snap = r.body;
    if (snap.status === 'completed' || snap.status === 'failed' || snap.status === 'cancelled' || snap.status.startsWith('waiting')) return snap;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`run ${runId} did not settle after ${POLLS} polls (last status: ${snap.status})`);
}

interface BundleEvent { type?: string; nodeId?: string; payload?: Record<string, unknown> }
async function bundleEvents(owner: Client, runId: string): Promise<BundleEvent[]> {
  const b = await owner.get<{ events?: BundleEvent[] }>(`/runs/${runId}/debug-bundle`);
  expect(b.status, JSON.stringify(b.body)).toBe(200);
  return b.body.events ?? [];
}
function completedOutputs(events: BundleEvent[], nodeSuffix: string): Record<string, unknown> {
  const ev = events.find((e) => e.type === 'node.completed' && e.nodeId?.endsWith(`_${nodeSuffix}`));
  expect(ev, `expected a node.completed event for node "${nodeSuffix}": ${JSON.stringify(events.map((e) => ({ type: e.type, nodeId: e.nodeId })))}`).toBeTruthy();
  return (ev!.payload!.outputs as Record<string, unknown>) ?? {};
}

describe('research.web-brief — real reads, honest missing-credential failure', () => {
  it('runs the search node for real (the query fix) and fails cleanly at synthesize (no BYOK credential)', async () => {
    const { owner } = await ownerLogin();

    const found = getChain('research.web-brief');
    expect(found, 'research.web-brief chain must be loaded at boot').toBeTruthy();
    const params = { query: 'What is OpenWOP?' };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);

    const create = await owner.post<{ runId: string }>('/runs', { workflowId: expanded.workflowId, inputs: params });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId;

    const snap = await pollRun(owner, runId);
    expect(snap.status).toBe('failed');
      // §Correction (P3): this asserted `provider_not_supported`, which PINNED THE
      // BUG AS EXPECTED BEHAVIOUR — the chain had no `provider` in its AI node
      // config, so the run died with `Provider "undefined"`. The suite called that
      // "fails cleanly". Now the chain freezes a real provider at expansion, so a
      // credential-less test tenant fails one step LATER and honestly:
      // `byok_required` — configure a key — instead of naming a provider that
      // never existed.
    expect(snap.error?.code).toBe('openwop-app.byok_required');

    const events = await bundleEvents(owner, runId);
    // The query-rename fix proof: pre-fix, `search` threw INVALID_INPUT on
    // every run (the chain never executed a single node). Post-fix it
    // completes with the real query threaded through and real results.
    const searchOutputs = completedOutputs(events, 'search');
    expect(searchOutputs.query).toBe('What is OpenWOP?');
    // With no key configured the surface answers its labelled demo placeholder;
    // the expected URL is built by hand (encodeURIComponent of the query).
    expect(searchOutputs.engine).toBe('demo');
    expect(searchOutputs.results).toEqual([expect.objectContaining({
      url: 'https://duckduckgo.com/?q=What%20is%20OpenWOP%3F',
      title: 'Web search: What is OpenWOP?',
      rank: 1,
    })]);

    // synthesize is where it fails — never silently skipped or reached notify.
    const failedEvent = events.find((e) => e.type === 'node.failed');
    expect(failedEvent?.nodeId?.endsWith('_synthesize')).toBe(true);
    expect(events.filter((e) => e.nodeId?.endsWith('_notify')).map((e) => e.type)).toEqual([]); // never started
  });
});
