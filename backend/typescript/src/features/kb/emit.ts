/**
 * KB lifecycle side-channel (ADR 0643 D3 — the ADR 0627 D2 `crm/emit.ts` shape).
 * Every KB lifecycle transition calls `kbMutated` from exactly ONE site: the
 * service function that performs the durable write and DECIDES the transition
 * on the landed row (`kbService.ts`). A host event (webhooks + trigger
 * bindings), nothing else.
 *
 * ONE SITE PER TRANSITION, enumerated:
 *   - `document.ingested` — the CREATED branch of `ingestDocument` only. The
 *     stable-id replace (`upsertDocument` over a prior row) is an `updated`, so
 *     it runs its ingest half silent; a same-id, same-content re-upsert returns
 *     the prior projection before any write and emits NOTHING.
 *   - `document.updated`  — `upsertDocument`, iff content changed under a
 *     stable id (the pre-existing site; `revision` rides the payload).
 *   - `document.deleted`  — `deleteDocument`, the route lane. The eraser, the
 *     DSAR remover and every bulk lane pass `{ silent: true }` (below).
 *   - `reindex.started`   — `startReindex`, after the job row's CAS insert.
 *   - `reindex.completed` — the cutover branch of `drainReindexCore`.
 *   - `reindex.failed`    — `drainReindexCore`'s ONE `fail()` helper (provider
 *     / collection failures) and `cancelReindex` (`reason:'cancelled'`, or
 *     `'lease-expired'` when ADR 0643 D1a's guard cancelled a stale job).
 *
 * SILENT LANES, TWO KINDS — and the difference is the point:
 *   (a) BULK, a volume decision: the six backfill sweeps, the knowledge-sync
 *       runner's per-file re-ingest and provisioning lanes pass `{ silent: true }`
 *       per row and, where a batch is meaningful, emit ONE `document.ingested
 *       { count }`. A 10 000-document import must not ignite 10 000 runs.
 *   (b) ERASURE, a correctness rule (ADR 0643 review #5): `eraseSubjectKb`
 *       deletes documents whose `documentId` IS the subject key
 *       (`subjectKeyedDocId`), and `removeProfileStrict` does the same on the
 *       DSAR fan-out. A `document.deleted { documentId }` there would publish
 *       the just-erased person's identifier to every webhook subscriber and
 *       into `metadata.triggerData` of every bound run, at the one moment the
 *       system has promised it is gone. `stripPiiPayload` cannot save it (it
 *       matches `email`/`phone` keys; an id-shaped string carries no signal).
 *       Those lanes pass `{ silent: true }` UNCONDITIONALLY.
 *
 * PAYLOAD DISCIPLINE — ids only: `orgId`, `collectionId`, `documentId`,
 * `revision`, `count`, and a CLOSED `reason` enum on `reindex.failed`. Never a
 * title, never chunk text, never a subject key, never a provider error string
 * (that text is the job row's `error`, read under authz).
 *
 * AWAITED, NOT DETACHED (ADR 0643 D6): `kbMutated` returns the dispatcher's
 * promise and every caller `await`s it — `emitHostEvent` never throws by
 * contract (`hostEventDispatcher.ts` — "NEVER throws"), so awaiting costs
 * only latency, while a `void`'d continuation on this host is documented to
 * be dropped under `cpu-throttling=true` (see the rule in `kbService`'s docblock).
 *
 * ADR 0617 D1a — `origin` is stamped ONLY by a workflow surface; the dispatcher
 * skips a binding whose workflow (or chain lineage) equals the emitting run's.
 *
 * `KB_EVENT_TYPES` is the closed-world catalog leg: `kbMutated`'s
 * `entity`/`verb` pair is typed against `KB_EVENT_VERBS`, and
 * `test/host-event-catalog-parity.test.ts` asserts the frontend's hand-listed
 * `KNOWN_HOST_EVENT_TYPES ∩ host.kb.*` equals this set in BOTH directions,
 * pinned to an exact count.
 */
import { emitHostEvent, type HostEventOrigin } from '../../host/hostEventDispatcher.js';

/** ADR 0643 D3 — the closed-world verb set per entity (the SSoT for
 *  `host.kb.<entity>.<verb>`). Adding a verb here is the ONLY way to emit it;
 *  the catalog parity test then requires the matching frontend row. */
export const KB_EVENT_VERBS = {
  document: ['ingested', 'updated', 'deleted'],
  reindex: ['started', 'completed', 'failed'],
} as const;

export type KbEntity = keyof typeof KB_EVENT_VERBS;
export type KbEventVerb<E extends KbEntity> = (typeof KB_EVENT_VERBS)[E][number];
export type KbEventType = { [E in KbEntity]: `host.kb.${E}.${KbEventVerb<E>}` }[KbEntity];

/** Every `host.kb.*` type this host can emit — derived from the verb table. */
export const KB_EVENT_TYPES: readonly KbEventType[] = (Object.keys(KB_EVENT_VERBS) as KbEntity[]).flatMap((entity) =>
  (KB_EVENT_VERBS[entity] as readonly string[]).map((verb) => `host.kb.${entity}.${verb}` as KbEventType),
);

/** The closed `reason` vocabulary on `reindex.failed`. Ids-only discipline: the
 *  provider's error TEXT stays on the job row, never on the wire. */
export type KbReindexFailReason = 'cancelled' | 'lease-expired' | 'collection-deleted' | 'embedder-unavailable' | 'embed-error' | 'cutover-conflict';

/** The emit options every mutating KB service function accepts (ADR 0643 D3). */
export interface KbEmitOptions {
  /** ADR 0617 D1a self-trigger guard — stamped by a workflow surface only. */
  origin?: HostEventOrigin;
  /** Bulk / provisioning / ERASURE lanes: perform the write, emit nothing. A bulk
   *  lane emits ONE `document.ingested { count }` instead; an erasure lane emits
   *  nothing at all (see the docblock — this is a correctness rule there). */
  silent?: boolean;
}

type KbMutation = { [E in KbEntity]: { entity: E; verb: KbEventVerb<E> } }[KbEntity];

/**
 * Emit one KB lifecycle event. Returns the dispatcher's promise — AWAIT it (D6).
 * Never throws (`emitHostEvent`'s contract); `silent` short-circuits before any
 * fan-out.
 */
export function kbMutated(input: KbMutation & KbEmitOptions & {
  tenantId: string;
  orgId: string;
  collectionId: string;
  /** Per-document transitions. Absent on a batch `ingested { count }` and on reindex events. */
  documentId?: string;
  /** `document.updated` only — the NEW revision number. */
  revision?: number;
  /** Batch lanes only (`document.ingested`): how many documents the ONE event stands for. */
  count?: number;
  /** `reindex.failed` only. */
  reason?: KbReindexFailReason;
}): Promise<void> {
  if (input.silent) return Promise.resolve();
  const { entity, verb, tenantId, orgId, collectionId, documentId, revision, count, reason, origin } = input;
  return emitHostEvent({
    type: `host.kb.${entity}.${verb}`,
    tenantId,
    payload: {
      orgId,
      collectionId,
      ...(documentId ? { documentId } : {}),
      ...(typeof revision === 'number' ? { revision } : {}),
      ...(typeof count === 'number' ? { count } : {}),
      ...(reason ? { reason } : {}),
    },
    ...(origin ? { origin } : {}),
  });
}
