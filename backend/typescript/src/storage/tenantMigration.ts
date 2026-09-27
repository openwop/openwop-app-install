/**
 * Shared contract for the cross-tenant adopt-migration (ADR 0003 Phase 4c) —
 * the constants both Storage adapters (sqlite + postgres) use so they stay in
 * lockstep. The per-adapter introspection + re-key SQL lives in each adapter
 * (sync better-sqlite3 vs async pg), but the SEMANTICS are defined here once.
 *
 * Coverage model (why introspection, not a hand-kept table list): the set of
 * tenant-scoped SQL tables is read directly from the live schema (every table
 * with a `tenant_id` column). That makes the migration complete BY CONSTRUCTION
 * — a future tenant table is re-keyed automatically, with no manifest to forget
 * and no silent orphan. Cascade children keyed by `run_id`/`session_id` (events,
 * interrupts, chat_messages, run_budget, …) follow their parent and are not
 * introspected (they carry no `tenant_id`).
 */

/**
 * host-ext KV row-key prefixes EXCLUDED from the generic JSON re-key. These
 * collections encode the tenant in the ROW KEY — the personal-workspace org
 * (`orgId == tenant`, keyed `hostext:access-orgs:<tenant>`) and its deterministic
 * owner member (`mbr-<hash(tenant,subject)>`, keyed `hostext:access-members:…`).
 * A value-only rewrite would orphan/duplicate them, so the adopt-migration skips
 * them and the destination re-seeds canonical scaffolding via
 * `ensurePersonalWorkspace`. Keep these two in sync with `accessControlService`'s
 * `orgs`/`members` collection names.
 */
export const HOSTEXT_SCAFFOLDING_KEY_PREFIXES = [
  'hostext:access-orgs:',
  'hostext:access-members:',
] as const;

/**
 * The JSON fields on a host-ext content row that name a tenant and must be
 * re-keyed when they equal the source tenant. `orgId` is included because a
 * personal-workspace-scoped content row carries `orgId == tenant` (CRM, KB, CMS,
 * publishing, sharing); a shared-workspace `orgId` never equals an `anon:` source
 * so it is left untouched.
 */
export const HOSTEXT_TENANT_FIELDS = ['tenantId', 'orgId'] as const;

/** The shape every `reassignTenant` adapter returns. The four named fields are
 *  retained for back-compat (callers + the audit log read them); `tables` is the
 *  full per-table breakdown and `hostExt` the count of re-keyed KV rows. */
export interface ReassignTenantResult {
  /** Per-SQL-table re-key counts, keyed by table name. */
  tables: Record<string, number>;
  /** host-ext KV content rows re-keyed IN PLACE (tenantId/orgId value only, key unchanged). */
  hostExt: number;
  /** host-ext KV rows/markers whose tenant-embedded KEY was moved to the destination (GEN-1b). */
  hostExtKeysRekeyed: number;
  /** Key-moves that collided with an existing destination key → source dropped (fold dedup). */
  hostExtKeysDeduped: number;
  runs: number;
  workflows: number;
  notifications: number;
  pushSubscriptions: number;
}

/**
 * GEN-1b — rewrite every colon-delimited occurrence of the source tenant token in
 * a string (a host-ext KV row KEY, or the `id` embedded in a secondary-index
 * marker value) to the destination tenant. Returns the input unchanged when the
 * tenant does not appear as a segment.
 *
 * WHY a non-consuming lookaround and NOT `replaceAll(':'+from+':', …)`:
 *  - A tenant id (`anon:<sid>` / `user:<32hex>`) itself CONTAINS a colon, and a
 *    personal workspace has `orgId === tenantId` (accessControlService: an org is
 *    "personal" iff `orgId === tenantId`). So a business key can embed the tenant
 *    TWICE, back-to-back — `hostext:commerce:cart:<t>:<t>:<user>`. A plain
 *    `replaceAll(':<t>:', …)` consumes the shared middle colon and MISSES the
 *    second occurrence, leaving the row half-keyed to the old tenant (a NEW
 *    orphan the fix itself created). Lookaround does not consume the delimiters,
 *    so adjacent occurrences both rewrite.
 *  - `(?<=^|:)` bounds the left edge to string-start OR a colon: it rewrites a
 *    LEADING segment (a marker's `id` field is `${tenant}:${entity}`) and never a
 *    mid-token substring. `(?=$|:)` bounds the right edge to string-end OR a colon
 *    — covering a trailing segment (`hostext:audit:head:<tenant>`) and the
 *    `::`-double-delimited keys some collections use (`${tenant}::${id}` — the
 *    lookahead matches the first of the two colons).
 *  - `from` is regex-escaped. False positives require a NON-tenant segment exactly
 *    equal to the full `from` string; a tenant hash never equals a raw subject uid
 *    and anon sids only ever appear as tenants, so an exact whole-segment match is
 *    safe (see the GEN-1b review).
 */
export function rekeyTenantSegment(s: string, from: string, to: string): string {
  if (from.length === 0 || !s.includes(from)) return s;
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return s.replace(new RegExp(`(?<=^|:)${esc}(?=$|:)`, 'g'), to);
}

/**
 * Rewrite a secondary-index MARKER value for a tenant fold. A marker value is a
 * bare id string, or `{id, p}` JSON when the collection projects into its index
 * (mirror of `hostExtPersistence.parseMarker`/`markerValue` — keep in sync). We
 * rewrite the tenant segment inside the embedded `id` (so `get(id)` resolves the
 * already-moved primary row) and DROP the projection `p`: the next indexed read
 * self-heals it by re-projecting from the current row (`listForTenantProjected`),
 * which sidesteps whether any projection field embedded the old tenant.
 */
