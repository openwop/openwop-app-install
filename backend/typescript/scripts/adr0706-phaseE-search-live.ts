/**
 * ADR 0706 Phase E — the Challenge Factory's research spine AND model leg, both live.
 *
 * The Phase 2 script (`adr0706-phase2-gemini-live.ts`) measured the model leg with the
 * search + fetch legs CANNED, because no durable-search key existed on the machine.
 * This one runs the chain's own spine for real, in the chain's own order and wiring
 * (`examples/workflow-chain-packs/kicktodo-challenge-factory`):
 *
 *   research-frame → core.web.search (suitability: durable) → source-normalize
 *                                    ↘ core.web.fetch (maxPages 6, readable)
 *   → claim-extract → claim-verify → evidence-graph → plan-generate
 *   → plan-validate → checkpoint-plan → lesson-batch-build (batch 0)
 *
 * `core.web.search` / `core.web.fetch` are the REGISTERED node modules, handed the REAL
 * `host.webResearch` surface from `buildHostSurfaceBundle` — so the durable gate, the
 * vendor inference from the key's shape, the SSRF-guarded fetch and readable
 * extraction are all the production code paths. The model nodes are the REAL pack
 * functions through the REAL AI adapter, exactly as in Phase 2. The two human gates
 * (outline-approve, gate-N) are skipped: they wait on a person, not on a vendor.
 *
 * Records: per-node status + wall time, search engine + result count, pages fetched /
 * failed, the adapter's `provider.usage` tokens, model-leg cost from `providers.json`,
 * and search-leg cost as (search requests × the vendor price passed in
 * OPENWOP_PHASEE_SEARCH_USD_PER_1K — a list price, not read from any invoice).
 *
 * Usage (never run by CI; needs both keys, read ONLY from the environment and never
 * printed):
 *   OPENWOP_LOG_LEVEL=error GOOGLE_API_KEY=… OPENWOP_WEBSEARCH_API_KEY=… \
 *   OPENWOP_PHASEE_SEARCH_USD_PER_1K=7 node_modules/.bin/tsx scripts/adr0706-phaseE-search-live.ts [model]
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { setInvocationBackend } from '../src/executor/invocationLog.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces, buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { setChatStorage } from '../src/host/chatSurface.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { configureSecretResolver } from '../src/byok/secretResolver.js';
import { createAiProvidersAdapter } from '../src/aiProviders/aiProvidersHost.js';
import { buildKicktodoCreatorSurface } from '../src/features/kicktodo-creator/surface.js';
import { createCandidate } from '../src/features/kicktodo-creator/creatorService.js';
import { getProviderConfig } from '../src/providers/catalog.js';

type NodeFn = (ctx: Record<string, unknown>) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: unknown }>;

const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? '';
if (!apiKey) { console.error('GOOGLE_API_KEY is not set — the model leg cannot run.'); process.exit(2); }
if (!process.env.OPENWOP_WEBSEARCH_API_KEY) { console.error('OPENWOP_WEBSEARCH_API_KEY is not set — the search leg cannot run.'); process.exit(2); }
const PROVIDER = 'google';
const MODEL = process.argv[2] ?? 'gemini-3.1-flash-lite';
const CREDENTIAL_REF = 'google:phase-e';
const SEARCH_USD_PER_1K = Number(process.env.OPENWOP_PHASEE_SEARCH_USD_PER_1K ?? NaN);
const pricing = getProviderConfig(PROVIDER)?.models.find((m) => m.id === MODEL)?.cost;

const dataDir = mkdtempSync(join(tmpdir(), 'openwop-adr0706-pe-'));
const storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
setInvocationBackend(storage);
initHostExtPersistence(storage);
configureSecretResolver({ storage, dataDir }); // no tenant secret: the search key resolves from the env lane
initInMemorySurfaces({ dataDir });
setChatStorage(storage);
const hostSuite = createHostAdapterSuite({ storage });
ensureNodesRegistered();
const registry = getNodeRegistry();
const packUrl = new URL('../../../packs/feature.kicktodo.nodes/index.mjs', import.meta.url).href;
const nodes = ((await import(packUrl)) as { nodes: Record<string, NodeFn> }).nodes;

const T = 'tenant-adr0706-phase-e';
const AUTHOR = 'user:adr0706-phase-e';
const RUN_ID = `run-adr0706-pe-${Date.now().toString(36)}`;
const surface = buildKicktodoCreatorSurface({ tenantId: T, actingUserId: AUTHOR });
const features = { 'kicktodo-creator': surface } as Record<string, unknown>;
const { webResearch } = buildHostSurfaceBundle({ tenantId: T, runId: RUN_ID, actingUserId: AUTHOR });
const bag = new Map<string, unknown>();
const variables = { get: (n: string) => bag.get(n), set: (n: string, v: unknown) => bag.set(n, v) };

const usage: Array<{ node: string; inputTokens: number; outputTokens: number }> = [];
let currentNode = '';
const mkCallAI = (nodeId: string) => createAiProvidersAdapter({
  runId: RUN_ID, nodeId, tenantId: T, actingUserId: AUTHOR, attempt: 1,
  secrets: { [CREDENTIAL_REF]: apiKey },
  policyResolver: hostSuite.providerPolicyResolver,
  emit: async (type, payload) => {
    if (type === 'provider.usage') {
      const p = payload as { inputTokens?: number; outputTokens?: number };
      usage.push({ node: currentNode, inputTokens: Number(p.inputTokens ?? 0), outputTokens: Number(p.outputTokens ?? 0) });
    }
    return { eventId: `ev-${usage.length}`, sequence: usage.length };
  },
}).callAI;
const AI = { provider: PROVIDER, model: MODEL, credentialRef: CREDENTIAL_REF };
const mkctx = (nodeId: string, inputs: Record<string, unknown>, config: Record<string, unknown> = {}, withAi = true) =>
  ({ runId: RUN_ID, nodeId, tenantId: T, actingUserId: AUTHOR, inputs: withAi ? { ...inputs, ...AI } : inputs, config, features, variables, webResearch, callAI: mkCallAI(nodeId) });

const report: Array<{ node: string; status: string; ms: number; error?: unknown }> = [];
const PACE_MS = Number(process.env.OPENWOP_PHASEE_PACE_MS ?? 0);
async function step(node: string, fn: () => Promise<{ status: string; outputs?: Record<string, unknown>; error?: unknown }>) {
  currentNode = node;
  if (PACE_MS > 0 && usage.length > 0) await new Promise((r) => setTimeout(r, PACE_MS));
  const t0 = Date.now();
  let out: { status: string; outputs?: Record<string, unknown>; error?: unknown };
  try { out = await fn(); } catch (err) {
    const e = err as { code?: string; message?: string };
    out = { status: 'threw', error: { code: e.code, message: e.message } };
  }
  const ms = Date.now() - t0;
  report.push({ node, status: out.status, ms, ...(out.error ? { error: out.error } : {}) });
  console.error(`▶ ${node}: ${out.status} in ${ms} ms${out.error ? ' — ' + JSON.stringify(out.error).slice(0, 300) : ''}`);
  return out;
}
const wall0 = Date.now();

const TOPIC = process.env.OPENWOP_PHASEE_TOPIC ?? 'Watercolor painting basics';
const AUDIENCE = 'absolute beginners';
const candidate = await createCandidate({ tenantId: T, createdBy: AUTHOR, topic: TOPIC, audience: AUDIENCE, transformation: '', durationDaysTarget: 3, dailyMinutesTarget: 15 });
bag.set('candidateId', candidate.id); bag.set('topic', TOPIC); bag.set('audience', AUDIENCE); bag.set('authorSubject', AUTHOR);

// ── The research spine, live ──
const frame = await step('research-frame', () => nodes['feature.kicktodo.nodes.research-frame']!(mkctx('research-frame', { topic: TOPIC, audience: AUDIENCE }, {}, false)));
const questions = ((frame.outputs ?? {}) as { questions?: string[] }).questions ?? [];
const searchNode = registry.get('core.web.search')!;
const search = await step('core.web.search (durable)', () => searchNode.execute(mkctx('search', { query: TOPIC, maxResults: 8, suitability: 'durable' }, { suitability: 'durable' }, false) as never) as never);
const searchOut = (search.outputs ?? {}) as { results?: unknown[]; engine?: string };
const normalize = await step('source-normalize', () => nodes['feature.kicktodo.nodes.source-normalize']!(mkctx('normalize', searchOut, {}, false)));
const sources = ((normalize.outputs ?? {}) as { sources?: unknown[] }).sources ?? [];
const fetchNode = registry.get('core.web.fetch')!;
const fetched = await step('core.web.fetch (6 pages, readable)', () => fetchNode.execute(mkctx('fetch', searchOut, { maxPages: 6, extractReadable: true }, false) as never) as never);
const fetchOut = (fetched.outputs ?? {}) as { pages?: Array<{ status: number; error?: unknown; extractedText?: string }>; fetched?: number; failed?: number };
const pages = fetchOut.pages ?? [];

// ── The model leg, live (same wiring as the chain's edges) ──
let claims: unknown[] = []; let verified: unknown[] = []; let generateStatus = 'skipped';
if (search.status === 'success' && pages.length > 0) {
  const extract = await step('claim-extract', () => nodes['feature.kicktodo.nodes.claim-extract']!(mkctx('extract-claims', { sources, pages, questions })));
  const extractOut = (extract.outputs ?? {}) as { claims?: unknown[]; readSourceHashes?: unknown };
  claims = extractOut.claims ?? [];
  const verify = await step('claim-verify', () => nodes['feature.kicktodo.nodes.claim-verify']!(mkctx('verify-claims', { claims, sources, pages })));
  verified = ((verify.outputs ?? {}) as { claims?: unknown[] }).claims ?? [];
  await step('evidence-graph', () => nodes['feature.kicktodo.nodes.evidence-graph']!(mkctx('evidence-graph', { candidateId: candidate.id, questions, sources, claims: verified, readSourceHashes: extractOut.readSourceHashes }, {}, false)));
  const generate = await step('plan-generate', () => nodes['feature.kicktodo.nodes.plan-generate']!(mkctx('generate', { candidateId: candidate.id, topic: TOPIC, audience: AUDIENCE, evidenceSummary: bag.get('evidenceSummary'), evidenceClaims: bag.get('evidenceClaims') })));
  generateStatus = generate.status;
  if (generate.status === 'success') {
    await step('plan-validate', () => nodes['feature.kicktodo.nodes.plan-validate']!(mkctx('plan-validate', { plan: bag.get('plan') }, {}, false)));
    await step('checkpoint-plan', () => nodes['feature.kicktodo.nodes.checkpoint-plan']!(mkctx('checkpoint-plan', { plan: bag.get('plan'), checkpointEvery: 'batched', evidenceClaims: bag.get('evidenceClaims') }, {}, false)));
    const batch0 = (bag.get('batch0') as unknown[] | undefined) ?? [];
    await step(`lesson-batch-build (${batch0.length} day(s))`, () => nodes['feature.kicktodo.nodes.lesson-batch-build']!(mkctx('lesson-batch-build', { candidateId: candidate.id, authorSubject: AUTHOR, days: batch0, evidenceClaims: bag.get('evidenceClaims'), generateMedia: 'false' })));
  }
}

const inTok = usage.reduce((a, u) => a + u.inputTokens, 0);
const outTok = usage.reduce((a, u) => a + u.outputTokens, 0);
const modelCost = pricing ? (inTok / 1000) * pricing.input + (outTok / 1000) * pricing.output : null;
const searchRequests = search.status === 'success' ? 1 : 0;
const summary = {
  measuredAt: new Date().toISOString(), provider: PROVIDER, model: MODEL, topic: TOPIC,
  wallMs: Date.now() - wall0,
  nodes: report,
  search: { engine: searchOut.engine ?? null, results: (searchOut.results ?? []).length, requests: searchRequests,
    estimatedCostUsd: Number.isFinite(SEARCH_USD_PER_1K) ? (searchRequests * SEARCH_USD_PER_1K) / 1000 : null },
  fetch: { pages: pages.length, ok: fetchOut.fetched ?? null, failed: fetchOut.failed ?? null,
    extractedChars: pages.reduce((a, p) => a + (p.extractedText?.length ?? 0), 0) },
  usage: { calls: usage.length, inputTokens: inTok, outputTokens: outTok, emptyCompletions: usage.filter((u) => u.outputTokens === 0).length },
  estimatedModelLegCostUsd: modelCost,
  claims: { extracted: claims.length, verified: verified.length },
  plan: generateStatus === 'success' ? { days: ((bag.get('plan') as { days?: unknown[] })?.days ?? []).length } : { status: generateStatus },
};
const out = join(process.env.OPENWOP_PHASEE_OUT ?? tmpdir(), `adr0706-phaseE-${MODEL}-${Date.now()}.json`);
writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.error(`\nwritten: ${out}`);
process.exit(report.every((r) => r.status === 'success') ? 0 : 1);
