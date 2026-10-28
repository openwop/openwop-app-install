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
import { runOrgScopeFilter } from '../../host/accessControlService.js';
import type { Scope } from '../../host/accessControlService.js';
import type { CampaignBrief, MessagingKernel } from './types.js';

export function buildCampaignBriefSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  // Org scoping (the ADR 0832 floor, extended to rows named by id). Briefs, personas,
  // evidence, angles and targeting packs belong to ONE org, but every by-id read here
  // used to be tenant-only: in an agency workspace a run for client A could read,
  // ground on, or write client B's brief. The seam's floor only fires when a method
  // receives `orgId`, and these take an id instead. So:
  //  - `orgId` given: the seam has already checked the run's person against it; the
  //    row must ALSO belong to it, else a uniform not-found;
  //  - `orgId` absent: the run's person (actor, else causing member) must hold the
  //    scope in the ROW's org, else the same uniform not-found;
  //  - no person (an actorless, causeless run): unchanged, the seam's own rule.
  //    ACCEPTED RESIDUAL (security review of this fix, 2026-10-20): a scheduled or
  //    system run with neither an actor nor a causing member stays TENANT-WIDE here
  //    (`if (!subject) return true`), exactly as the ADR 0832 floor treats every
  //    surface. It is by design, not an oversight: there is no person to scope to,
  //    and such runs are host- or operator-authored. Do not "fix" it here alone; a
  //    change belongs to the seam, for every surface at once.
  const subject = scope.actingUserId ?? scope.orgScopeSubject;
  const cause = !scope.actingUserId && !!scope.orgScopeSubject;
  const mayUseOrg = async (rowOrgId: string, argsOrgId: string | undefined, needed: Scope): Promise<boolean> => {
    if (argsOrgId) return rowOrgId === argsOrgId;
    if (!subject) return true;
    return (await runOrgScopeFilter(tenantId, subject, [rowOrgId], needed, { cause })).has(rowOrgId);
  };
  /** A list with no `orgId`: keep only the orgs the run's person may read. */
  const visibleOrgs = async <T extends { orgId: string }>(rows: T[], argsOrgId: string | undefined): Promise<T[]> => {
    if (argsOrgId || !subject) return rows;
    const allowed = await runOrgScopeFilter(tenantId, subject, rows.map((r) => r.orgId), 'workspace:read', { cause });
    return rows.filter((r) => allowed.has(r.orgId));
  };
  /** The brief named by `args.briefId`, or null when absent OR out of scope. */
  const scopedBrief = async (briefId: string, orgId: string | undefined, needed: Scope = 'workspace:read'): Promise<CampaignBrief | null> => {
    const brief = await getBrief(tenantId, briefId);
    if (!brief) return null;
    return (await mayUseOrg(brief.orgId, orgId, needed)) ? brief : null;
  };
  const notFound = (briefId: string): OpenwopError => new OpenwopError('not_found', `Brief '${briefId}' not found.`, 404);
  return {
    listPersonas: async (args) => ({ personas: await visibleOrgs(await listPersonas(tenantId, optStr(args.orgId), optStr(args.brandId)), optStr(args.orgId)) }),
    getPersona: async (args) => {
      const persona = await getPersona(tenantId, str(args.personaId));
      return { persona: persona && (await mayUseOrg(persona.orgId, optStr(args.orgId), 'workspace:read')) ? persona : null };
    },

    listBriefs: async (args) => ({ briefs: await visibleOrgs(await listBriefs(tenantId, optStr(args.orgId)), optStr(args.orgId)) }),
    getBrief: async (args) => ({ brief: await scopedBrief(str(args.briefId), optStr(args.orgId)) }),

    /** ADR 0956 D5 — the ONE tracked-URL helper for outbound links: stamps the
     *  brief's UTM schema (the owner of `BriefUtm`) plus the variant key and ad
     *  reference, and — when Campaign Intelligence is on for the tenant — lints
     *  the result against the brief's client-org UTM policy. A caller must not
     *  publish a link with violations (`utm_policy_violation`). */
    trackedUrl: async (args) => {
      const briefId = str(args.briefId);
      // Org-scoped like every by-id method here: a brief outside the run's org (or
      // outside the orgs the run's person may read) is the same not-found as a
      // missing one, so a run for client A cannot mint client B's tracked link or
      // read B's UTM policy verdict.
      const brief = await scopedBrief(briefId, optStr(args.orgId));
      if (!brief) throw notFound(briefId);
      const { buildTrackedUrl } = await import('../../host/trackedUrl.js');
      const url = buildTrackedUrl(str(args.url), brief.utm, {
        fallbackCampaign: briefId,
        ...(optStr(args.variantKey) ? { variantKey: optStr(args.variantKey) } : {}),
        ...(optStr(args.adRef) ? { adRef: optStr(args.adRef) } : {}),
      });
      const { resolveOne } = await import('../../host/featureToggles/service.js');
      const intel = await resolveOne('campaign-intel', { tenantId });
      if (!intel?.enabled) return { url, linted: false, violations: [] };
      // Fail closed: a policy that cannot be read is an error, never "no violations".
      const { lintUrls } = await import('../campaign-intel/utmGovernance.js');
      const out = await lintUrls(tenantId, brief.orgId, [url]);
      return { url, linted: true, policyVersion: out.policyVersion, violations: out.results[0]?.violations ?? [] };
    },

    /** Validate completeness + the enabled channel set (drives 0158 fan-out). */
    validateBrief: async (args) => {
      const brief = await scopedBrief(str(args.briefId), optStr(args.orgId));
      if (!brief) return { valid: false, issues: [{ field: 'briefId', message: 'Brief not found.' }], enabledChannels: [] };
      return { ...validateBrief(brief) };
    },

    /**
     * Assemble the brief-owned context block (product + audience + messaging) plus
     * the metadata the node needs to add the brand-voice + KB grounding legs.
     */
    assembleContext: async (args) => {
      const brief = await scopedBrief(str(args.briefId), optStr(args.orgId));
      if (!brief) return { found: false };
      // Only the brief's own org's personas, whatever ids the row carries.
      const personas = (await Promise.all(brief.personaIds.map((id) => getPersona(tenantId, id)))).filter((p): p is NonNullable<typeof p> => p !== null && p.orgId === brief.orgId);
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
      // A refusal is a typed failure, as for the other writes: returning
      // `{brief:null}` let the kernel node report success with nothing saved.
      if (!(await scopedBrief(str(args.briefId), optStr(args.orgId), 'workspace:write'))) throw notFound(str(args.briefId));
      const updated = await setKernel(tenantId, str(args.briefId), kernel);
      return { brief: updated ?? null };
    },

    // ── ADR 0403 — market-intel reads + the nodes' narrow writes ────────────

    /** VOC evidence for a brief (quote-level, citation-carrying). */
    listVocEvidence: async (args) => {
      if (!(await scopedBrief(str(args.briefId), optStr(args.orgId)))) return { evidence: [] };
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
      const brief = await scopedBrief(str(args.briefId), optStr(args.orgId), 'workspace:write');
      if (!brief) throw notFound(briefId);
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
    listAngles: async (args) => ({ angles: (await scopedBrief(str(args.briefId), optStr(args.orgId))) ? await listAngles(tenantId, str(args.briefId)) : [] }),

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
      const brief = await scopedBrief(str(args.briefId), optStr(args.orgId), 'workspace:write');
      if (!brief) throw notFound(briefId);
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
      if (!(await scopedBrief(str(args.briefId), optStr(args.orgId)))) return { pack: null };
      return { pack: await getTargetingPack(tenantId, str(args.briefId), platform) };
    },

    listTargetingPacks: async (args) => ({ packs: (await scopedBrief(str(args.briefId), optStr(args.orgId))) ? await listTargetingPacks(tenantId, str(args.briefId)) : [] }),

    /**
     * The build-targeting node's write. Closed-world: platform enum +
     * every evidenceRef resolves to stored voc-evidence of THIS brief at
     * persist time. A failed candidate is a typed 422 (single-item op —
     * there is no partial batch to drop from). Deterministic brief+platform
     * key: a re-run replaces, never duplicates.
     */
    persistTargeting: async (args) => {
      const briefId = str(args.briefId);
      const brief = await scopedBrief(str(args.briefId), optStr(args.orgId), 'workspace:write');
      if (!brief) throw notFound(briefId);
      const validIds = new Set((await listVocEvidence(tenantId, briefId)).map((e) => e.id));
      const verdict = validateTargetingCandidate((args.candidate ?? {}) as TargetingCandidateInput, validIds);
      if (!verdict.ok) {
        throw new OpenwopError('validation_error', `Targeting pack failed the grounding invariant: ${verdict.finding.message}`, 422, { finding: verdict.finding });
      }
      return { pack: await persistTargetingPack(tenantId, brief.orgId, briefId, scope.actingUserId ?? 'agent', verdict.item) };
    },
  };
}
