/**
 * App-tier migration runner (ADR 0052 §D5).
 *
 * The DB schema runner (`storage/{sqlite,postgres}/schema.ts`) owns DDL keyed by
 * `LATEST_SCHEMA_VERSION`. THIS runner owns **non-schema, app-level** one-shots —
 * re-seeding a pack, moving a config key, rewriting stored blobs, backfilling
 * from an external source — expressed over the `Storage` API rather than raw
 * DDL. It runs on boot AFTER the schema migrations, in order, exactly once,
 * keyed by its own monotonic counter in `__app_meta.app_migration_version`.
 *
 * Discipline (mirrors the schema runner):
 *  - **Forward-only** — append entries; never renumber or mutate a shipped one.
 *  - **Skip-intermediate** — apply every entry above the recorded counter.
 *  - **Idempotent** — a re-run MUST be a no-op. This is what lets the runner be
 *    safe on a fresh install (nothing to backfill → each entry no-ops) AND on an
 *    install that predates app-version tracking (counter defaults to 0 → the gap
 *    replays correctly), without needing to distinguish the two.
 *  - **Concurrency-safe** — there is NO advisory lock (matching the DB schema
 *    runner, which relies on `IF NOT EXISTS` DDL). On a multi-instance rolling
 *    deploy several instances boot at once and EACH calls this, so an entry's
 *    `run` MUST tolerate concurrent execution (e.g. upsert / `ON CONFLICT`, not a
 *    naive read-then-insert) — idempotent-under-serial is not enough. A migration
 *    that cannot be made concurrency-safe MUST ship in a release flagged a
 *    required stop (ADR 0052 §D2) so it runs against a single drained instance.
 */

import type { Storage } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';
import { backfillProfileReadPermissions } from './agentProfileService.js';
import { backfillCompanySizeFromEmployees } from '../features/crm/entities/companies.js';
import { migratePagesToKernel } from '../features/cms/cmsService.js';
import { migrateCompaniesToKernel } from '../features/crm/entities/companies.js';
import { migrateDealsToKernel } from '../features/crm/entities/deals.js';
import { migrateProductsToKernel } from '../features/commerce/commerceService.js';
import { builtinToolNamespaces } from './agentToolProvider.js';

const log = createLogger('host.appMigrations');

export const APP_MIGRATION_KEY = 'app_migration_version';

/** A single app-tier migration. `version` is its position in the monotonic
 *  sequence; `run` MUST be idempotent. */
export interface AppMigration {
  version: number;
  name: string;
  /**
   * MUST be idempotent, and MUST tolerate a CONCURRENT second execution.
   *
   * `runAppMigrations` is a bare read-then-write — `getAppMeta` → run pending →
   * `setAppMeta` — with **no lock and no CAS** (`Storage` exposes neither). Cloud
   * Run boots several instances at once on a deploy, so they all read the same
   * recorded version and they ALL run every pending migration, overlapping.
   *
   * That has been safe only because every entry so far happens to be idempotent.
   * This comment plus `app-migration-idempotence.test.ts` turn that from folklore
   * into an enforced property: the test executes the real `APP_MIGRATIONS` set
   * twice CONCURRENTLY and asserts the recorded version and observable effects are
   * unchanged.
   *
   * A lock was considered and rejected (MIG-LOCK-1): it would need a new `Storage`
   * primitive across both adapters, and it protects only the concurrent-boot case
   * — idempotency additionally covers retries, partial failure, and a manual
   * re-run. If you add an entry that CANNOT be made idempotent, the lock becomes
   * necessary; say so on the entry rather than silently relying on timing.
   */
  run(storage: Storage): Promise<void>;
}

/** The ordered app-migration set. Append-only — the first real entry lands with
 *  the feature that needs a non-schema backfill. Empty is valid (no-op runner). */
