/**
 * Zero-config workflow seed (2026-07-16).
 *
 * The demo's owned dashboard workflows used to be created ONLY by a silent
 * frontend effect (`preloadZeroConfigTemplates`) that POSTed `/workflows/from-chain`
 * — which mints a RANDOM `workflowId` per call and was guarded only by a
 * per-browser localStorage flag. Every new browser / incognito / cleared
 * storage / rotated anon tenant therefore re-created the whole set under fresh
 * ids, producing "X, X-2, X-3" duplicates the server never deduped.
 *
 * That preload is deleted; workflow seeding now lives HERE, in the demo seeder
 * that owns every other demo surface — and it is IDEMPOTENT by construction:
 *
 *   - the `workflowId` is DETERMINISTIC (`wf.seed.<slug(chainId)>`), so
 *     `recordOwnership`'s `${tenantId}:${workflowId}` upsert dedups a re-seed;
 *   - the NAME is the chain's own label (NOT `uniqueOwnedName`), so re-seeding
 *     never mints "-2/-3";
 *   - a shared global registry def per deterministic id (the `workflowAuthorSeed`
 *     pattern: register-if-missing, guarded by `getRegisteredWorkflow`).
 *
 * Deterministic ids also make the anon→user fold safe: `${anon}:wf.seed.x` and
 * `${real}:wf.seed.x` collide on the ownership key, so the fold's ON CONFLICT
 * DO NOTHING drops the anon copy instead of duplicating it (see reassignTenant).
 *
 * Only ZERO-CONFIG chains are seeded (no required params) — parameterized
 * templates still live in the gallery for a one-click, param-prompting "Use
 * template" (which keeps its intentional random-id fresh copy).
 */
import { listChains, expandChain, loadWorkflowChainPacks, defaultWorkflowChainPackRoots } from './workflowChainPackLoader.js';
import { registerWorkflowDurable, getRegisteredWorkflowAsync } from './workflowsRegistry.js';
import { recordRevision, HOST_REVISION_TENANT } from './workflowRevisions.js';
import type { Storage } from '../storage/storage.js';
import type { WorkflowDefinition } from '../executor/types.js';
import { recordOwnership, getOwned } from './workflowOwnership.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('seed-workflows');

/** Deterministic owned-workflow id for a seeded zero-config chain. The `seed.`
 *  infix distinguishes it from a user's random-id "Use template" copy. */
export function seedWorkflowId(chainId: string): string {
  const slug = chainId.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `wf.seed.${slug}`;
}

/** ADR 0507 — a chain carrying `x-openwop-sensitive` is the ONE input that makes
 *  deferred expansion produce different node ids than expansion-time (sensitive
 *  params are omitted from `resolvedParams`, which feeds `expansionId`). Zero
 *  shipped chains have one; this is a tripwire, not a constraint. */
function hasSensitiveParam(parameters: Record<string, unknown> | undefined): boolean {
  const props = (parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!props || typeof props !== 'object') return false;
  return Object.values(props).some(
    (spec) => spec && typeof spec === 'object' && (spec as Record<string, unknown>)['x-openwop-sensitive'] === true,
  );
}

/** A chain is zero-config iff it declares no required parameters. */
function isZeroConfig(parameters: Record<string, unknown>): boolean {
  const required = (parameters as { required?: unknown }).required;
  return !Array.isArray(required) || required.length === 0;
}

/**
 * Idempotently instantiate every installed ZERO-CONFIG chain template as an
 * owned dashboard workflow for `tenantId`. Returns the count of workflows the
 * tenant owns afterward (created + already-present). Best-effort per chain: an
 * expansion failure is logged and skipped, never fatal to the demo seed.
 */
