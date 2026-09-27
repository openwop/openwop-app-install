/**
 * Advisory catalog of host-extension event types (RFC 0086 §E) that this host
 * is KNOWN to emit today.
 *
 * **CORRECTION (WF-FORM-3, ADR 0584).** This docblock used to say the list was
 * "sourced by grepping every `emitHostEvent(...)` / `deliverHostExtEvent(...)`
 * call site" and then name seven files. That claim is FALSE and has been for a
 * long time: roughly FIFTEEN emitters are missing — forms, dealers, entities,
 * environments, goals, kb, priority-matrix, sales-commissions, service-desk,
 * strategy, territories, webinars, whatsapp, app-builder/syncWebhook,
 * cdp/segmentEntryDaemon and assistant/actionExecution. `host.forms.submission
 * .created` is added below because the forms-intake chain cannot be wired up
 * without it and this `<datalist>` is the ONLY operator-facing discovery surface
 * for the binding. The other ~14 are deliberately NOT swept in here: adding one
 * line per miss re-creates the same drift the day the next emitter ships. The
 * durable cure is a BUILD-TIME PARITY CHECK that greps the `emitHostEvent` call
 * sites and fails when this catalog drifts — the `promptCatalogParity` shape.
 *
 * **BUILT (ADR 0617 D4, 2026-09-02).** That gate now exists:
 * `backend/typescript/test/host-event-catalog-parity.test.ts` reads THIS file
 * from disk, scans every backend emit site (string literals AND template
 * prefixes, comments stripped) and fails when an emitted type is missing here
 * — except for the pre-existing misses baselined SHRINK-ONLY in
 * `backend/typescript/test/fixtures/host-event-catalog-baseline.json` (the
 * ~14 above; draining them is `UAUWF-6`). Adding an emitter without a row here
 * is red; adding a row here for a type nothing emits is also red. Do NOT grow
 * the baseline — add the type below.
 *
 * This is a UX convenience (a `<datalist>` of likely values), NOT a closed
 * enum: the backend's eventType validation is just `^host\.[a-z][…]*$`
 * (`routes/hostEvents.ts`) — the host-extension namespace is open, so a
 * binding for an event type not in this list (a future emitter, a pack the
 * operator installed, a typo they mean to fix later) is still accepted as
 * free text. Keep this catalog roughly current, but never gate on it.
 */
