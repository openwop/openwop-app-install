/**
 * Webinars workflow surface (ADR 0404 §a) — `ctx.features.webinars`. Backs the
 * `feature.webinars.nodes` action nodes. Both verbs run in a RUN context, so the
 * connections broker resolves the org's Zoom credential (the acting user is on
 * the run scope) — this is the authoritative registrant-push path (the anon
 * forms sink can't resolve a credential; see formsSubmissionSink header).
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { requireString as requireStr } from '../featureRoute.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import type { BrokeredEgressDeps } from '../../host/brokeredEgress.js';
import { makeWebinarAdapter } from './host/webinarAdapter.js';
import { ingestWebinarEvent } from './webinarProcessor.js';
import { syncEvent } from './webinarSyncService.js';
import { getMarketingEvent } from './entities/marketingEvent.js';

export function buildWebinarsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  const brokerDeps = (orgId: string): BrokeredEgressDeps => ({
    storage: hostExtStorage(),
    tenantId,
    runId: scope.runId ?? `hostext:webinar:${orgId}`,
    ...(scope.actingUserId ? { actingUserId: scope.actingUserId } : {}),
    orgId,
  });

  return {
    /** Push a registrant to the provider + record the local `registered` activity. */
    registerRegistrant: async (args) => {
      const orgId = requireStr(args.orgId, 'orgId');
      const webinarId = requireStr(args.webinarId, 'webinarId');
      const email = requireStr(args.email, 'email');
      const name = optStr(args.name);
      const [first, ...rest] = (name ?? '').split(' ');
      const push = await makeWebinarAdapter(brokerDeps(orgId)).registerRegistrant(webinarId, { email, ...(first ? { firstName: first } : {}), ...(rest.length ? { lastName: rest.join(' ') } : {}) });
      // Record the local registration regardless of the push outcome (honest CRM state).
      await ingestWebinarEvent(tenantId, orgId, undefined, { provider: 'zoom', providerEventId: webinarId, phase: 'registered', participantEmail: email, ...(name ? { participantName: name } : {}) });
      return push.ok
        ? { success: true, registrantId: push.value.registrantId, joinUrl: push.value.joinUrl }
        : { success: false, error: push.error };
    },

    /** Backfill-reconcile an event's attendance + no-shows. */
    syncEvent: async (args) => {
      const orgId = requireStr(args.orgId, 'orgId');
      const eventId = requireStr(args.eventId, 'eventId');
      const event = await getMarketingEvent(tenantId, orgId, eventId);
      if (!event) return { success: false, error: 'event_not_found' };
      const out = await syncEvent(brokerDeps(orgId), tenantId, orgId, event);
      return { success: out.outcome !== 'error', ...out };
    },
  };
}
