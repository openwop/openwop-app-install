/**
 * ADR 1110 D1 — declared indexes for SYSTEM entity types.
 *
 * A system type's rows live under `entity:record` keyed `<typeId>|<entityId>`, so the
 * only range a reader can scan is "every row of the type in this tenant". A façade
 * whose rows must be listed by org, facet or name prefix at a size that cannot be
 * read whole (commerce.product, up to 500,000 per org) declares index FAMILIES here:
 * for each row, a set of markers whose ids put the query dimensions in the key, each
 * carrying a small projection. The kernel keeps them in step inside its own system
 * write functions, the one path every write of the type takes.
 *
 * Keys (`entity:sysidx`): `<tenant>:<type>:<family>:<org>:<segment>…:<entityId>`.
 * The tenant and org are RAW, colon-bounded segments, so the anon→user fold moves
 * them with the generic `rekeyTenantSegment` (an encoded tenant would not match the
 * fold's `from`); every other segment is `encodeURIComponent`'d, so a `:` in a name
 * or facet cannot split a key. Every row carries `tenantId` (and `orgId`), which is
 * what tenant teardown and the org-cascade scans match on.
 *
 * Write ordering (ADR 1110 D1). The source of truth is the kernel row; the markers are
 * derived. A write marks a per-row INTENT (`entity:sysidx-pend`) before the kernel
 * write and again after it, then one holder of a short lease on that intent re-reads
 * the STORED row, writes its markers, deletes the stale ones, updates the per-row
 * MANIFEST (`entity:sysidx-manifest`, the keys the row currently has), and deletes the
 * intent only if nobody marked it again meanwhile. So a crash at any step leaves an
 * intent (repaired by `repairSystemIndex`), and two writers of one row serialise on
 * the lease, the last pass reading the last stored row. A write whose markers would
 * not change (a checkout's inventory decrement) skips all of it: the projection
 * carries no stock figure.
 *
 * An index failure never fails the kernel write: it is logged and the intent stays.
 */
import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection, hostExtStorage } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import type { EntityRecord } from './entitiesService.js';

const log = createLogger('entities.systemIndex');

/** One marker a row wants: `family` + key `segments` (encoded here) + projection. */
export interface IndexMarker {
  family: string;
  segments: string[];
  p: Record<string, unknown>;
}

export interface SystemIndexDecl<R = EntityRecord> {
  /** The org segment of every marker of this row (`_` when the row has none). */
  orgOf(rec: R): string | undefined;
  /** Every marker the row should have. Pure and deterministic. */
  markers(rec: R): IndexMarker[];
  /** The family the per-org row counter follows. Each row has at most one marker in it. */
  countedFamily: string;
  /** A family EVERY row has exactly one marker in (its size is the row count): the
   *  build check compares it with the store's own count. Defaults to `countedFamily`. */
  everyRowFamily?: string;
  /** #5928 — OPTIONAL per-row weight the per-org counter also SUMS (media's bytes), kept
   *  in step by the same intent lease as the count. The counted marker carries it, so an
   *  exact recount sums the family slice; a weight change on an update moves the sum. A
   *  finite number ≥ 0; anything else counts as 0. */
  weightOf?(rec: R): number;
}

/**
 * ADR 1110 P5 — a declared index over a feature's OWN store (not a kernel type), e.g.
 * `commerce.order`. The same markers, intent lease, manifest, repair and counter; the
 * feature supplies how to read a row by id, list a tenant's rows, and name a row's id and
 * tenant, and calls `beforeSystemWrite` / `afterSystemWrite` around its own writes.
 * `isRow` narrows what the hooks receive, so no cast is needed.
 */
export interface StoreIndexDecl<R> extends SystemIndexDecl<R> {
  isRow(v: unknown): v is R;
  idOf(rec: R): string;
  tenantOf(rec: R): string;
  read(tenantId: string, id: string): Promise<R | null>;
  scan(tenantId: string): AsyncGenerator<R>;
  /** How many rows the tenant has in the store (one counted read). */
  count(tenantId: string): Promise<number>;
}

// `w` (#5928): the row's weight, on the counted marker and the manifest of a weighted type only.
interface MarkerRow { k: string; tenantId: string; orgId?: string; type: string; id: string; p: Record<string, unknown>; w?: number }
interface ManifestRow { k: string; tenantId: string; orgId?: string; type: string; id: string; keys: string[]; hash: string; counted: boolean; w?: number }
interface PendRow { k: string; tenantId: string; type: string; id: string; dirty: boolean; lease?: string; until?: number; at: string; markedAt?: number }
interface CountRow { k: string; tenantId: string; orgId: string; type: string; count: number; sum?: number }
interface BuiltRow { k: string; tenantId: string; type: string; builtAt: string }

