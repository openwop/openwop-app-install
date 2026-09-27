/**
 * Recommendations workflow surface (ADR 0273 / MERCH-A) — `ctx.features.recommendations`.
 * A thin adapter over `recommendationsService.resolveRecommendations` (the source
 * of truth shared with REST). Tenant from the run scope (CTI-1); `orgId` node-supplied +
 * service-enforced.
 *
 * Review IM-5 — this said "Read-only — placements/holdouts are operator config, not a run
 * write", in the file that exposes `upsertPlacement`. It is NOT read-only: the write path
 * creates and (R2) patches placements. It is bounded instead by two rules that ARE
 * enforced below — the lane only ever adopts rows it authored (`createdBy: 'agent'`), and
 * a placement carrying a holdout lands INACTIVE for a human to activate (ADR 0273).
 *
 * A rec surfaced INSIDE a run (e.g. an email node) returns the resolved product ids; the
 * caller records them into the run output so `:fork` replays verbatim (ADR 0273 ruling 7).
 */
import { OpenwopError } from '../../types.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { resolveRecommendations, createPlacement, updatePlacement, listPlacements, RECO_SLOTS, type RecoSlot } from './recommendationsService.js';

export function buildRecommendationsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    // WRITE (role:'action' node) — the agent authors a placement (no money, easily
    // reversible ⇒ direct, per the ADR 0058 chat-drivability review). Calls the SAME
    // createPlacement the REST route calls (single source of truth).
    upsertPlacement: async (args) => {
      // R2 REC2-M9 — this is called `upsertPlacement`, the node pack advertises it as
      // "idempotent-by-effect", and it called `createPlacement` unconditionally with a
      // fresh uuid. A chain running daily minted a duplicate every run; the resolver
      // takes the FIRST by createdAt, so editing the newest (the row an operator
      // naturally reaches for, at the bottom of the table) changed nothing on the
      // storefront — until the 2000-row cap started rejecting every placement write.
      // Now it upserts on the identity the resolver actually keys on.
      const orgId = str(args.orgId);
      const slot = str(args.slot);
      const source = str(args.source);
      const segmentId = optStr(args.segmentId)?.trim() || undefined; // review IM-1 — surfaceOptStr does not trim
      const holdoutPct = typeof args.holdoutPct === 'number' ? args.holdoutPct : undefined;
      // Review MJ-6 — match on what the RESOLVER keys on: (slot, segmentId). It takes the
      // first ACTIVE row by createdAt, so keying on `source` too left a second row for the
      // same slot permanently shadowed while the chain reported success.
      // Review BL-2 — and only ever adopt a row this lane authored. Matching any row let a
      // chain silently mutate a merchandiser's live placement — and RAISE a holdout on it,
      // putting 20% of real shoppers into a no-recommendations arm with no approval. That
      // is verbatim the ADR 0273 rule the sibling agent tool enforces; closing it there and
      // widening it here is not closing it.
      const existing = (await listPlacements(tenantId, orgId)).find(
        (p) => p.createdBy === 'agent' && p.slot === slot && (p.segmentId ?? '') === (segmentId ?? ''),
      );
      // Review BL-1 — ONE projection for both paths. The node records `outputs` verbatim,
      // so a shape that changes between the create and the update run makes
      // `{{nodes.upsert.outputs.placementId}}` resolve on day 1 and freeze to '' on day 2
      // (ADR 0507), succeeding on a fabricated id — recorded, and replayed by :fork.
      const projectPlacement = (p: { placementId: string; slot: string; source: string; active: boolean }): Record<string, unknown> =>
        ({ placementId: p.placementId, slot: p.slot, source: p.source, active: p.active });
      if (existing) {
        const patched = await updatePlacement(tenantId, orgId, existing.placementId, {
          source,
          ...(holdoutPct !== undefined ? { holdoutPct } : {}),
          // The M7 rule applies to a PATCH too: raising a holdout re-drafts the row.
          ...(holdoutPct !== undefined && holdoutPct > 0 ? { active: false } : {}),
        });
        return { placement: projectPlacement(patched ?? existing) };
      }
      const placement = await createPlacement({
        tenantId, orgId, createdBy: 'agent',
        slot, source,
        ...(segmentId ? { segmentId } : {}),
        ...(holdoutPct !== undefined ? { holdoutPct } : {}),
        // The same ADR 0273 rule the chat tool applies: a holdout hides recommendations
        // from a share of REAL shoppers, so it lands as a draft for a human to activate.
        ...(holdoutPct !== undefined && holdoutPct > 0 ? { active: false } : {}),
      });
      return { placement: projectPlacement(placement) };
    },
    resolve: async (args) => {
      const slotRaw = str(args.slot);
      // R2 REC2-M8 — REFUSE an unknown slot; do not substitute a different valid one.
      // Every other entry point (route, chat tool, service) throws a typed
      // validation_error; this lane alone coerced to 'home' and returned SUCCESS — so a
      // chain configured `slot: "PDP"` (or a `{{params.slot}}` frozen to a typo) silently
      // inserted the HOME slot's products into a post-purchase email, and the recorded
      // output replayed that forever. The ADR 0507 fabrication shape, at a coercion site.
      if (!(RECO_SLOTS as readonly string[]).includes(slotRaw)) {
        throw new OpenwopError('validation_error', `Unknown recommendation slot '${slotRaw}'. Expected one of: ${RECO_SLOTS.join(', ')}.`, 400, { field: 'slot', supported: RECO_SLOTS });
      }
      const slot = slotRaw as RecoSlot;
      const result = await resolveRecommendations({
        tenantId, orgId: str(args.orgId), slot,
        ...(optStr(args.productId) ? { productId: optStr(args.productId)! } : {}),
        ...(optStr(args.contactId) ? { contactId: optStr(args.contactId)! } : {}),
        ...(optStr(args.sessionKey) ? { sessionKey: optStr(args.sessionKey)! } : {}),
      });
      return {
        placementId: result.placementId ?? null,
        source: result.source ?? null,
        variant: result.variant ?? null,
        productIds: result.products.map((p) => p.productId),
        // Review MJ-5 — carry the REASONS. A model told only `placementId: null` will
        // report the slot as unconfigured, which is the B2 lie relocated to the surface
        // where it is least visible. The tool's own description tells it to ground every
        // claim in what this returns, so what this returns has to be enough.
        ...(result.segmentTargetedSkipped ? { segmentTargetedSkipped: true } : {}),
        ...(result.segmentNotMatched ? { segmentNotMatched: true } : {}),
        ...(result.unresolvedSegmentIds?.length ? { unresolvedSegmentIds: result.unresolvedSegmentIds } : {}),
        ...(result.holdoutInert ? { holdoutInert: true } : {}),
      };
    },
  };
}
