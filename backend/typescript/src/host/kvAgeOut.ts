/**
 * KV age-out seam (ADR 0380 §3) — SIZE hygiene for append-only host-ext KV
 * stores (webhook ledgers, checkout pointers, idempotency claims). Owning
 * features register `{ prefix, ttlDays, timestampField }`; the ADR 0371
 * retention daemon tick sweeps each registration, deleting rows whose
 * timestamp is older than the TTL.
 *
 * THE BOUNDARY (name it, don't blur it): `registerRetentionPurger`
 * (retentionPurger.ts) is per-tenant GOVERNANCE/PII deletion driven by
 * classification policy and gated behind the opt-in sweep. THIS seam is
 * global size hygiene driven by store semantics, default ON. Two mechanisms,
 * two purposes, one tick.
 *
 * Constraints a registration must honor:
 *  - Prefer INDEX-FREE collections (no `tenantOf` secondary index). This seam
 *    historically deleted raw kv rows, so a tenant-indexed collection stranded
 *    its `hostextidx:` markers on every age-out (WF-ORGINV-1 — observed with
 *    `orgs:invite-hashidx`). Structural cure, both halves: (1) registering a
 *    tenant-indexed collection now trips a registration-time WARN (the
 *    tripwire — a warn, not a refusal, because `settings:byok-usage` is a
 *    live indexed registration and a throw would turn hygiene into a boot
 *    failure), and (2) the sweep deletes VIA the registered collection when
 *    one exists (`hostExtCollectionForPrefix`), which cleans the marker in
 *    the same call — so the stranding cannot recur even for a warned
 *    registration. The shipping registrations: billing:checkout,
 *    commerce:order-idem, orgs:invite, orgs:invite-hashidx (index-free since
 *    WF-ORGINV-1), settings:byok-usage (indexed — acknowledged via
 *    `acceptIndexed`, marker-aware swept).
 *    `billing:webhook-event` is DELIBERATELY NOT registered and must never
 *    be: it is the money-critical Stripe dedup ledger — a TTL on it lets a
 *    replayed event re-process (double-crediting). See billingService.ts.
 *  - The row JSON must carry `timestampField` as an ISO-8601 string. A row
 *    that doesn't parse, or lacks the field, is SKIPPED (never deleted on a
 *    guess) and counted; a store that throws is logged and skipped — one bad
 *    registration never stops the tick (fail-open per store).
 *    A store that ADDS `timestampField` after rows already exist must supply
 *    `deriveTimestamp` — otherwise the pre-existing rows are skipped on every
 *    tick FOREVER, and they are precisely the oldest ones (ANL-1 R2).
 */

import type { Storage } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';
import { hostExtCollectionForPrefix } from './hostExtPersistence.js';
import { listHeldTenantsFrom } from './retentionHold.js';

const log = createLogger('host.kvAgeOut');

/**
 * CONS-4 / WF-CONS-1 — the LEGAL HOLD on the one DEFAULT-ON deletion lane.
 *
 * This sweep is global (per STORE, not per tenant), so unlike `eraseSubject` and
 * `purgeRetained` it has no tenant to check up front — which is why the hold
 * never reached it. The shape that fits: resolve each ROW's tenant and skip the
 * held ones.
 *
 * Cost is zero on the normal path — one `listRetentionHolds()` read per tick,
 * and when there are no holds (the overwhelmingly common case) nothing else
 * changes at all.
 *
 * Resolution order, and the LIMIT stated rather than implied. A row's tenant is
 * taken from `row.tenantId` when present; failing that, the row id is tested
 * against the held set prefix-by-prefix (never `split(':')[0]`, which would
 * truncate the `ws:`/`anon:` tenant prefixes). Two residuals follow, and both
 * are counted:
 *
 *  - a row with no `tenantId` field and no `:` in its id cannot be attributed at
 *    all (`heldUnresolved`), and is SWEPT. The alternative — freezing every
 *    unresolvable row across all registrations for the duration of any one
 *    tenant's hold — turns a litigation hold into unbounded growth in stores
 *    whose entire purpose is size hygiene;
 *  - a row whose id happens to contain `:` for an unrelated reason reads as
 *    "attributable, not held". That is a false negative this seam cannot
 *    distinguish without a per-registration tenant extractor, which is the
 *    proper cure and is follow-on work.
 */