// Every index row's id starts with its tenant (teardown deletes one key range), and an
// index row is never an org's own data (the org-delete guard does not count it).
const INDEX_SHAPE = { tenantKeyed: true, derived: true } as const;
const markers = new DurableCollection<MarkerRow>('entity:sysidx', (r) => r.k, undefined, undefined, undefined, undefined, INDEX_SHAPE);
const manifests = new DurableCollection<ManifestRow>('entity:sysidx-manifest', (r) => r.k, undefined, undefined, undefined, undefined, INDEX_SHAPE);
const pending = new DurableCollection<PendRow>('entity:sysidx-pend', (r) => r.k, undefined, undefined, undefined, undefined, INDEX_SHAPE);
const counters = new DurableCollection<CountRow>('entity:sysidx-count', (r) => r.k, undefined, undefined, undefined, undefined, INDEX_SHAPE);
const built = new DurableCollection<BuiltRow>('entity:sysidx-built', (r) => r.k, undefined, undefined, undefined, undefined, INDEX_SHAPE);

const LEASE_MS = 30_000;
const SYNC_PASSES = 8;
const enc = encodeURIComponent;
const NO_ORG = '_';

/** Every declaration, erased to rows of unknown shape behind its own type guard. */
interface Decl {
  orgOf(row: unknown): string | undefined;
  markers(row: unknown): IndexMarker[];
  idOf(row: unknown): string;
  tenantOf(row: unknown): string;
  countedFamily: string;
  everyRowFamily: string;
  weightOf: ((row: unknown) => number) | null;
  read: ((tenantId: string, typeName: string, id: string) => Promise<unknown>) | null;
  scan: ((tenantId: string, typeName: string) => AsyncGenerator<unknown>) | null;
  count: ((tenantId: string, typeName: string) => Promise<number>) | null;
}
const decls = new Map<string, Decl>();

function isEntityRecord(v: unknown): v is EntityRecord {
  return typeof v === 'object' && v !== null && typeof (v as { entityId?: unknown }).entityId === 'string' && typeof (v as { tenantId?: unknown }).tenantId === 'string';
}

type RowReader = (tenantId: string, typeName: string, entityId: string) => Promise<EntityRecord | null>;
type RowScanner = (tenantId: string, typeName: string) => AsyncGenerator<EntityRecord>;
type RowCounter = (tenantId: string, typeName: string) => Promise<number>;
let readRow: RowReader | null = null;
let scanRows: RowScanner | null = null;
let countRows: RowCounter | null = null;

/** Wired once by `entitiesService` (which this module must not import at runtime). */
export function configureSystemIndex(io: { readRow: RowReader; scanRows: RowScanner; countRows?: RowCounter }): void {
  readRow = io.readRow;
  scanRows = io.scanRows;
  if (io.countRows) countRows = io.countRows;
}

/** Register (or replace) a kernel system type's index declaration. */
export function registerSystemIndex(typeName: string, decl: SystemIndexDecl): void {
  decls.set(typeName, {
    orgOf: (row) => (isEntityRecord(row) ? decl.orgOf(row) : undefined),
    markers: (row) => (isEntityRecord(row) ? decl.markers(row) : []),
    idOf: (row) => (isEntityRecord(row) ? row.entityId : ''),
    tenantOf: (row) => (isEntityRecord(row) ? row.tenantId : ''),
    countedFamily: decl.countedFamily,
    everyRowFamily: decl.everyRowFamily ?? decl.countedFamily,
    weightOf: decl.weightOf ? (row) => (isEntityRecord(row) ? weightOfRow(decl.weightOf!(row)) : 0) : null,
    read: null,
    scan: null,
    count: null,
  });
}

/** ADR 1110 P5 — register (or replace) a declared index over a feature's own store. */
export function registerStoreIndex<R>(typeName: string, decl: StoreIndexDecl<R>): void {
  decls.set(typeName, {
    orgOf: (row) => (decl.isRow(row) ? decl.orgOf(row) : undefined),
    markers: (row) => (decl.isRow(row) ? decl.markers(row) : []),
    idOf: (row) => (decl.isRow(row) ? decl.idOf(row) : ''),
    tenantOf: (row) => (decl.isRow(row) ? decl.tenantOf(row) : ''),
    countedFamily: decl.countedFamily,
    everyRowFamily: decl.everyRowFamily ?? decl.countedFamily,
    weightOf: decl.weightOf ? (row) => (decl.isRow(row) ? weightOfRow(decl.weightOf!(row)) : 0) : null,
    read: (tenantId, _type, id) => decl.read(tenantId, id),
    scan: (tenantId) => decl.scan(tenantId),
    count: (tenantId) => decl.count(tenantId),
  });
}

/** Every type with a declared index: the one upkeep sweep checks each (ADR 1155 P3a). */
export function registeredIndexTypes(): string[] {
  return [...decls.keys()];
}

