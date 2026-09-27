/**
 * Campaign Brief workflow surface (ADR 0156 Phase 3 / ADR 0014) —
 * `ctx.features['campaign-brief']`. Tenant-trusted reads + the pure context
 * assembler + `validate` + the kernel write the node calls. Generation (the LLM
 * kernel) stays in the node where the run-scoped provider + brand/kb surfaces are.
 *
 * @see docs/adr/0156-campaign-studio-personas-brief.md
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { getPersona, listPersonas } from './personaService.js';
import { getBrief, listBriefs, setKernel, validateBrief } from './briefService.js';
import { assembleBriefContextText } from './briefContext.js';
import { listVocEvidence, persistVocEvidence, validateVocCandidate, type VocEvidenceInput, type VocSentiment, VOC_SENTIMENTS } from './vocService.js';
import { listAngles, persistAngles, deleteAngle, validateAngleCandidate, type AngleCandidateInput } from './angleService.js';
import { emitCandidateHooks, listHooks, type HookStatus, HOOK_STATUSES } from './hookBankService.js';
import { getTargetingPack, listTargetingPacks, persistTargetingPack, validateTargetingCandidate, isTargetingPlatform, type TargetingCandidateInput } from './targetingService.js';
import { OpenwopError } from '../../types.js';
import type { MessagingKernel } from './types.js';

export function buildCampaignBriefSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    listPersonas: async (args) => ({ personas: await listPersonas(tenantId, optStr(args.orgId), optStr(args.brandId)) }),
    getPersona: async (args) => ({ persona: (await getPersona(tenantId, str(args.personaId))) ?? null }),

    listBriefs: async (args) => ({ briefs: await listBriefs(tenantId, optStr(args.orgId)) }),
    getBrief: async (args) => ({ brief: (await getBrief(tenantId, str(args.briefId))) ?? null }),

    /** Validate completeness + the enabled channel set (drives 0158 fan-out). */
    validateBrief: async (args) => {
      const brief = await getBrief(tenantId, str(args.briefId));
      if (!brief) return { valid: false, issues: [{ field: 'briefId', message: 'Brief not found.' }], enabledChannels: [] };
      return { ...validateBrief(brief) };
    },

    /**
     * Assemble the brief-owned context block (product + audience + messaging) plus
     * the metadata the node needs to add the brand-voice + KB grounding legs.
     */
    assembleContext: async (args) => {
      const brief = await getBrief(tenantId, str(args.briefId));
      if (!brief) return { found: false };
      const personas = (await Promise.all(brief.personaIds.map((id) => getPersona(tenantId, id)))).filter((p): p is NonNullable<typeof p> => p !== null);
      return {
        found: true,
        brief: {
          id: brief.id,
          orgId: brief.orgId,
          brandId: brief.brandId ?? '',
          kbCollectionId: brief.kbCollectionId ?? '',
          productName: brief.productName,
          industryVertical: brief.industryVertical,
          // ADR 0351 P2: the packs read this off the projection — omitting it made
          // strict grounding silently degrade to best-effort (KB-CODE-13).
          groundingPolicy: brief.groundingPolicy ?? 'best-effort',
          // FU-CODE-1 (same seam class as KB-CODE-13): the channels pack reads
          // `brief.competitors` (the ADR 0355 P5 differentiation block) and
          // `brief.personaIds` (the persona-lens resolveVoice) off this
          // projection — both Array.isArray-guarded, so an omission silently
          // no-ops. The projection-contract test in
          // test/campaign-brief-kb-integration.test.ts pins every pack read.
          competitors: brief.competitors ?? [],
          personaIds: brief.personaIds ?? [],
        },
        // The kernel (ADR 0156) — channel generators (ADR 0157) echo it.
        kernel: brief.kernel ?? null,
        // ADR 0403 P2 — TESTED hooks only (human-attested via the promote
        // route; candidates are unvetted model output and feeding them back
        // into generation would be a self-reinforcing ungraded loop), capped
        // so the projection stays prompt-sized. Top-level sibling of `kernel`;
        // the projection pin lives in test/campaign-brief-kb-integration.test.ts.
        hooks: (await listHooks(tenantId, brief.orgId, { status: 'tested', limit: 20 }))
          .map((h) => ({ id: h.id, text: h.text, format: h.format, ...(h.angleId ? { angleId: h.angleId } : {}) })),
        contextText: assembleBriefContextText(brief, personas),
        ...validateBrief(brief),
      };
    },

    /** Persist a generated kernel (the node calls this after ctx.callAI). */
    setKernel: async (args) => {
      const kernel = args.kernel as MessagingKernel;
      const updated = await setKernel(tenantId, str(args.briefId), kernel);
      return { brief: updated ?? null };
    },

    // ── ADR 0403 — market-intel reads + the nodes' narrow writes ────────────

    /** VOC evidence for a brief (quote-level, citation-carrying). */
    listVocEvidence: async (args) => {
      const sentiment = optStr(args.sentiment);
      return {
        evidence: await listVocEvidence(tenantId, str(args.briefId), {
          ...(sentiment && (VOC_SENTIMENTS as readonly string[]).includes(sentiment) ? { sentiment: sentiment as VocSentiment } : {}),
          ...(optStr(args.theme) ? { theme: optStr(args.theme)! } : {}),
        }),
      };
    },

    /**
     * The extract-voc node's write (the setKernel precedent — ONE narrow,
     * validated write). Candidates are closed-world validated HERE (the TS
     * SSoT); invalid ones are dropped WITH a finding, and an all-dropped batch
     * is a typed failure — never success-with-empty (the grounding invariant).
     */
    persistVoc: async (args) => {
      const briefId = str(args.briefId);
      const brief = await getBrief(tenantId, briefId);
      if (!brief) throw new OpenwopError('not_found', `Brief '${briefId}' not found.`, 404);
      const raw = Array.isArray(args.candidates) ? (args.candidates as VocEvidenceInput[]) : [];
      const findings: ReturnType<typeof validateVocCandidate>[] = raw.map((c, i) => validateVocCandidate(c, i));
      const valid = findings.flatMap((f) => (f.ok ? [f.item] : []));
      const dropped = findings.flatMap((f) => (f.ok ? [] : [f.finding]));
      if (valid.length === 0) {
        throw new OpenwopError('validation_error', 'Every extracted candidate failed the grounding invariant (a quote must cite a resolvable source).', 422, { findings: dropped.slice(0, 10) });
      }
      const persisted = await persistVocEvidence(tenantId, brief.orgId, briefId, scope.actingUserId ?? 'agent', valid);
      return { evidence: persisted, droppedFindings: dropped };
    },

    /** Ad angles for a brief (each grounded in proofRefs → voc-evidence). */
    listAngles: async (args) => ({ angles: await listAngles(tenantId, str(args.briefId)) }),

    /** The org hook bank (reads; promotion is a route-only HUMAN write). */
    listHooks: async (args) => {
      const status = optStr(args.status);
      return {
        hooks: await listHooks(tenantId, str(args.orgId), {
          ...(status && (HOOK_STATUSES as readonly string[]).includes(status) ? { status: status as HookStatus } : {}),
        }),
      };
    },

    /**
     * The generate-angles node's write (ADR 0403 P2). Closed-world: every
     * proofRef must resolve to a stored voc-evidence row of THIS brief at
     * persist time — the surface never trusts node/model-supplied ids. Invalid
     * candidates drop WITH findings; all-dropped is a typed 422. Angles persist
     * FIRST; their hook variants then project into the ORG bank as `candidate`
     * hooks with deterministic ids (idempotent, non-demoting) — a bank
     * emission failure is reported honestly, never fails the angles.
     */
    persistAngles: async (args) => {
      const briefId = str(args.briefId);
      const brief = await getBrief(tenantId, briefId);
      if (!brief) throw new OpenwopError('not_found', `Brief '${briefId}' not found.`, 404);
      const validIds = new Set((await listVocEvidence(tenantId, briefId)).map((e) => e.id));
      const raw = Array.isArray(args.candidates) ? (args.candidates as AngleCandidateInput[]) : [];
      const findings = raw.map((c, i) => validateAngleCandidate(c, i, validIds));
      const valid = findings.flatMap((f) => (f.ok ? [f.item] : []));
      const dropped = findings.flatMap((f) => (f.ok ? [] : [f.finding]));
      if (valid.length === 0) {
        throw new OpenwopError('validation_error', 'Every angle failed the grounding invariant (non-empty proofRefs resolving to stored evidence).', 422, { findings: dropped.slice(0, 10) });
      }
      const persisted = await persistAngles(tenantId, brief.orgId, briefId, scope.actingUserId ?? 'agent', valid);
      // MI-1 (grade pass): close the validate→put TOCTOU — evidence deleted
      // concurrently would leave a just-persisted angle dangling. Re-check and
      // roll back any angle whose refs no longer all resolve (finding, not
      // silence). The 409 route guard covers the human path; this covers the race.
      const postIds = new Set((await listVocEvidence(tenantId, briefId)).map((e) => e.id));
      const survivors: typeof persisted = [];
      for (const angle of persisted) {
        if (angle.proofRefs.every((r) => postIds.has(r))) { survivors.push(angle); continue; }
        await deleteAngle(tenantId, briefId, angle.id);
        dropped.push({ index: -1, field: 'proofRefs', message: `Angle '${angle.claim.slice(0, 60)}' lost a cited evidence row to a concurrent delete — rolled back.` });
      }
      if (survivors.length === 0) {
        throw new OpenwopError('validation_error', 'Every angle lost its cited evidence to a concurrent delete.', 422, { findings: dropped.slice(0, 10) });
      }
      const emittedHooks: unknown[] = [];
      const hookEmissionErrors: unknown[] = [];
      let skippedExistingHooks = 0;
      for (const angle of survivors) {
        const r = await emitCandidateHooks(tenantId, brief.orgId, angle.id, angle.hookVariants, scope.actingUserId ?? 'agent');
        emittedHooks.push(...r.emitted);
        hookEmissionErrors.push(...r.errors);
        skippedExistingHooks += r.skippedExisting.length;
      }
      return { angles: survivors, droppedFindings: dropped, emittedHooks, skippedExistingHooks, hookEmissionErrors };
    },

    // ── ADR 0403 Phase 3 — targeting packs ──────────────────────────────────

    /** THE pack for a brief+platform (null when absent). */
    getTargetingPack: async (args) => {
      const platform = optStr(args.platform);
      if (!isTargetingPlatform(platform)) return { pack: null };
      return { pack: await getTargetingPack(tenantId, str(args.briefId), platform) };
    },

    listTargetingPacks: async (args) => ({ packs: await listTargetingPacks(tenantId, str(args.briefId)) }),

    /**
     * The build-targeting node's write. Closed-world: platform enum +
     * every evidenceRef resolves to stored voc-evidence of THIS brief at
     * persist time. A failed candidate is a typed 422 (single-item op —
     * there is no partial batch to drop from). Deterministic brief+platform
     * key: a re-run replaces, never duplicates.
     */
    persistTargeting: async (args) => {
      const briefId = str(args.briefId);
      const brief = await getBrief(tenantId, briefId);
      if (!brief) throw new OpenwopError('not_found', `Brief '${briefId}' not found.`, 404);
      const validIds = new Set((await listVocEvidence(tenantId, briefId)).map((e) => e.id));
      const verdict = validateTargetingCandidate((args.candidate ?? {}) as TargetingCandidateInput, validIds);
      if (!verdict.ok) {
        throw new OpenwopError('validation_error', `Targeting pack failed the grounding invariant: ${verdict.finding.message}`, 422, { finding: verdict.finding });
      }
      return { pack: await persistTargetingPack(tenantId, brief.orgId, briefId, scope.actingUserId ?? 'agent', verdict.item) };
    },
  };
}
