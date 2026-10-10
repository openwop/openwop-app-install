/**
 * ADR 0825 P1 / RFC 0236 — the ONE list of host-event types this host emits,
 * their v2 names, and their delivery class.
 *
 * RFC 0236 (`spec/v2/core/events.md` §Host events) gives an event that belongs
 * to no run its own envelope (`schemas/v2/host-event.schema.json`: no `runId`,
 * no `sequence`) and a family, `hostEvents`, whose `types[]` lists every type a
 * host emits with its delivery class. A host advertising the family MUST NOT
 * emit a type it does not advertise, so the list below is both the
 * advertisement and the emission gate: a type missing here is NOT delivered on
 * the v2 host-event lanes (webhook `{ hostEvent }` body, `/host/events` SSE),
 * and the miss is logged.
 *
 * WHERE THE LIST COMES FROM. It was derived from the emit sites, not invented:
 * every `emitHostEvent` call site in `src/` (the dispatcher is the only
 * caller of `deliverHostExtEvent`), including the template-built families whose verbs are
 * `string` typed (territories, sales-commissions, priority-matrix, strategy,
 * dealers, service-desk, whatsapp consent, app-builder sync, webinars), read off
 * their call sites. `test/adr0825-rfc0236-host-events.test.ts` re-scans the emit sites and
 * pins this list against them, and against the closed-world CRM and KB verb
 * tables, so a new literal emitter that is not listed here is red.
 *
 * NAMES. `declaration.json` `extensionsKeyPattern` and the host-event schema
 * both require TWO segments (`org.name`). The in-process names keep their
 * historical spelling (ADR 0722 / ADR 0792: "the in-process event stays in the
 * host's v1 dialect"); the v2 name is derived by one deterministic rule:
 *
 *   host.<a>.<b>.<c>              → openwop-app.<a>-<b>-<c>
 *   host.<a>.<b>                  → openwop-app.<a>-<b>
 *   openwop-app.<a>.<b>           → openwop-app.<a>-<b>
 *   crm.segment.entered           → openwop-app.crm-segment-entered
 *
 * so `host.crm.contact.created` is `openwop-app.crm-contact-created`, the RFC's
 * own example. The rule is only safe while it is INJECTIVE over this list, which
 * the test asserts.
 *
 * DELIVERY CLASS. Every type here is `durable`: each is a business fact a
 * subscriber may need after a reconnect, and each was already delivered through
 * the durable webhook queue before RFC 0236. No ephemeral type is emitted today.
 *
 * FLAG. All of this is behind `OPENWOP_HOST_EVENTS_V2` (default OFF). With the
 * flag off nothing here is read on any delivery path and the v2 advertisement
 * carries no `hostEvents` record, so the wire is byte-identical to before.
 */

import { HOST_EVENT_ORG } from './hostEventNames.js';
import { seamsFloorServed } from '../routes/conformanceSeams.js';
import { hostEventTestTriggerDefined } from './hostEventTestContract.js';

/** `durable`: resumable by `eventId`, webhook-deliverable. `ephemeral`: never persisted or fanned out. */
export type HostEventDelivery = 'durable' | 'ephemeral';

export interface HostEventTypeEntry {
  /** The name the emitter passes to the dispatcher (the in-process dialect). */
  readonly emitted: string;
  /** The two-segment v2 type (`openwop-app.<name>`). */
  readonly type: string;
  readonly delivery: HostEventDelivery;
}

/**
 * The single switch. Read on every call (not cached) so a test, or an operator
 * flipping the env on a new revision, needs no restart-order reasoning.
 */
export function hostEventsV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.OPENWOP_HOST_EVENTS_V2 ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'on';
}