export async function seedZeroConfigWorkflows(tenantId: string): Promise<{ seeded: number }> {
  let seeded = 0;
  for (const { chain } of listChains()) {
    // RFC 0135 — a composition-only chain is never seeded as a directly-runnable
    // owned workflow (it would re-enter the ownership index the gallery omits it from).
    // Retro note: marking a PREVIOUSLY-seeded zero-config chain internal strands the
    // wf.seed rows already-minted for existing tenants — re-seed skips, it does not
    // retract. Vacuous today (no shipped internal chain is zero-config).
    if (chain.internal === true) continue;
    if (!isZeroConfig(chain.parameters)) continue;
    const workflowId = seedWorkflowId(chain.chainId);
    try {
      // Register the shared global def once (register-if-missing — the
      // workflowAuthorSeed pattern). Zero-config expansion is pure, so every
      // tenant references an identical def under this deterministic id.
      //
      // §Correction (grade-data RI-1) — THE DURABLE READ, not the in-memory one.
      // `getRegisteredWorkflow` is a process-local Map with no boot hydration, so
      // on a fresh instance it always misses and the seeder RE-EXPANDED and
      // overwrote the global `wfreg:` row. That row is keyed by workflowId with
      // no tenant component, so one cold boot silently rewrote the definition
      // every tenant runs. Harmless while expansion output was stable — but ADR
      // 0498 added chain params, which changed `expansionId` and therefore every
      // node id for 77 of 169 chains. A prior run then replays against a
      // definition whose node ids no longer match, missing both
      // `sourceOutcomes` (⇒ `replay_source_missing`) and the invocation-log key
      // (⇒ a "deterministic replay" that live-dispatches the model).
      //
      // The async read hits durable storage and re-populates the cache, so an
      // already-seeded definition is left exactly as it is.
      let def = await getRegisteredWorkflowAsync(workflowId);
      if (!def) {
        // ADR 0507 — seed in RFC 0124 DEFERRED mode. `expandChain(chain, {})`
        // froze every param that had no default to `undefined`, and 9 of the 52
        // seeded chains carry one — the node then reaches dispatch with the value
        // simply absent. Deferred materialises them as run-overridable
        // `variables[]` instead, which `ui/RunInputsForm` already renders from,
        // and lifts inline prompt bodies into minted templates that KEEP their
        // tokens for run-time interpolation.
        //
        // Safe because node ids do not move: `expansionId` hashes
        // (chainId, version, resolvedParams), and `resolvedParams` is built
        // identically in both modes. Measured 2026-08-01 — byte-identical node ids
        // for 169/169 loaded chains. The only input that WOULD fork them is a
        // sensitive param (deferred skips those from `resolvedParams`), which the
        // guard below refuses rather than silently forking a globally-shared row.
        if (hasSensitiveParam(chain.parameters)) {
          log.warn('seed skipped: chain declares an x-openwop-sensitive param', {
            chainId: chain.chainId,
            reason: 'deferred expansion omits sensitive params from resolvedParams, which would fork expansionId (and therefore every node id) for a definition every tenant shares',
          });
          continue;
        }
        const expanded = expandChain(chain, { deferred: true });
        const name = (typeof expanded.metadata?.name === 'string' && expanded.metadata.name.trim())
          ? expanded.metadata.name : chain.label;
        def = { ...expanded, workflowId, metadata: { ...expanded.metadata, name } };
        // AWAIT the durable write: the whole point of the async read above is
        // "seeded once, never rewritten", and a fire-and-forget write that loses
        // a race leaves the next cold boot re-expanding — the exact path being
        // closed. `registerWorkflowDurable` is the existing awaited variant.
        await registerWorkflowDurable(def);
        // §Correction (grade-data RI-1b) — pin a resolvable revision, matching
        // the `from-chain` lane. Runs stamp `metadata.definitionRevision`, but
        // with no revision row `resolveRunDefinition` falls through to HEAD — so
        // a replay silently resolves whatever the definition is NOW rather than
        // what the run actually executed. Content-addressed and idempotent, so
        // every tenant seeding the same global def yields one row.
        await recordRevision(tenantId, def).catch(() => undefined);
      }
      // Per-tenant ownership: deterministic key ⇒ a re-seed upserts the SAME
      // row (no dup), and the fold collides instead of duplicating.
      const name = (typeof def.metadata?.name === 'string' && def.metadata.name) ? def.metadata.name : chain.label;
      const already = await getOwned(tenantId, workflowId);
      await recordOwnership(tenantId, workflowId, { name, nodeCount: def.nodes.length });
      if (!already) seeded += 1;
    } catch (err) {
      log.warn('seed_workflow_skipped', { tenantId, chainId: chain.chainId, error: String(err) });
    }
  }
  return { seeded };
}

