/**
 * ADR 0954 D5/D6 — start a routing round: bump the lead's routing epoch, stamp
 * its pending grade run, and start `crm-ops.route-lead` (grade → route → the
 * speed-to-lead clock) through the ONE run starter.
 *
 * Two callers: the Leads route's Route action, and a rung-2 re-route
 * (`speedToLead.ts`), which passes the round it is leaving (`fromEpoch`, so it
 * never skips a round a person started meanwhile) and the owner to exclude. The
 * re-route reaches this through a starter the feature registers at boot (the
 * campaign-ops precedent): a surface has no storage or host suite of its own.
 */
import type { Storage } from '../../../storage/storage.js';
import type { HostAdapterSuite } from '../../../host/index.js';
import { OpenwopError } from '../../../types.js';
import { admitLeadDispatch, admitLeadReroute } from './runAdmission.js';

export interface RouteRunInput {
  tenantId: string; orgId: string; contactId: string;
  /** The person (or the source run's cause) the run acts on behalf of. */
  causedBy?: string;
  personalTenant?: string;
  sourceRunId?: string;
  /** Re-route: bump only from this round; null result when it moved on. */
  fromEpoch?: number;
}

export async function startRouteLeadRun(
  deps: { storage: Storage; hostSuite: HostAdapterSuite }, input: RouteRunInput,
): Promise<{ runId: string; routingEpoch: number } | null> {
  if (input.fromEpoch !== undefined) {
    if (!input.sourceRunId || !Number.isSafeInteger(input.fromEpoch) || input.fromEpoch < 1) throw new OpenwopError('validation_error', 'A reroute needs its source run and round.', 422, {});
    const child = await admitLeadReroute(deps, { tenantId: input.tenantId, orgId: input.orgId, contactId: input.contactId, sourceRunId: input.sourceRunId, sourceEpoch: input.fromEpoch });
    return child?.routingEpoch !== undefined ? { runId: child.runId, routingEpoch: child.routingEpoch } : null;
  }
  if (!input.causedBy) throw new OpenwopError('forbidden_scope', 'A routing start needs its authorized source principal.', 403, {});
  const response = await admitLeadDispatch(deps, { mode: 'route', tenantId: input.tenantId, orgId: input.orgId, contactId: input.contactId, userId: input.causedBy, ...(input.personalTenant ? { personalTenant: input.personalTenant } : {}) });
  if (response.routingEpoch === undefined) throw new OpenwopError('internal_error', 'The routing reservation has no round.', 500, {});
  return { runId: response.runId, routingEpoch: response.routingEpoch };
}

type Starter = (input: RouteRunInput) => Promise<{ runId: string; routingEpoch: number } | null>;
let starter: Starter | null = null;

/** Registered by `crm/feature.ts` with the host's storage and suite. */
export function registerRouteLeadStarter(fn: Starter): void { starter = fn; }

export function routeLeadStarter(): Starter {
  if (!starter) throw new OpenwopError('internal_error', 'The lead routing starter is not registered.', 500, {});
  return starter;
}
