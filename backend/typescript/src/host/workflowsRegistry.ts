/**
 * Workflow registry consulted by the workflowCatalog after the hardcoded
 * sample workflows. Populated by clients via
 * `POST /v1/host/openwop-app/workflows` — the builder UI calls this just
 * before dispatching a run so the catalog can resolve the workflowId.
 *
 * DURABILITY (ENG-3): the in-memory Map is now a write-through CACHE in front
 * of the kv Storage. `registerWorkflow` persists to storage as well, and the
 * catalog's async resolver (`getRegisteredWorkflowAsync`) falls back to a
 * storage read on a cache miss. This is what lets the dispatch sweeper recover
 * a crashed run on ANOTHER instance: previously the workflow id registered on
 * instance A was invisible to instance B (process-local Map), so the sweeper
 * "abandoned orphans whose workflow id no longer resolves". When storage isn't
 * wired (a unit test without host-ext init) it degrades to in-memory-only.
 */

import type { WorkflowDefinition } from '../executor/types.js';
import { catalogVisible, type CatalogVisibilityOpts } from './workflowLifecycle.js';
import { tryDurableStorage } from './durable/durableStore.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.workflowsRegistry');

/** In-process write-through cache. */
const registry = new Map<string, WorkflowDefinition>();

const KEY_PREFIX = 'wfreg:';
const key = (workflowId: string): string => `${KEY_PREFIX}${workflowId}`;

/** ADR 0473 (grade-data D5) — `registerWorkflow` with the durable write
 *  AWAITED. The propose path persists ownership + the approval hold durably;
 *  a fire-and-forget def write losing the race would leave a pending approval
 *  over a draft other instances can't resolve. Callers that need the
 *  cache-first fast path keep `registerWorkflow`. */
export async function registerWorkflowDurable(def: WorkflowDefinition): Promise<void> {
  // ADR 0770 D2 — storage FIRST, cache second. The cache-first order meant a
  // failed durable write left THIS instance serving a definition no other
  // instance could resolve, behind a route that had already answered 201.
  const storage = tryDurableStorage();
  if (storage) await storage.kvSet(key(def.workflowId), JSON.stringify(def));
  registry.set(def.workflowId, def);
}

/** ADR 0770 D5 — the stored head, read FRESH (never the per-instance cache,
 *  which never expires: comparing against it would 409 a user's own save that
 *  landed on another instance). `raw` is the exact stored string, the
 *  `expected` operand of {@link registerWorkflowIfUnchanged}. Without durable
 *  storage (a unit test with no host-ext init) the cache IS the store. */
export async function readRegisteredWorkflowFresh(
  workflowId: string,
): Promise<{ raw: string | null; def: WorkflowDefinition | null }> {
  const storage = tryDurableStorage();
  if (!storage) {
    const cached = registry.get(workflowId) ?? null;
    return { raw: cached ? JSON.stringify(cached) : null, def: cached };
  }
  const raw = await storage.kvGet(key(workflowId));
  const def = raw ? (JSON.parse(raw) as WorkflowDefinition) : null;
  // grade-code WBCD-1 — a fresh read REFRESHES this instance's cache. Without
  // it the by-id read (`GET /v1/workflows/:id`, cache-first) kept serving a
  // stale definition here while the save base came from storage, and a save
  // built on that stale canvas passed the precondition and overwrote the head.
  if (def) registry.set(workflowId, def);
  else registry.delete(workflowId);
  return { raw, def };
}

/** ADR 0770 D5 — register `def` only if the stored head is still `expectedRaw`
 *  (`null` ⇒ only if absent). Atomic ACROSS instances via
 *  `Storage.kvCompareAndSwap`; the cache is refreshed only on a won swap.
 *  Returns whether the write happened. */