/** A weight is a finite whole number ≥ 0; anything else counts as 0 (never NaN in a sum). */
const weightOfRow = (w: number): number => (Number.isFinite(w) && w > 0 ? Math.floor(w) : 0);

const readFor = (decl: Decl): ((tenantId: string, typeName: string, id: string) => Promise<unknown>) | null => decl.read ?? readRow;
const scanFor = (decl: Decl): ((tenantId: string, typeName: string) => AsyncGenerator<unknown>) | null => decl.scan ?? scanRows;
export function hasSystemIndex(typeName: string): boolean {
  return decls.has(typeName);
}

const orgSeg = (org: string | undefined): string => (org && org.length > 0 ? org : NO_ORG);
const rowKey = (tenantId: string, typeName: string, entityId: string): string => `${tenantId}:${enc(typeName)}:${enc(entityId)}`;
const counterKey = (tenantId: string, typeName: string, org: string): string => `${tenantId}:${enc(typeName)}:${org}`;

/** The id prefix of one family slice: `<tenant>:<type>:<family>:<org>:` plus the given
 *  segments, each followed by `:`, except the last when `openLast` (a prefix match on it). */
export function familyPrefix(tenantId: string, typeName: string, family: string, org: string | undefined, segments: string[] = [], openLast = false): string {
  const parts = [tenantId, enc(typeName), family, orgSeg(org), ...segments.map(enc)];
  const joined = parts.join(':');
  return openLast && segments.length > 0 ? joined : `${joined}:`;
}

function desiredOf(typeName: string, decl: Decl, rec: unknown): { rows: Map<string, MarkerRow>; hash: string; counted: boolean; org: string; w: number } {
  const rows = new Map<string, MarkerRow>();
  if (rec === null || rec === undefined) return { rows, hash: hashOf(rows), counted: false, org: NO_ORG, w: 0 };
  const org = orgSeg(decl.orgOf(rec));
  const tenantId = decl.tenantOf(rec);
  const id = decl.idOf(rec);
  const w = decl.weightOf ? decl.weightOf(rec) : 0;
  let counted = false;
  for (const m of decl.markers(rec)) {
    const k = `${familyPrefix(tenantId, typeName, m.family, org, m.segments)}${enc(id)}`;
    const isCounted = m.family === decl.countedFamily;
    if (isCounted) counted = true;
    rows.set(k, { k, tenantId, ...(org !== NO_ORG ? { orgId: org } : {}), type: typeName, id, p: m.p, ...(isCounted && decl.weightOf ? { w } : {}) });
  }
  return { rows, hash: hashOf(rows), counted, org, w };
}

function hashOf(rows: Map<string, MarkerRow>): string {
  const h = createHash('sha256');
  for (const [k, row] of [...rows.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    h.update(k).update('\u0000').update(JSON.stringify(row.p));
    // #5928 — only a weighted marker hashes its weight, so every unweighted type's
    // stored manifest hash is unchanged (no rebuild on deploy).
    if (row.w !== undefined) h.update('\u0002').update(String(row.w));
    h.update('\u0001');
  }
  return h.digest('base64url');
}

async function markDirty(tenantId: string, typeName: string, entityId: string): Promise<void> {
  const k = rowKey(tenantId, typeName, entityId);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const cur = await pending.get(k);
    // `markedAt` is refreshed on every mark: the repair sweep leaves a freshly marked
    // intent to the writer that marked it (its own sync is coming), so it never syncs a
    // row whose write has not landed yet and then deletes the intent that write needs.
    const now = Date.now();
    const next: PendRow = cur ? { ...cur, dirty: true, markedAt: now } : { k, tenantId, type: typeName, id: entityId, dirty: true, at: new Date(now).toISOString(), markedAt: now };
    if (await pending.compareAndSwap(cur, next)) return;
  }
  throw new Error(`systemIndex: could not mark ${typeName} row dirty`);
}

/** Before a kernel write: record the intent unless the row's markers would not change. */
export async function beforeSystemWrite(typeName: string, tenantId: string, entityId: string, next: unknown): Promise<void> {
  const decl = decls.get(typeName);
  if (!decl) return;
  try {
    const want = desiredOf(typeName, decl, next);
    const manifest = await manifests.get(rowKey(tenantId, typeName, entityId));
    if ((manifest?.hash ?? hashOf(new Map())) === want.hash) return;
    await markDirty(tenantId, typeName, entityId);
  } catch (err) {
    log.warn('system_index_intent_failed', { type: typeName, error: err instanceof Error ? err.message : String(err) });
  }
}

