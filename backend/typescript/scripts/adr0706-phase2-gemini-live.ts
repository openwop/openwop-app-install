/**
 * ADR 0706 Phase 2 — the GEMINI leg, live (no search vendor needed).
 *
 * Drives the Challenge Factory's four LLM nodes — claim-extract → claim-verify →
 * (evidence-graph) → plan-generate → (plan-validate → checkpoint-plan) →
 * lesson-batch-build — as the REAL pack functions with the REAL AI adapter
 * (`createAiProvidersAdapter`, the same code path the executor wires as
 * `ctx.callAI`) dispatching to Google on a real key, and records per node:
 * elapsed, status, token counts from the adapter's own `provider.usage` events,
 * and the cost from `providers.json`. The research spine's search + fetch are
 * CANNED (one page of text) because that leg needs a durable-search key this
 * measurement does not; everything the model does is live.
 *
 * What it measures, per ADR 0706 §5 Phase 2:
 *   - does Gemini's `responseSchema` structured output satisfy each node's
 *     closed-world validator (claim schema / verdict schema / plan schema /
 *     lesson schema) — success, or a typed `*_invalid` after the one repair;
 *   - the reasoning-budget caveat: an EMPTY completion on the largest structured
 *     output (plan-generate) shows up here as `ai.data` undefined → repair →
 *     `plan_invalid`, with `outputTokens` near zero on the usage event;
 *   - cost per factory run for the model leg.
 *
 * Usage (never run by CI; needs the key):
 *   OPENWOP_LOG_LEVEL=error GOOGLE_API_KEY=… node_modules/.bin/tsx scripts/adr0706-phase2-gemini-live.ts [model]
 * (the report is also written as JSON to $OPENWOP_PHASE2_OUT or the tmp dir)
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { setInvocationBackend } from '../src/executor/invocationLog.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { setChatStorage } from '../src/host/chatSurface.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { createAiProvidersAdapter } from '../src/aiProviders/aiProvidersHost.js';
import { buildKicktodoCreatorSurface } from '../src/features/kicktodo-creator/surface.js';
import { createCandidate } from '../src/features/kicktodo-creator/creatorService.js';
import { getProviderConfig } from '../src/providers/catalog.js';

type NodeFn = (ctx: Record<string, unknown>) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: unknown }>;

const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? '';
if (!apiKey) { console.error('GOOGLE_API_KEY is not set — nothing to measure.'); process.exit(2); }
const PROVIDER = 'google';
const MODEL = process.argv[2] ?? 'gemini-3.1-flash-lite';
const CREDENTIAL_REF = 'google:phase2';

const pricing = getProviderConfig(PROVIDER)?.models.find((m) => m.id === MODEL)?.cost;

const storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
setInvocationBackend(storage); // the adapter's Layer-2 invocation cache (ADR 0505) lives here
initHostExtPersistence(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-adr0706-p2-')) });
setChatStorage(storage);
const hostSuite = createHostAdapterSuite({ storage });
ensureNodesRegistered();
const packUrl = new URL('../../../packs/feature.kicktodo.nodes/index.mjs', import.meta.url).href;
const nodes = ((await import(packUrl)) as { nodes: Record<string, NodeFn> }).nodes;

const T = 'tenant-adr0706-phase2';
const AUTHOR = 'user:adr0706-phase2';
const RUN_ID = `run-adr0706-p2-${Date.now().toString(36)}`;
const surface = buildKicktodoCreatorSurface({ tenantId: T, actingUserId: AUTHOR });
const features = { 'kicktodo-creator': surface } as Record<string, unknown>;
const bag = new Map<string, unknown>();
const variables = { get: (n: string) => bag.get(n), set: (n: string, v: unknown) => bag.set(n, v) };

/** Every `provider.usage` the adapter emits, in order, tagged with the node. */
const usage: Array<{ node: string; provider: string; model: string; inputTokens: number; outputTokens: number }> = [];
let currentNode = '';
const mkCallAI = (nodeId: string) => {
  const adapter = createAiProvidersAdapter({
    runId: RUN_ID, nodeId, tenantId: T, actingUserId: AUTHOR, attempt: 1,
    secrets: { [CREDENTIAL_REF]: apiKey },
    policyResolver: hostSuite.providerPolicyResolver,
    emit: async (type, payload) => {
      if (type === 'provider.usage') {
        const p = payload as { provider?: string; model?: string; inputTokens?: number; outputTokens?: number };
        usage.push({ node: currentNode, provider: String(p.provider), model: String(p.model), inputTokens: Number(p.inputTokens ?? 0), outputTokens: Number(p.outputTokens ?? 0) });
      }
      return { eventId: `ev-${usage.length}`, sequence: usage.length };
    },
  });
  return adapter.callAI;
};
const AI = { provider: PROVIDER, model: MODEL, credentialRef: CREDENTIAL_REF };
const mkctx = (nodeId: string, inputs: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ runId: RUN_ID, nodeId, tenantId: T, actingUserId: AUTHOR, inputs: { ...inputs, ...AI }, features, variables, callAI: mkCallAI(nodeId), ...extra });

