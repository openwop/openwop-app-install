/**
 * PROBE-IS (ADR 0599 §4) — the witness `insights-suite` never had: EXECUTE the
 * three meta-workflow chains instead of asserting their edge topology.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * `insights-suite-meta.test.ts` already carries a probe written for exactly this
 * class — `PROBE-DOC-4`, "connectedness is not runnability" — added after
 * `weekly-variance.render` shipped with no inputs and died `not_found` behind a
 * green suite. It was then scoped to `feature.documents.nodes.*`, which the 1.1.0
 * pack no longer contains, and **its own comment concedes it is "vacuously
 * green"**. Sixteen lines below it sits the connectedness test whose
 * insufficiency that comment describes — still the only structural coverage the
 * three chains have.
 *
 * So 8 files and 790 test lines assert typeId spelling, graph connectedness, PII
 * masking, cron parsing, schedule reconciliation and agent listing, and **not one
 * asserts that any node in any chain can execute**. This file does.
 *
 * ── What makes it faithful rather than a mechanism test ─────────────────────
 *
 * The failure mode this replaces is "hand-feed the node the inputs the chain
 * never supplies, then assert the math." Two rules keep that from recurring:
 *
 *  1. **The variable bag may only contain values a real launcher could pass.**
 *     `maximalLaunch()` fills EVERY property the chain declares in its own
 *     `parameters` block and nothing else — the blocks are
 *     `additionalProperties:false`, so that is provably the most any caller can
 *     supply. If a node still starves, no lane can rescue it.
 *  2. **Node implementations resolve through the trust-gated registry**, not a
 *     direct `import()` of `packs/…/index.mjs`. A pack that goes `untrusted`
 *     becomes a refusal stub in production; a static import cannot tell the
 *     difference. (This also closes `ISWF-11` / `GEN-IS-3`.)
 *
 * Only the three things that are not this feature's logic are stubbed: the LLM
 * (a real completion is not a test), the ADR 0037 connector broker (the egress
 * is not under test — the CONFIG the node builds its request from is), and the
 * knowledge index. Notifications run FOR REAL through the feature surface, so
 * "the terminal was reached" is read off the durable inbox rather than asserted
 * about a stub.
 *
 * @see docs/adr/0599-insights-suite-honest-then-runnable.md §4
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { loadWorkflowChainPacks, defaultWorkflowChainPackRoots, getChain, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { resolveDeclaredInputs, buildNodeCtxInputs } from '../src/executor/nodeCtxInputs.js';
import { interpolateRunInputs, hasInputTokens } from '../src/executor/runInputInterpolation.js';
import { ensureLocalPacksMounted } from '../src/bootstrap/mountLocalPacks.js';
import { classifyPackDir } from '../src/host/packTrust.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import {
  buildInsightsMetaWorkflow, WEEKLY_VARIANCE_ID, ANNIVERSARY_DRAFT_ID, TALENT_PREP_ID,
} from '../src/features/insights-suite/metaWorkflows.js';
import type { NodeContext, WorkflowDefinition } from '../src/executor/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

let server: http.Server;
type NodeResult = { status: string; outputs?: Record<string, unknown>; error?: { code?: string; message?: string } };

/* ── Stubs: the three things that are NOT this feature's logic ───────────── */

const AI_CONTENT = 'Ten years of steady, generous work. Thank you, and congratulations.';
const aiStub = async (): Promise<NodeResult> => ({
  status: 'success',
  outputs: { content: AI_CONTENT, usage: {}, finishReason: 'stop', model: 'stub' },
});

/**
 * The ADR 0037 broker, stubbed at its boundary. It answers by URL, so a node that
 * builds the WRONG url (or never gets far enough to build one) is visible here
 * rather than papered over by a catch-all `{ok:true}`.
 *
 * The BigQuery payload is the real `tableRows`/`schema.fields` wire shape, carrying
 * the metric/actual/plan columns a financials read produces; the Workday payload is
 * the real `{data:[…]}` collection shape.
 */
