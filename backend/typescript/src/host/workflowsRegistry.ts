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
import { tryDurableStorage } from './durable/durableStore.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.workflowsRegistry');

/** In-process write-through cache. */
const registry = new Map<string, WorkflowDefinition>();

const KEY_PREFIX = 'wfreg:';
const key = (workflowId: string): string => `${KEY_PREFIX}${workflowId}`;

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

export function listRegisteredWorkflows(): readonly WorkflowDefinition[] {
  return Array.from(registry.values());
}

/** Test-only: drop the in-memory cache WITHOUT touching durable storage —
 *  simulates a fresh process / another instance that hasn't hydrated yet. */
export function __clearRegistryCacheForTests(): void {
  registry.clear();
}

export function deleteRegisteredWorkflow(workflowId: string): boolean {
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
  return existed;
}