const report: Array<{ node: string; status: string; ms: number; error?: unknown; note?: string }> = [];
const PACE_MS = Number(process.env.OPENWOP_PHASE2_PACE_MS ?? 0);
async function step<T>(node: string, fn: () => Promise<T>): Promise<T> {
  currentNode = node;
  // A free-tier key is RPM-limited; pacing between nodes keeps the measurement
  // about the code, not the key tier (the unpaced run hit 429 on plan-generate).
  if (PACE_MS > 0 && usage.length > 0) await new Promise((r) => setTimeout(r, PACE_MS));
  const t0 = Date.now();
  let out: T;
  try {
    out = await fn();
  } catch (err) {
    // The adapter THROWS typed provider errors (the executor turns them into a
    // node failure); record it as a step outcome so the report still writes.
    const e = err as { code?: string; message?: string; details?: unknown };
    out = { status: 'threw', error: { code: e.code, message: e.message, details: e.details } } as unknown as T;
  }
  const o = out as { status?: string; error?: unknown };
  report.push({ node, status: o.status ?? 'n/a', ms: Date.now() - t0, ...(o.error ? { error: o.error } : {}) });
  console.error(`▶ ${node}: ${o.status} in ${Date.now() - t0} ms${o.error ? ' — ' + JSON.stringify(o.error).slice(0, 300) : ''}`);
  return out;
}

// ── The research spine's canned inputs (the leg that needs a search key) ──
const TOPIC = 'Watercolor painting basics';
const AUDIENCE = 'absolute beginners';
const PAGE_URL = 'https://example.org/watercolor-for-beginners';
const PAGE_TITLE = 'Watercolor for beginners: a practical guide';
const PAGE_TEXT = [
  'Watercolor rewards short, regular practice. Most beginners improve fastest with daily studies of fifteen to twenty minutes rather than one long weekly session, because brush control and water-to-pigment judgment are motor skills that fade between sessions.',
  'Start with three tube colors — a warm yellow, a red, and a blue — and mix every other color from them; a limited palette teaches mixing and keeps early paintings harmonious.',
  'Use 140 lb (300 gsm) cold-pressed paper. Thinner paper buckles under a wash, and a buckled surface pools pigment unpredictably, which reads as a mistake the painter did not make.',
  'A flat wash is the first skill: tilt the board slightly, load a round brush, and pull the bead of paint down the sheet in overlapping strokes without going back into a drying area.',
  'Value before color: a small grey-scale thumbnail of the subject before painting settles the composition and prevents the muddy mid-tones that come from correcting values with more pigment.',
  'Let layers dry completely before glazing over them; wet-into-damp is where most unintended blooms come from.',
].join(' ');

const candidate = await createCandidate({ tenantId: T, createdBy: AUTHOR, topic: TOPIC, audience: AUDIENCE, transformation: '', durationDaysTarget: 3, dailyMinutesTarget: 15 });
bag.set('candidateId', candidate.id); bag.set('topic', TOPIC); bag.set('audience', AUDIENCE); bag.set('authorSubject', AUTHOR);