/**
 * ADR 0507 — re-expand the already-persisted seeded definitions in deferred mode.
 *
 * Invoked ONCE by `APP_MIGRATIONS` v14, never from the boot path. The seeder is
 * register-if-missing, so without this every existing install keeps definitions
 * whose params froze to `undefined` — and since the `wfreg:` row is global (no
 * tenant component), tenants seeding later inherit the broken one from cache.
 *
 * Idempotent by construction: a definition already carrying
 * `metadata.expansionMode === 'deferred'` is left untouched, so a re-run (or a
 * host that already migrated) is a no-op rather than a rewrite. Ownership rows
 * are NOT touched — this rewrites the shared definition only.
 */
export async function reseedChainWorkflowsDeferred(): Promise<{ examined: number; rewritten: number; skippedSensitive: number; absent: number; failed: number }> {
  // SESS-1 (/grade-code) — `failed` exists because the first version of this result
  // could NOT express failure. Per-chain errors were swallowed into `log.warn` and
  // none of the counters moved, so a migration where every chain threw reported
  // `rewritten: 0` and looked like a clean no-op. Shipping a result object blind to
  // its own failures, in a change about failures nobody can see, was the one thing
  // this work had no excuse for. The caller logs all five and the invariant below
  // makes a silent loss impossible.
  let examined = 0, rewritten = 0, skippedSensitive = 0, absent = 0, failed = 0;
  // ORDERING TRAP — `runAppMigrations` fires at `index.ts:186`; the chain registry
  // is not populated until `loadWorkflowChainPacks` at `index.ts:427`. Iterating
  // `listChains()` without this would examine ZERO chains, rewrite nothing, and
  // still record migration 14 as complete — a one-shot migration that silently
  // never runs. Caught before shipping; `reseed-migration-not-vacuous.test.ts`
  // pins it, because the failure is invisible by construction (it looks like
  // success).
  if (listChains().length === 0) {
    loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  }
  for (const { chain } of listChains()) {
    if (chain.internal === true) continue;
    if (!isZeroConfig(chain.parameters)) continue;
    examined += 1;
    const workflowId = seedWorkflowId(chain.chainId);
    try {
      const existing = await getRegisteredWorkflowAsync(workflowId);
      // Never MINT here. A definition that was never seeded on this install is
      // the seeder's job on next tenant seed; creating it now would seed rows for
      // chains this host may never have offered.
      if (!existing) { absent += 1; continue; }
      if ((existing.metadata as { expansionMode?: unknown } | undefined)?.expansionMode === 'deferred') continue;
      if (hasSensitiveParam(chain.parameters)) { skippedSensitive += 1; continue; }
      const expanded = expandChain(chain, { deferred: true });
      const name = (typeof existing.metadata?.name === 'string' && existing.metadata.name.trim())
        ? existing.metadata.name
        : (typeof expanded.metadata?.name === 'string' && expanded.metadata.name.trim() ? expanded.metadata.name : chain.label);
      const def = { ...expanded, workflowId, metadata: { ...expanded.metadata, name } };
      await registerWorkflowDurable(def);
      // Record a revision for the NEW shape so a run created after this migration
      // pins something resolvable. The OLD revision rows are content-addressed and
      // are never deleted, so runs that pinned them still resolve their own.
      //
      // `'host'` is the established host-level tenant sentinel (see
      // `webhookSecretCodec.ts` — no real tenant id is `'host'`). Correct here
      // because the row it annotates is GLOBAL: the revision key is
      // `keyOf(workflowId, hash)` with no tenant component, and `tenantId` is
      // provenance only. The seeder passes whichever tenant happened to seed
      // first, which is arbitrary; a migration has no tenant at all, so naming
      // that explicitly beats borrowing one.
      await recordRevision(HOST_REVISION_TENANT, def).catch(() => undefined);
      rewritten += 1;
    } catch (err) {
      failed += 1;
      log.warn('reseed_deferred_skipped', { chainId: chain.chainId, error: String(err) });
    }
  }
  return { examined, rewritten, skippedSensitive, absent, failed };
}

/** Result of the ROW-DRIVEN deferred conversion (PHBC-5). Every stored seed row
 *  lands in exactly one bucket, and the caller asserts that — see `reseedSeededRowsDeferred`. */
export interface RowReseedResult {
  total: number;
  alreadyDeferred: number;
  converted: number;
  chainGone: string[];
  inputBearing: string[];
  failed: number;
}