export async function registerWorkflowIfUnchanged(def: WorkflowDefinition, expectedRaw: string | null): Promise<boolean> {
  const storage = tryDurableStorage();
  if (!storage) {
    const cached = registry.get(def.workflowId);
    const current = cached ? JSON.stringify(cached) : null;
    if (current !== expectedRaw) return false;
    registry.set(def.workflowId, def);
    return true;
  }
  const { swapped, actual } = await storage.kvCompareAndSwap(key(def.workflowId), expectedRaw, JSON.stringify(def));
  if (swapped) registry.set(def.workflowId, def);
  else if (actual) registry.set(def.workflowId, JSON.parse(actual) as WorkflowDefinition); // lost: adopt the winner
  return swapped;
}

export function registerWorkflow(def: WorkflowDefinition): void {
  registry.set(def.workflowId, def);
  // Write through to durable storage so another instance can resolve it.
  const storage = tryDurableStorage();
  if (storage) {
    void storage.kvSet(key(def.workflowId), JSON.stringify(def)).catch((err) => {
      log.warn('workflow_registry_persist_failed', {
        workflowId: def.workflowId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

/** Synchronous cache lookup (in-process only). Kept for sync callers
 *  (`listRegisteredWorkflows` consumers, mcpServerRegistry). For cross-instance
 *  correctness use `getRegisteredWorkflowAsync`. */
/**
 * Test-only — drop the process-local cache WITHOUT touching durable storage,
 * i.e. exactly what a fresh Cloud Run instance sees. There is no boot hydration,
 * so this is the only way to reproduce the cold-start path that let the seeder
 * overwrite an already-seeded definition (grade-data RI-1). Production never
 * calls it.
 */
export function __resetWorkflowRegistryForTests(): void {
  registry.clear();
}

export function getRegisteredWorkflow(workflowId: string): WorkflowDefinition | undefined {
  return registry.get(workflowId);
}

/** Cross-instance lookup: cache hit, else a durable read that re-populates the
 *  cache. Used by the workflowCatalog's async resolver (ENG-3). */
export async function getRegisteredWorkflowAsync(workflowId: string): Promise<WorkflowDefinition | null> {
  const cached = registry.get(workflowId);
  if (cached) return cached;
  const storage = tryDurableStorage();
  if (!storage) return null;
  try {
    const raw = await storage.kvGet(key(workflowId));
    if (!raw) return null;
    const def = JSON.parse(raw) as WorkflowDefinition;
    registry.set(workflowId, def); // re-populate the cache on this instance
    return def;
  } catch (err) {
    log.warn('workflow_registry_hydrate_failed', {
      workflowId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * SEEDRM-1 — like `getRegisteredWorkflowAsync`, but a durable-read failure
 * THROWS instead of returning `null`. The lenient reader folds "storage errored"
 * into "absent", which is the right answer for a display read and the wrong one
 * for register-if-missing: the seeder took a transient `kvGet` error as "never
 * seeded", re-expanded the chain and overwrote the global `wfreg:` row every
 * tenant runs (the cold-instance rewrite ADR 0498 RI-1 closed, reopened by a
 * failed read instead of a cold cache). Use this wherever `null` licenses a WRITE.
 */
export async function getRegisteredWorkflowStrict(workflowId: string): Promise<WorkflowDefinition | null> {
  const cached = registry.get(workflowId);
  if (cached) return cached;
  const storage = tryDurableStorage();
  if (!storage) return null;
  const raw = await storage.kvGet(key(workflowId));
  if (!raw) return null;
  const def = JSON.parse(raw) as WorkflowDefinition;
  registry.set(workflowId, def);
  return def;
}

/** Catalog listing — ADR 0369: archived + unpromoted-transient definitions
 *  are hidden by DEFAULT so every consumer (workflow-author list, MCP tool
 *  listings, example-data summary) inherits the filter. Integrity checks and
 *  admin surfaces opt in explicitly. Resolution (`getRegisteredWorkflow*`)
 *  is deliberately UNfiltered — replay/`:fork` re-resolve by id. */
export function listRegisteredWorkflows(opts: CatalogVisibilityOpts = {}): readonly WorkflowDefinition[] {
  return Array.from(registry.values()).filter((d) => catalogVisible(d, opts));
}

/** Test-only: drop the in-memory cache WITHOUT touching durable storage —
 *  simulates a fresh process / another instance that hasn't hydrated yet. */
export function __clearRegistryCacheForTests(): void {
  registry.clear();
}

/** ADR 0474 — deletion hooks: dependents (the revision store) cascade when a
 *  definition is deleted, WITHOUT the registry importing them (revisions →
 *  ownership → registry would cycle). Registered at module load; best-effort
 *  (history cleanup must not block a delete; tenant teardown's extractor walk
 *  is the backstop for any missed rows). */
const deletionHooks: Array<(workflowId: string, tenantIds?: readonly string[]) => Promise<unknown>> = [];
/** `tenantIds` (grade-data M7): callers that KNOW the owning tenant(s) pass
 *  them so cascades can prefix-scan `${tenantId}:` slices instead of a
 *  full cross-tenant `list()` — the retention GC deletes drafts in a loop,
 *  so per-delete full scans are the host_ext_kv incident shape reborn.
 *  Absent ⇒ hooks fall back to the full scan (rare boot/seed paths only). */
export function onWorkflowDeleted(hook: (workflowId: string, tenantIds?: readonly string[]) => Promise<unknown>): void {
  deletionHooks.push(hook);
}

/** ADR 0789 — fork hooks. When a tenant's write to a SHARED definition forks it
 *  onto a tenant-owned id (`sharedWorkflowFork.ts`), every store that points at
 *  the old id FOR THAT TENANT re-points to the fork, so a schedule or a card keeps
 *  running what the user just edited. Same shape as the deletion hooks, for the
 *  same reason: the owning module subscribes, the registry imports none of them.
 *  A hook returns how many rows it re-pointed and touches ONLY `tenantId`'s rows —
 *  every other tenant still owns the shared id. */
export type WorkflowForkHook = (tenantId: string, fromWorkflowId: string, toWorkflowId: string) => Promise<number>;
const forkHooks: Array<{ id: string; hook: WorkflowForkHook }> = [];
export function onWorkflowForked(id: string, hook: WorkflowForkHook): void {
  if (!forkHooks.some((h) => h.id === id)) forkHooks.push({ id, hook });
}
/** Run every fork hook. Per-hook failures are counted, never thrown: the fork is
 *  already durable, and a missed re-point leaves a reference on the (unchanged,
 *  still resolvable) shared definition — stale, not unsafe. */
export async function runWorkflowForkHooks(
  tenantId: string,
  fromWorkflowId: string,
  toWorkflowId: string,
  only?: readonly string[],
): Promise<{ repointed: Record<string, number>; failed: string[] }> {
  const repointed: Record<string, number> = {};
  const failed: string[] = [];
  for (const { id, hook } of forkHooks) {
    if (only && !only.includes(id)) continue;
    try {
      const n = await hook(tenantId, fromWorkflowId, toWorkflowId);
      if (n > 0) repointed[id] = n;
    } catch (err) {
      failed.push(id);
      log.error('workflow_fork_hook_failed', {
        hook: id, tenantId, fromWorkflowId, toWorkflowId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { repointed, failed };
}
/** Test seam: the registered fork-hook ids (the witness asserts coverage). */
export function workflowForkHookIds(): string[] {
  return forkHooks.map((h) => h.id);
}

export function deleteRegisteredWorkflow(workflowId: string, tenantIds?: readonly string[]): boolean {
  const existed = registry.delete(workflowId);
  const storage = tryDurableStorage();
  if (storage) {
    void storage.kvDelete(key(workflowId)).catch((err) => {
      log.warn('workflow_registry_delete_failed', {
        workflowId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  for (const hook of deletionHooks) {
    void hook(workflowId, tenantIds).catch((err) => {
      log.warn('workflow_registry_delete_hook_failed', {
        workflowId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  return existed;
}