export function rekeyHostExtMarkerValue(value: string, from: string, to: string): string {
  if (value.startsWith('{')) {
    try {
      const o = JSON.parse(value) as { id?: unknown };
      if (typeof o.id === 'string') return rekeyTenantSegment(o.id, from, to);
    } catch { /* fall through — treat as a bare id */ }
  }
  return rekeyTenantSegment(value, from, to);
}

/** The action a host-ext KV row needs during a tenant fold, decided purely (no
 *  DB) so both adapters execute identical semantics. */
export type HostExtRekeyAction =
  | { kind: 'none' }
  | { kind: 'value'; v: string }            // content-only rewrite; key unchanged (UPDATE in place)
  | { kind: 'move'; k: string; v: string }; // tenant-embedded key moved (INSERT-if-absent + DELETE old)

/**
 * GEN-1b — decide how one `host_ext_kv` row participates in a `from`→`to` fold.
 * The caller MUST have already excluded the access-control scaffolding
 * (`HOSTEXT_SCAFFOLDING_KEY_PREFIXES` in both the `hostext:` and `hostextidx:`
 * keyspaces), which is re-seeded at the destination rather than moved.
 *
 *  - `hostextidx:` secondary-index marker whose key embeds `from` → MOVE it to the
 *    destination slice (both the `<tenant>` slice segment and, for tenant-prefixed
 *    collections, the `<id>` segment are rewritten by the key pass) with a
 *    projection-dropped value. A marker whose key does not embed `from` isn't this
 *    tenant's — leave it.
 *  - `hostext:` primary row → rewrite `tenantId`/`orgId` content fields; if the
 *    KEY also embeds `from` (mechanism A: `${tenant}:${id}` PK) MOVE it, else
 *    UPDATE the value in place (mechanism: tenant only in content — the majority).
 *  - anything else (e.g. `hostextidxmeta:` sentinels — tenant-agnostic) → none.
 */
export function planHostExtRekey(k: string, v: string, from: string, to: string): HostExtRekeyAction {
  const newKey = rekeyTenantSegment(k, from, to);
  const moved = newKey !== k;
  if (k.startsWith('hostextidx:')) {
    return moved ? { kind: 'move', k: newKey, v: rekeyHostExtMarkerValue(v, from, to) } : { kind: 'none' };
  }
  if (k.startsWith('hostext:')) {
    const content = rewriteRowContentTenant(v, from, to);
    if (moved) return { kind: 'move', k: newKey, v: content ?? v };
    return content === null ? { kind: 'none' } : { kind: 'value', v: content };
  }
  return { kind: 'none' };
}

/**
 * GEN-1c — does a `run_budget` row's `bucket` PK belong to `tenantId`? The
 * `run_budget` table has no `tenant_id` column, so schema introspection skips it in
 * BOTH the fold and teardown; but the tenant is encoded in the bucket string:
 *   • autonomous: `${tenantId}:${windowStart}`
 *   • deep:       `deep:${tenantId}:${conversationId}:${windowStart}`
 * (built by `host/runBudgetService.ts` `consumeBudget` — keep in sync; the fold +
 * teardown tests seed through the REAL writer so a bucket-shape drift breaks them.
 * The predicate lives here, not in runBudgetService, because `storage/` must not
 * import `host/`.) The trailing ':' delimits, so a shorter tenant can't
 * prefix-match a longer tenant's bucket. The FOLD moves buckets with the generic
 * `rekeyTenantSegment` (the tenant is a colon-bounded segment); teardown uses this.
 */
export function runBudgetBucketBelongsTo(bucket: string, tenantId: string): boolean {
  return bucket.startsWith(`${tenantId}:`) || bucket.startsWith(`deep:${tenantId}:`);
}

/**
 * Rewrite every top-level string field of a KV row's JSON value that embeds the
 * source tenant as a colon-bounded SEGMENT. Returns the re-serialized value, or
 * null when nothing changed / the value isn't a JSON object.
 *
 * WHY segment-rewrite ALL string fields and not just `tenantId`/`orgId`: a
 * mechanism-A collection (`hostext:<name>:${tenant}:${id}` PK) redundantly stores
 * its tenant-embedded composite id INSIDE the value too — `workflow:ownership`
 * persists `key: "${tenantId}:${workflowId}"`. A value-rewrite that touched only
 * the two named tenant fields would move the row's KEY but leave that self-
 * referential composite stale, and the NEXT `put(record)` — whose id is
 * `idOf(record)` = the stale composite — would re-create the row under the OLD
 * tenant key: a latent re-orphan. Segment-rewriting `tenantId`/`orgId` (the bare
 * tenant token) AND every composite (`${tenant}:…`) keeps the whole row coherent.
 * The segment match is exact-token-bounded, so a subject ref `user:<uid>` or any
 * external id that merely shares a prefix is untouched (see the GEN-1b review).
 */
function rewriteRowContentTenant(v: string, from: string, to: string): string | null {
  let obj: unknown;
  try { obj = JSON.parse(v); } catch { return null; }
  if (typeof obj !== 'object' || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  let changed = false;
  for (const [field, val] of Object.entries(rec)) {
    if (typeof val !== 'string') continue;
    const next = rekeyTenantSegment(val, from, to);
    if (next !== val) { rec[field] = next; changed = true; }
  }
  return changed ? JSON.stringify(rec) : null;
}
