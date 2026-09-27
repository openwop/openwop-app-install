/**
 * Host-extension durability helper (read-through, best-effort-hardened).
 *
 * Backs the host-extension stores (Kanban boards/cards, agent roster,
 * org-chart, RFC 0083 trigger bridge) with the generic `Storage` kv table —
 * but, unlike the previous boot-hydrate + in-memory write-back cache, this is
 * a READ-THROUGH, PER-ENTITY, SYNCHRONOUSLY-WRITTEN store:
 *
 *  - READ-THROUGH: every read hits storage, so a write made on one process is
 *    visible to every other process immediately (no boot-time snapshot that
 *    drifts). This is what makes a multi-instance deployment correct — the
 *    earlier cache forced a single instance.
 *  - PER-ENTITY: each entity is one row keyed `hostext:<name>:<id>`, so two
 *    concurrent writes to *different* entities never clobber each other (the
 *    prior whole-collection blob lost one of any two concurrent writes), and a
 *    mutation rewrites one row, not the whole collection.
 *  - SYNCHRONOUS: a write `await`s its `kvSet`/`kvDelete` before the service
 *    returns, closing the fire-and-forget data-loss window.
 *
 * FEAT-1 status (docs/steward/CODEBASE-ASSESSMENT.md) — the two concerns the audit raised
 * are addressed at the infrastructure level here:
 *  - OPTIMISTIC CONCURRENCY: `compareAndSwap()` below is a real cross-instance
 *    CAS (`If-Match`-equivalent) on a single entity — a service that needs
 *    last-writer-loses semantics reads, then swaps against the read value. (The
 *    plain `put()` remains last-writer-wins by design for the common
 *    no-contention path.)
 *  - SCOPED SCANS: `listByPrefix(idPrefix)` is a storage-level secondary-index
 *    read (ADR 0029) — a collection whose ids embed the dimensions
 *    (`${tenantId}:${entityId}`) turns a tenant query into a bounded scan of
 *    just that slice instead of `list()`'s full-collection scan + in-memory
 *    filter.
 *
 * Remaining per-feature work (not an infra gap): each feature still has to ADOPT
 * tenant-prefixed ids + call `listByPrefix('${tenantId}:')` to get the bounded
 * scan; collections that still call bare `list()` scan all tenants and filter in
 * the service layer (fine at demo scale, indexed by the kv primary key). That
 * adoption is a per-collection key-scheme + data-migration choice, not a change
 * to this helper.
 *
 * The Kanban SSE board-change fan-out is now CROSS-INSTANCE: see
 * `publishHostExtEvent`/`subscribeHostExtEvent` below, backed by the storage
 * pub/sub (Postgres LISTEN/NOTIFY; in-process emitter on sqlite).
 */

import type { Storage } from '../storage/storage.js';

let storageRef: Storage | null = null;

/** Wire the durability layer to the host's storage. Called once at boot. */
export function initHostExtPersistence(storage: Storage): void {
  storageRef = storage;
}

/** Test-only: drop the storage ref. */
export function __resetHostExtPersistence(): void {
  storageRef = null;
}

/** Test-only: the bound storage handle, so route tests can assert persisted
 *  rows (e.g. server-side run.metadata stamps) the wire snapshot rightly omits. */
export function __hostExtStorage(): Storage | null {
  return storageRef;
}

/** ADR 0284 — the live-collection registry tenant teardown walks. Populated by the
 *  `DurableCollection` constructor (module-singleton instances, created at import). */
const HOSTEXT_COLLECTIONS: Array<{
  prefix: string;
  /** WF-ORGINV-1 — whether this collection maintains a `hostextidx:` tenant
   *  secondary index. The kvAgeOut seam consults this at registration time
   *  (tripwire) and at sweep time (delete via the collection so markers can
   *  never strand). */
  indexed: boolean;
  /** Marker-aware delete by row id (WF-ORGINV-1) — identical to a raw
   *  `kvDelete` for index-free collections, and additionally cleans the
   *  tenant-index marker for indexed ones. */
  deleteById: (id: string) => Promise<boolean>;
  purge: (tenantId: string) => Promise<number>;
  countFor: (tenantId: string, orgId?: string) => Promise<number>;
}> = [];

/**
 * WF-SHARE-1 — delete cascades, keyed by NAMESPACE rather than by handle.
 *
 * This is a map and not a constructor field because a namespace can legitimately
 * have MORE THAN ONE `DurableCollection` handle over it, and the registry above
 * dedupes by prefix with last-construction-wins. Sharing has exactly that shape:
 * `links` (the live hash-keyed view) and `legacyLinksView` (the ADR 0448 P2
 * raw-token migration view) both name `sharing:link`, and the legacy one is
 * constructed second. With the cascade stored on the instance, the entry the
 * kvAgeOut sweep resolves was the hook-LESS one — so the frame-view cascade was
 * silently inert on the exact lane it was written for, while every direct
 * `links.delete()` still worked. It read as correct in review and failed only
 * under the retention test.
 *
 * A cascade is a fact about the DATA ("frame-view rows belong to a link row"),
 * so it belongs to the namespace: registered once, fired by whichever handle
 * performs the delete, and never cleared by a later hook-less construction.
 */