export const KNOWN_HOST_EVENT_TYPES: readonly string[] = [
  // host.crm.* (ADR 0208 §1; ADR 0627 D2) — hand-listed, and pinned BOTH ways
  // against the backend's closed-world `CRM_EVENT_VERBS` (`features/crm/emit.ts`)
  // by `test/host-event-catalog-parity.test.ts`: a verb the backend can emit
  // that is missing here is red, and a row here the backend cannot emit is red.
  'host.crm.contact.created',
  'host.crm.contact.updated',
  'host.crm.contact.deleted',
  'host.crm.contact.merged',
  'host.crm.contact.converted',
  'host.crm.contact.imported',
  'host.crm.contact.exported',
  'host.crm.company.created',
  'host.crm.company.updated',
  'host.crm.company.deleted',
  'host.crm.company.merged',
  'host.crm.company.imported',
  'host.crm.company.exported',
  'host.crm.deal.created',
  'host.crm.deal.updated',
  'host.crm.deal.stage-changed',
  'host.crm.deal.won',
  'host.crm.deal.lost',
  'host.crm.deal.deleted',
  'host.crm.deal.exported',
  'host.crm.task.created',
  'host.crm.task.updated',
  'host.crm.task.completed',
  'host.crm.task.deleted',
  'host.crm.task.exported',
  'host.crm.activity.logged',
  'host.crm.activity.exported',
  'host.crm.segment.created',
  'host.crm.segment.updated',
  'host.crm.segment.deleted',
  'host.crm.pipeline.created',
  'host.crm.pipeline.updated',
  'host.crm.pipeline.deleted',
  'host.crm.fielddef.created',
  'host.crm.fielddef.deleted',
  'host.crm.booking-link.created',
  'host.crm.sign-request.created',
  'host.crm.sign-request.signed',
  'host.crm.sign-request.completed',
  'host.crm.sign-request.declined',
  'host.crm.sign-request.voided',
  // host.cms.page.*
  'host.cms.page.submitted',
  'host.cms.page.published',
  'host.cms.page.rejected',
  'host.cms.page.unpublished',
  'host.cms.page.archived',
  'host.cms.page.restored',
  // host.campaign.*
  'host.campaign.brief.created',
  'host.campaign.brief.validated',
  'host.campaign.brief.confirmed',
  'host.campaign.brief.deleted',
  'host.campaign.campaign.status-changed',
  'host.campaign.campaign.finalized',
  'host.campaign.campaign.deleted',
  'host.campaign.ads.dispatched',
  'host.campaign.ads.budget-updated',
  'host.campaign.ads.audience-synced',
  // host.forms.* (ADR 0246 — `features/forms/emit.ts`; the ignition for the
  // `forms-intake.route-submission` chain, which is unbindable without it)
  'host.forms.submission.created',
  // host.users.* (ADR 0617 D1 — `features/users/emit.ts`; ids-only lifecycle
  // events from the ONE status writer. `deactivated` is the ignition for the
  // `people-hr.offboarding` chain's SCIM-leaver lane — see that pack's README.)
  'host.users.user.provisioned',
  'host.users.user.deactivated',
  'host.users.user.reactivated',
  'host.users.user.erased',
  // host.orgs.invitation.* (ADR 0622 D1 — `features/orgs/emit.ts`; ids-only
  // invitation lifecycle from ONE site each: `created` (the route + the
  // `feature.orgs.nodes.invite` surface), `accepted` (the ignition for a
  // welcome/onboarding chain — carries `memberId`/`userId`, never the email),
  // `revoked` (the admin route only), `declined` (ADR 0564). No `expired`.)
  'host.orgs.invitation.created',
  'host.orgs.invitation.accepted',
  'host.orgs.invitation.revoked',
  'host.orgs.invitation.declined',
  // host.profiles.* (ADR 0624 D3 — `features/profiles/emit.ts`; ids-only
  // lifecycle from the WRITERS, transition-guarded: `endorsement.given` /
  // `.removed` (the "endorsement received → notify the endorsee" recipe — a
  // tenant-authored chain; payload names the endorser id + the skill NAME),
  // `profile.updated` (`fields[]` = changed top-level keys, never values; an
  // identical PATCH emits nothing), `completeness.crossed` (`from`/`to`/
  // `direction`/`thresholds[]` over the 25/50/75/100 bands — ONE event per
  // write). No pin / knowledge events (ADR 0023 / ADR 0042). A bound chain
  // reads the store via `feature.profiles.nodes.get`, never the KB mirror.)
  'host.profiles.endorsement.given',
  'host.profiles.endorsement.removed',
  'host.profiles.profile.updated',
  'host.profiles.completeness.crossed',
  // host.kb.* (ADR 0643 D3 — `features/kb/emit.ts`; ids-only lifecycle from ONE
  // site per transition, pinned BOTH ways against the backend's closed-world
  // `KB_EVENT_VERBS` by `test/host-event-catalog-parity.test.ts`. `document.
  // ingested` fires on the CREATED branch only (a same-id re-ingest that changes
  // nothing emits nothing); bulk lanes — the six backfill sweeps, knowledge-sync,
  // provisioning — are silent per row and emit ONE `document.ingested { count }`;
  // the ERASURE lanes are silent unconditionally (the documentId there IS the
  // erased subject's key). `document.updated` carries `revision`; `reindex.failed`
  // carries a closed `reason` (`cancelled` | `lease-expired` | `collection-deleted`
  // | `embedder-unavailable` | `embed-error`). Payloads never carry a title, text
  // or subject key — a bound chain reads the store via `feature.kb.nodes.*`.)
  'host.kb.document.ingested',
  'host.kb.document.updated',
  'host.kb.document.deleted',
  'host.kb.reindex.started',
  'host.kb.reindex.completed',
  'host.kb.reindex.failed',
  // host.commerce.*
  'host.commerce.order.created',
  'host.commerce.order.paid',
  'host.commerce.order.fulfillment-updated',
  'host.commerce.order.canceled',
  'host.commerce.order.refunded',
  'host.commerce.inventory.low-stock',
];