/**
 * PHBC-5 — convert seeded definitions to deferred mode by iterating the STORED
 * ROWS, not the chain corpus.
 *
 * WHY THIS EXISTS RATHER THAN A SECOND ATTEMPT AT MIGRATION 14. Migration 14
 * iterates `listChains()` and looks up a DERIVED id (`seedWorkflowId(chainId)`),
 * so a stored definition whose originating chain has LEFT the corpus is invisible
 * to it. Measured in production: 71 rows written 2026-07-28, migration ran
 * 2026-08-01 and logged `{examined: 52, absent: 52, rewritten: 0}` — the rows
 * existed and it reported every one absent, then recorded itself complete. Being
 * one-shot, it never looked again, and all 71 are still `expansion-time`: the mode
 * ADR 0507 exists to eliminate because it freezes params with no default to
 * `undefined` and the node reaches dispatch with the value simply absent.
 *
 * THE FATAL PROPERTY WAS NOT "ONE-SHOT" — it was that its no-op outcome was
 * INDISTINGUISHABLE from the legitimate fresh-install outcome. `{examined: 52,
 * absent: 52, rewritten: 0}` is CORRECT on a fresh install and catastrophic on a
 * populated one, and nothing could tell them apart. Deriving the population from
 * the ROWS makes them distinguishable: a fresh install has `total === 0`.
 *
 * Uses `kvList` (the same read-through prefix scan every host-ext collection uses)
 * and `kvCompareAndSwap` — the documented atomic building block for read-modify-
 * write surfaces that must stay correct across instances, which plain
 * `registerWorkflowDurable` (a blind `kvSet`) is not.
 */
export async function reseedSeededRowsDeferred(storage: Storage): Promise<RowReseedResult> {
  // Same ordering trap migration 14 documents: `runAppMigrations` fires long
  // before `loadWorkflowChainPacks`, so self-load or every chain reads as gone.
  if (listChains().length === 0) {
    loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  }
  const byChainId = new Map(listChains().map(({ chain }) => [seedWorkflowId(chain.chainId), chain]));

  // `kvList('wfreg:')` returns EVERY registered workflow, including tenant-authored
  // ones. Filter to the seeded namespace: sweeping a hand-authored workflow into a
  // "seeded" conversion would rewrite work this migration was never asked to touch.
  const SEED_PREFIX = 'wfreg:wf.seed.';
  const rows = (await storage.kvList('wfreg:')).filter((r) => r.key.startsWith(SEED_PREFIX));

  const out: RowReseedResult = {
    total: rows.length, alreadyDeferred: 0, converted: 0, chainGone: [], inputBearing: [], failed: 0,
  };

  for (const row of rows) {
    const workflowId = row.key.slice('wfreg:'.length);
    try {
      const existing = JSON.parse(row.value) as WorkflowDefinition;
      const mode = (existing.metadata as { expansionMode?: unknown } | undefined)?.expansionMode;
      if (mode === 'deferred') { out.alreadyDeferred += 1; continue; }

      // CLASSIFY THE ROW BEFORE ASKING THE CORPUS. Whether a head carries node
      // `inputs` is a property of the stored row; making that verdict depend on
      // whether its chain still loads would reintroduce the corpus-driven blind
      // spot this migration exists to remove — an input-bearing row would be
      // reported as merely "chain gone" and its real hazard hidden.
      //
      // That hazard: deferred expansion MOVES params out of node `inputs` into
      // top-level `variables[]`, and `tokenSubstitution` resolves `{{inputs.*}}`
      // from node inputs at run time. Converting one relocates data the other rows
      // do not have — a decision, not a sweep.
      if ((existing.nodes ?? []).some((n) => n.inputs && Object.keys(n.inputs).length > 0)) {
        out.inputBearing.push(workflowId);
        continue;
      }

      const chain = byChainId.get(workflowId);
      // REPORT, never silently skip. A chain that has left the corpus is exactly
      // what made migration 14 invisible; naming the ids is the whole point.
      if (!chain) { out.chainGone.push(workflowId); continue; }

      const expanded = expandChain(chain, { deferred: true });
      const name = (typeof existing.metadata?.name === 'string' && existing.metadata.name.trim())
        ? existing.metadata.name
        : (typeof expanded.metadata?.name === 'string' && expanded.metadata.name.trim() ? expanded.metadata.name : chain.label);
      const def = { ...expanded, workflowId, metadata: { ...expanded.metadata, name } };

      // CAS against the exact bytes we classified. If another instance rewrote the
      // row between the scan and here, we lose the race and skip rather than
      // clobbering a definition every tenant runs — the incident ADR 0507 cites.
      const swap = await storage.kvCompareAndSwap(row.key, row.value, JSON.stringify(def));
      if (!swap.swapped) { out.failed += 1; log.warn('reseed_rows_cas_lost', { workflowId }); continue; }
      await recordRevision(HOST_REVISION_TENANT, def).catch(() => undefined);
      out.converted += 1;
    } catch (err) {
      out.failed += 1;
      log.warn('reseed_rows_failed', { workflowId, error: String(err) });
    }
  }
  return out;
}