function tenantOfRow(row: Record<string, unknown>): string | null {
  const declared = row.tenantId;
  return typeof declared === 'string' && declared ? declared : null;
}

/** The id's tenant, resolved against the KNOWN held set so multi-segment tenant
 *  ids (`ws:acme`, `anon:xyz`) are matched whole rather than truncated at the
 *  first `:`. Returns the matching held tenant, or null. */
function heldTenantForId(id: string, held: ReadonlySet<string>): string | null {
  for (let i = id.indexOf(':'); i > 0; i = id.indexOf(':', i + 1)) {
    const candidate = id.slice(0, i);
    if (held.has(candidate)) return candidate;
  }
  return null;
}

export interface KvAgeOutRegistration {
  /** Stable id for logs/tests, e.g. `billing:webhook-event`. */
  id: string;
  /** Full kv key prefix, e.g. `hostext:billing:webhook-event:`. */
  prefix: string;
  /** Rows older than this are deleted. Must be > 0. */
  ttlDays: number;
  /** ISO-8601 timestamp field inside the row JSON, e.g. `processedAt`. */
  timestampField: string;
  /** ANL-1 R2 — LAST-RESORT derivation for a row that predates `timestampField`.
   *  Returns an ISO-8601 instant, or `undefined` to leave the row skipped.
   *
   *  This is NOT a relaxation of "never delete on a guess": it exists only for a
   *  store whose row ALREADY CARRIES the instant in another exact form (the
   *  visitor-salt row's id IS its UTC mint day), and it must derive the EARLIEST
   *  instant consistent with that data so the row can only age out later than
   *  the truth would, never sooner. A store with no such field must not set it.
   *
   *  Why it is needed: a field added after rows already exist is invisible to
   *  this lane FOREVER — the skip is permanent, and the population it strands is
   *  exactly the oldest rows, i.e. the ones a TTL was introduced to bound. */
  deriveTimestamp?: (row: Record<string, unknown>, id: string) => string | undefined;
  /** Review F3 — acknowledges a TENANT-INDEXED collection on this lane, muting
   *  the registration-time tripwire warn for THIS registration only. Setting it
   *  is a statement, not a free pass: the sweep deletes via the collection
   *  (marker-aware), but index markers would strand if deletes ever bypassed
   *  the collection again — prefer dropping `tenantOf` where nothing reads the
   *  tenant slice. Unacknowledged indexed registrations still warn. */
  acceptIndexed?: boolean;
  /**
   * Review F7 — this store is HOST-GLOBAL: its rows belong to no tenant BY
   * CONSTRUCTION, so no tenant's legal hold can ever protect them and their
   * being unattributable is not a finding.
   *
   * Why it exists. `heldUnresolved` counts rows the hold could not be applied
   * to, and `kv_age_out_hold_unresolvable` warns on it — a real tripwire for a
   * store that SHOULD carry a tenant and doesn't. But `analytics:visitor-salt`
   * rows are `{day, salt, mintedAt}` with no `tenantId`, and the row id IS a
   * UTC date (`2026-08-19`), which contains no `:` — so EVERY salt row landed
   * in `heldUnresolved` and the warn fired on EVERY tick for as long as any
   * tenant anywhere was held. A tripwire that is guaranteed to fire while the
   * condition it watches is active is pre-desensitised: the first thing an
   * operator learns is to ignore it, and the real finding it exists to surface
   * arrives in the same noise.
   *
   * Setting this is a claim about the DATA MODEL, not a mute button: it says
   * "no row in this store can ever belong to a tenant". A store whose rows
   * merely HAPPEN to lack a tenantId today must NOT set it — that is exactly
   * the case the warn is for.
   */
  hostGlobal?: boolean;
}

