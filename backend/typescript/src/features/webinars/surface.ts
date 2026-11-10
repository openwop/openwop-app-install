/**
 * Webinars workflow surface (ADR 0404 §a) — `ctx.features.webinars`. Backs the
 * `feature.webinars.nodes` action nodes. Both verbs run in a RUN context, so the
 * connections broker resolves the org's Zoom credential (the acting user is on
 * the run scope) — this is the authoritative registrant-push path (the anon
 * forms sink can't resolve a credential; see formsSubmissionSink header).
 *
 * ADR 1054 D2 — both verbs write (a Zoom registration + CRM activities; provider reads
 * + CRM activities), so the ADR 0832 floor asks `workspace:write` of the run's person,
 * as the HTTP doors do. A run with no person passes the floor (ADR 0832 D1) and the
 * broker hands it at most a WORKSPACE-scoped connection; D3 bounds it to a webinar
 * the client already tracks.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { requireString as requireStr } from '../featureRoute.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import type { BrokeredEgressDeps } from '../../host/brokeredEgress.js';
import { makeWebinarAdapter } from './host/webinarAdapter.js';
import { ingestWebinarEvent } from './webinarProcessor.js';
import { syncEvent } from './webinarSyncService.js';
import { getMarketingEvent, getMarketingEventByProviderId } from './entities/marketingEvent.js';
import { enqueuePendingPush } from './pendingPush.js';

/** ADR 1054 D2 — see the header. */
export const WEBINARS_SURFACE_POLICY = {
  methodScopes: { registerRegistrant: 'workspace:write', syncEvent: 'workspace:write' },
} as const;

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
    /** ADR 1054 D3 — register one person for a webinar THIS client already tracks:
     *  resolve the tracked event → record the local `registered` activity → push (pinned
     *  to its connection) → queue an unconfirmed push for the operator's drain.
     *  Never creates an event (a run's webinar id may come from a trigger payload). */
    registerRegistrant: async (args) => {
      const orgId = requireStr(args.orgId, 'orgId');
      const webinarId = requireStr(args.webinarId, 'webinarId');
      const email = requireStr(args.email, 'email');
      const name = optStr(args.name);
      const event = await getMarketingEventByProviderId(tenantId, 'zoom', webinarId);
      if (!event) return { success: false, error: 'event_not_tracked', queued: false, recorded: false };
      if (event.orgId !== orgId) return { success: false, error: 'event_in_other_org', queued: false, recorded: false };
      // Record FIRST: an erased person (or a failed write) is never sent to Zoom — the push
      // follows a registration this workspace actually holds.
      const ingest = await ingestWebinarEvent(tenantId, orgId, undefined, { provider: event.provider, providerEventId: webinarId, phase: 'registered', participantEmail: email, ...(name ? { participantName: name } : {}), ...(event.title ? { title: event.title } : {}) });
      if (ingest !== 'recorded' && ingest !== 'duplicate') return { success: false, error: 'not_recorded', queued: false, recorded: false };
      const [first, ...rest] = (name ?? '').split(' ');
      const push = await makeWebinarAdapter(brokerDeps(orgId), event.connectionId).registerRegistrant(webinarId, { email, ...(first ? { firstName: first } : {}), ...(rest.length ? { lastName: rest.join(' ') } : {}) });
      if (push.ok) return { success: true, registrantId: push.value.registrantId, joinUrl: push.value.joinUrl, recorded: true };
      // Every unconfirmed registration is queued (insert-once): the operator's drain shows
      // the reason and retries with a real acting user; the retention purger bounds the hold.
      await enqueuePendingPush({ tenantId, orgId, eventId: event.eventId, providerEventId: webinarId, email, ...(name ? { name } : {}) });
      return { success: false, error: push.error, queued: true, recorded: true };
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