/** After a kernel write (the stored row, or null after a delete): bring the index in step. */
export async function afterSystemWrite(typeName: string, tenantId: string, entityId: string, written: unknown): Promise<void> {
  const decl = decls.get(typeName);
  if (!decl) return;
  try {
    const k = rowKey(tenantId, typeName, entityId);
    const [pend, manifest] = await Promise.all([pending.get(k), manifests.get(k)]);
    const want = desiredOf(typeName, decl, written);
    if (!pend && (manifest?.hash ?? hashOf(new Map())) === want.hash) return;
    await markDirty(tenantId, typeName, entityId);
    await syncRow(tenantId, typeName, entityId);
  } catch (err) {
    log.warn('system_index_sync_failed', { type: typeName, error: err instanceof Error ? err.message : String(err) });
  }
}

async function acquire(k: string, token: string, now: number): Promise<PendRow | null> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const cur = await pending.get(k);
    if (!cur) return null; // nothing pending: another holder finished
    if (cur.lease && cur.lease !== token && (cur.until ?? 0) > now) return null; // held: its holder will see our mark
    const next: PendRow = { ...cur, lease: token, until: now + LEASE_MS, dirty: false };
    if (await pending.compareAndSwap(cur, next)) return next;
  }
  return null;
}

/** Hold the row's intent lease and re-derive its markers from the stored row until no
 *  writer has marked it again. Returns false when another holder has it. */
export async function syncRow(tenantId: string, typeName: string, entityId: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const decl = decls.get(typeName);
  const read = decl ? readFor(decl) : null;
  if (!decl || !read) return false;
  const k = rowKey(tenantId, typeName, entityId);
  const token = randomUUID();
  let held = await acquire(k, token, Date.now());
  if (!held) return false;
  for (let pass = 0; pass < SYNC_PASSES; pass += 1) {
    try {
      const stored = await read(tenantId, typeName, entityId);
      await applyRow(tenantId, typeName, entityId, decl, stored, opts.force === true, token);
    } catch (err) {
      // A lost lease is not a failure: the newer holder re-derives the row.
      if (err instanceof LeaseLost) return false;
      // Give the lease back still dirty, so the repair sweep can take it at once
      // instead of waiting out the lease.
      const cur = await pending.get(k);
      if (cur?.lease === token) {
        const { lease: _l, until: _u, ...rest } = cur;
        await pending.compareAndSwap(cur, { ...rest, dirty: true });
      }
      throw err;
    }
    // Release only if nobody marked the row while this pass ran.
    const cur = await pending.get(k);
    if (!cur || cur.lease !== token) return true; // lease lost or released: the new holder re-derives
    if (!cur.dirty) {
      if (await pending.compareAndDelete(cur)) return true;
      continue;
    }
    const next: PendRow = { ...cur, dirty: false, until: Date.now() + LEASE_MS };
    if (!(await pending.compareAndSwap(cur, next))) continue;
    held = next;
  }
  log.warn('system_index_sync_unsettled', { type: typeName, passes: SYNC_PASSES });
  return true; // the intent stays; the repair sweep finishes it
}

/** Re-derive one row's markers from its stored row now, even with no write pending: for
 *  a reader that found a marker disagreeing with its row (ADR 1155 P3c-1). Forced, so a
 *  marker whose projection is wrong while the manifest agrees is rewritten too. */
export async function resyncSystemRow(tenantId: string, typeName: string, entityId: string): Promise<boolean> {
  if (!decls.has(typeName)) return false;
  await markDirty(tenantId, typeName, entityId);
  return syncRow(tenantId, typeName, entityId, { force: true });
}

/** A pass whose lease expired stops before writing: a newer holder owns the row. */
class LeaseLost extends Error {}