/**
 * ADR 0498 DATA-1 — rewrite already-seeded definitions that still carry the
 * retired `core.openwop.integration.notification-push` node.
 *
 * WHY A REWRITE IS NEEDED AT ALL. `seedWorkflows` is "seeded once, never
 * rewritten", so a tenant that seeded before the retarget keeps a definition whose
 * notify node requires a `deviceToken` no chain author can supply — it POSTs
 * `to: undefined`, errors, and reports `status:'success'` with `sent:false`. The
 * pack fix reaches new instantiations only.
 *
 * WHY IT IS SURGICAL RATHER THAN A RE-EXPANSION. The first cut of this migration
 * re-expanded the chain and replaced the whole definition, which forced a per-run
 * guard: `deterministicExpansionId` hashes `chainId@VERSION:params`, the retarget
 * bumped all 23 packs (`support.kb-answer` 1.0.4 → 1.0.5 moves the node prefix
 * `157849946cdb` → `8f254cf75b30`), so EVERY node id changed and any run
 * resolving HEAD would find no matching checkpoints — the #2671 hazard. Two
 * independent reviews killed that design:
 *
 *   - the guard stranded exactly the tenants who use these workflows most, and
 *   - a wholesale replacement REVERTS tenant edits. These `wf.seed.*` rows are
 *     tenant-owned and builder-editable (`recordOwnership`), and rebuilding from
 *     the pack drops everything in `metadata` — `requiresAgentId` ("erasing it
 *     silently stops enforcement"), `retention.ttlDays`, `lifecycle`, the
 *     walkthrough/tour binding. That is data loss, not incomplete coverage.
 *
 * The retarget was PURELY NODE-LOCAL (verified against 91e398f52^: same node id,
 * same position, same edges; only `typeId`/`config`/`inputs` moved), so the
 * migration copies exactly those three fields onto the existing node and touches
 * nothing else. Node ids are therefore PRESERVED — `hydrateSnapshot` overlays
 * checkpoints by node id, so finished work is untouched and no run guard is
 * needed at all. Every affected install is repaired, not just the quiet ones.
 *
 * WHAT IT STILL DOES NOT REACH. A run that pinned `definitionRevision` resolves
 * its own content-addressed row and keeps the old node forever; this fixes HEAD,
 * and therefore new runs, unpinned resumes, and branch forks. It also only covers
 * `wf.seed.*` rows — the 42 parameterized notify-carrying chains reach tenants as
 * `wf.<slug>.<uuid>` copies via `from-chain` and are tracked separately (`GRD-9`).
 *
 * Idempotent: after a rewrite the old typeId is gone, so a second pass finds
 * nothing to do. Every outcome is counted — a result object blind to its own
 * failures is exactly the defect this program exists to remove.
 */
const RETIRED_NOTIFY_TYPE = 'core.openwop.integration.notification-push';
const NOTIFY_TYPE = 'feature.notifications.nodes.notify';

/** A `{{token}}` or a structured ref in a replacement's config/inputs. Those are
 *  `expansionId`-derived (the deferred variable prefix, minted template ids), so
 *  copying one into a definition carrying the OLD prefix would dangle silently. */
/** The three fields the retarget moved — the only fields this migration copies. */
interface NotifyReplacement {
  config?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
}

