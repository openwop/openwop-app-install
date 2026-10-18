/**
 * `ctx.features.kicktodo-accountability` (ADR 0419 P4) — READ + PROPOSE only:
 * grant WRITES (invite/accept/revoke) stay route-level with the acting
 * participant; a workflow/agent can never expand consent (PRD §8.5.2).
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceOptStr, surfaceStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { CircleDeniedError, listCirclesOwnedBy, resolveCircleByOpaqueId } from './circleService.js';
import { circleFeedFor } from './projectionService.js';
import { coachCaseload, proposePlanChange } from './cohortService.js';
import { sendSessionReminder } from './sessionService.js';
import { bindKicktodoSurface, type KicktodoSurfaceSpecs } from '../kicktodo-core/surfaceBinding.js';

/** ADR 0901 (DEC-1) — the run-principal spec per method (`surfaceBinding.ts`).
 *  `feed`/`caseload`/`propose` check the coach/grantee relation in the SERVICE,
 *  against the bound subject — the same call each route makes with
 *  `subjectOf(req)`. `sendSessionReminder` is the session-reminder job's op
 *  (system lane); a person may only fire it for a circle they OWN, the
 *  authority `scheduleSession` (and its route) requires. */
export const KICKTODO_ACCOUNTABILITY_SURFACE_SPECS = {
  listCircles: { subjectArg: 'ownerSubject', authority: 'none', personOnly: true },
  feed: { subjectArg: 'callerSubject', authority: 'none', personOnly: true },
  caseload: { subjectArg: 'coachSubject', authority: 'none', personOnly: true },
  propose: { subjectArg: 'coachSubject', authority: 'none', personOnly: true },
  sendSessionReminder: {
    authority: 'relation',
    relation: async (tenantId, person, args) => {
      const circleId = typeof args.circleId === 'string' ? args.circleId : '';
      if (!circleId) return false;
      const circle = await resolveCircleByOpaqueId(circleId).catch((err: unknown) => {
        if (err instanceof CircleDeniedError) return null;
        throw err;
      });
      return !!circle && circle.tenantId === tenantId && circle.ownerSubject === person;
    },
  },
} as const satisfies KicktodoSurfaceSpecs;

export function buildKicktodoAccountabilitySurface(scope: BundleScope): FeatureSurface {
  const tenant = scope.tenantId;
  // Code-grade KTA-1 — circle ids are opaque and resolve across tenants (the
  // grantee index is cross-workspace by design for the coach console). A workflow
  // runs inside ONE tenant, so every circle it names must belong to that tenant.
  const circleInTenant = async (circleId: string) => {
    const circle = await resolveCircleByOpaqueId(circleId);
    if (circle.tenantId !== tenant) throw new CircleDeniedError();
    return circle;
  };
  return bindKicktodoSurface('kicktodo-accountability', scope, {
    listCircles: async (args) => ({ circles: await listCirclesOwnedBy(tenant, surfaceStr(args.ownerSubject)) }),
    feed: async (args) => {
      const circle = await circleInTenant(surfaceStr(args.circleId));
      return { feed: await circleFeedFor(circle, surfaceStr(args.callerSubject)) } as unknown as Record<string, unknown>;
    },
    caseload: async (args) => ({ caseload: await coachCaseload(surfaceStr(args.coachSubject), { tenantId: tenant }) }),
    propose: async (args) => {
      const circleId = surfaceStr(args.circleId);
      await circleInTenant(circleId);
      const note = surfaceStr(args.note);
      // KTA-4 — inside a run, a retried node re-executes this op with the same
      // run id and inputs; key the proposal on them so the retry returns the
      // first proposal instead of raising a second card. (A caller that also
      // passes `nodeId` disambiguates two propose nodes with identical inputs.)
      // Runless (surface-direct) callers keep the fresh-id behaviour.
      const idempotencyKey = scope.runId ? `run:${scope.runId}|${surfaceStr(args.nodeId)}|${note}` : undefined;
      return {
        proposal: await proposePlanChange(circleId, surfaceStr(args.coachSubject), note, undefined, idempotencyKey ? { idempotencyKey } : {}),
      };
    },
    /** ADR 0459 P3 — deliver a scheduled session's T-minus reminder to the circle's
     *  live grantees (mute-respecting; the coach is skipped). The `session-reminder`
     *  pack node forwards { circleId, atIso, conversationId } here when the one-shot
     *  scheduler job fires; membership fan-out + mute-respect stay in the service. */
    sendSessionReminder: async (args) => await sendSessionReminder(tenant, {
      circleId: surfaceStr(args.circleId),
      atIso: surfaceStr(args.atIso),
      ...(surfaceOptStr(args.conversationId) ? { conversationId: surfaceOptStr(args.conversationId) } : {}),
    }),
  }, KICKTODO_ACCOUNTABILITY_SURFACE_SPECS);
}