const frame = await step('research-frame', () => nodes['feature.kicktodo.nodes.research-frame']!(mkctx('research-frame', { topic: TOPIC, audience: AUDIENCE })));
const questions = (frame.outputs as { questions: string[] }).questions;
const normalize = await step('source-normalize', () => nodes['feature.kicktodo.nodes.source-normalize']!(mkctx('normalize', { results: [{ url: PAGE_URL, title: PAGE_TITLE, snippet: 'A practical guide.', rank: 1 }], engine: 'exa' })));
const sources = (normalize.outputs as { sources: unknown[] }).sources;
const pages = [{ url: PAGE_URL, status: 200, title: PAGE_TITLE, extractedText: PAGE_TEXT }];

// ── The live model leg ──
const extract = await step('claim-extract (Gemini, claim schema)', () => nodes['feature.kicktodo.nodes.claim-extract']!(mkctx('extract-claims', { sources, pages, questions })));
const claims = (extract.outputs as { claims?: unknown[] } | undefined)?.claims ?? [];
const verify = await step('claim-verify (Gemini, verdict schema ×N)', () => nodes['feature.kicktodo.nodes.claim-verify']!(mkctx('verify-claims', { claims, sources, pages })));
const verified = (verify.outputs as { claims?: unknown[] } | undefined)?.claims ?? [];
await step('evidence-graph', () => nodes['feature.kicktodo.nodes.evidence-graph']!(mkctx('evidence-graph', { candidateId: candidate.id, questions, sources, claims: verified })));
const generate = await step('plan-generate (Gemini, plan schema — the largest structured output)', () => nodes['feature.kicktodo.nodes.plan-generate']!(mkctx('generate', { candidateId: candidate.id, topic: TOPIC, audience: AUDIENCE, evidenceSummary: bag.get('evidenceSummary'), evidenceClaims: bag.get('evidenceClaims') })));
if (generate.status === 'success') {
  await step('plan-validate', () => nodes['feature.kicktodo.nodes.plan-validate']!(mkctx('plan-validate', { plan: bag.get('plan') })));
  await step('checkpoint-plan', () => nodes['feature.kicktodo.nodes.checkpoint-plan']!(mkctx('checkpoint-plan', { plan: bag.get('plan'), checkpointEvery: 'batched' })));
  // checkpoint-plan writes each slot's day payloads to the variable BAG (batchN), not its outputs.
  const batch0 = (bag.get('batch0') as unknown[] | undefined) ?? [];
  await step(`lesson-batch-build (Gemini, lesson schema × ${batch0.length} day(s))`, () => nodes['feature.kicktodo.nodes.lesson-batch-build']!(mkctx('lesson-batch-build', { candidateId: candidate.id, authorSubject: AUTHOR, days: batch0, evidenceClaims: bag.get('evidenceClaims'), generateMedia: 'false' })));
}

// ── Roll-up ──
const inTok = usage.reduce((a, u) => a + u.inputTokens, 0);
const outTok = usage.reduce((a, u) => a + u.outputTokens, 0);
const cost = pricing ? (inTok / 1000) * pricing.input + (outTok / 1000) * pricing.output : null;
const emptyCompletions = usage.filter((u) => u.outputTokens === 0).length;
const summary = {
  measuredAt: new Date().toISOString(), provider: PROVIDER, model: MODEL,
  nodes: report,
  usage: { calls: usage.length, inputTokens: inTok, outputTokens: outTok, emptyCompletions, byNode: usage },
  pricingPer1kTokens: pricing ?? null, estimatedModelLegCostUsd: cost,
  claims: { extracted: claims.length, verified: verified.length },
  plan: generate.status === 'success' ? { days: ((bag.get('plan') as { days?: unknown[] })?.days ?? []).length } : null,
};
const out = join(process.env.OPENWOP_PHASE2_OUT ?? tmpdir(), `adr0706-phase2-${MODEL}-${Date.now()}.json`);
writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.error(`\nwritten: ${out}`);
process.exit(report.every((r) => r.status === 'success') ? 0 : 1);