const brokerCalls: Array<{ connectorId: string; url: string; method: string; body: string }> = [];
function connectorsStub(): NonNullable<NodeContext['connectors']> {
  return {
    async invoke(connectorId, request) {
      brokerCalls.push({ connectorId, url: request.url, method: request.method ?? 'GET', body: request.body ?? '' });
      if (connectorId === 'bigquery') {
        const row = (metric: string, actual: number, plan: number) => ({ f: [{ v: metric }, { v: String(actual) }, { v: String(plan) }] });
        return {
          ok: true,
          status: 200,
          data: {
            jobReference: { jobId: 'job-stub' },
            schema: { fields: [{ name: 'metric' }, { name: 'actual' }, { name: 'plan' }] },
            rows: [row('sales', 95, 100), row('margin', 40, 38), row('labor', 22, 20), row('shrink', 3, 3)],
          },
        };
      }
      if (connectorId === 'workday') {
        return {
          ok: true,
          status: 200,
          data: {
            data: [
              { workerId: 'subj-42', name: 'A. Person', serviceDate: '2016-08-22', milestone: '10 years', performanceRating: 3, potentialRating: 2 },
            ],
            total: 1,
          },
        };
      }
      // microsoft-graph / gmail — the draft create.
      return { ok: true, status: 201, data: { id: 'draft-stub' } };
    },
  };
}

const knowledgeStub = {
  async retrieve() {
    return { chunks: [{ id: 'k1', text: 'We say thank you plainly and name the specific work.', relevanceScore: 0.9 }], totalCandidates: 1 };
  },
} as unknown as NodeContext['knowledge'];

/**
 * Resolve a node the way the RUNTIME does — through the registry, whose miss path
 * runs `packs/tarballLoader` → `host/packTrust.classifyPackDir`. "The pack has
 * tests" is not "the pack is reachable in production".
 */
async function nodeImpl(typeId: string): Promise<(ctx: unknown) => Promise<NodeResult>> {
  if (typeId === 'core.ai.chatCompletion') return aiStub;
  const mod = await getNodeRegistry().resolve(typeId);
  expect(mod, `${typeId} did not resolve through the trust-gated pack lane`).toBeTruthy();
  return (ctx) => mod!.execute(ctx as NodeContext) as Promise<NodeResult>;
}

/* ── The harness ─────────────────────────────────────────────────────────── */

/** The short (pre-expansion) node id — expansion prefixes `<chain>_<hash>_`. */
const shortId = (nodeId: string): string => nodeId.slice(nodeId.lastIndexOf('_') + 1);

interface StepResult { status: string; outputs: Record<string, unknown>; error?: { code?: string; message?: string } }

/**
 * Walk an EXPANDED definition in node order using the executor's OWN input rule
 * (`buildNodeInputs` port semantics + `resolveDeclaredInputs` + `buildNodeCtxInputs`
 * + `interpolateRunInputs` on config). `node.config` is otherwise used VERBATIM —
 * whatever `expandChain` froze — so an unfrozen token or a missing key surfaces as
 * the node's own validation failure instead of being re-substituted here.
 *
 * A `core.approvalGate` suspension is treated as an APPROVAL (the human said yes)
 * so the pipeline downstream of a gate is exercised. Reject-blocks-downstream is a
 * different guarantee and is already covered by `routes/interrupts.ts`'s own tests.
 */
async function runDefinition(
  def: WorkflowDefinition,
  variableBag: Record<string, unknown>,
  tenantId: string,
  broker: NonNullable<NodeContext['connectors']> = connectorsStub(),
  // ADR 0600 §5 — a SYSTEM run (scheduler / inbound webhook) carries no acting
  // human. `BundleScope.actingUserId` absent is the correct fail-closed signal,
  // and `PROBE-IS-10` needs to reach it: `audience:'self'` must refuse there,
  // not quietly widen back to the tenant.
  opts: { systemRun?: boolean } = {},
): Promise<Record<string, StepResult>> {
  const runId = `run:${def.workflowId}:${Math.random().toString(36).slice(2)}`;
  const features = buildFeatureSurfaces({
    tenantId, runId,
    ...(opts.systemRun ? {} : { actingUserId: 'u-ceo' }),
  });
  const outputs = new Map<string, Record<string, unknown>>();
  const results: Record<string, StepResult> = {};
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
    const result = await impl({
      runId,
      nodeId: node.nodeId,
      tenantId,
      inputs: buildNodeCtxInputs(inputsByPort, resolveDeclaredInputs(node.inputs, variableBag)),
      config: hasInputTokens(node.config) ? interpolateRunInputs(node.config ?? {}, variableBag) : (node.config ?? {}),
      features,
      connectors: broker,
      knowledge: knowledgeStub,
    });
    const step: StepResult = { status: result.status, outputs: result.outputs ?? {}, ...(result.error ? { error: result.error } : {}) };
    results[shortId(node.nodeId)] = step;
    if (result.status === 'suspended' && node.typeId === 'core.approvalGate') {
      outputs.set(node.nodeId, { approved: true, decision: 'approve' });
      continue;
    }
    if (result.status !== 'success') break;
    outputs.set(node.nodeId, result.outputs ?? {});
  }
  return results;
}