const HOSTEXT_DELETE_HOOKS = new Map<string, (id: string) => Promise<void>>();

/** WF-ORGINV-1 — the live collection registered for a `hostext:<name>:` prefix,
 *  if any (collections self-register at construction). Lets the kvAgeOut seam
 *  detect a tenant-indexed collection and delete THROUGH it (cleaning the
 *  `hostextidx:` marker) instead of deleting raw kv rows underneath it. */
export function hostExtCollectionForPrefix(
  prefix: string,
): { indexed: boolean; deleteById: (id: string) => Promise<boolean> } | null {
  const c = HOSTEXT_COLLECTIONS.find((e) => e.prefix === prefix);
  return c ? { indexed: c.indexed, deleteById: c.deleteById } : null;
}

/**
 * PMXWF-1 (ADR 0590) — feature-registered tenant-purge PRE-hooks. A feature
 * whose child rows carry NO tenant marker (neither `tenantOf` nor a JSON
 * `tenantId`) and are tenant-resolvable only through a PARENT row this walk
 * deletes (e.g. priority-matrix overlays keyed `listId::cardId`) registers a
 * purge here. Hooks run FIRST inside `purgeTenantHostExt` — before the generic
 * walk destroys the parent rows that are the children's only tenant resolution
 * — so EVERY teardown lane (account delete, the anon retention sweep, any
 * future caller) is covered at the one composition owner rather than per call
 * site (the KT-D1 `purgeTenantKanban` pre-step covers only the account lane).
 * A hook MUST be idempotent and strictly tenant-scoped. Hook failures
 * PROPAGATE: an incomplete purge must never report success.
 */
const TENANT_PURGE_HOOKS: Array<{ id: string; run: (tenantId: string) => Promise<number> }> = [];

export function registerTenantPurgeHook(id: string, run: (tenantId: string) => Promise<number>): void {
  const existing = TENANT_PURGE_HOOKS.findIndex((h) => h.id === id);
  if (existing >= 0) TENANT_PURGE_HOOKS[existing] = { id, run }; // idempotent re-registration (test re-boots)
  else TENANT_PURGE_HOOKS.push({ id, run });
}

/** Best-effort JSON `tenantId` probe for rows whose collection has no `tenantOf`. */
function jsonTenantId(row: unknown): string | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const t = (row as { tenantId?: unknown }).tenantId;
  return typeof t === 'string' ? t : undefined;
}

/**
 * The rows `countRowsFor` must examine for an org-scoped count — every row of the
 * collection, narrowed IN THE DATABASE to those whose raw JSON contains the org id's
 * text, when that narrowing is provably lossless.
 *
 * WHY (2026-09-26): `deleteOrg`'s refuse-while-populated guard pulled EVERY row of
 * EVERY collection into the app to count one org's rows — ~134k rows / ~60 MB on
 * production — and hit the Postgres statement timeout, so deleting any org 500'd.
 *
 * WHY IT CANNOT UNDERCOUNT: a row only counts when its JSON `orgId` equals `orgId`,
 * and `JSON.stringify` writes a printable-ASCII string with no `"` or `\` verbatim,
 * so every row that counts contains that exact text. The database filter is
 * therefore a SUPERSET — it can only drop rows that could not have counted — and the
 * exact filter below still decides. An org id outside that alphabet (whose JSON
 * spelling could differ from its raw text) takes the full scan, as does a backend
 * without `kvListContaining`. NOT the tenant index: it tolerates missing markers
 * (FU-DATA-1), and an undercount here would let a populated org be deleted.
 */
async function scanCandidates(prefix: string, orgId: string | undefined): Promise<ReadonlyArray<{ key: string; value: string }>> {
  const storage = requireStorage();
  const lossless = orgId !== undefined && /^[\x20-\x7e]+$/.test(orgId) && !/["\\]/.test(orgId);
  if (lossless && storage.kvListContaining) return storage.kvListContaining(prefix, orgId);
  return storage.kvList(prefix);
}

/** Best-effort JSON `orgId` probe (the RI-7 org-scoped guard uses it). */
function jsonOrgId(row: unknown): string | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const o = (row as { orgId?: unknown }).orgId;
  return typeof o === 'string' ? o : undefined;
}

/**
 * Grade-data RI-7 — count a tenant's `host_ext_kv` rows scoped to `orgId` across
 * every live collection EXCEPT the excluded namespaces (the caller excludes its
 * own bookkeeping — e.g. `deleteOrg` excludes the access-control scaffolding it
 * legitimately deletes). Used as a refuse-while-populated guard, not a hot path.
 */