async function applyRow(tenantId: string, typeName: string, entityId: string, decl: Decl, stored: unknown, force: boolean, token: string): Promise<void> {
  const mk = rowKey(tenantId, typeName, entityId);
  const holds = async (): Promise<void> => { if ((await pending.get(mk))?.lease !== token) throw new LeaseLost('lease lost'); };
  const manifest = await manifests.get(mk);
  const want = desiredOf(typeName, decl, stored);
  // `force` (a rebuild) rewrites every desired marker: a manifest can agree with the
  // row while a marker it lists is gone, which is the drift a rebuild exists to fix.
  if (!force && manifest && manifest.hash === want.hash && (manifest.orgId ?? NO_ORG) === want.org) return;
  const old = new Set(manifest?.keys ?? []);
  const changed = force || !manifest || manifest.hash !== want.hash;
  await holds();
  for (const [key, row] of want.rows) {
    if (changed || !old.has(key)) await markers.put(row);
  }
  for (const key of old) if (!want.rows.has(key)) await markers.delete(key);
  // The per-org counter follows membership of the counted family; a weighted type's sum
  // follows the weight the manifest recorded (#5928), so a weight change moves it too.
  const before = manifest?.counted ? { org: manifest.orgId ?? NO_ORG, w: manifest.w ?? 0 } : null;
  const after = want.counted ? { org: want.org, w: want.w } : null;
  if (before?.org !== after?.org) {
    if (before) await bumpCounter(tenantId, typeName, before.org, -1, -before.w);
    if (after) await bumpCounter(tenantId, typeName, after.org, 1, after.w);
  } else if (before && after && before.w !== after.w) {
    await bumpCounter(tenantId, typeName, after.org, 0, after.w - before.w);
  }
  // The manifest moves by compare-and-swap from the one this pass read: a holder that
  // lost its lease mid-pass cannot overwrite the newer holder's manifest.
  await holds();
  if (want.rows.size === 0) {
    if (manifest && !(await manifests.compareAndDelete(manifest))) throw new LeaseLost('manifest moved');
    return;
  }
  const nextManifest: ManifestRow = {
    k: mk, tenantId, ...(want.org !== NO_ORG ? { orgId: want.org } : {}), type: typeName, id: entityId,
    keys: [...want.rows.keys()], hash: want.hash, counted: want.counted, ...(want.counted && decl.weightOf ? { w: want.w } : {}),
  };
  if (!(await manifests.compareAndSwap(manifest, nextManifest))) throw new LeaseLost('manifest moved');
}

async function bumpCounter(tenantId: string, typeName: string, org: string, delta: number, dSum = 0): Promise<void> {
  const k = counterKey(tenantId, typeName, org);
  const weighted = decls.get(typeName)?.weightOf != null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const cur = await counters.get(k);
    const count = Math.max(0, (cur?.count ?? 0) + delta);
    // A counter at zero is deleted, not kept: an absent row reads as 0 and leaves nothing
    // behind for an emptied org.
    if (count === 0) { if (!cur || (await counters.compareAndDelete(cur))) return; continue; }
    // A weighted counter with no sum yet (absent row, or one written before the weight)
    // is not guessed at: it is left without one, and the next read recounts (#5928).
    const sum = weighted && (cur === null || cur.sum !== undefined) ? Math.max(0, (cur?.sum ?? 0) + dSum) : undefined;
    const next: CountRow = { k, tenantId, orgId: org, type: typeName, count, ...(sum !== undefined ? { sum } : {}) };
    if (await counters.compareAndSwap(cur, next)) return;
  }
  // Drift, not loss: `indexedCount` recounts at the cap and the gauge resets it.
  log.warn('system_index_counter_contended', { type: typeName });
}

/** How many rows of the type the org has, from the maintained counter. With `exact`,
 *  recounted from the counted family (one indexed count) and the counter corrected. */
export async function indexedCount(tenantId: string, typeName: string, org: string, opts: { exact?: boolean } = {}): Promise<number> {
  return (await indexedTotals(tenantId, typeName, org, opts)).count;
}

/** #5928 — the org's counter as `{ count, sum }` (`sum` is the summed weight of a
 *  weighted type, else 0). From the maintained row; recounted from the counted family
 *  when `exact`, when the row is absent, or when a weighted row has no sum yet, and the
 *  row corrected. An unweighted recount is one indexed count; a weighted one pages the
 *  org's counted slice (only at a cap boundary or in the hourly check). */
export async function indexedTotals(tenantId: string, typeName: string, org: string, opts: { exact?: boolean } = {}): Promise<{ count: number; sum: number }> {
  const decl = decls.get(typeName);
  if (!decl) throw new Error(`systemIndex: ${typeName} declares no index`);
  const k = counterKey(tenantId, typeName, orgSeg(org));
  const cur = await counters.get(k);
  if (cur && !opts.exact && (!decl.weightOf || cur.sum !== undefined)) return { count: cur.count, sum: cur.sum ?? 0 };
  const prefix = familyPrefix(tenantId, typeName, decl.countedFamily, org);
  let n = 0;
  let sum = 0;
  if (!decl.weightOf) n = await markers.countByPrefix(prefix);
  else {
    let afterId: string | undefined;
    for (;;) {
      const page = await markers.listByPrefixPage(prefix, { ...(afterId !== undefined ? { afterId } : {}), limit: 500 });
      for (const m of page.items) { n += 1; sum += weightOfRow(m.w ?? 0); }
      if (!page.lastId) break;
      afterId = page.lastId;
    }
  }
  // Correct the counter; a zero is no row at all (never written on a read).
  if (n === 0) { if (cur) await counters.delete(k); }
  else if (cur?.count !== n || (decl.weightOf && cur?.sum !== sum)) {
    await counters.put({ k, tenantId, orgId: orgSeg(org), type: typeName, count: n, ...(decl.weightOf ? { sum } : {}) });
  }
  return { count: n, sum };
}

