/**
 * Per-tenant workflow ownership index (ADR 0163 Phase 1 — the security gate).
 *
 * The workflow REGISTRY (`workflowsRegistry.ts`) is a GLOBAL by-id store — its job
 * is to resolve a `workflowId` to a definition on any instance for run/`:fork`/
 * agent/project dispatch (workflowIds are globally unique). It is deliberately NOT
 * tenant-scoped, so it must never back a per-tenant "your workflows" listing
 * directly — doing so would leak every tenant's workflows to every other tenant.
 *
 * This module is the **ownership/authz layer OVER** the global registry: a durable
 * index keyed by `${tenantId}:${workflowId}` recording which tenant owns a workflow
 * (+ minimal list metadata so the dashboard renders without N registry reads). The
 * registry stays the resolver; this gates the list + delete. Pure read-model —
 * zero replay impact (it never resolves a run).
 *
 * `tenantId` is the isolation boundary the auth middleware already computes
 * (`anon:<sid>` for anonymous sessions, `ws:<id>`/personal for signed-in) — so
 * anon callers are isolated per session and workspace members share a workspace's
 * workflows (matching CRM/projects scoping).
 *
 * @see docs/adr/0155-workflow-pack-templates.md (R1–R5)
 * @see src/host/workflowsRegistry.ts (the global by-id resolver this layers over)
 */

import { DurableCollection } from './hostExtPersistence.js';

export interface WorkflowOwnershipRecord {
  /** `${tenantId}:${workflowId}` */
  key: string;
  tenantId: string;
  workflowId: string;
  /** List-render metadata (avoids N+1 registry reads on the scoped list). */
  name?: string;
  nodeCount: number;
  createdAt: string;
  /** Refreshed on every (re-)save so the dashboard can show "Updated …". */
  updatedAt: string;
}

/** Metadata captured at ownership time for cheap listing. */
export interface OwnershipMeta {
  name?: string;
  nodeCount: number;
}

const store = new DurableCollection<WorkflowOwnershipRecord>(
  'workflow:ownership',
  (r) => r.key,
  undefined,
  (r) => r.tenantId,
);

const ownKey = (tenantId: string, workflowId: string): string => `${tenantId}:${workflowId}`;
const tenantPrefix = (tenantId: string): string => `${tenantId}:`;

/** Record (idempotent upsert) that `tenantId` owns `workflowId`. Re-registering
 *  preserves the original `createdAt`; only the list metadata refreshes. */
export async function recordOwnership(
  tenantId: string,
  workflowId: string,
  meta: OwnershipMeta,
  now: Date = new Date(),
): Promise<void> {
  const key = ownKey(tenantId, workflowId);
  const existing = await store.get(key);
  const iso = now.toISOString();
  await store.put({
    key,
    tenantId,
    workflowId,
    ...(meta.name !== undefined ? { name: meta.name } : {}),
    nodeCount: meta.nodeCount,
    createdAt: existing?.createdAt ?? iso,
    updatedAt: iso,
  });
}

/** The workflows owned by one tenant (newest first) — list-metadata only. */
export async function listOwned(tenantId: string): Promise<WorkflowOwnershipRecord[]> {
  const rows = await store.listByPrefix(tenantPrefix(tenantId));
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The ownership record iff `tenantId` owns `workflowId` (the IDOR guard). */
export async function getOwned(tenantId: string, workflowId: string): Promise<WorkflowOwnershipRecord | null> {
  return store.get(ownKey(tenantId, workflowId));
}

/** Drop the ownership record (after the registry definition is deleted). */
export async function removeOwnership(tenantId: string, workflowId: string): Promise<boolean> {
  return store.delete(ownKey(tenantId, workflowId));
}