const SEGMENT = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** `host-event.schema.json#/properties/type` — the two-segment grammar. */
export const HOST_EVENT_TYPE_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*\.[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * The two-segment v2 name of an in-process host-event name, or `null` when the
 * name is not one this host's host events can carry.
 */
export function twoSegmentHostEventType(emitted: string): string | null {
  let rest: string[];
  if (emitted.startsWith('host.')) rest = emitted.split('.').slice(1);
  else if (emitted.startsWith(`${HOST_EVENT_ORG}.`)) rest = emitted.slice(HOST_EVENT_ORG.length + 1).split('.');
  else if (emitted === 'crm.segment.entered') rest = ['crm', 'segment', 'entered'];
  else return null;
  if (rest.length < 1 || rest.length > 3 || !rest.every((s) => SEGMENT.test(s))) return null;
  return `${HOST_EVENT_ORG}.${rest.join('-')}`;
}

/** `host.<feature>.<entity>.<verb>` for every verb, kept as data so the list reads like the emitters. */
const family = (prefix: string, entities: Record<string, readonly string[]>): string[] =>
  Object.entries(entities).flatMap(([entity, verbs]) => verbs.map((v) => `${prefix}.${entity}.${v}`));

/**
 * Every in-process host-event name this host emits. Grouped by emitter so a
 * reviewer can check a group against its file.
 */
const EMITTED: readonly string[] = [
  // features/crm/emit.ts — closed-world `CRM_EVENT_VERBS` (pinned both ways by the test).
  ...family('host.crm', {
    contact: ['created', 'updated', 'deleted', 'merged', 'converted', 'imported', 'exported'],
    company: ['created', 'updated', 'deleted', 'merged', 'imported', 'exported'],
    deal: ['created', 'updated', 'deleted', 'stage-changed', 'won', 'lost', 'exported'],
    task: ['created', 'updated', 'deleted', 'completed', 'exported'],
    activity: ['logged', 'exported'],
    segment: ['created', 'updated', 'deleted'],
    pipeline: ['created', 'updated', 'deleted'],
    fielddef: ['created', 'deleted'],
    'booking-link': ['created'],
    'sign-request': ['created', 'signed', 'completed', 'declined', 'voided'],
  }),
  // features/kb/emit.ts — closed-world `KB_EVENT_VERBS`.
  ...family('host.kb', { document: ['ingested', 'updated', 'deleted'], reindex: ['started', 'completed', 'failed'] }),
  // features/cdp/segmentEntryDaemon.ts — the one legacy name outside `host.`.
  'crm.segment.entered',
  // host/adsAdapter.ts
  'host.campaign.ads.dispatched', 'host.campaign.ads.budget-updated', 'host.campaign.ads.audience-synced',
  // features/campaign-brief/briefService.ts
  'host.campaign.brief.created', 'host.campaign.brief.validated', 'host.campaign.brief.confirmed', 'host.campaign.brief.deleted',
  // features/campaign-orchestration/campaignService.ts
  'host.campaign.campaign.finalized', 'host.campaign.campaign.status-changed', 'host.campaign.campaign.deleted',
  // features/cms/cmsService.ts
  'host.cms.page.submitted', 'host.cms.page.published', 'host.cms.page.rejected', 'host.cms.page.archived',
  'host.cms.page.unpublished', 'host.cms.page.restored',
  // features/commerce/telemetry.ts
  'host.commerce.order.created', 'host.commerce.order.paid', 'host.commerce.order.refunded', 'host.commerce.order.canceled',
  'host.commerce.order.fulfillment-updated', 'host.commerce.inventory.low-stock',
  // features/environments/environmentsService.ts
  'host.environments.applied', 'host.environments.promoted',
  // features/forms/emit.ts
  'host.forms.submission.created',
  // features/goals/goalEvents.ts
  'host.goals.evaluated', 'host.goals.closed',
  // features/orgs/emit.ts + host/memberLifecycleEvents.ts
  'host.orgs.invitation.created', 'host.orgs.invitation.accepted', 'host.orgs.invitation.revoked', 'host.orgs.invitation.declined',
  'host.orgs.member.added', 'host.orgs.member.roles-changed', 'host.orgs.member.removed',
  // features/profiles/emit.ts
  'host.profiles.endorsement.given', 'host.profiles.endorsement.removed', 'host.profiles.profile.updated',
  'host.profiles.completeness.crossed',
  // features/users/emit.ts
  'host.users.user.provisioned', 'host.users.user.deactivated', 'host.users.user.reactivated', 'host.users.user.erased',
  // Already under the vendor org in-process (ADR 0674 renames).
  'openwop-app.entities.entity-written', // features/entities/entitiesService.ts
  'openwop-app.servicedesk.ticket-reply-approved', // features/assistant/actionExecution.ts
  'openwop-app.servicedesk.ticket-sla-breached', // features/service-desk/sla.ts
  'openwop-app.whatsapp.health-degraded', // features/whatsapp/health.ts
  // features/service-desk/tickets.ts — `ticketMutated(verb: 'created' | 'message-appended' | 'status-changed' | 'assigned')`.
  ...family('host.servicedesk', { ticket: ['created', 'message-appended', 'status-changed', 'assigned'] }),
  // features/whatsapp/compliance.ts — `kind` is 'opt-in' | 'opt-out'.
  ...family('host.whatsapp', { consent: ['opt-in', 'opt-out'] }),
  // features/app-builder/syncWebhook.ts — every outcome `conclude()` is called with, `_` → `-`.
  ...family('host.app-builder', { sync: ['applied', 'ignored', 'skipped-self', 'fallback-invalid', 'fallback-basis', 'fallback-cas'] }),
  // features/webinars/webinarProcessor.ts — `WebinarPhase`.
  ...family('host', { webinar: ['registered', 'attended', 'no-show'] }),
  // features/territories/emit.ts — `territoryMutated` call sites.
  ...family('host.territory', {
    model: ['created', 'activated', 'archived', 'purged'],
    rule: ['created', 'deleted'],
    quota: ['set', 'deleted'],
    assignment: ['reassigned'],
  }),
  // features/sales-commissions/emit.ts — `commissionMutated` call sites.
  ...family('host.commission', { plan: ['created', 'updated', 'deleted'], statement: ['computed', 'approved', 'paid'] }),
  // features/dealers/emit.ts — `dealerMutated` call sites (registration verb is the approval outcome).
  ...family('host.dealer', {
    dealer: ['created', 'updated', 'deleted', 'portal-issued'],
    outlet: ['created', 'updated', 'deleted'],
    registration: ['created', 'approved', 'rejected'],
  }),
  // features/priority-matrix/emit.ts — `priorityMutated` call sites.
  ...family('host.priority', {
    list: ['created', 'updated', 'deleted'],
    idea: [
      'submitted', 'updated', 'deleted', 'cloned', 'status-moved', 'scored', 'scheduled', 'schedule-cleared',
      'evidence-added', 'evidence-removed', 'intake-updated', 'merged', 'promoted',
    ],
    session: ['created', 'updated', 'scenario-added', 'scenario-selected'],
  }),
  // features/strategy/emit.ts — `strategyMutated` call sites (the routes.ts status
  // transition verb is activated | paused | completed | archived | updated).
  ...family('host.strategy', {
    strategy: [
      'created', 'updated', 'deleted', 'activated', 'paused', 'completed', 'archived', 'cadence-updated',
      'decision-recorded', 'initiative-promoted', 'objectives-imported',
      'activation-queued', 'activation-approved', 'activation-rejected', 'activation-withdrawn',
    ],
    links: ['updated'],
    revision: ['restored'],
    'check-in': ['proposed', 'recorded', 'confirmed', 'dismissed'],
  }),
];

function build(): { list: readonly HostEventTypeEntry[]; byEmitted: ReadonlyMap<string, HostEventTypeEntry>; byType: ReadonlyMap<string, HostEventTypeEntry> } {
  const list: HostEventTypeEntry[] = [];
  const byEmitted = new Map<string, HostEventTypeEntry>();
  const byType = new Map<string, HostEventTypeEntry>();
  for (const emitted of EMITTED) {
    const type = twoSegmentHostEventType(emitted);
    // A malformed or colliding row is a programming error in this file, so it
    // fails at import (boot), never on the wire.
    if (type === null || !HOST_EVENT_TYPE_PATTERN.test(type)) throw new Error(`hostEventTypes: ${emitted} has no two-segment v2 name`);
    if (byEmitted.has(emitted)) throw new Error(`hostEventTypes: ${emitted} is listed twice`);
    const clash = byType.get(type);
    if (clash) throw new Error(`hostEventTypes: ${emitted} and ${clash.emitted} share the v2 name ${type}`);
    const entry: HostEventTypeEntry = { emitted, type, delivery: 'durable' };
    list.push(entry);
    byEmitted.set(emitted, entry);
    byType.set(type, entry);
  }
  return { list, byEmitted, byType };
}

const CATALOG = build();

/**
 * RFC 0236 §G — the reserved `example` org is held for conformance: a host that
 * serves the seams profile advertises one `example.*` durable and one
 * `example.*` ephemeral type for the suite to drive through the emit seam
 * (`routes/hostEventEmitSeam.ts`). Same names as the v2 reference host. No
 * production emitter produces them, and they exist ONLY while the seams profile
 * is mounted (`seamsFloorServed()`, the same predicate that advertises
 * `conformance.seamsProfile`), so a production revision never lists them.
 */
export const EXAMPLE_DURABLE_HOST_EVENT = 'example.thing-happened';
export const EXAMPLE_EPHEMERAL_HOST_EVENT = 'example.thing-noticed';
const EXAMPLE_ENTRIES: readonly HostEventTypeEntry[] = [
  { emitted: EXAMPLE_DURABLE_HOST_EVENT, type: EXAMPLE_DURABLE_HOST_EVENT, delivery: 'durable' },
  { emitted: EXAMPLE_EPHEMERAL_HOST_EVENT, type: EXAMPLE_EPHEMERAL_HOST_EVENT, delivery: 'ephemeral' },
];
/**
 * RFC 0241 §A — the reserved test types, one per delivery class. Emitted ONLY by
 * `POST /host/events/test` (§A.2), with an empty payload (§A.1). Listed exactly
 * when the installed contract defines that operation (`hostEventTestContract.ts`),
 * which is what binds the operation (§B.1). Unlike `example.*`, they are listed
 * on a production revision: that is the point of RFC 0241.
 */
export const HOST_TEST_EVENT_TYPES = { durable: 'host-test.durable-triggered', ephemeral: 'host-test.ephemeral-triggered' } as const;
const TEST_ENTRIES: readonly HostEventTypeEntry[] = [
  { emitted: HOST_TEST_EVENT_TYPES.durable, type: HOST_TEST_EVENT_TYPES.durable, delivery: 'durable' },
  { emitted: HOST_TEST_EVENT_TYPES.ephemeral, type: HOST_TEST_EVENT_TYPES.ephemeral, delivery: 'ephemeral' },
];
/**
 * The reserved entries currently listed: the `example.*` pair while the seams
 * profile is mounted, the `host-test.*` pair while the contract defines the RFC
 * 0241 trigger. Every reader of the advertisement goes through here, so
 * discovery, subscription matching and the ephemeral refusal agree.
 */
function activeReservedEntries(): readonly HostEventTypeEntry[] {
  return [...(seamsFloorServed() ? EXAMPLE_ENTRIES : []), ...(hostEventTestTriggerDefined() ? TEST_ENTRIES : [])];
}

/** Every entry this host's emitters produce, in source order (never the reserved `example.*` / `host-test.*` ones). */
export function hostEventTypeEntries(): readonly HostEventTypeEntry[] {
  return CATALOG.list;
}

/** The `hostEvents.types[]` facet: the emitted types, plus the `example.*` pair while the seams profile is mounted. */
export function advertisedHostEventTypes(): Array<{ type: string; delivery: HostEventDelivery }> {
  return [...CATALOG.list, ...activeReservedEntries()].map((e) => ({ type: e.type, delivery: e.delivery }));
}

/** The ADVERTISED entry for a two-segment type, the reserved entries included while they are listed (`activeReservedEntries`). */
export function advertisedHostEventEntry(type: string): HostEventTypeEntry | undefined {
  return CATALOG.byType.get(type) ?? activeReservedEntries().find((e) => e.type === type);
}

/** The entry for an EMITTED (in-process) name, or `undefined` when it is not advertised. */
export function hostEventEntryForEmitted(emitted: string): HostEventTypeEntry | undefined {
  return CATALOG.byEmitted.get(emitted);
}

/**
 * The advertised entry a subscription's `events[]` element names, or
 * `undefined`. Accepts the two-segment type AND the spellings a subscription
 * may have been registered with before RFC 0236 — the in-process name
 * (`host.crm.contact.created`) and the ADR 0792 three-segment projection
 * (`openwop-app.crm.contact-created`) — so subscriptions that predate the flag
 * keep receiving. `*` names no type and is NOT a match (RFC 0236 §E: the host
 * body goes only to a subscription whose `events[]` names the type).
 */
export function hostEventEntryForSubscriptionName(name: string): HostEventTypeEntry | undefined {
  const direct = CATALOG.byType.get(name) ?? CATALOG.byEmitted.get(name) ?? activeReservedEntries().find((e) => e.type === name);
  if (direct) return direct;
  // The ADR 0792 three-segment spelling `openwop-app.<a>.<b>-<c>` of `host.<a>.<b>.<c>`.
  if (name.startsWith(`${HOST_EVENT_ORG}.`)) {
    const parts = name.slice(HOST_EVENT_ORG.length + 1).split('.');
    if (parts.length === 2) {
      const flattened = CATALOG.byType.get(`${HOST_EVENT_ORG}.${parts[0]}-${parts[1]}`);
      // Only accept it when it IS the ADR 0792 spelling of that entry, so a
      // stray three-segment name never matches a type it was not derived from.
      if (flattened && legacyThreeSegmentSpelling(flattened.emitted) === name) return flattened;
    }
  }
  return undefined;
}

/** The ADR 0792 spelling (`host.a.b.c` → `openwop-app.a.b-c`), mirrored here to resolve old subscriptions. */
function legacyThreeSegmentSpelling(emitted: string): string | null {
  if (emitted === 'crm.segment.entered') return `${HOST_EVENT_ORG}.crm.segment-entered`;
  if (emitted.startsWith(`${HOST_EVENT_ORG}.`)) return emitted;
  if (!emitted.startsWith('host.')) return null;
  const p = emitted.split('.').slice(1);
  if (p.length === 2) return `${HOST_EVENT_ORG}.${p[0]}.${p[1]}`;
  if (p.length === 3) return `${HOST_EVENT_ORG}.${p[0]}.${p[1]}-${p[2]}`;
  return null;
}

/** `ids.schema.json#/$defs/eventId`. */
const EVENT_ID = /^[A-Za-z0-9._~-]{16,128}$/;

/**
 * An `eventId` in the v2 grammar. The dispatcher mints `hev-<uuid>` under the
 * flag (already valid); an id minted before the flag flipped (`hev:<uuid>`) is
 * projected character-for-character so it stays stable across retries.
 */
export function v2HostEventId(raw: string): string {
  if (EVENT_ID.test(raw)) return raw;
  const projected = raw.replace(/[^A-Za-z0-9._~-]/g, '-').slice(0, 128);
  return projected.length >= 16 ? projected : `hev-${projected}`.padEnd(16, '0');
}

/** RFC 0236 §A — the envelope. Closed; no `runId`, no `sequence`. */
export interface HostEventEnvelope {
  readonly eventId: string;
  readonly type: string;
  readonly timestamp: string;
  readonly delivery: HostEventDelivery;
  readonly workspaceId?: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Build the envelope for an advertised entry. `workspaceId` is omitted: the
 * host's emitters carry a tenant and no workspace, and `identity.md` §1 forbids
 * substituting the tenant for an absent workspace.
 */
export function hostEventEnvelope(entry: HostEventTypeEntry, input: { eventId: string; timestamp: string; payload: Record<string, unknown> }): HostEventEnvelope {
  return {
    eventId: v2HostEventId(input.eventId),
    type: entry.type,
    timestamp: input.timestamp,
    delivery: entry.delivery,
    payload: input.payload,
  };
}