export async function countOrgHostExtRows(
  tenantId: string,
  orgId: string,
  excludeNamespacePrefixes: readonly string[] = [],
): Promise<number> {
  if (!tenantId || !orgId) return 0;
  let total = 0;
  for (const c of HOSTEXT_COLLECTIONS) {
    if (excludeNamespacePrefixes.some((p) => c.prefix.startsWith(`hostext:${p}`))) continue;
    total += await c.countFor(tenantId, orgId);
  }
  return total;
}

/**
 * ADR 0284 — delete every `host_ext_kv` row a tenant owns, across (1) all LIVE
 * `DurableCollection`s (walked via the self-registration above — no hand-kept
 * manifest to forget) and (2) GHOST namespaces no live collection owns (rows left
 * behind by retired features), matched on their JSON `tenantId`. The account-
 * deletion flow calls this beside `storage.deleteAllTenantData` (the SQL half).
 * Idempotent and resumable: a re-run finds nothing left. Fail-closed on a falsy
 * tenant. A LIVE collection's `hostextidx:` markers are now swept by KEY
 * (GEN-1d — `purgeTenantRows` clears the `hostextidx:<name>:<tenant>:` slice even
 * for stale markers the content scan can't reach). Accepted residue (documented in
 * the ADR): `hostextidx:` markers of GHOST namespaces no live collection owns, and
 * non-`hostext:` host markers (e.g. seed-claim CAS rows) — marker-only rows with no
 * payload and no registered collection to drive the key sweep.
 */
export async function purgeTenantHostExt(
  tenantId: string,
): Promise<{ deleted: number; ghostRows: number; collections: number }> {
  if (!tenantId) return { deleted: 0, ghostRows: 0, collections: 0 };
  let deleted = 0;
  let collections = 0;
  // PMXWF-1 — feature pre-hooks FIRST, while the parent rows that resolve the
  // tenant for markerless child rows still exist. Failures propagate (an
  // incomplete purge must not report success).
  for (const hook of TENANT_PURGE_HOOKS) {
    deleted += await hook.run(tenantId);
  }
  for (const c of HOSTEXT_COLLECTIONS) {
    const n = await c.purge(tenantId);
    if (n > 0) { deleted += n; collections += 1; }
  }
  let ghostRows = 0;
  const live = HOSTEXT_COLLECTIONS.map((c) => c.prefix);
  // (`hostextidx:`/`hostextidxmeta:` keyspaces don't match the `hostext:` prefix —
  // the scan sees content rows only.)
  for (const { key, value } of await requireStorage().kvList('hostext:')) {
    if (live.some((p) => key.startsWith(p))) continue; // handled above
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { continue; }
    if (jsonTenantId(parsed) !== tenantId) continue;
    if (await requireStorage().kvDelete(key)) ghostRows += 1;
  }
  return { deleted, ghostRows, collections };
}

function requireStorage(): Storage {
  if (!storageRef) {
    throw new Error('host-ext persistence not initialized — call initHostExtPersistence() at boot');
  }
  return storageRef;
}

/** The bound host-ext storage, or throw if boot hasn't wired it. Public
 *  accessor for host-side services that need `Storage` but aren't handed it
 *  through a route's deps (e.g. the assistant ensuring its seeded agent via
 *  the demo seeder). */
export function hostExtStorage(): Storage {
  return requireStorage();
}

/**
 * Cross-instance live-event fan-out for the host-ext surfaces (e.g. the Kanban
 * SSE board-change push). Delegates to the storage pub/sub — LISTEN/NOTIFY on
 * Postgres (every instance), an in-process emitter on sqlite (single node) —
 * so a mutation on one instance reaches SSE clients on every instance.
 */
export async function publishHostExtEvent(channel: string, payload: string): Promise<void> {
  await requireStorage().publish(channel, payload);
}

export async function subscribeHostExtEvent(
  channel: string,
  handler: (payload: string) => void,
): Promise<() => Promise<void>> {
  return requireStorage().subscribe(channel, handler);
}

/**
 * A read-through, per-entity durable collection. `name` may contain `:` to
 * namespace sub-collections (e.g. `kanban:board`). `idOf` extracts an entity's
 * stable id (the row key suffix).
 */
