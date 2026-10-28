/**
 * ADR 0458 §2.2 — the Challenge Factory workflow's node chain, end to end.
 *
 * HAPPY PATH — every node adapter in the factory chain is driven in order against
 * honest stand-ins (a non-stub web-search result, a validated plan from
 * `ctx.callAI`, an approved outline gate). The candidate reaches a SUBMITTED
 * publication with a `challenge-publish` approval raised — and NO in-run step
 * completes publication (a distinct identity decides that). Red if the submit
 * path completes the publication record (`completedAt`), or if decompose stops
 * binding the draft to its candidate.
 *
 * Cut in w41 /grade-tests (each covering case witnessed red under the same
 * sabotage, reports/probe-w41g1-*):
 *  - the old "(B)" gate-branch block (real approvalGate + scheduler + resume on a
 *    reject/approve resolution) and the "outline gate emits approved=false" case —
 *    the identical harness is `kicktodo-lesson-assembly.test.ts` (D) "a LIVE slot
 *    REJECTED / APPROVED" (fac-gate-approved-covering);
 *  - the old "(C)" structural block — it read the TS `kicktodoCreatorBuiltinWorkflows`
 *    edges, which do NOT ship (the registered definition is expanded from
 *    `examples/workflow-chain-packs/kicktodo-challenge-factory/pack.json`); flipping
 *    the SHIPPED edge left it green. The shipped edges are pinned by
 *    `chain-backed-flagships.test.ts` "the truthy/falsy reject-safe barrier
 *    round-trips" (fac-shipped-chain-edge-covering).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { setChatStorage } from '../src/host/chatSurface.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { buildKicktodoCreatorSurface } from '../src/features/kicktodo-creator/surface.js';
import { createCandidate, getCandidate } from '../src/features/kicktodo-creator/creatorService.js';
import { getPublication } from '../src/features/kicktodo-creator/publishService.js';
import { getApproval } from '../src/host/approvalService.js';
import type { NodeContext, NodeOutcome } from '../src/executor/types.js';
import type { FeatureSurface } from '../src/host/featureSurfaces.js';
import type { WebResearchSurface } from '../src/host/webResearchSurface.js';

const packUrl = new URL('../../../packs/feature.kicktodo.nodes/index.mjs', import.meta.url).href;
const chatUrl = new URL('../../../packs/vendor.myndhyve.chat/index.mjs', import.meta.url).href;

/** The untyped pack nodes' outcome, read field-by-field as `unknown`. */
interface PackOutcome { status: string; outputs?: Record<string, unknown>; error?: unknown }
type NodeFn = (ctx: Record<string, unknown>) => Promise<PackOutcome>;

/** A plan that genuinely passes the authoritative `validatePlan` (KTFULL-B3). */
const VALID_PLAN = {
  title: 'Paint your first watercolor in three weeks',
  promise: 'Complete a simple watercolor from a reference photo.',
  audience: 'Absolute beginners',
  durationDays: 3,
  dailyMinutesBudget: 20,
  outcomes: [{ outcomeId: 'o1', measurableOutcome: 'Finish one watercolor study on 3 of 3 days', method: 'Photo of the finished study' }],
  achievements: [{ achievementId: 'a1', observableEvidence: 'Three completed studies', outcomeIds: ['o1'] }],
  days: [1, 2, 3].map((day) => ({
    day,
    stableActivityId: `study-${day}`,
    title: `Watercolor study, day ${day}`,
    actionInstruction: 'Paint a small study from the reference.',
    userFacingWhy: 'Repetition builds brush control.',
    estimatedMinutes: 15,
    achievementIds: ['a1'],
    evidencePolicy: 'photo' as const,
  })),
};

/** A success outcome's outputs, or a failed assertion naming the outcome. */
function successOutputs(o: NodeOutcome): Record<string, unknown> {
  if (o.status !== 'success' || typeof o.outputs !== 'object' || o.outputs === null) {
    throw new Error(`expected a success outcome, got ${JSON.stringify(o)}`);
  }
  return { ...o.outputs };
}

let packNodes: Record<string, NodeFn>;
let approvalGateFn: NodeFn;

const storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initHostExtPersistence(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kt-factory-')) });
setChatStorage(storage); // the approvalGate emits a card through the chat surface

beforeAll(async () => {
  ensureNodesRegistered();
  const packMod: { nodes: Record<string, NodeFn> } = await import(packUrl);
  packNodes = packMod.nodes;
  const chatMod: { approvalGate: NodeFn } = await import(chatUrl);
  approvalGateFn = chatMod.approvalGate;
});

describe('the factory happy path reaches a submitted publication (ADR 0458 §2.2)', () => {
  it('drives research → search → normalize → evidence → plan → approve → validate → decompose → submit', async () => {
    const T = 'tenant-kt-factory';
    const AUTHOR = 'user:factory-author';
    const surface = buildKicktodoCreatorSurface({ tenantId: T, actingUserId: AUTHOR });
    const features: Record<string, FeatureSurface> = { 'kicktodo-creator': surface };
    const bag = new Map<string, unknown>();
    const variables = { get: (n: string) => bag.get(n), set: (n: string, v: unknown) => bag.set(n, v) };

    const candidate = await createCandidate({
      tenantId: T, createdBy: AUTHOR, topic: 'Watercolor painting basics', audience: 'absolute beginners',
      transformation: '', durationDaysTarget: 3, dailyMinutesTarget: 15,
    });
    bag.set('candidateId', candidate.id);
    bag.set('topic', 'Watercolor painting basics');
    bag.set('audience', 'absolute beginners');
    bag.set('authorSubject', AUTHOR);

    const mkctx = (nodeId: string, inputs: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      ({ runId: 'run-factory-A', nodeId, tenantId: T, actingUserId: AUTHOR, inputs, features, variables, ...extra });

    // 1. research-frame
    const frame = await packNodes['feature.kicktodo.nodes.research-frame']!(mkctx('research-frame', { topic: 'Watercolor painting basics', audience: 'absolute beginners', transformation: 'paint a simple landscape in one sitting' }));
    expect(frame.status).toBe('success');
    const questions = frame.outputs?.questions;
    expect(Array.isArray(questions) && questions.length > 0).toBe(true);
    // ADR 0975 D3 — the node emits the search query the chain wires into search.query.
    const searchQuery = frame.outputs?.searchQuery;
    expect(searchQuery).toBe('Watercolor painting basics: paint a simple landscape in one sitting — research evidence and practical guidance');

    // 2. core.web.search — honest non-stub stand-in (`engine:'brave'`) via a
    //    stub webResearch surface (no live egress / SSRF guard in a unit test).
    const search = getNodeRegistry().get('core.web.search');
    if (!search) throw new Error('core.web.search is not registered');
    const webResearch: WebResearchSurface = {
      search: async () => ({ results: [{ url: 'https://example.org/watercolor-guide', title: 'A beginner watercolor guide', snippet: 'Start simple.', rank: 1 }], engine: 'brave', totalResults: 1 }),
      fetchBatch: async () => ({ pages: [] }),
      research: async () => ({ citations: [] }),
    };
    const searchCtx: NodeContext = {
      runId: 'run-factory-A', nodeId: 'search', tenantId: T, actingUserId: AUTHOR,
      inputs: { query: searchQuery, maxResults: 8 },
      configurable: {}, attempt: 1, secrets: {}, features, webResearch,
      emit: async () => ({ eventId: 'evt-search', sequence: 0 }),
    };
    const searchOut = successOutputs(await search.execute(searchCtx));
    expect(searchOut.engine).toBe('brave');

    // 3. source-normalize (receives the search node's outputs via the edge)
    const normalize = await packNodes['feature.kicktodo.nodes.source-normalize']!(mkctx('normalize', { results: searchOut.results, engine: searchOut.engine }));
    const sources = normalize.outputs?.sources;
    expect(Array.isArray(sources) ? sources.length : -1).toBe(1);

    // 4. evidence-graph — records a NON-STUB dossier (engine 'brave' passes the
    //    honesty gate); no claims ⇒ nothing unsupported.
    const graph = await packNodes['feature.kicktodo.nodes.evidence-graph']!(mkctx('evidence-graph', { candidateId: candidate.id, questions, sources, claims: [] }));
    expect(graph.status).toBe('success');

    // 5. plan-generate — honest `ctx.callAI` returning the VALID_PLAN; the node
    //    validates it authoritatively and writes `plan` to the bag.
    const callAI = async () => ({ data: VALID_PLAN });
    const generate = await packNodes['feature.kicktodo.nodes.plan-generate']!(mkctx('generate', { candidateId: candidate.id, topic: 'Watercolor painting basics', audience: 'absolute beginners', evidenceSummary: bag.get('evidenceSummary') }, { callAI }));
    expect(generate.status).toBe('success');
    expect(bag.get('plan')).toEqual(expect.objectContaining({ title: VALID_PLAN.title, durationDays: 3 }));

    // 6. outline-approve (REAL core.chat.approvalGate) — approved.
    const approve = await approvalGateFn(mkctx('outline-approve', { artifact: bag.get('plan') }, { config: { title: 'Approve the challenge outline?', artifactType: 'challenge-outline', maxRequestChangesIterations: 0 }, suspend: async () => ({ decision: 'approved', approved: true }) }));
    expect(approve.outputs?.approved).toBe(true);

    // 7. plan-validate
    const validate = await packNodes['feature.kicktodo.nodes.plan-validate']!(mkctx('plan-validate', { plan: bag.get('plan') }));
    expect(validate.outputs?.valid).toBe(true);

    // 8. decompose — drafts the challenge + binds it to the candidate (ADR 0441).
    const decompose = await packNodes['feature.kicktodo.nodes.decompose']!(mkctx('decompose', { plan: bag.get('plan'), authorSubject: AUTHOR, candidateId: candidate.id }));
    expect(decompose.status).toBe('success');
    const bound = await getCandidate(T, candidate.id);
    expect(bound?.draft).toEqual({ challengeId: expect.stringMatching(/^chal:ktc-/), challengeVersion: 1 });
    expect(bound?.state).toBe('planned');

    // 8b. simulation stage — the three sim personas' verdicts recorded on the
    //     candidate (ADR 0458 P2). The publication `simulation` gate reads these;
    //     without them the submit below fails the gate.
    const recordSimulationVerdicts = surface.recordSimulationVerdicts;
    if (!recordSimulationVerdicts) throw new Error('recordSimulationVerdicts is not on the creator surface');
    await recordSimulationVerdicts({
      candidateId: candidate.id,
      // the persona-tagged array sim-collect forwards (ADR 0458 P2): verbatim
      // sim-verdict schema bodies + the port-derived `sim` routing tag.
      verdicts: [
        { sim: 'newcomer', verdict: 'pass', personaSummary: 'clear', findings: [] },
        { sim: 'time-poor', verdict: 'flag', personaSummary: 'tight on day 2', findings: [{ severity: 'flag', text: 'day-2-load', day: 2 }] },
        { sim: 'skeptic', verdict: 'pass', personaSummary: 'sourced', findings: [] },
      ],
    });

    // 9. submit-publication — raises the SoD approval; NEVER completes publication.
    const submit = await packNodes['feature.kicktodo.nodes.submit-publication']!(mkctx('submit', { candidateId: candidate.id }));
    expect(submit.status).toBe('success');
    expect(submit.outputs?.state).toBe('submitted');

    // The publication act exists, is submitted-but-not-completed, and its approval
    // is the separation-of-duties `challenge-publish` kind.
    const publication = await getPublication(T, candidate.id);
    expect(publication?.approvalId).toBe(submit.outputs?.approvalId);
    expect(publication?.submittedBy).toBe(AUTHOR);
    expect(publication?.completedAt).toBeUndefined();
    expect(publication?.completedBy).toBeUndefined();
    expect((await getApproval(publication?.approvalId ?? ''))?.kind).toBe('challenge-publish');
    // And the challenge is NOT published — the candidate is still 'planned'.
    expect((await getCandidate(T, candidate.id))?.state).toBe('planned');
  });
});
