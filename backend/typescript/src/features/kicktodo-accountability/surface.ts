/**
 * `ctx.features.kicktodo-accountability` (ADR 0419 P4) — READ + PROPOSE only:
 * grant WRITES (invite/accept/revoke) stay route-level with the acting
 * participant; a workflow/agent can never expand consent (PRD §8.5.2).
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceOptStr, surfaceStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { listCirclesOwnedBy, resolveCircleByOpaqueId } from './circleService.js';
import { circleFeedFor } from './projectionService.js';
import { coachCaseload, proposePlanChange } from './cohortService.js';
import { sendSessionReminder } from './sessionService.js';

export function buildKicktodoAccountabilitySurface(scope: BundleScope): FeatureSurface {
  const tenant = scope.tenantId;
  return {
    listCircles: async (args) => ({ circles: await listCirclesOwnedBy(tenant, surfaceStr(args.ownerSubject)) }),
    feed: async (args) => {
      const circle = await resolveCircleByOpaqueId(surfaceStr(args.circleId));
      return { feed: await circleFeedFor(circle, surfaceStr(args.callerSubject)) } as unknown as Record<string, unknown>;
    },
    caseload: async (args) => ({ caseload: await coachCaseload(surfaceStr(args.coachSubject)) }),
    propose: async (args) => ({
      proposal: await proposePlanChange(surfaceStr(args.circleId), surfaceStr(args.coachSubject), surfaceStr(args.note)),
    }),
    /** ADR 0459 P3 — deliver a scheduled session's T-minus reminder to the circle's
     *  live grantees (mute-respecting; the coach is skipped). The `session-reminder`
     *  pack node forwards { circleId, atIso, conversationId } here when the one-shot
     *  scheduler job fires; membership fan-out + mute-respect stay in the service. */
    sendSessionReminder: async (args) => await sendSessionReminder(tenant, {
      circleId: surfaceStr(args.circleId),
      atIso: surfaceStr(args.atIso),
      ...(surfaceOptStr(args.conversationId) ? { conversationId: surfaceOptStr(args.conversationId) } : {}),
    }),
  };
}