export class DurableCollection<T> {
  /**
   * @param validate OPTIONAL runtime validator (DEBT-7). When provided, every
   *   row read from storage is run through it instead of a blind `as T` cast,
   *   so a corrupt / schema-drifted persisted row is rejected (returns null /
   *   skipped) rather than flowing into the app as a malformed `T`. Collections
   *   that want input validation at the persistence boundary pass a predicate
   *   (e.g. an Ajv validator or a hand-written type guard).
   */
  /**
   * @param tenantOf OPTIONAL (GOV-1 / FEAT-1). When provided, the collection maintains a
   *   TENANT SECONDARY INDEX in a separate `hostextidx:` keyspace — a marker per row keyed
   *   `${tenantId}:${id}` — so `listForTenantIndexed(tenantId)` is a BOUNDED scan of just
   *   that tenant's slice instead of `list()`'s full-collection scan + in-memory filter.
   *   Crucially this does NOT re-key the primary rows (`key(id)` is unchanged), so there is
   *   no data migration on the primary store and no data-loss risk: the worst case is a
   *   missing marker (the row is simply not enumerated this pass — retention is delayed, not
   *   lost; `ensureTenantIndex()` backfills) or a stale marker (a harmless skip).
   */
  constructor(
    private readonly name: string,
    private readonly idOf: (item: T) => string,
    private readonly validate?: (parsed: unknown) => T | null,
    private readonly tenantOf?: (item: T) => string,
    /**
     * OPTIONAL (GC-CV-11). When set, the tenant-index MARKER stores a small
     * identity PROJECTION of the row (`{id, p}`) alongside the id, so
     * `listForTenantProjected(tenantId)` returns those projections WITHOUT
     * reading + decoding the full primary rows — the fix for listing a tenant
     * whose rows carry large blobs (e.g. `canvas.state`). Opt-in per collection:
     * collections without it keep the bare-id marker, unchanged. Backward- and
     * forward-compatible: a legacy bare-id marker is transparently upgraded on
     * the next projected read (self-heal), and `listForTenantIndexed` reads the
     * id out of either marker shape.
     */
    private readonly indexProjection?: (item: T) => Record<string, unknown>,
    /**
     * WF-SHARE-1 — OPTIONAL sidecar cascade, fired AFTER a row is removed by
     * `delete()`. It exists because a collection can be reclaimed by paths its
     * owning feature never calls: the kvAgeOut tick (`deleteById`), tenant
     * teardown (`purgeTenantRows`), or a sibling feature's cascade. Sharing's
     * per-link `sharing:frameview` rows were previously reclaimed only by the
     * feature's own bespoke sweep, so moving that sweep onto the sanctioned
     * retention lane would have turned the analytics rows into the new orphans.
     *
     * Contract, stated because all three halves matter: it runs ONLY when the row
     * actually existed; it MAY THROW (a cascade that fails silently is how orphans
     * are minted — callers that must not fail, like the kvAgeOut tick, already wrap
     * their sweep); and it is registered per NAMESPACE, so EVERY handle over this
     * namespace fires it, including ones constructed later without it (see
     * `HOSTEXT_DELETE_HOOKS` above for the aliasing that makes that necessary).
     * Keep the handler bounded and idempotent: a re-delete of an already-gone row
     * does not fire it.
     */
    private readonly onDeleted?: (id: string) => Promise<void>,
  ) {
    // ADR 0284 — every collection self-registers so tenant teardown can walk the
    // full live surface with no hand-kept manifest (complete by construction, the
    // same rationale as tenantMigration's schema introspection). Deduped by
    // namespace so a re-constructed collection (all are module singletons today;
    // this guards a future dynamic construction) replaces its slot instead of
    // stacking registry entries.
    const prefix = `hostext:${name}:`;
    const at = HOSTEXT_COLLECTIONS.findIndex((c) => c.prefix === prefix);
    const entry = {
      prefix,
      indexed: this.tenantOf !== undefined,
      deleteById: (id: string) => this.delete(id),
      purge: (tenantId: string) => this.purgeTenantRows(tenantId),
      countFor: (tenantId: string, orgId?: string) => this.countRowsFor(tenantId, orgId),
    };
    if (at >= 0) HOSTEXT_COLLECTIONS[at] = entry; else HOSTEXT_COLLECTIONS.push(entry);
    // Namespace-scoped, and deliberately SET-ONLY: a later handle over the same
    // namespace that declares no cascade must not silently remove one.
    if (this.onDeleted) HOSTEXT_DELETE_HOOKS.set(prefix, this.onDeleted);
  }

  private key(id: string): string {
    return `hostext:${this.name}:${id}`;
  }

  private prefix(): string {
    return `hostext:${this.name}:`;
  }

