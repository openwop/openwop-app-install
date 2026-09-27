/**
 * `ctx.features.kicktodo-creator` (ADR 0415 P1) — the factory workflow
 * surface. Deterministic research framing lives HERE (host policy, not model
 * judgment); the pack nodes are thin adapters.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { OpenwopError } from '../../types.js';
import {
  createCandidate,
  getCandidate,
  getCandidatePlan,
  recordResearch,
  CLAIM_EXTRACTION_JSON_SCHEMA,
  CLAIM_VERDICT_JSON_SCHEMA,
  deriveAndBindCandidateDraft,
  DraftAlreadyPublishedError,
  sourceHash,
  type ResearchClaim,
  type ResearchSource,
  sourceDomain,
  evidenceClaimsForPrompt,
  supportedClaimIds,
} from './creatorService.js';
import { CHALLENGE_PLAN_JSON_SCHEMA, draftFromPlan, validatePlan, type PlanValidationOptions } from './planService.js';
import {
  submitForPublication,
  publicationView,
  PublicationGateError,
  SeparationOfDutiesError,
} from './publishService.js';
import { setCandidateSimulation } from './creatorService.js';
import {
  computeCheckpointBatches,
  normalizeSimulationVerdicts,
  setLessonMedia as setLessonMediaPointer,
  listLessonMedia,
  type CheckpointCadence,
  type LessonMediaKind,
  LESSON_JSON_SCHEMA,
} from './lessonAssembly.js';

/** The closed world a candidate's plan may cite: its dossier's claim ids. No
 *  candidate (a bare validate) or no dossier ⇒ undefined ⇒ refs unchecked. */
async function claimRefWorld(tenant: string, candidateId: string): Promise<PlanValidationOptions | undefined> {
  if (!candidateId) return undefined;
  const candidate = await getCandidate(tenant, candidateId);
  if (!candidate?.dossier) return undefined;
  return { knownClaimIds: supportedClaimIds(candidate.dossier) };
}

/** Deterministic question families (PRD §7.3 workflow 2 step 1) — templated,
 *  reviewable, and model-free: the model RESEARCHES the questions later; it
 *  never chooses what due diligence looks like. */
export function frameResearchQuestions(topic: string, audience: string): string[] {
  const t = topic.trim();
  const a = audience.trim() || 'busy adults';
  return [
    `What outcomes can ${a} realistically achieve with ${t} in 2–4 weeks?`,
    `What does current primary research and professional guidance say about ${t}?`,
    `What evidence CONTRADICTS common advice about ${t}?`,
    `What are the most common failure modes and barriers for ${a} attempting ${t}?`,
    `What safety considerations or contraindications apply to ${t}?`,
    `What accessibility alternatives exist for the core activities of ${t}?`,
    `Which daily actions for ${t} are supported by evidence rather than habit-industry folklore?`,
  ];
}