/** #5928 — the tenant's totals across its orgs. Not `exact`: the sum of the tenant's
 *  org counter rows (one row per org, never per entity). `exact`: the tenant's counted
 *  family paged once, every org counter corrected and a counter for an org with no rows
 *  removed; for the workspace cap's boundary and the hourly check. */
export async function indexedTenantTotals(tenantId: string, typeName: string, opts: { exact?: boolean } = {}): Promise<{ count: number; sum: number }> {
  const decl = decls.get(typeName);
  if (!decl) throw new Error(`systemIndex: ${typeName} declares no index`);
  const cprefix = `${tenantId}:${enc(typeName)}:`;
  const rows: CountRow[] = [];
  let afterId: string | undefined;
  for (;;) {
    const page = await counters.listByPrefixPage(cprefix, { ...(afterId !== undefined ? { afterId } : {}), limit: 200 });
    // The tenant and type re-check: a raw tenant id that is a `:`-prefix of another must not leak.
    rows.push(...page.items.filter((c) => c.tenantId === tenantId && c.type === typeName));
    if (!page.lastId) break;
    afterId = page.lastId;
  }
  if (!opts.exact && (!decl.weightOf || rows.every((c) => c.sum !== undefined))) {
    return rows.reduce((t, c) => ({ count: t.count + c.count, sum: t.sum + (c.sum ?? 0) }), { count: 0, sum: 0 });
  }
  const orgs = new Set(rows.map((c) => c.orgId));
  const mprefix = `${[tenantId, enc(typeName), decl.countedFamily].join(':')}:`;
  afterId = undefined;
  for (;;) {
    const page = await markers.listByPrefixPage(mprefix, { ...(afterId !== undefined ? { afterId } : {}), limit: 500 });
    for (const m of page.items) if (m.tenantId === tenantId) orgs.add(m.orgId ?? NO_ORG);
    if (!page.lastId) break;
    afterId = page.lastId;
  }
  const total = { count: 0, sum: 0 };
  for (const org of orgs) {
    const t = await indexedTotals(tenantId, typeName, org, { exact: true });
    total.count += t.count;
    total.sum += t.sum;
  }
  return total;
}

/** One page of a family slice, in key (byte) order. `cursor` is opaque: the id of the
 *  last key read, base64url. A cursor outside the slice is ignored (start over). */
export async function listIndexPage(
  tenantId: string, typeName: string, family: string, org: string | undefined,
  opts: { segments?: string[]; openLast?: boolean; cursor?: string; limit: number; allOrgs?: boolean },
): Promise<{ rows: { id: string; p: Record<string, unknown>; cursor: string }[]; cursor?: string }> {
  // `allOrgs` (ADR 1122 P1b): every org of the tenant, for a paged background walk. An
  // undefined `org` alone means the no-org segment, not every org.
  const prefix = opts.allOrgs ? `${[tenantId, enc(typeName), family].join(':')}:` : familyPrefix(tenantId, typeName, family, org, opts.segments ?? [], opts.openLast ?? false);
  let afterId: string | undefined;
  if (opts.cursor) {
    const decoded = Buffer.from(opts.cursor, 'base64url').toString('utf8');
    if (decoded.startsWith(prefix)) afterId = decoded;
  }
  const page = await markers.listByPrefixPage(prefix, { ...(afterId !== undefined ? { afterId } : {}), limit: opts.limit });
  return {
    // Each row's own cursor resumes right after it, for a reader that stops mid-page.
    rows: page.items.map((r) => ({ id: r.id, p: r.p, cursor: Buffer.from(r.k, 'utf8').toString('base64url') })),
    ...(page.lastId ? { cursor: Buffer.from(page.lastId, 'utf8').toString('base64url') } : {}),
  };
}