  // --- tenant secondary index (separate keyspace so `list()`/`listByPrefix` never see it) ---
  private idxKey(tenantId: string, id: string): string {
    // FU-DATA-4 — a `tenantOf` that probes a missing field at runtime would mint a
    // bogus `hostextidx:<name>:undefined:<id>` marker slice; throw instead so the
    // defective write fails loud at the source.
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      throw new Error(`hostext '${this.name}': tenantOf produced a non-string/empty tenantId for index marker '${id}'`);
    }
    return `hostextidx:${this.name}:${tenantId}:${id}`;
  }
  private idxPrefix(tenantId: string): string {
    return `hostextidx:${this.name}:${tenantId}:`;
  }
  private get backfillKey(): string {
    return `hostextidxmeta:${this.name}:backfilled`;
  }

  /** The marker VALUE for a row (GC-CV-11): the bare id, or `{id, p}` JSON when
   *  this collection projects into its index. */
  private markerValue(item: T): string {
    const id = this.idOf(item);
    return this.indexProjection ? JSON.stringify({ id, p: this.indexProjection(item) }) : id;
  }

  /** Read a marker value into `{ id, p? }`, tolerating BOTH shapes: a bare id
   *  string (legacy / non-projecting collections) and the `{id, p}` JSON. */
  private parseMarker(value: string): { id: string; p?: Record<string, unknown> } {
    if (value.startsWith('{')) {
      try {
        const o = JSON.parse(value) as { id?: unknown; p?: unknown };
        if (typeof o.id === 'string') return { id: o.id, ...(o.p && typeof o.p === 'object' ? { p: o.p as Record<string, unknown> } : {}) };
      } catch { /* fall through — treat as a bare id */ }
    }
    return { id: value };
  }

  /** Parse one stored row, applying the optional validator. */
  private decode(raw: string): T | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    return this.validate ? this.validate(parsed) : (parsed as T);
  }

  /** Read one entity by id (read-through). */
  async get(id: string): Promise<T | null> {
    const raw = await requireStorage().kvGet(this.key(id));
    if (raw === null) return null;
    return this.decode(raw);
  }

  /**
   * Read the entities whose ID starts with `idPrefix` — a storage-level prefix
   * scan scoped BELOW the collection (ADR 0029's secondary-index read
   * primitive). An index collection whose ids embed the dimensions
   * (`${tenantId}:${status}:${entityId}`) turns hot-path queries into bounded
   * scans of just the matching slice, instead of `list()`'s full-collection
   * scan + in-memory filter.
   */
  async listByPrefix(idPrefix: string): Promise<T[]> {
    const rows = await requireStorage().kvList(this.prefix() + idPrefix);
    const out: T[] = [];
    for (const row of rows) {
      const decoded = this.decode(row.value); // corrupt / invalid → skipped
      if (decoded !== null) out.push(decoded);
    }
    return out;
  }

  /**
   * Bounded per-tenant scan for collections whose ids are tenant-prefixed
   * (`${tenantId}:${entityId}`) — the production-shaped alternative to `list()`
   * + a service-layer tenant filter (FEAT-1). Scans only the tenant's slice.
   */
  async listForTenant(tenantId: string): Promise<T[]> {
    return this.listByPrefix(`${tenantId}:`);
  }

  /**
   * Every entity whose JSON `orgId` is `orgId`, across tenants — the org-delete
   * cascade's read. Same rows `list().filter(r => r.orgId === orgId)` returns
   * (decode skips corrupt/invalid rows exactly as `list()` does), but narrowed
   * in the database by the lossless `scanCandidates` pre-filter instead of
   * pulling the whole namespace: `access-members` grows with every workspace,
   * and a full scan of it inside `deleteOrg` is the statement-timeout shape that
   * 500'd org deletes on 2026-09-26.
   */
  async listForOrg(orgId: string): Promise<T[]> {
    if (!orgId) return [];
    const out: T[] = [];
    for (const { value } of await scanCandidates(this.prefix(), orgId)) {
      const decoded = this.decode(value);
      if (decoded !== null && jsonOrgId(decoded) === orgId) out.push(decoded);
    }
    return out;
  }

  /** Read every entity in the collection (prefix scan, read-through). */
  async list(): Promise<T[]> {
    const rows = await requireStorage().kvList(this.prefix());
    const out: T[] = [];
    for (const row of rows) {
      const decoded = this.decode(row.value); // corrupt / invalid → skipped
      if (decoded !== null) out.push(decoded);
    }
    return out;
  }

  /** Upsert one entity (synchronous — awaits the write). */
  async put(item: T): Promise<void> {
    const id = this.idOf(item);
    // FU-DATA-2 — marker BEFORE row: a crash between the two writes leaves a
    // stale/early marker, which the indexed reads self-heal (a marker whose row
    // is missing is skipped + deleted). The reverse order left a committed row
    // permanently invisible to indexed reads (the backfill is sentinel-guarded
    // and runs at most once, so it never repairs a post-sentinel gap).
    if (this.tenantOf) await requireStorage().kvSet(this.idxKey(this.tenantOf(item), id), this.markerValue(item)); // maintain index
    await requireStorage().kvSet(this.key(id), JSON.stringify(item));
  }

  /**
   * Insert one entity **iff its id is not already present**. Returns true iff
   * THIS caller created it.
   *
   * WHY THIS EXISTS. `get()`-then-`put()` is not a lock, and reads as one. The
   * ADR 0684 join ledger documented its `if (await get(id)) return false;` +
   * `put()` as "the record's existence is the lock" — but existence is only
   * checked BEFORE the write, with an `await` in between, so two concurrent
   * first sign-ins both read null, both write, and both are told they won. The
   * duplicate is invisible in the final state: both writes target the same key,
   * so the row count is right and only the SIDE EFFECTS downstream of the
   * boolean are doubled. That is the same shape as this repo's double-refund
   * incident — a legal-transition check only rejects a write it SEES.
   *
   * `kvCompareAndSwap(key, null, next)` is the real primitive (`storage.ts:1294`
   * — "swap only if the key is absent", a single atomic statement per backend,
   * correct ACROSS instances). It already existed; nothing surfaced it on this
   * collection, so every caller needing insert-once hand-rolled the racy form.
   *
   * MARKER ORDER IS DELIBERATE and matches `put()` (FU-DATA-2): the tenant-index
   * marker is written BEFORE the row. When the CAS then LOSES, that marker
   * describes a row another caller just created under the same id and tenant —
   * byte-identical to what the winner writes — so it is correct rather than
   * orphaned. Writing the row first would invert FU-DATA-2 and a crash between
   * the two would leave a committed row permanently invisible to indexed reads.
   */
  async putIfAbsent(item: T): Promise<boolean> {
    const id = this.idOf(item);
    if (this.tenantOf) await requireStorage().kvSet(this.idxKey(this.tenantOf(item), id), this.markerValue(item));
    const res = await requireStorage().kvCompareAndSwap(this.key(id), null, JSON.stringify(item));
    return res.swapped;
  }

  /** Delete one entity by id. Returns true if it existed. Fires `onDeleted`
   *  (when configured) after a real removal — see the constructor param. */
  async delete(id: string): Promise<boolean> {
    const removed = await this.deleteRow(id);
    if (removed) {
      const cascade = HOSTEXT_DELETE_HOOKS.get(this.prefix());
      if (cascade) await cascade(id);
    }
    return removed;
  }

  private async deleteRow(id: string): Promise<boolean> {
    if (this.tenantOf) {
      // Clean the tenant-index marker. We need the row's tenant; one extra read on delete
      // (only for indexed collections — deletes here are infrequent). If the row is already
      // gone we have nothing to unindex.
      //
      // FU-DATA-1 POSTURE, ADDED (R2 review, F2): the read is RAW with the
      // validator applied as a FALLBACK, not as a gate. `this.get(id)` alone
      // returns null for a row this handle's validator rejects, and `if (existing)`
      // then skipped the marker delete — so the row died and its
      // `hostextidx:<name>:<tenant>:<id>` marker STRANDED.
      //
      // That is not hypothetical: `HOSTEXT_COLLECTIONS` is deduped by namespace
      // and LAST CONSTRUCTION WINS, so a legacy migration VIEW constructed after
      // the production handle over the same namespace becomes the registry entry
      // that `hostExtCollectionForPrefix` hands to the kvAgeOut sweep. Sharing has
      // exactly that shape (`legacyLinksView` after `links`, both over
      // `hostext:sharing:link:`), and its legacy validator returns null for every
      // new-shape row — so every aged-out share link stranded a marker. Bounded
      // (the indexed reads self-heal a stale marker), but the sweep's own comment
      // claimed it could not happen, which is the part that was false.
      //
      // The raw JSON `tenantId` probe is the same fallback `purgeTenantRows` uses
      // for validator-rejected rows, and it is why the fix is at this layer rather
      // than in sharing: any namespace with two handles has the same hazard.
      const raw = await requireStorage().kvGet(this.key(id));
      let tenant: string | undefined;
      if (raw !== null) {
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
        const row = parsed === undefined ? null : (this.validate ? this.validate(parsed) : (parsed as T));
        tenant = row !== null && row !== undefined ? this.tenantOf(row) : jsonTenantId(parsed);
      }
      // FU-DATA-2 (delete keeps row-first ordering — verified correct for delete
      // semantics): a crash between the two deletes leaves a lingering marker
      // whose row is gone, which the indexed reads self-heal (skip + delete).
      // Marker-first would instead make a still-live row invisible to indexed
      // reads until re-put — the exact failure mode put()'s ordering avoids.
      const removed = await requireStorage().kvDelete(this.key(id));
      if (tenant) await requireStorage().kvDelete(this.idxKey(tenant, id));
      return removed;
    }
    return requireStorage().kvDelete(this.key(id));
  }

  /**
   * ADR 0284 — tenant teardown: delete every row this collection holds for `tenantId`.
   * Deliberately a FULL RAW scan with an exact per-row filter, NOT
   * `listForTenantIndexed`: the tenant index tolerates missing markers ("delayed, not
   * lost" — fine for retention), but a teardown miss is a PERMANENT orphan. Teardown is
   * rare; completeness wins over speed. FU-DATA-1: the scan decodes RAW rows, never
   * through the collection's validator — a validator-rejected legacy row under a shared
   * prefix (e.g. the token-keyed byte rows under `hostext:media:asset:`) still carries a
   * tenant's data and MUST be swept. Validated rows are matched via `tenantOf` (when set)
   * and deleted through `delete()` (keeps the tenant-index markers coherent); rejected
   * rows are matched on their JSON `tenantId` probe and deleted by raw key — they never
   * received a marker (the index backfill also runs through the validator), so there is
   * nothing to unindex. Fail-closed on a falsy tenant — never a cross-tenant or global
   * purge.
   */
  async purgeTenantRows(tenantId: string): Promise<number> {
    if (!tenantId) return 0;
    let deleted = 0;
    for (const { key, value } of await requireStorage().kvList(this.prefix())) {
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { continue; }
      const row = this.validate ? this.validate(parsed) : (parsed as T);
      const rowTenant = row !== null && this.tenantOf ? this.tenantOf(row) : jsonTenantId(parsed);
      if (rowTenant !== tenantId) continue;
      if (row !== null) {
        if (await this.delete(this.idOf(row))) deleted += 1;
      } else if (await requireStorage().kvDelete(key)) {
        deleted += 1; // validator-rejected legacy row — no marker exists to clean
      }
    }
    // GEN-1d — the content scan above cleans a marker only via the primary row it
    // still finds; a marker whose primary row is already GONE (stale marker) or was
    // deleted by raw key (validator-rejected, so `delete()` never ran) survives it.
    // Sweep the tenant's index slice by KEY (the tenant is IN the marker key) so the
    // teardown leaves NO `hostextidx:<name>:<tenant>:` residue — the account-delete
    // mirror of the fold's GEN-1b marker move. The trailing ':' delimits, so a
    // shorter tenant can't prefix-match a longer tenant's slice. No-op on keys the
    // content scan already removed.
    if (this.tenantOf) {
      for (const { key } of await requireStorage().kvList(this.idxPrefix(tenantId))) {
        await requireStorage().kvDelete(key).catch(() => undefined);
      }
    }
    return deleted;
  }

  /** ADR 0272-adjacent guard support (grade-data RI-7) — count this collection's
   *  rows for a tenant (optionally narrowed to rows whose JSON `orgId` matches).
   *  Same completeness stance as `purgeTenantRows` (FU-DATA-1 included): full RAW
   *  scan, exact filter, validator-rejected rows counted via the JSON probes. */
  async countRowsFor(tenantId: string, orgId?: string): Promise<number> {
    if (!tenantId) return 0;
    let n = 0;
    for (const { value } of await scanCandidates(this.prefix(), orgId)) {
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { continue; }
      const row = this.validate ? this.validate(parsed) : (parsed as T);
      const rowTenant = row !== null && this.tenantOf ? this.tenantOf(row) : jsonTenantId(parsed);
      if (rowTenant !== tenantId) continue;
      if (orgId !== undefined && jsonOrgId(parsed) !== orgId) continue;
      n += 1;
    }
    return n;
  }

  /**
   * GOV-1 — bounded per-tenant read via the secondary index: enumerate this tenant's row
   * ids from the index slice, then read each (a stale marker whose row is gone is skipped +
   * self-healed). Requires `tenantOf` set on the collection. Backfills legacy rows once.
   */
  async listForTenantIndexed(tenantId: string): Promise<T[]> {
    if (!this.tenantOf) throw new Error(`listForTenantIndexed requires a tenantOf on '${this.name}'`);
    await this.ensureTenantIndex();
    const markers = await requireStorage().kvList(this.idxPrefix(tenantId));
    const out: T[] = [];
    for (const m of markers) {
      const row = await this.get(this.parseMarker(m.value).id); // marker may be a bare id or {id,p}
      if (row !== null) out.push(row);
      else await requireStorage().kvDelete(m.key).catch(() => undefined); // self-heal a stale marker
    }
    return out;
  }

  /**
   * GC-CV-11 — bounded per-tenant read that returns the index PROJECTIONS
   * WITHOUT reading the (potentially large) primary rows. Requires the
   * collection to be constructed with `indexProjection`. A marker that predates
   * the projection (a bare id / an old `{id}` with no `p`) is self-healed:
   * its row is read once, projected, and its marker rewritten. Newest writes
   * cost zero primary reads. A stale marker (row gone) is dropped.
   */
  async listForTenantProjected(tenantId: string): Promise<Record<string, unknown>[]> {
    if (!this.tenantOf || !this.indexProjection) throw new Error(`listForTenantProjected requires tenantOf + indexProjection on '${this.name}'`);
    await this.ensureTenantIndex();
    const storage = requireStorage();
    const markers = await storage.kvList(this.idxPrefix(tenantId));
    const out: Record<string, unknown>[] = [];
    for (const m of markers) {
      const parsed = this.parseMarker(m.value);
      if (parsed.p) { out.push(parsed.p); continue; }
      // Legacy/unprojected marker → read once, project, self-heal the marker.
      const row = await this.get(parsed.id);
      if (row === null) { await storage.kvDelete(m.key).catch(() => undefined); continue; }
      await storage.kvSet(m.key, this.markerValue(row)).catch(() => undefined);
      out.push(this.indexProjection(row));
    }
    return out;
  }

  /**
   * DATA-D8 — the PER-CANVAS analog of `listForTenantProjected`. Reads the light
   * marker projections for the tenant-index slice whose IDs start with `idPrefix`
   * (relative to the tenant), WITHOUT decoding the primary rows. Requires
   * `tenantOf` + `indexProjection`. Markers live at
   * `hostextidx:<name>:<tenantId>:<id>`, so scoping to `idPrefix` (e.g.
   * `${tenantId}:${canvasId}:`) yields exactly that entity slice — the version
   * list (50 rows × a large snapshot blob) reads 4 metadata fields per row
   * instead of decoding every snapshot. Same self-heal as the tenant-wide read:
   * a legacy bare-id marker is read once, projected, and rewritten.
   *
   * READ-ONLY use only: a marker can briefly outlive its primary row (delete is
   * two awaited kvDeletes), so a projection here is "delayed, not lost" for
   * READS but MUST NOT drive destructive ops (evictions) — those stay on the
   * authoritative primary `listByPrefix`.
   */
  async listByTenantAndIdPrefixProjected(tenantId: string, idPrefix: string): Promise<Record<string, unknown>[]> {
    if (!this.tenantOf || !this.indexProjection) throw new Error(`listByTenantAndIdPrefixProjected requires tenantOf + indexProjection on '${this.name}'`);
    await this.ensureTenantIndex();
    const storage = requireStorage();
    const markers = await storage.kvList(this.idxPrefix(tenantId) + idPrefix);
    const out: Record<string, unknown>[] = [];
    for (const m of markers) {
      const parsed = this.parseMarker(m.value);
      if (parsed.p) { out.push(parsed.p); continue; }
      const row = await this.get(parsed.id); // legacy bare-id marker → read once, project, self-heal
      if (row === null) { await storage.kvDelete(m.key).catch(() => undefined); continue; }
      await storage.kvSet(m.key, this.markerValue(row)).catch(() => undefined);
      out.push(this.indexProjection(row));
    }
    return out;
  }

  /**
   * One-time idempotent backfill of the tenant index for rows written before the index
   * existed. Guarded by a sentinel so it scans `list()` at most once per collection
   * (fleet-wide); concurrent backfills are harmless (idempotent marker writes).
   */
  async ensureTenantIndex(): Promise<void> {
    if (!this.tenantOf) return;
    const storage = requireStorage();
    if ((await storage.kvGet(this.backfillKey)) !== null) return; // already backfilled
    for (const item of await this.list()) {
      await storage.kvSet(this.idxKey(this.tenantOf(item), this.idOf(item)), this.markerValue(item));
    }
    await storage.kvSet(this.backfillKey, '1'); // sentinel — backfill complete
  }

  /**
   * A7 — atomic compare-and-swap on one entity, correct ACROSS instances (unlike
   * get→put, which races). `expected` is the value previously read (or `null` to
   * insert-only-if-absent); the swap occurs only if the stored row still byte-
   * matches it. Returns whether the swap happened. Pass the exact object from
   * `get()` as `expected` so the serialization matches. Backed by the storage
   * `kvCompareAndSwap` atomic primitive.
   */
  async compareAndSwap(expected: T | null, next: T): Promise<boolean> {
    const id = this.idOf(next);
    const expectedRaw = expected === null ? null : JSON.stringify(expected);
    // FU-DATA-2 — same ordering as put(): marker BEFORE the row write, so a crash
    // between the two can only leave a stale marker (self-healed by the indexed
    // reads), never a swapped-in row that indexed reads can't see (an insert via
    // `expected: null` has no pre-existing marker to fall back on). A FAILED swap
    // then repairs the marker from the authoritative row, since the pre-written
    // marker described `next`, which never landed.
    if (this.tenantOf) await requireStorage().kvSet(this.idxKey(this.tenantOf(next), id), this.markerValue(next));
    const res = await requireStorage().kvCompareAndSwap(this.key(id), expectedRaw, JSON.stringify(next));
    if (!res.swapped && this.tenantOf) {
      const current = await this.get(id);
      if (current === null) await requireStorage().kvDelete(this.idxKey(this.tenantOf(next), id)).catch(() => undefined);
      else await requireStorage().kvSet(this.idxKey(this.tenantOf(current), id), this.markerValue(current)).catch(() => undefined);
    }
    return res.swapped;
  }

  /** Test-only: remove every entity in this collection (and its tenant index). */
  async __clear(): Promise<void> {
    const storage = requireStorage();
    for (const row of await storage.kvList(this.prefix())) await storage.kvDelete(row.key);
    if (this.tenantOf) {
      for (const row of await storage.kvList(`hostextidx:${this.name}:`)) await storage.kvDelete(row.key);
      await storage.kvDelete(this.backfillKey);
    }
  }
}