/**
 * Every property the chain declares in its own `parameters` block, filled with a
 * realistic value — provably the MOST any launcher can pass, because both blocks
 * are `additionalProperties:false`. Anything a node needs beyond this is
 * undeliverable by construction, which is the whole point of the probe.
 */
const REALISTIC: Record<string, unknown> = {
  projectId: 'acme-analytics',
  businessUnit: 'TX',
  subjectId: 'subj-42',
  milestone: '10 years',
  workdayResource: 'serviceDates',
  sql: 'SELECT metric, actual, plan FROM `acme-analytics.finance.weekly_variance`',
  workdayBaseUrl: 'https://acme.workday.com/ccx/api/v1/acme',
  exemplarQuery: 'work anniversary recognition exemplars',
  recipient: 'a.person@acme.test',
  draftSubject: 'Work anniversary: A. Person',
};
function maximalLaunch(chainId: string): Record<string, unknown> {
  const chain = getChain(chainId)?.chain;
  expect(chain, `${chainId} is not loaded`).toBeTruthy();
  const props = ((chain!.parameters as { properties?: Record<string, { default?: unknown }> }).properties) ?? {};
  const bag: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(props)) {
    const v = REALISTIC[name] ?? spec.default;
    expect(v, `test gap: chain '${chainId}' declares parameter '${name}' with no realistic value in REALISTIC`).toBeDefined();
    bag[name] = v;
  }
  return bag;
}