const registrations = new Map<string, KvAgeOutRegistration>();

/** Register an append-only kv store for TTL age-out. Idempotent by `id`
 *  (module-scope call sites re-execute under test isolation). */
export function registerKvAgeOut(reg: KvAgeOutRegistration): void {
  if (!(reg.ttlDays > 0)) throw new Error(`kvAgeOut '${reg.id}': ttlDays must be > 0`);
  // WF-ORGINV-1 — registration-time index-free tripwire. A tenant-indexed
  // collection on this lane used to strand a `hostextidx:` marker per aged-out
  // row. The sweep now deletes via the collection (marker-aware), so this is a
  // warn, not a refusal — but it makes the next indexed registration visible
  // instead of silent. Best-effort: it only fires when the collection was
  // constructed before this call (true for every shipping registration — the
  // module-scope constructor precedes its own registerKvAgeOut call).
  // Review F3 — an ACKNOWLEDGED indexed registration (`acceptIndexed: true`)
  // stays silent: a warn on every boot for a known, accepted state is alarm
  // fatigue, not a tripwire.
  if (!reg.acceptIndexed && hostExtCollectionForPrefix(reg.prefix)?.indexed) {
    log.warn('kv_age_out_indexed_collection', {
      id: reg.id,
      prefix: reg.prefix,
      hint: 'tenant-indexed collection on the kvAgeOut lane — prefer dropping tenantOf; the sweep deletes via the collection so markers do not strand',
    });
  }
  registrations.set(reg.id, reg);
}

export function __clearKvAgeOutForTest(): void {
  registrations.clear();
}

export function __listKvAgeOutForTest(): ReadonlyArray<KvAgeOutRegistration> {
  return [...registrations.values()];
}

/** Per-store per-tick delete cap — keeps one tick bounded even against a
 *  backlogged store (the next hourly tick takes the next slice). */
const MAX_DELETES_PER_STORE_PER_TICK = 1000;

/** One sweep pass over every registration. Called from the retention daemon
 *  tick; also directly from tests with a fixed `now`. Fail-open per store. */
export interface KvAgeOutSweepResult {
  id: string; deleted: number; skipped: number; derived: number;
  heldSkipped: number; heldUnresolved: number; scanned: number; error?: string;
}

