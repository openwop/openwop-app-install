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
  /** host-ext KV content rows re-keyed. */
  hostExt: number;
  runs: number;
  workflows: number;
  notifications: number;
  pushSubscriptions: number;
}
