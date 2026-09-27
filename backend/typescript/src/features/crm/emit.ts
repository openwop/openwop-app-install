/**
 * CRM lifecycle side-channel (ADR 0208 §1/§3, reshaped by ADR 0627 D2) — every
 * CRM lifecycle transition calls `crmMutated` from exactly ONE site: the entity
 * service that performs the durable write (`contactsService`, `entities/*`,
 * `segmentsService`, `crmMergeService`, `convertService`). A host event
 * (webhooks + trigger bindings) and a best-effort audit append, both
 * fire-and-forget so they can never fail the mutation.
 *
 * WHY the services and not the callers: this file used to claim the HTTP route
 * handlers and the `ctx.features.crm` verbs were "the two entry paths that
 * exist". They were not — the forms sink, CSV import, the anon lead-capture
 * tool, public booking, commerce checkout and the webinar processor all called
 * `createContact`/`ensureContact` directly and emitted nothing, so the chain
 * advertised as "auto-route every new lead" never fired for the lanes that
 * produce leads (`CRMWF-2`). Owning the emit at the write means every caller
 * — present and future — is covered by construction.
 *
 * TRANSITION GUARDS are decided on the LANDED row inside the write (the ADR
 * 0617 SHOULD-3 shape): `deal.stage-changed` iff the stage moved; `deal.won`
 * / `deal.lost` iff `status` flipped; `task.completed` iff the status flipped
 * to `done`; `activity.logged` only on the CREATED branch (a deterministic-id
 * re-append emits nothing). A re-PATCH is not a transition.
 *
 * THE TWO EXCEPTIONS, stated: `imported` and `exported` stay at their ROUTE —
 * there is no service write to move them to. Bulk lanes (CSV import, the
 * webinar participant sync, the demo seeds) pass `{ silent: true }` per row
 * and the batch lane emits ONE `imported` carrying `count` — 10k rows must not
 * start 10k bound runs (ADR 0627 alternative 2).
 *
 * PAYLOAD DISCIPLINE — ids only: `entityType`, `entityId`, `orgId`, `changed`
 * (top-level FIELD NAMES, never values), `sourceEntityId` (`merged` only — the
 * absorbed entity's id, a NAMED key, never smuggled into `changed`), `count`.
 * Never a name/email/phone.
 *
 * `changed` IS A DIFF, NOT THE PATCH'S KEYS (review S1 of the D2 build): every
 * `update*` computes it with `changedFields(prev, next)` on the pre-image vs
 * the landed row, so a value-equal re-PATCH yields `[]` and emits nothing —
 * "idempotent re-PATCH ⇒ no event" is decided on the ROWS. The first cut used
 * `Object.keys(patch)`, which re-emitted `updated` (and re-triggered every
 * bound workflow) for a PATCH that changed nothing.
 *
 * ADR 0617 D1a — `origin` is stamped ONLY by the workflow surface
 * (`surface.ts`): the dispatcher skips a binding whose workflow (or chain
 * lineage) equals the emitting run's, so a chain that creates a contact cannot
 * start a second run of itself through its own `contact.created` binding.
 *
 * `CRM_EVENT_TYPES` is the closed-world catalog leg: `crmMutated`'s
 * `entity`/`verb` pair is typed against `CRM_EVENT_VERBS`, and
 * `test/host-event-catalog-parity.test.ts` asserts the frontend's hand-listed
 * `KNOWN_HOST_EVENT_TYPES ∩ host.crm.*` equals this set in BOTH directions.
 */
import { emitHostEvent, type HostEventOrigin } from '../../host/hostEventDispatcher.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';

/** ADR 0627 D2 — the closed-world verb set per entity (the SSoT for
 *  `host.crm.<entity>.<verb>`). Adding a verb here is the ONLY way to emit it;
 *  the catalog parity test then requires the matching frontend row. */
export const CRM_EVENT_VERBS = {
  contact: ['created', 'updated', 'deleted', 'merged', 'converted', 'imported', 'exported'],
  company: ['created', 'updated', 'deleted', 'merged', 'imported', 'exported'],
  deal: ['created', 'updated', 'deleted', 'stage-changed', 'won', 'lost', 'exported'],
  task: ['created', 'updated', 'deleted', 'completed', 'exported'],
  activity: ['logged', 'exported'],
  segment: ['created', 'updated', 'deleted'],
  pipeline: ['created', 'updated', 'deleted'],
  fielddef: ['created', 'deleted'],
  // ADR 0402 — booking links + e-signature depth.
  'booking-link': ['created'],
  'sign-request': ['created', 'signed', 'completed', 'declined', 'voided'],
} as const;