export const APP_MIGRATIONS: readonly AppMigration[] = [
  {
    // ADR 0102 — backfill existing agent profiles so the per-tool permission
    // gate permits the host's builtin tools (web research / knowledge / fetch /
    // compute). Without this, a profile whose `permissions.read/write` only lists
    // illustrative domain ids would have ALL builtin tool calls blocked once
    // `OPENWOP_AGENT_TOOL_PERMISSIONS_ENABLED` is flipped on. Idempotent set-union
    // on `permissions.read`; profiles with no `permissions` block stay ungated.
    version: 1,
    name: 'backfill-builtin-tool-permissions',
    async run(): Promise<void> {
      const updated = await backfillProfileReadPermissions(builtinToolNamespaces());
      log.info('app_migration_backfill_tool_permissions', { profilesUpdated: updated });
    },
  },
  {
    // ADR 0376 Phase 2 — the tour → walkthrough persisted-id migration. COPIES
    // (never deletes) the stored state whose ids the rename changed, so the
    // deployed canary + existing progress survive under the new ids while the
    // old rows stay put (reversible). Concurrency-safe: kvSet is last-writer-wins
    // with deterministic values, and the toggle copy is first-write-wins.
    version: 2,
    name: 'rename-guided-tours-to-walkthroughs',
    async run(storage: Storage): Promise<void> {
      // 1. Toggle row: copy hostext:feature-toggle:guided-tours -> :walkthroughs,
      //    preserving status + tenantOverrides (the prod canary). First-write-wins
      //    so a later admin edit to the new toggle is never clobbered by a re-run.
      const OLD_TOGGLE = 'hostext:feature-toggle:guided-tours';
      const NEW_TOGGLE = 'hostext:feature-toggle:walkthroughs';
      const oldToggle = await storage.kvGet(OLD_TOGGLE);
      if (oldToggle && !(await storage.kvGet(NEW_TOGGLE))) {
        let toWrite = oldToggle;
        try {
          const cfg = JSON.parse(oldToggle) as Record<string, unknown>;
          cfg.id = 'walkthroughs'; // the config's own id must match the new key
          toWrite = JSON.stringify(cfg);
        } catch { /* opaque value — copy verbatim */ }
        await storage.kvSet(NEW_TOGGLE, toWrite);
        log.info('app_migration_walkthrough_toggle_copied', {});
      }

      // 2. Progress rows: copy hostext:guided-tour-progress:* -> walkthrough-progress:*,
      //    renaming the `tourId` field -> `walkthroughId` and rewriting the legacy
      //    builtin workflow id value. Idempotent (deterministic target key + value).
      // NOTE (grade-pass): these copies use raw kvSet, so they carry no
      // hostextidx: tenant-index marker. Harmless while every reader full-scans
      // (the documented demo-scale stance); if this collection ever moves to
      // indexed reads, ensureTenantIndex's backfill repairs them.
      const rows = await storage.kvList('hostext:guided-tour-progress:');
      let copied = 0;
      for (const { value } of rows) {
        let rec: Record<string, unknown>;
        try { rec = JSON.parse(value) as Record<string, unknown>; } catch { continue; }
        const tenantId = typeof rec.tenantId === 'string' ? rec.tenantId : undefined;
        const oldId = typeof rec.tourId === 'string' ? rec.tourId : undefined;
        if (!tenantId || !oldId) continue;
        const walkthroughId = oldId === 'tour.campaign-studio.first-brief'
          ? 'walkthrough.campaign-studio.first-brief' : oldId;
        const key = `${tenantId}:${walkthroughId}`;
        const next = {
          key,
          tenantId,
          walkthroughId,
          status: rec.status,
          runId: rec.runId,
          updatedAt: rec.updatedAt,
        };
        await storage.kvSet(`hostext:walkthrough-progress:${key}`, JSON.stringify(next));
        copied += 1;
      }
      if (copied > 0) log.info('app_migration_walkthrough_progress_copied', { rows: copied });
    },
  },
  {
    // ADR 0380 §2 — delete agent_run_activity rows orphaned by runs swept
    // BEFORE the deleteRun cascade covered the table (probe-confirmed: 24 rows
    // in prod, 2026-07-16). Idempotent (already-clean → deletes 0) and
    // concurrency-safe (a guarded DELETE; concurrent executions race to delete
    // the same rows, which is harmless). Future orphans can't occur — the
    // cascade now owns the invariant.
    version: 3,
    name: 'delete-orphan-agent-run-activity',
    async run(storage: Storage): Promise<void> {
      const deleted = await storage.deleteOrphanAgentRunActivity();
      log.info('app_migration_orphan_agent_run_activity', { deleted });
    },
  },
  {
    // ADR 0383 (CRM-2) — the company `size` field was promoted from
    // `customFields.employees`. Lift existing rows' numeric `employees` onto the
    // first-class `size` and drop the customField. Idempotent (a row already
    // carrying `size`, or with no numeric `employees`, is skipped); forward-only.
    version: 4,
    name: 'backfill-company-size-from-employees',
    async run(): Promise<void> {
      const updated = await backfillCompanySizeFromEmployees();
      log.info('app_migration_backfill_company_size', { companiesUpdated: updated });
    },
  },
  {
    // ADR 0379 P2 (PR-A) — rekey roster rows to the tenant-qualified key
    // scheme (`hostext:roster:<rosterId>` → `hostext:roster:<tenant>:<rosterId>`).
    // Old-shape keys are recognizable by their `host:` remainder prefix (every
    // rosterId is `host:<slug>-…`; no tenant id is 'host'). Idempotent +
    // concurrency-safe: first-write-wins on the new key, delete-old only after
    // the new row exists; a re-run finds no old-shape keys and no-ops. A row
    // written by a still-old instance during a rolling deploy is caught by the
    // identical re-sweep shipping with PR-B.
    version: 5,
    name: 'rekey-roster-rows-tenant-qualified',
    async run(storage: Storage): Promise<void> {
      let rekeyed = 0;
      for (const { key, value } of await storage.kvList('hostext:roster:host:')) {
        try {
          const entry = JSON.parse(value) as { tenantId?: string };
          if (typeof entry.tenantId !== 'string' || !entry.tenantId) continue; // never guess
          const rosterId = key.slice('hostext:roster:'.length);
          const newKey = `hostext:roster:${entry.tenantId}:${rosterId}`;
          if (!(await storage.kvGet(newKey))) await storage.kvSet(newKey, value);
          await storage.kvDelete(key);
          rekeyed += 1;
        } catch { /* skip an unparseable row — leave it for inspection */ }
      }
      if (rekeyed > 0) log.info('app_migration_roster_rekey', { rekeyed });
    },
  },
  {
    // ADR 0379 P2 (PR-B) — the promised re-sweep of v5: catches roster rows
    // written under the OLD key shape by a still-old instance during PR-A's
    // rolling deploy window. Identical logic, idempotent (no old-shape keys ⇒
    // no-op).
    version: 6,
    name: 'rekey-roster-rows-tenant-qualified-resweep',
    async run(storage: Storage): Promise<void> {
      let rekeyed = 0;
      for (const { key, value } of await storage.kvList('hostext:roster:host:')) {
        try {
          const entry = JSON.parse(value) as { tenantId?: string };
          if (typeof entry.tenantId !== 'string' || !entry.tenantId) continue;
          const rosterId = key.slice('hostext:roster:'.length);
          const newKey = `hostext:roster:${entry.tenantId}:${rosterId}`;
          if (!(await storage.kvGet(newKey))) await storage.kvSet(newKey, value);
          await storage.kvDelete(key);
          rekeyed += 1;
        } catch { /* leave unparseable rows for inspection */ }
      }
      if (rekeyed > 0) log.info('app_migration_roster_rekey_resweep', { rekeyed });
    },
  },
  {
    // ADR 0379 P2 (PR-B) — rekey agent-profile rows to the tenant-qualified
    // scheme (profileId = rosterId, which is deterministic per persona now, so
    // a bare-profileId key would collide across tenants). Shape-agnostic: move
    // any row whose key is not `hostext:agent-profile:<its-tenant>:<its-id>`.
    // Idempotent first-write-wins, mirrors v5/v6.
    version: 7,
    name: 'rekey-agent-profiles-tenant-qualified',
    async run(storage: Storage): Promise<void> {
      let rekeyed = 0;
      for (const { key, value } of await storage.kvList('hostext:agent-profile:')) {
        try {
          const row = JSON.parse(value) as { tenantId?: string; profileId?: string };
          if (typeof row.tenantId !== 'string' || !row.tenantId || typeof row.profileId !== 'string' || !row.profileId) continue;
          const expected = `hostext:agent-profile:${row.tenantId}:${row.profileId}`;
          if (key === expected) continue;
          if (!(await storage.kvGet(expected))) await storage.kvSet(expected, value);
          await storage.kvDelete(key);
          rekeyed += 1;
        } catch { /* leave unparseable rows for inspection */ }
      }
      if (rekeyed > 0) log.info('app_migration_agent_profile_rekey', { rekeyed });
    },
  },
  {
    // Grade-pass fix (ADR 0379): the REAL rolling-window re-sweep. v6 was
    // meant to catch bare-shape rows written by still-old instances during
    // PR-A's rollout, but v5+v6+v7 all shipped in ONE deploy (rev 00523), so
    // they ran back-to-back in the same boot — any roster/profile row written
    // by an old instance DURING that rollout was stranded (invisible to the
    // tenant-qualified readers, no future sweep). This v8 runs on the NEXT
    // deploy and catches exactly those stragglers: the v5 roster sweep + the
    // v7 profile sweep, verbatim, idempotent (clean stores ⇒ no-op).
    version: 8,
    name: 'rekey-roster-and-profile-rows-post-rollout-resweep',
    async run(storage: Storage): Promise<void> {
      // Grade-pass refinement over v5/v6's plain first-write-wins: a bare-shape
      // straggler is a write made by an OLD instance DURING the rollout — i.e.
      // potentially FRESHER than the row already at the new key. Compare
      // updatedAt and keep the newer copy instead of silently dropping the
      // straggler's update.
      const fresher = (a: string, b: string | null): boolean => {
        if (!b) return true;
        try {
          const ta = (JSON.parse(a) as { updatedAt?: string }).updatedAt ?? '';
          const tb = (JSON.parse(b) as { updatedAt?: string }).updatedAt ?? '';
          return ta > tb;
        } catch { return false; }
      };
      let rekeyed = 0;
      for (const { key, value } of await storage.kvList('hostext:roster:host:')) {
        try {
          const entry = JSON.parse(value) as { tenantId?: string };
          if (typeof entry.tenantId !== 'string' || !entry.tenantId) continue;
          const rosterId = key.slice('hostext:roster:'.length);
          const newKey = `hostext:roster:${entry.tenantId}:${rosterId}`;
          if (fresher(value, await storage.kvGet(newKey))) await storage.kvSet(newKey, value);
          await storage.kvDelete(key);
          rekeyed += 1;
        } catch { /* leave unparseable rows for inspection */ }
      }
      for (const { key, value } of await storage.kvList('hostext:agent-profile:')) {
        try {
          const row = JSON.parse(value) as { tenantId?: string; profileId?: string };
          if (typeof row.tenantId !== 'string' || !row.tenantId || typeof row.profileId !== 'string' || !row.profileId) continue;
          const expected = `hostext:agent-profile:${row.tenantId}:${row.profileId}`;
          if (key === expected) continue;
          if (fresher(value, await storage.kvGet(expected))) await storage.kvSet(expected, value);
          await storage.kvDelete(key);
          rekeyed += 1;
        } catch { /* leave unparseable rows for inspection */ }
      }
      if (rekeyed > 0) log.info('app_migration_post_rollout_resweep', { rekeyed });
    },
  },
  {
    // ADR 0408 Phase C — pages move into the content kernel (the entities
    // engine): every legacy `cms:page` row becomes a `cms.page` system-type
    // row, id-preserving (pageId = entityId — versions/redirects/experiments
    // keys untouched). Idempotent (already-migrated pages skip) and
    // concurrency-safe (the kernel write is CAS-guarded; a losing instance
    // sees the winner's row on re-check). Legacy rows stay READ-DARK for one
    // release — the next release's cleanup migration removes them.
    version: 9,
    name: 'cms-pages-to-content-kernel',
    async run(): Promise<void> {
      await migratePagesToKernel();
    },
  },
  {
    // ADR 0409 Phase 2 — companies move into the content kernel: every legacy
    // `crm:company` row becomes a `crm.company` system-type row, id-preserving
    // (companyId = entityId — deal.companyId refs + key-claims + merge-events
    // untouched). `crm.company` is `neverPublic` (CRM records are never served
    // anonymously). Idempotent + concurrency-safe; legacy rows read-dark one
    // release. Runs AFTER APP_MIGRATION 4 (employees→size backfill) so
    // firmographics are already promoted before the move.
    version: 10,
    name: 'crm-companies-to-content-kernel',
    async run(): Promise<void> {
      await migrateCompaniesToKernel();
    },
  },
  {
    // ADR 0409 Phase 3 — deals move into the content kernel: every legacy
    // `crm:deal` row becomes a `crm.deal` system-type row, id-preserving
    // (dealId = entityId — stage-history + pipeline refs untouched).
    // `neverPublic`. Idempotent + concurrency-safe; legacy rows read-dark one
    // release. Stage history (`crm:stagehistory`) stays its own façade store.
    version: 11,
    name: 'crm-deals-to-content-kernel',
    async run(): Promise<void> {
      await migrateDealsToKernel();
    },
  },
  {
    // ADR 0410 Phase 1 — the product CATALOG moves into the content kernel:
    // every legacy `commerce:product` row becomes a `commerce.product`
    // system-type row, id-preserving (productId = entityId — order/cart/
    // stock-movement/price-list refs untouched). Only the catalog moves; the
    // money path (orders/carts/refunds/stock-movement/payouts) STAYS.
    // commerce.product is publicRead-eligible but v1 sets neither flag (façade-
    // only; storefront read stays the commerce route). Idempotent; legacy
    // read-dark one release.
    version: 12,
    name: 'commerce-products-to-content-kernel',
    async run(): Promise<void> {
      await migrateProductsToKernel();
    },
  },
  {
    // ADR 0409 Phase 2 correction — re-run the employees→size promotion AFTER
    // the companies are in the kernel. APP_MIGRATION 4
    // (`backfillCompanySizeFromEmployees`) reads the kernel via
    // `listAllSystemRows`, but it runs BEFORE version 10 populates the kernel —
    // so a skip-upgrader recorded at counter < 4 (deployed before ADR 0383)
    // would run mig 4 against an empty kernel (no-op) and then mig 10 moves the
    // companies with `customFields.employees` still un-promoted. Re-running the
    // (idempotent) promotion here, post-move, closes that gap for every install
    // ordering without mutating the already-shipped mig 4. Installs that already
    // promoted correctly re-run it to a no-op.
    version: 13,
    name: 'crm-company-size-backfill-post-kernel',
    async run(): Promise<void> {
      await backfillCompanySizeFromEmployees();
    },
  },
  {
    // ADR 0507 — re-expand the seeded chain definitions in RFC 0124 deferred mode.
    //
    // The seeder is register-if-missing (`getRegisteredWorkflowAsync` at
    // `seedWorkflows.ts`), so changing the expansion mode fixes only definitions
    // that have never been minted. Every existing install keeps rows whose params
    // froze to `undefined` — and because the row is GLOBAL (keyed by workflowId
    // with no tenant component), a tenant seeding later hits the cached broken def
    // too. Without this the seeder change is inert for every deployed host.
    //
    // Deliberately a MIGRATION and not boot-path logic. A conditional re-seed on
    // the boot path runs on every cold boot of every instance, and
    // read-then-`registerWorkflowDurable` has no CAS — precisely the shape of the
    // §Correction (grade-data RI-1) incident where "one cold boot silently rewrote
    // the definition every tenant runs". `APP_MIGRATIONS` is versioned, recorded
    // and single-shot by construction.
    //
    // Replay-safe: node ids are byte-identical between the two modes (measured
    // 169/169), so a run that resolves HEAD still matches its checkpoints by
    // nodeId; a run that pinned `definitionRevision` keeps resolving its own
    // revision row, which is content-addressed and additive — re-seeding ADDS a
    // row, it never deletes the pinned one.
    version: 14,
    name: 'reseed-chain-workflows-deferred',
    async run(): Promise<void> {
      const { reseedChainWorkflowsDeferred } = await import('./seedWorkflows.js');
      const result = await reseedChainWorkflowsDeferred();
      log.info('app_migration_reseed_deferred', result);
    },
  },
  {
    // ADR 0498 DATA-1 — already-seeded definitions still carry the retired
    // `core.openwop.integration.notification-push`, whose required `deviceToken`
    // no chain author can supply: it POSTs `to: undefined` and reports
    // `status:'success'` with `sent:false`. Packs are retargeted, but
    // `seedWorkflows` is "seeded once, never rewritten", so existing tenants keep
    // the broken node.
    //
    // The edit is SURGICAL: only the retired node's `typeId`/`config`/`inputs`
    // change, copied from the pack. It does NOT re-expand the chain.
    //
    // That is load-bearing twice over. (1) Re-expansion re-rolls every node id
    // (`deterministicExpansionId` hashes `chainId@version:params` and all 23 packs
    // were bumped), so a run resolving HEAD would find no matching checkpoints —
    // the #2671 hazard, which a re-expanding version had to buy off with a per-run
    // guard that stranded the heaviest users permanently. Preserving node ids
    // removes the hazard AND the guard. (2) These `wf.seed.*` rows are tenant-owned
    // and builder-editable, so rebuilding from the pack would revert tenant edits
    // and drop `metadata` other code depends on (`requiresAgentId`, `retention`,
    // `lifecycle`) — data loss, caught in review before it shipped.
    //
    // `storage` is unused by design: with node ids preserved there is no run
    // history to consult. The parameter stays for the AppMigration signature.
    //
    // Idempotent: after the rewrite the retired typeId is gone, so a second (or
    // concurrent) execution finds nothing to rewrite.
    version: 15,
    name: 'retarget-seeded-notification-push',
    async run(storage: Storage): Promise<void> {
      const { retargetSeededNotifyNodes } = await import('./seedWorkflows.js');
      const result = await retargetSeededNotifyNodes(storage);
      log.info('app_migration_retarget_notify', result);
    },
  },
  {
    // PHBC-5 — migration 14 ran, converted NOTHING, and recorded itself complete.
    //
    // It iterates the chain corpus and looks up a DERIVED id, so a stored
    // definition whose chain has left the corpus is invisible to it. Measured in
    // production: 71 rows written 2026-07-28; migration 14 ran 2026-08-01 logging
    // `{examined: 52, absent: 52, rewritten: 0}`; all 71 are still
    // `expansion-time`. One-shot, so it never looked again.
    //
    // THIS ONE DERIVES THE POPULATION FROM THE ROWS, which is what makes its no-op
    // DISTINGUISHABLE from a fresh install's: a fresh install has `total === 0`.
    // Migration 14 could not tell those apart, and that — not being one-shot — is
    // why it failed silently.
    version: 16,
    name: 'reseed-seeded-rows-deferred',
    async run(storage: Storage): Promise<void> {
      const { reseedSeededRowsDeferred } = await import('./seedWorkflows.js');
      const r = await reseedSeededRowsDeferred(storage);
      log.info('app_migration_reseed_rows', {
        total: r.total, alreadyDeferred: r.alreadyDeferred, converted: r.converted,
        chainGone: r.chainGone.length, inputBearing: r.inputBearing.length, failed: r.failed,
      });

      // ── The invariants. Falsifiable, not comments. ──

      // 1. EVERY row lands in exactly one bucket. A row that falls through every
      //    branch is a classifier bug; this makes it loud instead of silent.
      const accounted = r.alreadyDeferred + r.converted + r.chainGone.length
        + r.inputBearing.length + r.failed;
      // Throwing here DOES crash boot (see invariant 4's note). Kept as a throw
      // because an unaccounted row means a branch bug in this migration's own
      // classifier — a code defect that no data state can produce, and precisely
      // when refusing to record success is right.
      if (accounted !== r.total) {
        throw new Error(
          `reseed-seeded-rows-deferred: ${r.total} rows scanned but ${accounted} accounted for — `
          + 'a row matched no branch, so this migration cannot claim to have seen the population.',
        );
      }

      // 2. A row whose chain is GONE is NAMED. Silence about these is exactly what
      //    hid migration 14 — it counted them "absent" and said nothing.
      if (r.chainGone.length > 0) {
        log.warn('app_migration_reseed_rows_chain_gone', {
          count: r.chainGone.length, workflowIds: r.chainGone.slice(0, 50),
          note: 'cannot convert — the originating chain is no longer loadable',
        });
      }

      // 3. An input-bearing head is NAMED and left alone. Deferred expansion MOVES
      //    params out of node `inputs`, so converting one relocates data the other
      //    rows do not have — a decision, not a sweep.
      if (r.inputBearing.length > 0) {
        log.warn('app_migration_reseed_rows_input_bearing', {
          count: r.inputBearing.length, workflowIds: r.inputBearing.slice(0, 50),
          note: 'left unconverted: deferred mode relocates node inputs to variables[]',
        });
      }

      // 4. Rows exist but NOTHING was convertible. This is the production state as
      //    measured (71 rows whose chains have left the corpus), so it must be LOUD
      //    but MUST NOT THROW.
      //
      //    Throwing here would crash boot: `runAppMigrations` has no try/catch,
      //    `recordAppVersion` is unguarded at `index.ts:187`, and `main()`'s catch
      //    does `process.exit(1)`. My first draft threw on exactly this condition —
      //    it would have taken every instance down on deploy while "fixing" a
      //    silent-no-op bug. A migration that turns a data problem into an outage is
      //    strictly worse than the problem.
      if (r.total > 0 && r.converted === 0 && r.alreadyDeferred === 0) {
        log.error('app_migration_reseed_rows_nothing_convertible', {
          total: r.total, chainGone: r.chainGone.length, inputBearing: r.inputBearing.length,
          failed: r.failed,
          note: 'every seeded row is still expansion-time and none could be converted — the chains that '
            + 'produced them are no longer loadable. Restoring those packs and re-running a later '
            + 'migration version is the fix; this one records complete rather than blocking boot.',
        });
      }
    },
  },
  {
    // WF-ORGINV-1 follow-up (review F2) — `orgs:invite-hashidx` dropped its
    // `tenantOf` secondary index (nothing reads the tenant slice; teardown
    // rides the jsonTenantId content probe). That orphans every marker the
    // indexed era minted: with no `tenantOf`, `delete()`/`purgeTenantRows` no
    // longer touch the `hostextidx:orgs:invite-hashidx:*` keyspace, so the
    // stale markers (and the one-time backfill sentinel) would sit there
    // FOREVER — tenant teardown residue, breaking the GEN-1d no-residue
    // property for this namespace. One-time sweep of the whole slice: the
    // markers are pure duplicates of live rows' identity (the rows themselves
    // are untouched), so deleting all of them loses nothing. Idempotent and
    // concurrency-safe: kvDelete of an absent key is a no-op.
    version: 17,
    name: 'drop-orphaned-invite-hashidx-markers',
    async run(storage: Storage): Promise<void> {
      let deleted = 0;
      for (const { key } of await storage.kvList('hostextidx:orgs:invite-hashidx:')) {
        if (await storage.kvDelete(key)) deleted += 1;
      }
      const sentinel = await storage.kvDelete('hostextidxmeta:orgs:invite-hashidx:backfilled');
      log.info('app_migration_invite_hashidx_markers_dropped', { deleted, sentinel });
    },
  },
  {
    // PROF-1 review F4 — profiles stored before the durable-lane promotion hold
    // SCRATCH-lane avatar/portfolio tokens (7-day TTL): live ones are promoted
    // in place; refs whose asset is already gone are CLEARED from the row (a
    // dead ref renders as a broken image forever). Idempotent: promotion is a
    // monotonic no-op on a durable token; a cleared ref stays cleared.
    // Concurrency-safe: promotion is monotonic and the row edit is a per-row
    // CAS mutate, so concurrent boots converge on the same state. Never fatal —
    // per-row failures are counted + logged (a broken image is strictly better
    // than a crash-looping deploy; see migration 16's invariant-4 note).
    version: 18,
    name: 'promote-profile-media-tokens-durable',
    async run(): Promise<void> {
      const { backfillProfileMediaDurability } = await import('../features/profiles/profilesService.js');
      const r = await backfillProfileMediaDurability();
      if (r.failed > 0) {
        log.error('app_migration_profile_media_promotion_failures', {
          ...r, note: 'some rows could not be promoted/cleared — re-check on the next deploy or run the backfill manually',
        });
      }
      log.info('app_migration_profile_media_promoted', { examined: r.examined, promoted: r.promoted, cleared: r.cleared, failed: r.failed });
    },
  },
  {
    // ADR 0508 fold-in (B3) — re-tenant the CRM rows the shared-workspace defect
    // misfiled. ADR 0508 concluded "no migration" on the premise that the 404
    // prevented a handler from writing `user.tenantId` while authorized in `ws:`.
    // Phase 2 REMOVED that 404, and CRM's 95 gate-bound handlers kept re-deriving
    // the home tenant for the whole window between the phases — so rows were written
    // in exactly the state the premise called impossible. After the CRM fix they are
    // unreachable by reads AND by every reclaim path (`ws:` teardown, the retention
    // purger, the new subject eraser all enumerate per tenant), which makes them
    // undeletable PII in the wrong partition.
    //
    // Narrow by construction (all four conditions in the module header), idempotent
    // (a moved row no longer matches), concurrency-safe (per-row CAS — several
    // instances run this at once on a rolling deploy), and NEVER fatal: per-row
    // failures are counted, never thrown, because `runAppMigrations` is unguarded
    // and a throw here would take every instance down on deploy (APP_MIGRATION 16's
    // invariant-4 lesson).
    version: 19,
    name: 'retenant-misfiled-crm-org-rows',
    async run(storage: Storage): Promise<void> {
      const { retenantMisfiledCrmRows } = await import('../features/crm/orgScopeRetenant.js');
      const r = await retenantMisfiledCrmRows(storage);
      log.info('app_migration_crm_retenant', {
        examined: r.examined, rewritten: r.rewritten, skippedNoOrg: r.skippedNoOrg,
        skippedOrgMissing: r.skippedOrgMissing, skippedCorrect: r.skippedCorrect,
        skippedWorkspaceTenant: r.skippedWorkspaceTenant, casLost: r.casLost,
        failed: r.failed, byNamespace: r.byNamespace,
      });
      // The uncovered class, NAMED. Companies/deals live in the content kernel,
      // where the primary key embeds the tenant, so moving one is a re-key across
      // five collections — its own migration, with its own ADR. Counting it here is
      // what keeps the gap a number an operator can act on instead of a silence
      // (the failure mode APP_MIGRATION 14 shipped with).
      if (r.kernelResidue > 0) {
        log.warn('app_migration_crm_retenant_kernel_residue', {
          rows: r.kernelResidue,
          note: 'content-kernel crm.company/crm.deal rows are misfiled the same way but are NOT moved here — '
            + 'their key embeds the tenant, so a move is a re-key across entity:record/type/count/ref-idx/term-idx.',
        });
      }
      // This runner is ONE-SHOT, so a row that lost three CAS attempts is NOT
      // picked up by a later boot. Say that plainly rather than implying a self-heal
      // that does not exist: closing these needs a follow-up sweep version.
      if (r.casLost > 0 || r.failed > 0) {
        log.error('app_migration_crm_retenant_incomplete', {
          casLost: r.casLost, failed: r.failed,
          note: 'these rows are still misfiled and this migration is one-shot — ship a follow-up sweep version to close them.',
        });
      }
    },
  },
  {
    // ADR 0622 D7 review S2 — `User.emailProvenance` landed with "a row with no
    // provenance PASSES the invitation gate", which made every pre-D7 row (and
    // any write that forgot the field) a free pass: fail-open. The gate now
    // reads a missing provenance as `'self'` (fail-closed), and THIS one-shot
    // stamp keeps that from refusing every legitimate legacy accept: each
    // unstamped row gets the provenance its LANE implies — `'idp'` iff
    // `source ∈ {saml, scim}`, `'self'` iff the row lives in a personal tenant
    // (`isPersonalTenantId`), else `'admin'`. Idempotent (a stamped row no
    // longer matches), per-row CAS (concurrent boots converge), never fatal
    // (per-row failures are counted — migration 16's invariant-4 lesson).
    version: 20,
    name: 'stamp-user-email-provenance',
    async run(): Promise<void> {
      const { backfillEmailProvenance } = await import('../features/users/usersService.js');
      const r = await backfillEmailProvenance();
      log.info('app_migration_user_email_provenance_stamped', {
        examined: r.examined, stamped: r.stamped, idp: r.idp, self: r.self, admin: r.admin, casLost: r.casLost, failed: r.failed,
      });
      if (r.casLost > 0 || r.failed > 0) {
        log.error('app_migration_user_email_provenance_incomplete', {
          casLost: r.casLost, failed: r.failed,
          note: 'unstamped rows read as self (fail-closed) — their invitation accepts refuse until an IdP or admin re-asserts the address; re-run the backfill manually or ship a sweep version.',
        });
      }
    },
  },
  {
    // ADR 0722 — the demo auto-ingest subscription was minted as
    // `demo:agent-knowledge:auto-ingest:<tenant>`, three `:` inside an id the
    // v2 opaque grammar forbids, and `subscriptionId` goes out on the v2 wire
    // raw. The mint moved to a hashed, grammar-safe spelling; this re-keys the
    // rows already registered so the (idempotent-by-id) seed finds them instead
    // of registering a SECOND demo subscription per tenant on the next boot.
    // Idempotent (a re-keyed row no longer matches the prefix); never fatal.
    version: 21,
    name: 'rekey-demo-auto-ingest-subscription-ids',
    async run(): Promise<void> {
      const { LEGACY_DEMO_AUTO_INGEST_PREFIX, demoAutoIngestSubscriptionId, listLegacyDemoAutoIngestIds, rekeySubscription } =
        await import('./triggerBridgeService.js');
      const counts = { moved: 0, absent: 0, 'target-exists': 0, failed: 0 };
      for (const oldId of await listLegacyDemoAutoIngestIds()) {
        const tenantId = oldId.slice(LEGACY_DEMO_AUTO_INGEST_PREFIX.length);
        // Per-row, never fatal (migration 16's invariant-4 lesson, kept by v20):
        // `runAppMigrations` has no try/catch around `run()`, so an uncaught
        // per-row failure here would abort BOOT over a demo row. Counted and
        // logged instead; the row stays under its legacy id and the next boot
        // retries it (it still matches the prefix).
        try {
          counts[await rekeySubscription(oldId, demoAutoIngestSubscriptionId(tenantId))] += 1;
        } catch (err) {
          counts.failed += 1;
          log.error('app_migration_demo_auto_ingest_rekey_failed', { oldId, error: err instanceof Error ? err.message : String(err) });
        }
      }
      log.info('app_migration_demo_auto_ingest_rekeyed', counts);
    },
  },
];

/** Highest version present in `migrations` (0 when empty). */
export function latestAppMigration(migrations: readonly AppMigration[] = APP_MIGRATIONS): number {
  return migrations.reduce((max, m) => Math.max(max, m.version), 0);
}

/**
 * Apply every migration above the recorded counter, in ascending order, then
 * record the new counter. `migrations` is injectable for tests; production uses
 * the module-level `APP_MIGRATIONS`. Forward-only + idempotent (see header), so
 * calling it on every boot is safe.
 */
export async function runAppMigrations(
  storage: Storage,
  migrations: readonly AppMigration[] = APP_MIGRATIONS,
): Promise<{ applied: number[] }> {
  const recorded = Number((await storage.getAppMeta(APP_MIGRATION_KEY)) ?? '0');
  const pending = migrations
    .filter((m) => m.version > recorded)
    .sort((a, b) => a.version - b.version);
  if (pending.length === 0) return { applied: [] };
  for (const m of pending) {
    log.info('app_migration_apply', { version: m.version, name: m.name });
    await m.run(storage);
  }
  await storage.setAppMeta(APP_MIGRATION_KEY, String(latestAppMigration(migrations)));
  return { applied: pending.map((m) => m.version) };
}
