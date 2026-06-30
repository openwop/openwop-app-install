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
 * FEAT-1 status (CODEBASE-ASSESSMENT.md) — the two concerns the audit raised
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
  ) {}

  private key(id: string): string {
    return `hostext:${this.name}:${id}`;
  }

  private prefix(): string {
    return `hostext:${this.name}:`;
  }

  // --- tenant secondary index (separate keyspace so `list()`/`listByPrefix` never see it) ---
  private idxKey(tenantId: string, id: string): string {
    return `hostextidx:${this.name}:${tenantId}:${id}`;
  }
  private idxPrefix(tenantId: string): string {
    return `hostextidx:${this.name}:${tenantId}:`;
  }
  private get backfillKey(): string {
    return `hostextidxmeta:${this.name}:backfilled`;
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
    await requireStorage().kvSet(this.key(id), JSON.stringify(item));
    if (this.tenantOf) await requireStorage().kvSet(this.idxKey(this.tenantOf(item), id), id); // maintain index
  }

  /** Delete one entity by id. Returns true if it existed. */
  async delete(id: string): Promise<boolean> {
    if (this.tenantOf) {
      // Clean the tenant-index marker. We need the row's tenant; one extra read on delete
      // (only for indexed collections — deletes here are infrequent). If the row is already
      // gone we have nothing to unindex.
      const existing = await this.get(id);
      const removed = await requireStorage().kvDelete(this.key(id));
      if (existing) await requireStorage().kvDelete(this.idxKey(this.tenantOf(existing), id));
      return removed;
    }
    return requireStorage().kvDelete(this.key(id));
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
      const row = await this.get(m.value);
      if (row !== null) out.push(row);
      else await requireStorage().kvDelete(m.key).catch(() => undefined); // self-heal a stale marker
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
      await storage.kvSet(this.idxKey(this.tenantOf(item), this.idOf(item)), this.idOf(item));
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
    const res = await requireStorage().kvCompareAndSwap(this.key(id), expectedRaw, JSON.stringify(next));
    if (res.swapped && this.tenantOf) await requireStorage().kvSet(this.idxKey(this.tenantOf(next), id), id); // maintain index
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