export function buildKicktodoCreatorSurface(scope: BundleScope): FeatureSurface {
  const tenant = scope.tenantId;
  return {
    createCandidate: async (args) => ({
      candidate: await createCandidate({
        tenantId: tenant,
        createdBy: surfaceStr(args.createdBy) || 'workflow',
        topic: surfaceStr(args.topic),
        audience: surfaceStr(args.audience),
        transformation: surfaceStr(args.transformation),
        durationDaysTarget: typeof args.durationDaysTarget === 'number' ? args.durationDaysTarget : 14,
        dailyMinutesTarget: typeof args.dailyMinutesTarget === 'number' ? args.dailyMinutesTarget : 15,
      }),
    }),
    getCandidate: async (args) => ({ candidate: await getCandidate(tenant, surfaceStr(args.candidateId)) }),
    frameResearch: async (args) => ({
      questions: frameResearchQuestions(surfaceStr(args.topic), surfaceStr(args.audience)),
    }),
    normalizeSource: async (args) => {
      const url = surfaceStr(args.url);
      const title = surfaceStr(args.title);
      // ARCH-5 — this used to parse the URL inline with an empty-string
      // fallback, which is exactly the permissive default the B7 fix calls
      // the bypass (an unparsable URL with domain '' matches no blocked-domain
      // entry). `recordResearch` re-derives anyway, so this was dead output —
      // but dead code that models the wrong rule is how the wrong rule comes
      // back. One derivation, shared.
      const domain = sourceDomain(url);
      const source: ResearchSource = {
        url,
        domain,
        title,
        hash: sourceHash(url, title),
        engine: surfaceStr(args.engine) || 'unknown',
        ...(typeof args.rank === 'number' ? { rank: args.rank } : {}),
      };
      return { source };
    },
    // ADR 0458 §2.2 (correction) — with a candidateId in scope the plan's
    // `claimRefs` are checked closed-world against that candidate's dossier.
    validatePlan: async (args) => ({ defects: validatePlan(args.plan, await claimRefWorld(tenant, surfaceStr(args.candidateId))) }),
    // ADR 0458 §2.2 (correction) — the STRUCTURED evidence (claim ids + sources)
    // every text-producing factory step is grounded on, derived from the recorded
    // dossier here (the SSoT) so no node re-derives it from raw rows.
    evidenceClaims: async (args) => {
      const candidate = await getCandidate(tenant, surfaceStr(args.candidateId));
      return { claims: evidenceClaimsForPrompt(candidate?.dossier) };
    },
    // ADR 0458 §2.2 (correction) — the lesson-shape SSoT for the lesson-batch-build
    // node (responseSchema + prompt grounding at call time; the planSchema pattern).
    lessonSchema: async () => ({ schema: LESSON_JSON_SCHEMA as unknown as Record<string, unknown> }),
    // XCH-KT-1 — the plan-shape SSoT read: the JSON schema `validatePlan` shares
    // its vocabulary with, for the plan-generate node to hand the model as
    // responseSchema + prompt grounding at call time (never a hand-copy).
    planSchema: async () => ({ schema: CHALLENGE_PLAN_JSON_SCHEMA as unknown as Record<string, unknown> }),
    // ADR 0494 P2 — the claim-shape SSoT, handed to the claim-extract node as
    // responseSchema so prompt + recorder agree by construction (the planSchema
    // pattern). Never a hand-copy in a prompt.
    claimSchema: async () => ({ schema: CLAIM_EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown> }),
    // ADR 0494 P2b — the entailment-verdict SSoT for the claim-verify node.
    verdictSchema: async () => ({ schema: CLAIM_VERDICT_JSON_SCHEMA as unknown as Record<string, unknown> }),
    // ADR 0458 §2.2 — the deterministic checkpoint batching (host policy, never
    // model judgment). Runs AFTER plan-validate, but re-validates defensively:
    // a malformed plan is a typed failure, never silent outline-only. Days are
    // read from the SAME validated plan the outline gate approved (single SoT).
    checkpointPlan: async (args) => {
      const defects = validatePlan(args.plan);
      if (defects.length) {
        throw new OpenwopError('validation_error', 'checkpointPlan requires a validated plan.', 400, { defects });
      }
      const plan = args.plan as { days?: Array<{ day?: unknown }> };
      const dayNumbers = (plan.days ?? [])
        .map((d) => d.day)
        .filter((d): d is number => typeof d === 'number');
      const cadence: CheckpointCadence = args.checkpointEvery === 'outline-only' ? 'outline-only' : 'batched';
      return { plan: computeCheckpointBatches(dayNumbers, cadence) };
    },
    // ADR 0458 §2.2 — the app-owned lesson-media pointer (replace-on-retry). The
    // pack node persists the generated asset via `ctx.features.media`
    // (createAssetFromServeUrl — the sanctioned reach) then calls THIS with the
    // resulting `assetId`, so persistence stays in node-context while the
    // deterministic `(candidate, day)` pointer lives on the app side.
    setLessonMedia: async (args) => {
      const candidateId = surfaceStr(args.candidateId);
      const assetId = surfaceStr(args.assetId);
      const day = typeof args.day === 'number' ? args.day : NaN;
      const kind = surfaceStr(args.kind) as LessonMediaKind;
      try {
        const pointer = await setLessonMediaPointer({ tenantId: tenant, candidateId, day, assetId, kind });
        return { pointer };
      } catch (err) {
        throw new OpenwopError('validation_error', err instanceof Error ? err.message : 'Invalid lesson media.', 400);
      }
    },
    lessonMedia: async (args) => ({ pointers: await listLessonMedia(tenant, surfaceStr(args.candidateId)) }),
    // ADR 0458 §2.2 — the sim stage's terminal write: closed-world-normalize the
    // three personas' returns (an off-shape or unreadable verdict never silently
    // passes — it degrades to `block`) and record them on the candidate for the
    // publication `simulation` gate to read.
    recordSimulationVerdicts: async (args) => {
      const candidateId = surfaceStr(args.candidateId);
      if (!candidateId) throw new OpenwopError('validation_error', 'Field `candidateId` is required.', 400);
      const verdicts = normalizeSimulationVerdicts(args.verdicts);
      const candidate = await setCandidateSimulation(tenant, candidateId, verdicts);
      if (!candidate) throw new OpenwopError('not_found', 'Candidate not found.', 404);
      return { verdicts, state: candidate.state };
    },
    draftFromPlan: async (args) => {
      // ADR 0441 (TD1 binding) — bind the draft to its candidate so the Studio's
      // publication submit can reference it. candidateId flows from the decompose
      // node (it is already the plan-generate input). KT-EXP-8 — the draft id is
      // DETERMINISTIC per candidate, so a re-decompose overwrites the one draft.
      // ADR 0458 §2.3 — a candidate decompose also stamps the VALIDATED plan
      // revision (the SSoT) through the shared `deriveAndBindCandidateDraft` flow
      // the canvas apply route reuses. Absent candidateId (a bare decompose) is
      // draft-only — nothing to bind or stamp.
      const candidateId = surfaceStr(args.candidateId);
      const authorSubject = surfaceStr(args.authorSubject) || 'workflow';
      if (!candidateId) return { challenge: await draftFromPlan(tenant, authorSubject, args.plan) };
      try {
        const { challenge } = await deriveAndBindCandidateDraft(tenant, authorSubject, candidateId, args.plan);
        return { challenge };
      } catch (err) {
        if (err instanceof DraftAlreadyPublishedError) {
          throw new OpenwopError('conflict', err.message, 409, { challengeId: err.challengeId, challengeVersion: err.challengeVersion });
        }
        throw err;
      }
    },
    // ADR 0458 §2.3 — the SSoT read: the candidate's current validated plan
    // revision (the canvas seed + apply loop read this). Null until first decompose.
    getCandidatePlan: async (args) => {
      const rev = await getCandidatePlan(tenant, surfaceStr(args.candidateId));
      return { planRevision: rev };
    },
    recordResearch: async (args) => ({
      candidate: await recordResearch(tenant, surfaceStr(args.candidateId), {
        questions: Array.isArray(args.questions) ? (args.questions as string[]).filter((q) => typeof q === 'string') : [],
        sources: (Array.isArray(args.sources) ? args.sources : []) as ResearchSource[],
        claims: (Array.isArray(args.claims) ? args.claims : []) as ResearchClaim[],
      }),
    }),
    // ADR 0458 §2.2 step 7 — the factory's TERMINAL submit op, calling the SAME
    // `publishService.submitForPublication` the REST route uses. The challenge
    // binding is read from the candidate's ADR 0441 `draft` (never a workflow
    // input — a run cannot submit an unrelated challenge), the deterministic
    // publication gates re-run server-side, and the act only ever RAISES the
    // separation-of-duties `challenge-publish` approval — it NEVER completes
    // publication (a distinct identity decides that in the reviews inbox). The
    // submitter is the run's acting human (`scope.actingUserId`), so the SoD
    // check at complete-time has a real submitter to differ from. Idempotent (a
    // re-submit returns the pending act). Domain refusals are re-thrown as
    // `OpenwopError`s carrying a `.code` so the thin pack node surfaces a typed
    // failure rather than crashing the run.
    submitPublication: async (args) => {
      const candidateId = surfaceStr(args.candidateId);
      if (!candidateId) throw new OpenwopError('validation_error', 'Field `candidateId` is required.', 400);
      const submittedBy = scope.actingUserId;
      if (!submittedBy) {
        throw new OpenwopError('validation_error', 'An acting user is required to submit a challenge for publication.', 400);
      }
      const candidate = await getCandidate(tenant, candidateId);
      if (!candidate) throw new OpenwopError('not_found', 'Candidate not found.', 404);
      if (!candidate.draft) {
        throw new OpenwopError('validation_error', 'This candidate has no decomposed draft to submit — decompose the plan first.', 400);
      }
      try {
        const record = await submitForPublication(
          tenant,
          candidateId,
          candidate.draft.challengeId,
          candidate.draft.challengeVersion,
          submittedBy,
        );
        const view = publicationView(record);
        return { approvalId: view.approvalId, state: view.state };
      } catch (err) {
        if (err instanceof SeparationOfDutiesError) throw new OpenwopError('forbidden', err.message, 403);
        if (err instanceof PublicationGateError) throw new OpenwopError('conflict', err.message, 409, { gate: err.gate });
        throw err;
      }
    },
  };
}