export type CrmEntity = keyof typeof CRM_EVENT_VERBS;
export type CrmEventVerb<E extends CrmEntity> = (typeof CRM_EVENT_VERBS)[E][number];
export type CrmEventType = { [E in CrmEntity]: `host.crm.${E}.${CrmEventVerb<E>}` }[CrmEntity];

/** Every `host.crm.*` type this host can emit — derived from the verb table. */
export const CRM_EVENT_TYPES: readonly CrmEventType[] = (Object.keys(CRM_EVENT_VERBS) as CrmEntity[]).flatMap((entity) =>
  (CRM_EVENT_VERBS[entity] as readonly string[]).map((verb) => `host.crm.${entity}.${verb}` as CrmEventType),
);

/** The emit options every mutating CRM service accepts (ADR 0627 D2). */
export interface CrmEmitOptions {
  /** Opaque actor id for the audit row — a principal for HTTP callers,
   *  `run:<runId>` for surface verbs, `system:<lane>` for cross-feature lanes.
   *  Services fall back to the row's `createdBy`, then `system:crm`. */
  actor?: string;
  /** ADR 0617 D1a self-trigger guard — stamped by the workflow surface only. */
  origin?: HostEventOrigin;
  /** Bulk/seed lanes: perform the write, emit nothing (no event, no audit row);
   *  the batch lane emits ONE `imported` instead. */
  silent?: boolean;
}

/** Pick the emit options off a service input that intersects `CrmEmitOptions`. */
export function emitOptsOf(input: CrmEmitOptions & { createdBy?: string }): CrmEmitOptions {
  return {
    ...(input.actor ?? input.createdBy ? { actor: input.actor ?? input.createdBy } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.silent ? { silent: true } : {}),
  };
}

/** Structural equality for row values — plain objects, arrays, primitives (a
 *  CRM row holds nothing else: `customFields`, `identifiers[]`, `stages[]`,
 *  `tags[]`, `filters[]`). Order-sensitive for arrays (a reordered `stages[]`
 *  IS a change). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a as Record<string, unknown>).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as Record<string, unknown>).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * ADR 0627 D2 (review S1) — the top-level field names whose value differs
 * between the PRE-IMAGE row and the LANDED row, sorted. `updatedAt` is excluded
 * (every write stamps it, so it would make every re-PATCH look like a change).
 * A deleted key (`delete next.owner`) vs a present one is a change; a
 * value-equal re-PATCH is `[]`. Callers emit `updated` ONLY when non-empty.
 */
export function changedFields<T extends object>(prev: T, next: T, ignore: readonly string[] = ['updatedAt']): string[] {
  const p = prev as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  const keys = new Set([...Object.keys(p), ...Object.keys(n)]);
  return [...keys].filter((k) => !ignore.includes(k) && !deepEqual(p[k], n[k])).sort();
}

type CrmMutation = { [E in CrmEntity]: { entity: E; verb: CrmEventVerb<E> } }[CrmEntity];

export function crmMutated(input: CrmMutation & CrmEmitOptions & {
  tenantId: string;
  entityId: string;
  orgId?: string;
  /** Changed top-level field names (ids-only payload discipline — no values).
   *  A DIFF (`changedFields`), never the patch's keys. */
  changed?: string[];
  /** `merged` only — the id of the entity absorbed into `entityId` (review S5:
   *  an id is not a field name, so it gets its own key rather than `changed`). */
  sourceEntityId?: string;
  /** Batch lanes only (`imported`): how many rows the ONE event stands for. */
  count?: number;
}): void {
  if (input.silent) return;
  const { entity, verb, tenantId, entityId, orgId, changed, sourceEntityId, count, origin } = input;
  const actor = input.actor ?? 'system:crm';
  void emitHostEvent({
    type: `host.crm.${entity}.${verb}`,
    tenantId,
    payload: {
      entityType: entity,
      entityId,
      ...(orgId ? { orgId } : {}),
      ...(changed && changed.length > 0 ? { changed } : {}),
      ...(sourceEntityId ? { sourceEntityId } : {}),
      ...(typeof count === 'number' ? { count } : {}),
    },
    ...(origin ? { origin } : {}),
  });
  // payload.tenantId is REQUIRED — the governance audit view fail-closed
  // filters on it (rows without it are invisible to non-wildcard admins).
  void hostExtStorage()
    .appendAudit({
      timestamp: new Date().toISOString(),
      principalId: actor,
      action: `crm.${entity}.${verb}`,
      resource: `crm-${entity}:${entityId}`,
      outcome: 'success',
      payload: { tenantId, ...(orgId ? { orgId } : {}) },
    })
    .catch(() => {});
}