export async function __runKvAgeOutOnce(storage: Storage, now: Date = new Date()): Promise<KvAgeOutSweepResult[]> {
  // CONS-13 — this returned `void`, so no caller could ever assert on the
  // sweep's outcome and no test could tell a working registration from an inert
  // one. It now reports per-store counters; the daemon may ignore them, a test
  // may not have to.
  const totals: KvAgeOutSweepResult[] = [];
  // CONS-4 — one read per tick; an empty set means the loop below is byte-for-byte
  // the pre-existing behaviour.
  let held: ReadonlySet<string>;
  try {
    // Read from THIS storage, not the ambient host-ext handle — see
    // `listHeldTenantsFrom`. A hold read that can throw is worse than useless
    // here: it either fails open (sweeping under a hold) or freezes all size
    // hygiene on a storage-wiring detail.
    held = await listHeldTenantsFrom(storage);
  } catch (err) {
    // Reaching here means the sweep's OWN storage is unreadable, in which case
    // nothing below could run either. Fail closed and let the next tick retry:
    // size hygiene delayed by an hour is not a defect; sweeping under a hold is.
    log.error('kv_age_out_hold_read_failed', { error: err instanceof Error ? err.message : String(err) });
    return totals;
  }
  for (const reg of registrations.values()) {
    try {
      const cutoffMs = now.getTime() - reg.ttlDays * 86_400_000;
      const rows = await storage.kvList(reg.prefix);
      // WF-ORGINV-1 — when a live DurableCollection owns this prefix, delete
      // THROUGH it: for a tenant-indexed collection that also removes the
      // `hostextidx:` marker in the same call (no stranding); for an
      // index-free collection it degrades to the same raw kvDelete as before.
      // Resolved per sweep (not captured at registration) so a re-constructed
      // collection under test isolation is always the live one.
      const col = hostExtCollectionForPrefix(reg.prefix);
      let deleted = 0;
      let skipped = 0;
      let derived = 0;
      let heldSkipped = 0;
      let heldUnresolved = 0;
      for (const { key, value } of rows) {
        if (deleted >= MAX_DELETES_PER_STORE_PER_TICK) break;
        const id = key.slice(reg.prefix.length);
        let ts: number;
        try {
          const parsed = JSON.parse(value) as Record<string, unknown>;
          // Review F7 — a HOST-GLOBAL store is skipped entirely: no row in it
          // can belong to a tenant, so there is no hold to apply and nothing
          // unresolved to report. Without this the salt store fired the
          // `hold_unresolvable` warn on every tick while any tenant was held.
          if (held.size > 0 && !reg.hostGlobal) {
            // CONS-4 — a row belonging to a held tenant is never aged out.
            const rowTenant = tenantOfRow(parsed);
            if (rowTenant !== null) {
              if (held.has(rowTenant)) { heldSkipped += 1; continue; }
            } else if (heldTenantForId(id, held) !== null) {
              heldSkipped += 1;
              continue;
            } else if (!id.includes(':')) {
              // Neither a declared tenantId nor a `${tenantId}:` id shape — this
              // row cannot be attributed, so the hold cannot protect it. Swept,
              // and counted so the residual is visible instead of implied.
              heldUnresolved += 1;
            }
          }
          const raw = parsed[reg.timestampField];
          ts = typeof raw === 'string' ? Date.parse(raw) : NaN;
          // ANL-1 R2 — the field is absent/unparseable but the store can derive
          // it exactly from the row itself (see `deriveTimestamp`). Without this
          // a rows-predate-the-field store is skipped on EVERY tick forever.
          if (!Number.isFinite(ts) && reg.deriveTimestamp) {
            const fallback = reg.deriveTimestamp(parsed, id);
            const fallbackMs = typeof fallback === 'string' ? Date.parse(fallback) : NaN;
            if (Number.isFinite(fallbackMs)) { ts = fallbackMs; derived += 1; }
          }
        } catch {
          ts = NaN;
        }
        if (!Number.isFinite(ts)) { skipped += 1; continue; } // never delete on a guess
        if (ts < cutoffMs) {
          const removed = col ? await col.deleteById(id) : await storage.kvDelete(key);
          if (removed) deleted += 1;
        }
      }
      // CONS-13 — UNCONDITIONAL. This line used to fire only when
      // `deleted > 0 || skipped > 0 || derived > 0`, so a MIS-PREFIXED or
      // renamed store — one that scans nothing, forever — was indistinguishable
      // from a healthy empty one. Silence was the failure mode of the only
      // DEFAULT-ON deletion lane in the app. `scanned` is the field that
      // discriminates: a registration that never sees a row is a registration
      // pointing at nothing.
      log.info('kv_age_out_swept', { id: reg.id, deleted, skipped, derived, heldSkipped, heldUnresolved, scanned: rows.length });
      totals.push({ id: reg.id, deleted, skipped, derived, heldSkipped, heldUnresolved, scanned: rows.length });
      // CONS-4 — a hold that could not be applied is itself an audit finding, so
      // it warns rather than riding along in an info line nobody alerts on.
      if (heldUnresolved > 0) {
        log.warn('kv_age_out_hold_unresolvable', { id: reg.id, heldUnresolved, holds: held.size });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn('kv_age_out_store_error', { id: reg.id, error });
      totals.push({ id: reg.id, deleted: 0, skipped: 0, derived: 0, heldSkipped: 0, heldUnresolved: 0, scanned: 0, error });
    }
  }
  return totals;
}
