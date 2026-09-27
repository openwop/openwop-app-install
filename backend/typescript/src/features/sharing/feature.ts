/**
 * Sharing (ADR 0013). Mints unguessable public share links to a specific
 * resource and resolves them on a public, unauthenticated surface — composing
 * the resource features' read projections via a resolver registry.
 *
 * § Correction (ADR 0434) — graduated off its toggle to always-on.
 * Sharing is a shared HOST SEAM, not a product surface: `sharingService` is
 * imported directly by five unrelated features — `commerce/routes.ts`
 * (`assertLiveLinkFor`), `crm/signRoutes.ts` + `crm/bookingRoutes.ts`
 * (`resolveActiveResource`), `creative-briefs/routes.ts` (`purgeLinksForResource`),
 * and `commerce/commerceService.ts` (`createLink`). The toggle had already
 * admitted this: ADR 0402 had to add an `enforceSharingToggle: false` carve-out
 * so CRM booking/e-sign capability tokens would keep working with the toggle
 * off. A seam that needs a bypass hatch is plumbing, not a curtain — so the
 * hatch is removed along with the toggle rather than widened.
 *
 * What still gates the public surface (unchanged): the unguessable token IS the
 * credential (charset-validated), plus revocation, expiry, and the org↔tenant
 * binding — all uniform-404 on failure. Authed link management keeps its
 * org-scoped RBAC (`requireOrgScope`, workspace:read/write); only the toggle
 * half of the former `authorizeOrgScope` is gone.
 *
 * § CORRECTION (SHARE-1, 2026-08-18) — the paragraph that used to close this
 * docblock said "each resolver still applies its OWN feature's toggle before
 * returning content (`creative-briefs`, `app-builder`, `slides`, `crm`), so no
 * feature becomes shareable that was not already". That was FALSE for seven of
 * the twelve resource types, and had been since the graduation: `cms_page`,
 * `kb_collection`, `document`, `conversation`, `prompt`, `commerce_quote` and
 * `commerce_order` applied no toggle at all, and their backing services do not
 * either. `FEATURES.md` and `middleware/auth.ts` repeated the same claim. The
 * sentence is kept here rather than deleted, because a public surface whose
 * documented gate does not exist is the failure worth remembering.
 *
 * WHAT IS TRUE NOW, stated at the precision the fix actually reaches:
 *  - ONE gate (`owningFeatureEnabled`, driven by a `toggleId` on each resolver)
 *    runs on EVERY public entry point and at mint, always against the LINK's
 *    tenant. `document` → `documents` and the two commerce types → `commerce`
 *    join the five that were already gated (`creative-briefs`, `app-builder`,
 *    `slides`, `crm` ×2), so eight types are toggle-gated.
 *  - FOUR are not, and CANNOT be: `cms_page`, `kb_collection`, `prompt` and
 *    `conversation` are owned by features that graduated to always-on (or, for
 *    conversations, by the core chat store), so no toggle exists to consult.
 *    Each declares `toggleId: null` WITH ITS REASON at the resolver. For those
 *    four there is no kill-switch for the public lane — revocation, expiry and
 *    deleting the resource are the controls. Saying so is the point; the
 *    previous text implied a curtain that was never there.
 *
 * @see docs/adr/0434-graduate-substrate-toggles.md
 */

import type { BackendFeature } from '../types.js';
import { rekeySharingAtRest, backfillLinkDeadAt } from './sharingService.js';
import { registerSharingRoutes } from './routes.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.sharing');

export const sharingFeature: BackendFeature = {
  id: 'sharing',
  registerRoutes: (deps) => {
    registerSharingRoutes(deps);
    // ADR 0448 P2 — hashed-at-rest re-key: idempotent by shape, safe every
    // boot, best-effort (a hiccup never blocks boot; the next boot resumes).
    // WF-SHARE-1 — then stamp `deadAt` on any pre-existing dead row, so the
    // kvAgeOut lane can see rows written before that field existed. Same
    // posture: idempotent by shape, best-effort, resumable.
    // SHCD-2 — this was `void rekeySharingAtRest().then(backfillLinkDeadAt).catch(() => undefined)`,
    // which hid TWO different failures behind one silent catch:
    //   1. a failed re-key leaves the RAW bearer token in durable legacy rows
    //      (`LegacyShareLink.token`), so the ADR 0448 P2 "never at rest" invariant
    //      stays violated indefinitely and nobody is told — only rows someone
    //      happens to resolve get migrated by the lazy on-read fallback; and
    //   2. because the backfill was CHAINED behind it, a rejected re-key skipped
    //      `backfillLinkDeadAt` entirely, so every pre-`deadAt` dead row stays
    //      invisible to `registerKvAgeOut` forever. That is exactly the "silent
    //      retention regression that would have looked like success" the backfill's
    //      own docblock says it exists to prevent.
    // Both stay best-effort and ordered, but a failure is now LOUD and the second
    // pass no longer depends on the first succeeding.
    void (async () => {
      try {
        await rekeySharingAtRest();
      } catch (err) {
        log.warn('sharing_rekey_at_rest_failed', { error: err instanceof Error ? err.message : String(err) });
      }
      try {
        await backfillLinkDeadAt();
      } catch (err) {
        log.warn('sharing_deadat_backfill_failed', { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  },
  // No toggleDefault — graduated off its toggle (§ Correction above).
};