function carriesRef(value: unknown): boolean {
  if (typeof value === 'string') {
    // A `{{token}}`, or a minted PromptTemplate id — `chainmint-${expansionId}-…`
    // (`workflowChainPackLoader.ts:966`), which is expansion-scoped despite
    // containing no braces.
    return value.includes('{{') || value.startsWith('chainmint-');
  }
  if (Array.isArray(value)) return value.some(carriesRef);
  if (value && typeof value === 'object') {
    // Deferred expansion emits STRUCTURED refs — `{type:'variable',variableName}`
    // (`:939`) — whose variable prefix is `expansionId`-derived. A brace-only
    // check returned false for these, so the guard would have copied one onto a
    // definition carrying the OLD prefix: a silently dangling ref, which is the
    // exact failure this function exists to prevent. Caught by the grade pass;
    // unreachable today (all 55 replacements are literal), which is precisely
    // why it needed a test rather than a measurement.
    if ((value as { type?: unknown }).type === 'variable') return true;
    return Object.values(value).some(carriesRef);
  }
  return false;
}

export interface NotifyRetargetResult extends Record<string, unknown> {
  examined: number;
  rewritten: number;
  /** No node in the fresh expansion matched the persisted node's pack id. */
  skippedUnmatchedNode: number;
  /** The authored replacement carries a token/ref that is expansion-scoped. */
  skippedRefBearingReplacement: number;
  /** The row changed under us between the read and the write. */
  skippedConcurrentEdit: number;
  absent: number;
  alreadyClean: number;
  /** Rewritten, but its revision row failed to record. */
  revisionRecordFailed: number;
  failed: number;
}

/**
 * Strip `${chainId_underscored}_${expansionId}_` off a persisted node id to
 * recover the id the PACK authored.
 *
 * Reconstructed from the row's own `metadata`, not guessed by suffix matching:
 * `expandChain` records `chainId` + `expansionId` (`workflowChainPackLoader.ts:1187`)
 * and builds the prefix at `:894-895`. Suffix matching would collide (`notify` vs
 * `xnotify`) and would silently mis-attribute a node from a renamed pack.
 */
function packNodeId(persistedNodeId: string, meta: Record<string, unknown> | undefined): string | null {
  const chainId = typeof meta?.chainId === 'string' ? meta.chainId : null;
  const expansionId = typeof meta?.expansionId === 'string' ? meta.expansionId : null;
  if (!chainId || !expansionId) return null;
  const prefix = `${chainId.replace(/\./g, '_')}_${expansionId}_`;
  return persistedNodeId.startsWith(prefix) ? persistedNodeId.slice(prefix.length) : null;
}

