/**
 * ADR 0641 phase 3 — the anonymous challenge catalog.
 *
 * `GET /v1/host/openwop-app/public/:orgId/challenges` — one more member of the
 * ADR 0012 public family (org in the URL, tenant resolved server-side,
 * published-only, no credential), not a new anonymous surface. The family
 * already carries the cross-cutting middleware: `PUBLIC_EMBED_PREFIX` in
 * `cors.ts`, the CSRF carve-out, the `PUBLIC_PATH_PREFIXES` entry in `auth.ts`,
 * and custom-domain org mapping. A second public namespace would duplicate an
 * owner that already has all four.
 *
 * ── TWO DELIBERATE DEPARTURES FROM THE FAMILY, both worth stating ───────────
 *
 * **1. This read IS toggle-gated; the CMS pages beside it are not.** That is not
 * an inconsistency — `publishingService.ts:138-141` records why the page reads
 * skip the gate: *"Publishing is always-on, so there is NO per-tenant toggle gate
 * here — the CMS editorial `published` status is the sole public gate."* Challenges
 * are not always-on: KickTodo is one distribution among several, and an operator
 * who has never enabled it must not answer 200 with an empty catalog at a public
 * URL. An empty 200 is an indexable claim that this org runs a challenge program
 * and has none.
 *
 * **2. The toggle resolves on the ORG'S tenant, not the caller's — and this is
 * the exact distinction ADR 0641 decision 12 forbids in the other direction.**
 *
 * Decision 12 bans variants and tenant overrides on a public ROUTE because the
 * caller is `anon:<sid>`, minted fresh per browser session, so the key can never
 * match and bucketing re-rolls per visit. None of that applies here: the subject
 * is the tenant that `getOrg(orgId)` resolved SERVER-SIDE from a path segment.
 * It is stable across visits, identical for every visitor of that org, and
 * coherent for a CDN-cached document.
 *
 * So "toggle-gated" means something different on the two sides of this feature,
 * and conflating them is how a reader would conclude either that decision 12 is
 * violated here or that this gate is safe to mirror onto the route. It is not:
 * `resolveOne(id, { tenantId })` with a server-resolved tenant is meaningful;
 * the same call with a request-derived tenant is a coin flip.
 *
 * ── Projection ──────────────────────────────────────────────────────────────
 *
 * Scalar-projected to the fields a catalog page needs. NOT the stored row: a
 * `ChallengeDefinition` carries authoring state (draft lineage, translation
 * pointers, retirement) that has no business on an anonymous wire, and shipping
 * the row would make every future internal field a public one by default.
 *
 * `activities` IS included, deliberately and against the shape a kernel
 * projection would have given. ADR 0641 decision 5 rejected routing challenges
 * through `entityList` precisely because ADR 0408 Phase D projects published
 * pages' SCALARS only — which would surface titles and drop the day-by-day
 * curriculum, i.e. most of what makes a challenge page worth indexing. Having
 * rejected that path for dropping `activities`, this projection would be
 * incoherent without it.
 */

import { OpenwopError } from '../../types.js';
import { getOrg } from '../../host/accessControlService.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { listPublishedForLocale, type NegotiatedChallenge } from './challengeService.js';
import type { ChallengeDefinition, EvidencePolicy } from './types.js';

/** The toggle that owns the challenge surface. */
export const KICKTODO_CORE_FEATURE_ID = 'kicktodo-core';

/** One catalog entry on the anonymous wire. Additive-only: a new field here is
 *  a new PUBLIC field, so it is spelled out rather than spread from the row. */