/** Drain unfinished intents (oldest key first), each under its own lease. */
export async function repairSystemIndex(opts: { limit: number; now?: number }): Promise<{ repaired: number; held: number; failed: number }> {
  const page = await pending.listByPrefixPage('', { limit: opts.limit });
  const now = opts.now ?? Date.now();
  let repaired = 0;
  let held = 0;
  let failed = 0;
  for (const p of page.items) {
    if (!decls.has(p.type)) continue;
    // A freshly marked, unleased intent belongs to the writer that marked it.
    if (!p.lease && p.markedAt !== undefined && now - p.markedAt < LEASE_MS) { held += 1; continue; }
    try {
      if (await syncRow(p.tenantId, p.type, p.id)) repaired += 1; else held += 1;
    } catch (err) {
      // One bad row must not stall every intent behind it.
      failed += 1;
      log.warn('system_index_repair_row_failed', { type: p.type, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { repaired, held, failed };
}

/**
 * Rebuild one tenant's index of a type from its stored rows: every row re-derived,
 * every manifest whose row is gone emptied, every org counter recounted. Idempotent
 * and safe beside live writers (each row goes through the same intent lease). Records
 * that the tenant's index is built, which only tells readers they may trust it; the
 * drift gauge repairs regardless of that record, so it can never block a repair.
 */
export async function rebuildSystemIndex(tenantId: string, typeName: string): Promise<{ rows: number; removed: number }> {
  const decl = decls.get(typeName);
  const read = decl ? readFor(decl) : null;
  const scan = decl ? scanFor(decl) : null;
  if (!decl || !scan || !read) return { rows: 0, removed: 0 };
  let rows = 0;
  const orgs = new Set<string>();
  for await (const rec of scan(tenantId, typeName)) {
    rows += 1;
    orgs.add(orgSeg(decl.orgOf(rec)));
    const id = decl.idOf(rec);
    await markDirty(tenantId, typeName, id);
    await syncRow(tenantId, typeName, id, { force: true });
  }
  let removed = 0;
  let afterId: string | undefined;
  const mprefix = `${tenantId}:${enc(typeName)}:`;
  for (;;) {
    const page = await manifests.listByPrefixPage(mprefix, { ...(afterId !== undefined ? { afterId } : {}), limit: 500 });
    for (const m of page.items) {
      orgs.add(m.orgId ?? NO_ORG);
      if (await read(tenantId, typeName, m.id)) continue;
      removed += 1;
      await markDirty(tenantId, typeName, m.id);
      await syncRow(tenantId, typeName, m.id);
    }
    if (!page.lastId) break;
    afterId = page.lastId;
  }
  for (const org of orgs) await indexedCount(tenantId, typeName, org, { exact: true });
  await built.put({ k: rowKey(tenantId, typeName, ''), tenantId, type: typeName, builtAt: new Date().toISOString() });
  return { rows, removed };
}

/** The largest tenant (in rows of the type) whose index a request may build inline. */
export const INLINE_BUILD_MAX = 500;
/** Tenants waiting for a background build (`drainSystemIndexBuilds`). */
interface BuildRow { k: string; tenantId: string; type: string; at: string }
const buildQueue = new DurableCollection<BuildRow>('entity:sysidx-build', (r) => r.k, undefined, undefined, undefined, undefined, INDEX_SHAPE);
/** In-process single flight: concurrent callers for one tenant share one build. */
const inflight = new Map<string, Promise<void>>();
/** Tenants (per type) this process has verified as built, per storage: a process that
 *  re-points host persistence (a test, a re-init) must not trust a check it ran against
 *  another store. */
const verifiedBy = new WeakMap<object, Set<string>>();
const verified = {
  set(): Set<string> {
    const s = hostExtStorage();
    let v = verifiedBy.get(s);
    if (!v) { v = new Set(); verifiedBy.set(s, v); }
    return v;
  },
  has(k: string): boolean { return this.set().has(k); },
  add(k: string): void { this.set().add(k); },
  delete(k: string): void { this.set().delete(k); },
  clear(): void { this.set().clear(); },
};
/** Test-only. */
export function __forgetVerifiedIndexes(): void { verified.clear(); }

/** ADR 1110 (round fix) — is the tenant's index usable? `built` is trusted only after a
 *  check: the store's row count must equal the size of the family every row has a marker
 *  in, so a fold that merged two tenants, deploy skew or a lost marker shows up as a
 *  mismatch and rebuilds instead of serving a short index. A request never builds a
 *  large index: up to INLINE_BUILD_MAX rows it builds (one flight per tenant), above that
 *  it queues the tenant for the background sweep and answers 'building', and the caller
 *  reads through its bounded fallback meanwhile. */
export async function ensureSystemIndexBuilt(tenantId: string, typeName: string): Promise<'built' | 'building'> {
  const decl = decls.get(typeName);
  if (!decl) return 'built';
  const vk = rowKey(tenantId, typeName, '');
  if (verified.has(vk)) return 'built';
  const count = decl.count ?? countRows;
  const rows = count ? await count(tenantId, typeName) : 0;
  if (await built.get(vk)) {
    const indexed = await markers.countByPrefix(`${tenantId}:${enc(typeName)}:${decl.everyRowFamily}:`);
    if (indexed === rows) { verified.add(vk); return 'built'; }
    await built.delete(vk); // drifted: rebuild below
  }
  if (rows > INLINE_BUILD_MAX) {
    await buildQueue.put({ k: vk, tenantId, type: typeName, at: new Date().toISOString() });
    return 'building';
  }
  let flight = inflight.get(vk);
  if (!flight) {
    flight = rebuildSystemIndex(tenantId, typeName).then(() => undefined).finally(() => inflight.delete(vk));
    inflight.set(vk, flight);
  }
  await flight;
  verified.add(vk);
  return 'built';
}

/** ADR 1110 (round fix) — the daily drift check for one tenant: the same count check as
 *  `ensureSystemIndexBuilt`, but a mismatch QUEUES a rebuild (never builds inline), and
 *  every org counter is recounted exactly, so counter drift lasts at most a day. */
export async function checkSystemIndex(tenantId: string, typeName: string): Promise<boolean> {
  const decl = decls.get(typeName);
  if (!decl) return true;
  const vk = rowKey(tenantId, typeName, '');
  const count = decl.count ?? countRows;
  const rows = count ? await count(tenantId, typeName) : 0;
  const indexed = await markers.countByPrefix(`${tenantId}:${enc(typeName)}:${decl.everyRowFamily}:`);
  let afterId: string | undefined;
  for (;;) {
    const page = await counters.listByPrefixPage(`${tenantId}:${enc(typeName)}:`, { ...(afterId !== undefined ? { afterId } : {}), limit: 200 });
    for (const c of page.items) await indexedCount(tenantId, typeName, c.orgId, { exact: true });
    if (!page.lastId) break;
    afterId = page.lastId;
  }
  if (indexed === rows && (await built.get(vk))) return true;
  verified.delete(vk);
  await built.delete(vk);
  await buildQueue.put({ k: vk, tenantId, type: typeName, at: new Date().toISOString() });
  return false;
}

/** Every tenant whose index of the type has been built (one small row per tenant). */
export async function* builtTenants(typeName: string): AsyncGenerator<string> {
  let afterId: string | undefined;
  for (;;) {
    const page = await built.listByPrefixPage('', { ...(afterId !== undefined ? { afterId } : {}), limit: 500 });
    for (const b of page.items) if (b.type === typeName) yield b.tenantId;
    if (!page.lastId) return;
    afterId = page.lastId;
  }
}

/** Queue a tenant's build without a request (the sweep's backfill of older tenants). */
export async function queueSystemIndexBuild(tenantId: string, typeName: string): Promise<void> {
  const vk = rowKey(tenantId, typeName, '');
  if (await built.get(vk)) return;
  await buildQueue.put({ k: vk, tenantId, type: typeName, at: new Date().toISOString() });
}

/** How many tenants wait for a background build (the gauge's figure). */
export async function queuedBuildCount(): Promise<number> {
  return buildQueue.countByPrefix('');
}

/** Build up to `limit` queued tenants' indexes (the background sweep). A queued row is
 *  claimed by deleting it first, so two instances never build one tenant at once; a
 *  crash mid-build loses the claim, and the next request queues the tenant again. */
export async function drainSystemIndexBuilds(opts: { limit: number }): Promise<number> {
  const page = await buildQueue.listByPrefixPage('', { limit: opts.limit });
  let done = 0;
  for (const row of page.items) {
    if (!(await buildQueue.compareAndDelete(row))) continue;
    try {
      await rebuildSystemIndex(row.tenantId, row.type);
      done += 1;
    } catch (err) {
      await buildQueue.put(row);
      log.warn('system_index_build_failed', { type: row.type, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return done;
}

/** The counted family's size for the whole tenant (all orgs): the drift gauge compares
 *  it with the kernel's row count for the type. */
export async function indexedTenantCount(tenantId: string, typeName: string): Promise<number> {
  const decl = decls.get(typeName);
  if (!decl) return 0;
  return markers.countByPrefix(`${tenantId}:${enc(typeName)}:${decl.countedFamily}:`);
}

/** One family slice's size for an org, counted in the database (one indexed count). */
export async function indexedFamilyCount(tenantId: string, typeName: string, family: string, org: string, segments: string[] = []): Promise<number> {
  return markers.countByPrefix(familyPrefix(tenantId, typeName, family, org, segments));
}

/** How many intents are waiting (the gauge's backlog figure). */
export async function pendingIntentCount(): Promise<number> {
  return pending.countByPrefix('');
}

/** Test-only: drop one type's index rows (every collection) and its verified marks, so a
 *  feature's own test reset leaves no counter or marker of rows it cleared. */
export async function __clearSystemIndexType(typeName: string): Promise<void> {
  for (const k of [...verified.set()]) if (k.includes(`:${enc(typeName)}:`)) verified.delete(k);
  const drop = async <R extends { k: string; type: string }>(c: DurableCollection<R>): Promise<void> => {
    for (const r of await c.list()) if (r.type === typeName) await c.delete(r.k);
  };
  await Promise.all([drop(markers), drop(manifests), drop(pending), drop(counters), drop(built), drop(buildQueue)]);
}

/** Test-only. */
export async function __clearSystemIndex(): Promise<void> {
  verified.clear();
  await Promise.all([markers.__clear(), manifests.__clear(), pending.__clear(), counters.__clear(), built.__clear(), buildQueue.__clear()]);
}