/** Node ids whose failure means "the pipeline never ran", reported precisely. */
function firstFailure(results: Record<string, StepResult>): string | null {
  for (const [id, r] of Object.entries(results)) {
    if (r.status !== 'success' && r.status !== 'suspended') return `${id}: ${r.status} ${r.error?.code ?? ''} — ${r.error?.message ?? ''}`;
  }
  return null;
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  for (const id of ['insights-suite', 'notifications']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  expect(errors).toEqual([]);
  ensureLocalPacksMounted();
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('PROBE-IS-0 — the insights node pack is REACHABLE through the trust gate', () => {
  it('is dispatchable and both nodes resolve through the registry, not a direct import', async () => {
    const verdict = classifyPackDir(join(REPO_ROOT, 'packs', 'feature.insights-suite.nodes'), { noCache: true });
    expect(verdict.dispatchable, `not dispatchable (${verdict.tier}: ${verdict.reason}) ⇒ every insights node is a refusal stub`).toBe(true);
    for (const typeId of ['feature.insights-suite.nodes.variance-compute', 'feature.insights-suite.nodes.talent-score', 'feature.notifications.nodes.notify']) {
      expect(await getNodeRegistry().resolve(typeId), typeId).toBeTruthy();
    }
  });
});

describe('PROBE-IS-1 — every insights chain RUNS to its terminal notify (ISC-1 / ISWF-1 / ISU-5)', () => {
  it('weekly-variance: BigQuery → variance → red-team → notify, with a real verdict', async () => {
    const tenantId = `t-wv-${Date.now()}`;
    const def = buildInsightsMetaWorkflow(WEEKLY_VARIANCE_ID);
    const r = await runDefinition(def, maximalLaunch(WEEKLY_VARIANCE_ID), tenantId);

    expect(firstFailure(r), 'a node failed — the chain cannot produce an insight').toBeNull();
    // The source node must have actually reached the broker with a real query.
    expect(r.query?.status).toBe('success');
    expect(Number(r.query?.outputs.rowCount)).toBeGreaterThan(0);
    // The compute node must have received DATA, not just the upstream envelope.
    expect(r.compute?.status).toBe('success');
    expect(Object.keys(r.compute?.outputs.variances as Record<string, unknown>).length).toBeGreaterThan(0);
    expect(r.compute?.outputs.verdict).toBe('off_plan'); // sales −5%, labor +10% in the fixture
    // The terminal was reached AND the notification actually emitted.
    expect(r.notify?.status).toBe('success');
    expect(r.notify?.outputs.emitted, `notify refused: ${String(r.notify?.outputs.reason)}`).toBe(true);
    const inbox = await __hostExtStorage()!.listNotifications({ tenantId, limit: 20 });
    expect(inbox.length).toBeGreaterThan(0);
  });

  it('talent-prep: Workday → 9-box score → notify, with a score derived from the pulled rows', async () => {
    const tenantId = `t-tp-${Date.now()}`;
    const def = buildInsightsMetaWorkflow(TALENT_PREP_ID);
    const r = await runDefinition(def, maximalLaunch(TALENT_PREP_ID), tenantId);

    expect(firstFailure(r), 'a node failed — the chain cannot produce a readiness score').toBeNull();
    expect(r.pull?.status).toBe('success');
    expect(r.score?.status).toBe('success');
    // The fixture worker is performance 3 / potential 2 → box 6, High Performer.
    // If this ever reads box 1 / Underperformer again, the fabrication is back.
    expect(r.score?.outputs).toMatchObject({ subjectId: 'subj-42', performance: 3, potential: 2, box: 6 });
    expect(r.notify?.outputs.emitted).toBe(true);
  });

  it('anniversary-draft: Workday → knowledge → LLM → email DRAFT → approve → notify, and the draft carries the drafted body', async () => {
    const tenantId = `t-ad-${Date.now()}`;
    const def = buildInsightsMetaWorkflow(ANNIVERSARY_DRAFT_ID);
    brokerCalls.length = 0;
    const r = await runDefinition(def, maximalLaunch(ANNIVERSARY_DRAFT_ID), tenantId);

    expect(firstFailure(r), 'a node failed — the chain cannot produce a draft').toBeNull();
    expect(r.milestones?.status).toBe('success');
    expect(r.retrieve?.status).toBe('success');
    expect(r.generate?.status).toBe('success');
    expect(r.emailDraft?.status).toBe('success');
    // ISU-3's latent twin, and the assertion this probe originally got WRONG.
    // `core.email.draft` reads `body`; the LLM emits `content`. Supplying only the
    // recipient makes the node succeed with an EMPTY body — `draftId` is still
    // returned and the URL is still a draft URL, so an assertion on either of those
    // passes over a blank draft. Sabotaging the `generate.content → emailDraft.body`
    // edge back to portless proved exactly that: 5 passed. The only assertion that
    // can fail is one that reads the BODY the broker actually received.
    const draftCall = brokerCalls.find((c) => c.connectorId === 'microsoft-graph' || c.connectorId === 'gmail');
    expect(draftCall, 'no draft request ever reached the broker').toBeTruthy();
    expect(draftCall!.url, 'the draft node must only ever construct a CREATE-DRAFT url').toMatch(/messages$|drafts$/);
    const wire = draftCall!.connectorId === 'gmail'
      ? Buffer.from(JSON.parse(draftCall!.body).message.raw as string, 'base64url').toString('utf8')
      : draftCall!.body;
    expect(wire, 'the draft reached the mailbox with an EMPTY body — the drafted text was dropped on the port-name mismatch').toContain(AI_CONTENT);
    expect(wire, 'the draft carries no recipient').toContain('a.person@acme.test');
    expect(r.emailDraft?.outputs.draftId).toBeTruthy();
    expect(r.notify?.outputs.emitted).toBe(true);
  });
});

/** Run a chain end-to-end against a substituted broker payload. */
const runWithBroker = async (
  chainId: string,
  broker: NonNullable<NodeContext['connectors']>,
  tenantId: string,
): Promise<Record<string, StepResult>> =>
  runDefinition(buildInsightsMetaWorkflow(chainId), maximalLaunch(chainId), tenantId, broker);

const brokerReturning = (data: unknown): NonNullable<NodeContext['connectors']> => ({
  async invoke() { return { ok: true, status: 200, data }; },
});

describe('PROBE-IS-2 — no chain reports a verdict it did not compute (ISC-2 / ISC-3)', () => {
  it('a source that returns NOTHING fails the run rather than notifying a fabricated result', async () => {
    const tenantId = `t-empty-${Date.now()}`;
    // Same chains, same launch — only the upstream data is gone.
    const emptyBroker = brokerReturning({ data: [], rows: [] });

    const wv = await runWithBroker(WEEKLY_VARIANCE_ID, emptyBroker, tenantId);
    expect(wv.compute?.status, 'zero financial rows must NOT produce a verdict').toBe('failure');
    expect(wv.compute?.error?.code).toBe('insufficient_data');
    expect(wv.notify, 'the tenant must not be notified about a variance nobody computed').toBeUndefined();

    const tp = await runWithBroker(TALENT_PREP_ID, emptyBroker, tenantId);
    expect(tp.score?.status, 'zero review rows must NOT place a named person in a 9-box cell').toBe('failure');
    expect(tp.score?.error?.code).toBe('insufficient_data');
    expect(tp.notify, 'confidential-pii must not be broadcast from a fabricated score').toBeUndefined();
  });
});

/**
 * PROBE-IS-3 (ADR 0599 §Correction 1) — **the absence shape production actually
 * has**, which PROBE-IS-2 above could not see.
 *
 * PROBE-IS-2 feeds an EMPTY ROW SET. That is the one absence shape 1.1.0's guards
 * could detect, and it is not the shape a warehouse produces: a warehouse produces
 * ROWS WITH ABSENT VALUES. `mapBigQueryRows` writes the REST cell value straight
 * through, so a SQL NULL arrives at the compute node as literal `null` — and
 * 1.1.0 read every cell through `Number()`, where `null`, `''`, `'  '` and `false`
 * are all **0**. So a full table of NULLs produced four real `variances` entries,
 * the "zero metrics" guard never fired, and the chain notified `verdict:'on_plan'`
 * — with a human red-team approval signature on it. The talent chain did the same
 * thing to a NAMED PERSON: blank rating columns → box 1, "Underperformer".
 *
 * Both were reproduced by executing the shipped 1.1.0 pack before this was
 * written. The distinction that matters, and the reason this probe is separate
 * rather than folded into PROBE-IS-2: **an empty row set is not a blank cell.**
 */
describe('PROBE-IS-3 — rows that ARRIVE but carry no VALUES are absence, not zero', () => {
  /**
   * The `measure()` witness proper.
   *
   * A FIRST DRAFT of this test used all-NULL rows (NULL actual AND NULL plan) —
   * the literal reproduction. Sabotaging `measure()` back to `Number()` left it
   * GREEN, because coerced zeros then made every plan 0 and the SECOND guard
   * (zero-plan) caught it instead. The assertion existed and measured a
   * different mechanism than the one it named. So the shape here is the one only
   * `measure()` can catch: **the actuals table has not loaded, the plan table
   * has.** Under `Number()` every NULL actual becomes a real 0 against a real
   * plan, i.e. `pct = -1` on every metric — a fabricated 100% collapse reported
   * as `off_plan` with `status:'success'`, then handed to a human to red-team.
   */
  it('weekly-variance: NULL actual cells against real plans fail closed, not a fabricated −100%', async () => {
    const tenantId = `t-null-${Date.now()}`;
    // The real `jobs.query` wire shape with the real NULL representation
    // (`mapBigQueryRows` writes `cells[i].v` straight through) plus one blank
    // string, which `Number('')` also mapped to 0.
    const nullActuals = brokerReturning({
      jobReference: { jobId: 'job-null' },
      schema: { fields: [{ name: 'metric' }, { name: 'actual' }, { name: 'plan' }] },
      rows: [
        { f: [{ v: 'sales' }, { v: null }, { v: '100' }] },
        { f: [{ v: 'margin' }, { v: '' }, { v: '38' }] },
        { f: [{ v: 'labor' }, { v: null }, { v: '20' }] },
        { f: [{ v: 'shrink' }, { v: null }, { v: '3' }] },
      ],
    });
    const r = await runWithBroker(WEEKLY_VARIANCE_ID, nullActuals, tenantId);

    // The source node genuinely SUCCEEDED with four rows — this is not the
    // upstream `invalid_config` starvation, it is a real read of empty data.
    expect(r.query?.status, 'the probe must exercise a SUCCESSFUL read, not a starved node').toBe('success');
    expect(Number(r.query?.outputs.rowCount), 'the rows must actually arrive — otherwise this is PROBE-IS-2 again').toBe(4);

    expect(r.compute?.status, 'four rows of NULL actuals must NOT produce a verdict').toBe('failure');
    expect(r.compute?.error?.code).toBe('insufficient_data');
    expect(r.compute?.outputs.verdict, 'an unloaded actuals table must never report a verdict at all').toBeUndefined();
    expect(r.notify, 'the tenant must not be notified — and a human must not be asked to red-team nothing').toBeUndefined();
  });

  it('weekly-variance: an all-NULL read fails closed too (the literal reproduction)', async () => {
    const tenantId = `t-allnull-${Date.now()}`;
    // Defense in depth, and honest about which guard holds it: with `measure()`
    // every cell drops out and the ZERO-METRICS guard fires; with `Number()` the
    // cells coerce to 0/0 and the ZERO-PLAN guard fires. Either way no verdict —
    // which is precisely why this shape cannot be the `measure()` witness.
    const allNull = brokerReturning({
      jobReference: { jobId: 'job-allnull' },
      schema: { fields: [{ name: 'metric' }, { name: 'actual' }, { name: 'plan' }] },
      rows: [
        { f: [{ v: 'sales' }, { v: null }, { v: null }] },
        { f: [{ v: 'margin' }, { v: '' }, { v: '' }] },
        { f: [{ v: 'labor' }, { v: null }, { v: null }] },
        { f: [{ v: 'shrink' }, { v: null }, { v: null }] },
      ],
    });
    const r = await runWithBroker(WEEKLY_VARIANCE_ID, allNull, tenantId);
    expect(r.query?.status).toBe('success');
    expect(r.compute?.status).toBe('failure');
    expect(r.compute?.error?.code).toBe('insufficient_data');
    expect(r.compute?.outputs.verdict).toBeUndefined();
    expect(r.notify).toBeUndefined();
  });

  it('weekly-variance: a plan of 0 across every metric is an unloaded plan, not "on plan"', async () => {
    const tenantId = `t-zeroplan-${Date.now()}`;
    // `SUM(plan)` over a table with no plan rows returns 0, not NULL. Every `pct`
    // is then null, so nothing can EVER be flagged and `flagged.length === 0`
    // reported "checked and clean" — the §3 conflation, one layer in.
    const zeroPlan = brokerReturning({
      jobReference: { jobId: 'job-zero' },
      schema: { fields: [{ name: 'metric' }, { name: 'actual' }, { name: 'plan' }] },
      rows: [
        { f: [{ v: 'sales' }, { v: '482000' }, { v: '0' }] },
        { f: [{ v: 'margin' }, { v: '31' }, { v: '0' }] },
      ],
    });
    const r = await runWithBroker(WEEKLY_VARIANCE_ID, zeroPlan, tenantId);

    expect(r.query?.status).toBe('success');
    expect(r.compute?.status, 'no metric is comparable to a zero plan — that is not a verdict').toBe('failure');
    expect(r.compute?.error?.code).toBe('insufficient_data');
    expect(r.compute?.outputs.verdict).toBeUndefined();
    expect(r.notify).toBeUndefined();
  });

  it('talent-prep: a BLANK rating column must not place a named person in box 1', async () => {
    const tenantId = `t-blank-${Date.now()}`;
    // The real Workday collection shape, with the subject PRESENT and rated by
    // nobody. 1.1.0 answered this with box 1 / "Underperformer" / not_ready,
    // broadcast at `audience:'tenant'` as confidential-pii.
    const blankRatings = brokerReturning({
      data: [{ workerId: 'subj-42', name: 'A. Person', performanceRating: '', potentialRating: null }],
      total: 1,
    });
    const r = await runWithBroker(TALENT_PREP_ID, blankRatings, tenantId);

    expect(r.pull?.status, 'the probe must exercise a SUCCESSFUL pull that found the subject').toBe('success');
    expect(r.score?.status, 'a blank rating must NOT become the worst possible rating').toBe('failure');
    expect(r.score?.error?.code).toBe('insufficient_data');
    expect(r.score?.outputs.box, 'no 9-box cell may be assigned from a blank column').toBeUndefined();
    expect(r.score?.outputs.label).toBeUndefined();
    expect(r.notify, 'a fabricated HR assessment must not reach the tenant-wide inbox').toBeUndefined();
    const inbox = await __hostExtStorage()!.listNotifications({ tenantId, limit: 20 });
    expect(inbox, 'nothing about this person may be durable').toEqual([]);
  });

  it('talent-prep: review cycles that DISAGREE are ambiguous, not "whichever row came first"', async () => {
    const tenantId = `t-ambig-${Date.now()}`;
    // A `performanceReviews` pull returns one row PER CYCLE, in collection order,
    // with no recency field. 1.1.0 took the first row that carried any rating.
    const conflicting = brokerReturning({
      data: [
        { workerId: 'subj-42', cycle: '2024', performanceRating: 1, potentialRating: 1 },
        { workerId: 'subj-42', cycle: '2026', performanceRating: 3, potentialRating: 3 },
      ],
      total: 2,
    });
    const r = await runWithBroker(TALENT_PREP_ID, conflicting, tenantId);

    expect(r.pull?.status).toBe('success');
    expect(r.score?.status, 'two different ratings is an ambiguity, not a pick').toBe('failure');
    expect(r.score?.error?.code).toBe('ambiguous_data');
    expect(r.notify).toBeUndefined();
  });

  it('talent-prep: a rating outside 1-3 is an unknown scale, not a clamp', async () => {
    const tenantId = `t-scale-${Date.now()}`;
    // A 1-5 Workday scale. Clamping maps 4 and 5 onto the TOP band and leaves a
    // mid `3` reading as top — the node cannot know the scale, so it refuses.
    const fiveScale = brokerReturning({
      data: [{ workerId: 'subj-42', performanceRating: 4, potentialRating: 5 }],
      total: 1,
    });
    const r = await runWithBroker(TALENT_PREP_ID, fiveScale, tenantId);

    expect(r.pull?.status).toBe('success');
    expect(r.score?.status, 'a scraped column on an unknown scale must not be clamped into 1-3').toBe('failure');
    expect(r.score?.error?.code).toBe('unknown_scale');
    expect(r.notify).toBeUndefined();
  });
});

/**
 * `PROBE-IS-10` (closes `ISU-6` / `ISU-7` / `ISU-8`) — ADR 0600 §5.
 *
 * Three coupled defects on the same node, asserted on the EMITTED RECORD rather
 * than on the pack's spelling — a `config.audience === 'self'` assertion polices
 * a string; `recipientUserId` is the thing that decides who can read it.
 *
 *  ISU-6  All three chains emitted at `audience:'tenant'`, which
 *         `notifications/surface.ts` turns into `target = {}` — no recipient
 *         filter, i.e. every member of the workspace. The record carries `runId`
 *         and the inbox renders it as a `/runs/:id` link. MEASURED: `runs:read`
 *         is in `VIEWER_SCOPES` (the LOWEST built-in role) and
 *         `host/runAccess.loadReadableRun` gates on scope + TENANT ownership
 *         with no per-run owner check — so the report's one SUSPECTED item is
 *         confirmed: any viewer could open a named colleague's 9-box score.
 *  ISU-7  `message` was never bound, so the body slot — built, styled and
 *         un-clamped — was empty on every surface, and the ambient ones (bell
 *         drawer, OS toast, web push) show a headline and nothing else.
 *  ISU-8  `actionUrl` was never set. The inbox open-codes a `runId` fallback;
 *         the drawer and the dashboard tile do not, so they DEAD-ENDED.
 *
 * ISU-6 and ISU-7 are ONE decision, not two: binding a body was declined in
 * PR-A precisely because `score.label` on a tenant broadcast is
 * "A. Person — High Performer" sent workspace-wide. Narrowing the audience is
 * what makes the body safe, so both land together or neither does.
 */
describe('PROBE-IS-10 — who the notification reaches, what it says, and where it goes', () => {
  it('talent-prep notifies ONLY the acting user, with the score in the body and a run link', async () => {
    const tenantId = `t-n1-${Date.now()}`;
    const r = await runDefinition(buildInsightsMetaWorkflow(TALENT_PREP_ID), maximalLaunch(TALENT_PREP_ID), tenantId);
    expect(r.notify?.outputs.emitted, `notify refused: ${String(r.notify?.outputs.reason)}`).toBe(true);

    const inbox = await __hostExtStorage()!.listNotifications({ tenantId, limit: 20 });
    expect(inbox.length).toBe(1);
    const n = inbox[0]!;
    // ISU-6 — a RECIPIENT, not a broadcast. `recipientUserId: undefined` with no
    // `recipientRole` is what "everyone in the workspace" looks like on the row.
    expect(n.recipientUserId, 'confidential-pii went out as a tenant-wide broadcast').toBe('u-ceo');
    // ISU-7 — the body carries the verdict the score node actually produced.
    expect(n.message, 'the notification body is still empty').toBe('High Performer');
    // ISU-8 — the deep link the bell drawer and dashboard tile need.
    expect(n.actionUrl).toMatch(/^\/runs\//);
  });

  it('weekly-variance KEEPS the tenant broadcast — and that is a decision, not an omission', async () => {
    // Stated rather than silently inconsistent. `self` resolves from the run's
    // acting user, and weekly-variance's real lane is the RFC 0052 scheduler,
    // where there is none: `surface.ts` would return
    // `no_acting_user_on_this_run` on every fire, forever. It also declares no
    // PII entity — only `insights.talentSnapshot` is registered
    // `confidential-pii` — so the report's "the two chains carrying
    // confidential-pii" over-counts by one.
    const tenantId = `t-n2-${Date.now()}`;
    const r = await runDefinition(buildInsightsMetaWorkflow(WEEKLY_VARIANCE_ID), maximalLaunch(WEEKLY_VARIANCE_ID), tenantId);
    expect(r.notify?.outputs.emitted).toBe(true);
    const inbox = await __hostExtStorage()!.listNotifications({ tenantId, limit: 20 });
    expect(inbox[0]!.recipientUserId).toBeUndefined();
    // …but it STILL gets the deep link, which is the half that was pure loss.
    expect(inbox[0]!.actionUrl).toMatch(/^\/runs\//);
  });

  it('anniversary-draft ALSO refuses on a system run — its only automated lane, stated not hidden', async () => {
    // ADR 0600 §Correction 6. §5 kept `tenant` on `weekly-variance` on exactly
    // this argument — "`self` resolves from the run's acting user, and its real
    // lane is the RFC 0052 scheduler, where there is none" — and then moved
    // `anniversary-draft` to `self` without applying it. Its automated ignition
    // is the webhook subscription, and `host/triggerIngestionService.ts` builds
    // the `RunRecord` with NO `actingUserId`. So on that lane the chain loses its
    // completion surface entirely.
    //
    // The trade is still the right one — the alternative is broadcasting a named
    // colleague's recognition draft workspace-wide, which is the harm §5 exists
    // to close — but it was UNSTATED, and `PROBE-IS-10`'s system-run case above
    // covers `talent-prep` only. This is the missing half of that pair: the
    // refusal is a decision, so it is asserted over the anniversary id too.
    const tenantId = `t-n4-${Date.now()}`;
    const def = buildInsightsMetaWorkflow(ANNIVERSARY_DRAFT_ID);
    const r = await runDefinition(def, maximalLaunch(ANNIVERSARY_DRAFT_ID), tenantId, connectorsStub(), { systemRun: true });
    expect(r.notify?.outputs.emitted).toBe(false);
    expect(r.notify?.outputs.reason).toBe('no_acting_user_on_this_run');
    // Fail-CLOSED, not fail-open: no row was written for anyone.
    expect(await __hostExtStorage()!.listNotifications({ tenantId, limit: 20 })).toHaveLength(0);
  });

  it('a run with NO acting user REFUSES rather than falling back to the broadcast', async () => {
    // The fail-closed direction that makes `self` safe to choose. A scheduled or
    // webhook-started talent-prep has no human; the surface says so in the
    // recorded outputs instead of notifying everyone the author never intended.
    const tenantId = `t-n3-${Date.now()}`;
    const def = buildInsightsMetaWorkflow(TALENT_PREP_ID);
    const r = await runDefinition(def, maximalLaunch(TALENT_PREP_ID), tenantId, connectorsStub(), { systemRun: true });
    expect(r.notify?.outputs.emitted).toBe(false);
    expect(r.notify?.outputs.reason).toBe('no_acting_user_on_this_run');
    expect(await __hostExtStorage()!.listNotifications({ tenantId, limit: 20 })).toHaveLength(0);
  });
});