export interface PublicChallenge {
  challengeId: string;
  version: number;
  title: string;
  summary: string;
  outcome: string;
  durationDays: number;
  /** The locale actually SERVED, plus whether it was an exact match. Both are
   *  on `NegotiatedChallenge` and both belong on the wire: a catalog page that
   *  fell back to `en` for a `fr` visitor should be able to say so, and a
   *  crawler should not be told a fallback is canonical. */
  servedLocale: string;
  exactLocale: boolean;
  /** Day-by-day curriculum. See the projection note above — this is the field
   *  decision 5 refused to lose.
   *
   *  `instructions`, not a guessed `description`: that is the real field name on
   *  `ChallengeActivity`. `stableActivityId` and `alternatives` are deliberately
   *  omitted — enrolment mechanics, not catalog copy.
   *
   *  `evidencePolicy` IS carried — corrected 2026-09-16 (ADR 0684 phase 4). The
   *  first cut omitted it under the same "enrolment mechanics" reasoning, and the
   *  signed-out preview (ADR 0436 §5.4: the summary IS the commitment preview a
   *  participant sees before enrolling) then labelled every activity "just check
   *  in" while the signed-in page for the same challenge said "note" — measured
   *  on kicktodo.com at `302a534`, beside a sentence promising the preview is
   *  exactly what the visitor will commit to. What a participant will be asked
   *  to show IS the commitment, not a mechanic of it; it sits inside the
   *  immutable published body (`contentHash`) and carries nothing personal. */
  activities: Array<{ day: number; title: string; instructions: string; estimatedMinutes?: number; evidencePolicy: EvidencePolicy }>;
  /** Same correction, same reason: the depth chip is on every Discover card and
   *  on the signed-in preview, so a stranger's preview without it is a different
   *  page from the one it promises to be. Optional on the row, so optional here. */
  depthLevel?: ChallengeDefinition['depthLevel'];
}

export interface PublicCatalog {
  orgId: string;
  locale: string;
  challenges: PublicChallenge[];
}

/**
 * Resolve the org's tenant for the public surface.
 *
 * 404 on an unknown org, matching `publishingService.resolvePublicOrg`. The
 * status is deliberate: a public caller learns "no such site", never "that site
 * exists but its challenges are off" — those two answers must be
 * indistinguishable, or the endpoint becomes an oracle for which orgs run
 * KickTodo.
 */
async function resolvePublicTenant(orgId: string): Promise<string> {
  const org = await getOrg(orgId);
  if (!org) throw new OpenwopError('not_found', 'Site not found.', 404, { orgId });
  return org.tenantId;
}

function project(c: NegotiatedChallenge): PublicChallenge {
  const d = c.challenge;
  return {
    challengeId: d.id,
    version: d.version,
    title: d.title,
    summary: d.summary,
    outcome: d.outcome,
    durationDays: d.durationDays,
    servedLocale: c.servedLocale,
    exactLocale: c.exactLocale,
    activities: (d.activities ?? []).map((a) => ({
      day: a.day,
      title: a.title,
      instructions: a.instructions,
      ...(a.estimatedMinutes === undefined ? {} : { estimatedMinutes: a.estimatedMinutes }),
      evidencePolicy: a.evidencePolicy,
    })),
    ...(d.depthLevel === undefined ? {} : { depthLevel: d.depthLevel }),
  };
}

/**
 * The anonymous catalog for one org.
 *
 * Throws 404 for an unknown org AND for an org whose challenge feature is off —
 * same status, same body, for the reason in `resolvePublicTenant`.
 */
export async function publicChallengeCatalog(
  orgId: string,
  acceptLanguage: string | undefined,
): Promise<PublicCatalog> {
  const tenantId = await resolvePublicTenant(orgId);

  // Fail CLOSED on a resolution error. `.catch(() => false)` rather than letting
  // it throw: a toggle-store blip must not turn a public catalog into a 500, and
  // it must not turn it into an open door either. Absent ⇒ off.
  const enabled = await resolveOne(KICKTODO_CORE_FEATURE_ID, { tenantId })
    .then((t) => t?.enabled === true)
    .catch(() => false);
  if (!enabled) throw new OpenwopError('not_found', 'Site not found.', 404, { orgId });

  const requested = (acceptLanguage ?? 'en').split(',')[0]?.trim() || 'en';
  const negotiated = await listPublishedForLocale(tenantId, requested);
  return {
    orgId,
    locale: requested,
    challenges: negotiated.map(project),
  };
}
