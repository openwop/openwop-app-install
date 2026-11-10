/**
 * The client an event-triggered journey is bound to (found by fl2-86; feature-loop row 73
 * area). Registered with the host dispatcher's `registerEventTriggerOrgResolver`, which
 * starts an org-bound workflow only for an event whose `payload.orgId` is that org.
 *
 * A journey chain is instantiated once per client with `params.orgId` (ADR 0955 D1), but
 * its host-event binding carried no org, so client A's post-webinar journey started on
 * client B's `host.webinar.attended` and enrolled and mailed B's attendee under A's brand.
 *
 * The org is the one the journey's own verbs would use: `resolveEnrollmentOrg` over the
 * frozen `expandedFrom.params.orgId`. In a workspace with no clients (or naming the
 * workspace root) that is `''`, so the journey is NOT org-bound and keeps starting for
 * every event, as before: the workspace is the only scope there. An org that is no longer a
 * client throws, and the dispatcher refuses (fail closed).
 */
import { chainIdOfDefinition, type EventTriggerOrgResolver } from '../../host/hostEventDispatcher.js';
import { resolveEnrollmentOrg } from './journeyService.js';

export const journeyEventTriggerOrg: EventTriggerOrgResolver = async (tenantId, definition) => {
  if (!chainIdOfDefinition(definition)?.startsWith('campaign-journeys.')) return undefined;
  const params = (definition.metadata as { expandedFrom?: { params?: Record<string, unknown> } } | undefined)?.expandedFrom?.params;
  const raw = typeof params?.orgId === 'string' ? params.orgId : '';
  if (!raw) return null; // a legacy journey instance with no selected client: not org-bound
  return (await resolveEnrollmentOrg(tenantId, raw)) || null;
};