export async function retargetSeededNotifyNodes(_storage: Storage): Promise<NotifyRetargetResult> {
  const out: NotifyRetargetResult = {
    examined: 0, rewritten: 0, skippedUnmatchedNode: 0, skippedRefBearingReplacement: 0,
    skippedConcurrentEdit: 0, absent: 0, alreadyClean: 0, revisionRecordFailed: 0, failed: 0,
  };
  // Same ORDERING TRAP as migration 14: `runAppMigrations` fires before
  // `loadWorkflowChainPacks`, so without this `listChains()` is empty and the
  // migration records itself complete having examined nothing.
  if (listChains().length === 0) {
    loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  }
  for (const { chain } of listChains()) {
    // Match the seeder's own population (`seedZeroConfigWorkflows`): only
    // zero-config, non-internal chains are ever seeded, so anything else could
    // not have a `wf.seed.*` row to repair.
    if (chain.internal === true || !isZeroConfig(chain.parameters ?? {})) continue;
    out.examined += 1;
    const workflowId = seedWorkflowId(chain.chainId);
    try {
      const existing = await getRegisteredWorkflowAsync(workflowId);
      // Never MINT — a chain never seeded on this install is the seeder's job.
      if (!existing) { out.absent += 1; continue; }
      const stale = (existing.nodes ?? []).filter(
        (n) => (n as { typeId?: string }).typeId === RETIRED_NOTIFY_TYPE,
      );
      if (stale.length === 0) { out.alreadyClean += 1; continue; }

      // Read the AUTHORED replacement out of a fresh expansion — the pack is the
      // source of truth for `config`/`inputs`, not this migration.
      const fresh = expandChain(chain, { deferred: true });
      const replacements = new Map<string, NotifyReplacement>();
      for (const node of fresh.nodes ?? []) {
        if (node.typeId !== NOTIFY_TYPE) continue;
        const bare = packNodeId(node.nodeId, fresh.metadata);
        if (bare) replacements.set(bare, { config: node.config, inputs: node.inputs });
      }

      const meta = existing.metadata;
      let unmatched = false;
      let refBearing = false;
      for (const node of stale) {
        const bare = packNodeId(node.nodeId, meta);
        const replacement = bare ? replacements.get(bare) : undefined;
        if (!replacement) { unmatched = true; break; }
        if (carriesRef(replacement.config) || carriesRef(replacement.inputs)) { refBearing = true; break; }
      }
      if (unmatched) { out.skippedUnmatchedNode += 1; continue; }
      if (refBearing) { out.skippedRefBearingReplacement += 1; continue; }

      // THE SURGICAL EDIT. Only the retired node's `typeId`/`config`/`inputs`
      // change. Node ids, edges, positions, every other node, and ALL metadata are
      // preserved — these `wf.seed.*` rows are tenant-owned and builder-editable
      // (`recordOwnership` above), so a wholesale re-expansion would revert a
      // tenant's edits and drop the metadata `definitionMetadata.ts` depends on
      // (`requiresAgentId`, `retention.ttlDays`, `lifecycle`, …).
      //
      // Preserving node ids is also what makes this replay-safe WITHOUT a run
      // guard: `hydrateSnapshot` overlays checkpoints BY NODE ID, so a completed
      // node is never re-entered and the type change is inert for finished work.
      // A run parked at the node resumes onto the FIXED node — the documented
      // point of a branch fork — and a `replay` fork serves the recorded outcome
      // because the node is now ADR 0341-classified (`executor/sideEffects.ts`).
      //
      // RE-READ IMMEDIATELY BEFORE THE WRITE, and build from the LATEST copy.
      // `wfreg:` is a host-global row with no CAS, and the real racer is the
      // builder's REST autosave (`routes/workflows.ts:185` deliberately permits a
      // tenant to save its own `wf.seed.*`), NOT the collab room: a previous cut
      // guarded on `workflowRoomLive`, which the grade pass proved VACUOUS —
      // `workflowCollabResource.ts:45` refuses `^wf\.seed\.` outright, so no room
      // can ever exist for these ids and the branch was unreachable outside its
      // own mock. Rebasing on the re-read narrows the window to the two awaits
      // below and PRESERVES a concurrent save instead of clobbering it.
      const latest = await getRegisteredWorkflowAsync(workflowId);
      if (!latest || !(latest.nodes ?? []).some((n) => n.typeId === RETIRED_NOTIFY_TYPE)) {
        out.skippedConcurrentEdit += 1;
        continue;
      }
      const def: WorkflowDefinition = {
        ...latest,
        nodes: (latest.nodes ?? []).map((node) => {
          if (node.typeId !== RETIRED_NOTIFY_TYPE) return node;
          const bare = packNodeId(node.nodeId, latest.metadata ?? meta);
          const replacement = bare ? replacements.get(bare) : undefined;
          return {
            ...node,
            typeId: NOTIFY_TYPE,
            ...(replacement?.config ? { config: replacement.config } : {}),
            ...(replacement?.inputs ? { inputs: replacement.inputs } : {}),
          };
        }),
      };
      await registerWorkflowDurable(def);
      // `recordRevision` NEVER rejects — it catches internally and returns null
      // (`workflowRevisions.ts:161`). The old `.catch(() => undefined)` here was
      // dead code that also discarded the only failure signal, counting a
      // failed record as a clean rewrite.
      const revision = await recordRevision(HOST_REVISION_TENANT, def);
      if (!revision) out.revisionRecordFailed += 1;
      out.rewritten += 1;
    } catch (err) {
      out.failed += 1;
      log.warn('notify_retarget_skipped', { chainId: chain.chainId, error: String(err) });
    }
  }
  if (out.skippedUnmatchedNode > 0) {
    // Not benign. `defaultWorkflowChainPackRoots()` puts `~/.openwop-packs` AHEAD
    // of `examples/`, first-root-wins, and a shadow is logged rather than raised.
    // A host with an older installed `core.openwop.workflows.*` therefore expands
    // the STALE chain, finds no replacement, sends every chain down this path —
    // and the migration still records itself complete, permanently. Prod is not
    // exposed (its pin list covers node packs only; the chain packs are vendored
    // in the image), but a self-hosted install is. Loud, because the counter alone
    // reads as a clean run.
    log.warn('notify_retarget_unmatched', {
      count: out.skippedUnmatchedNode,
      hint: 'a stale installed chain pack may be shadowing the vendored copy — compare ~/.openwop-packs versions against examples/workflow-chain-packs',
    });
  }
  return out;
}
