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
import { getRegisteredWorkflowAsync, getRegisteredWorkflow } from './workflowsRegistry.js';
import { registerCredentialRefConsumer } from './credentialRefRegistry.js';
// NOTE: this is a CYCLE — `chainBackedWorkflows` imports `recordOwnership` from here.
// Both directions are used only INSIDE functions at runtime, never at module top
// level, so the live bindings are populated by the time either is called. That is
// asserted, not assumed: `workflow-author-builtin-guard.test.ts` calls
// `isBuiltinWorkflowId` on a chain-backed id, which is exactly the path that would
// throw or return undefined if the cycle bit.
import { getChainBackedWorkflow } from './chainBackedWorkflows.js';

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
  /** ADR 0369 — denormalized lifecycle (same rationale as name/nodeCount:
   *  the scoped list renders without N registry reads). Source of truth is
   *  `definition.metadata.lifecycle`; refreshed on save + lifecycle verbs. */
  transient?: boolean;
  archivedAt?: string;
  /** ADR 0474 — the revision hash the promote verb published (publish=pin).
   *  Absent until first promote; preserved across metadata refreshes. */
  publishedRevision?: string;
  /** ADR 0596 (`WFAC-9` / `WFAU-2`) — model provenance, denormalized for the
   *  same reason as name/nodeCount: the scoped list projects from THESE rows
   *  precisely to avoid N registry reads, so provenance that lives only in
   *  `definition.metadata.authoring` cannot reach the surface that needs it.
   *  STICKY like `publishedRevision`: a later save from another lane (the
   *  builder's autosave, a revision restore) omits it and MUST NOT erase it —
   *  a machine-authored workflow does not stop being machine-authored because
   *  a human edited it. */
  authoredVia?: string;
}

/** Metadata captured at ownership time for cheap listing. */
export interface OwnershipMeta {
  name?: string;
  nodeCount: number;
  transient?: boolean;
  archivedAt?: string;
  /** ADR 0474 — set by the promote verb; omitted meta preserves the existing value. */
  publishedRevision?: string;
  /** ADR 0596 — set by the workflow-author write lane; omitted meta preserves it. */
  authoredVia?: string;
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
  const iso = now.toISOString();
  // ADR 0482 grade-fix H2 — CAS loop (matches setPublishedRevision). A blind
  // get→put here captured `publishedRevision` at read time and could clobber
  // a concurrent environments pin-restore (setPublishedRevision's CAS win),
  // OR omit the key entirely when its read saw undefined — silently reverting
  // production launches after a "green" apply (the exact B4 half-truth ADR
  // 0479 closes). Both pin writers now compare-and-swap on the same row, so
  // neither can lose. Re-read `publishedRevision` INSIDE the loop so a pin set
  // between our reads is preserved.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = await store.get(key);
    const next: WorkflowOwnershipRecord = {
      key,
      tenantId,
      workflowId,
      ...(meta.name !== undefined ? { name: meta.name } : {}),
      ...(meta.transient !== undefined ? { transient: meta.transient } : {}),
      ...(meta.archivedAt !== undefined ? { archivedAt: meta.archivedAt } : {}),
      // ADR 0474 — publish pin: sticky across ordinary saves (only promote sets it).
      ...((meta.publishedRevision ?? existing?.publishedRevision) !== undefined
        ? { publishedRevision: meta.publishedRevision ?? existing?.publishedRevision }
        : {}),
      // ADR 0596 — provenance: sticky, same rule (only the authoring lane sets it).
      ...((meta.authoredVia ?? existing?.authoredVia) !== undefined
        ? { authoredVia: meta.authoredVia ?? existing?.authoredVia }
        : {}),
      nodeCount: meta.nodeCount,
      createdAt: existing?.createdAt ?? iso,
      updatedAt: iso,
    };
    if (await store.compareAndSwap(existing ?? null, next)) return;
  }
  // Persistent contention (rare) — a last-writer put keeps the write live;
  // the pin's own CAS writer is the authority that must never lose.
  const existing = await store.get(key);
  await store.put({
    key, tenantId, workflowId,
    ...(meta.name !== undefined ? { name: meta.name } : {}),
    ...(meta.transient !== undefined ? { transient: meta.transient } : {}),
    ...(meta.archivedAt !== undefined ? { archivedAt: meta.archivedAt } : {}),
    ...((meta.publishedRevision ?? existing?.publishedRevision) !== undefined
      ? { publishedRevision: meta.publishedRevision ?? existing?.publishedRevision }
      : {}),
    ...((meta.authoredVia ?? existing?.authoredVia) !== undefined
      ? { authoredVia: meta.authoredVia ?? existing?.authoredVia }
      : {}),
    nodeCount: meta.nodeCount,
    createdAt: existing?.createdAt ?? iso,
    updatedAt: iso,
  });
}

/** ADR 0479 — the environments workflow-pins domain's restore seam: point an
 *  EXISTING ownership row's publish pin at a revision. Fail-closed: never
 *  creates a row (an unknown/foreign workflowId is the caller's per-item
 *  error), and there is deliberately NO clear variant — the domain restores
 *  apply-only (clearing a pin would flip production launches back to head).
 *  The promote route keeps `recordOwnership`'s sticky-merge path. */
export async function setPublishedRevision(
  tenantId: string,
  workflowId: string,
  revisionHash: string,
): Promise<boolean> {
  const key = ownKey(tenantId, workflowId);
  // Code-review H1 — CAS loop (the environments setProtection pattern): a
  // plain get→put here raced the builder autosave's recordOwnership sticky
  // merge, which could resurrect the OLD pin after a "green" apply (the
  // silently-wrong-revision failure this seam exists to prevent), and the
  // reverse put could clobber a concurrent rename/archive.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = await store.get(key);
    if (!existing) return false;
    if (existing.publishedRevision === revisionHash) return true; // idempotent
    const next = { ...existing, publishedRevision: revisionHash, updatedAt: new Date().toISOString() };
    if (await store.compareAndSwap(existing, next)) return true;
  }
  return false; // persistent contention — the caller reports a named failure
}

/** The workflows owned by one tenant (newest first) — list-metadata only. */
export async function listOwned(tenantId: string): Promise<WorkflowOwnershipRecord[]> {
  const rows = await store.listByPrefix(tenantPrefix(tenantId));
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A workflow name unique among the tenant's owned workflows: returns `base`
 *  if free, else `base-2`, `base-3`, … — so instantiating the same template
 *  twice yields "Daily Executive Briefing", "Daily Executive Briefing-2", … */
export async function uniqueOwnedName(tenantId: string, base: string): Promise<string> {
  const taken = new Set((await listOwned(tenantId)).map((r) => r.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The ownership record iff `tenantId` owns `workflowId` (the IDOR guard). */
export async function getOwned(tenantId: string, workflowId: string): Promise<WorkflowOwnershipRecord | null> {
  return store.get(ownKey(tenantId, workflowId));
}

/** ADR 0473 (grade-data D1) — tenant-teardown purge of the tenant's authored
 *  workflow DEFINITIONS. Registry rows live under `wfreg:` (not `hostext:`,
 *  no JSON tenantId), so the generic teardown walk never reaches them and
 *  agent-composed draft bodies — exactly the "may embed user prose" class the
 *  redactor residual names — would survive account deletion. Deletes a def
 *  only when NO other tenant also owns the id (the dual-ownership edge);
 *  ownership rows themselves are removed for this tenant either way (their
 *  store is hostext-purged too — this keeps ordering-independence). MUST run
 *  BEFORE `purgeTenantHostExt`, which deletes the ownership rows this reads. */
export async function purgeTenantOwnedWorkflowDefs(
  tenantId: string,
  deleteDef: (workflowId: string) => void,
): Promise<{ defsDeleted: number; ownershipRows: number }> {
  const owned = await listOwned(tenantId);
  let defsDeleted = 0;
  for (const row of owned) {
    if (!(await isAuthoredByOtherTenant(tenantId, row.workflowId))) {
      deleteDef(row.workflowId);
      defsDeleted += 1;
    }
    await store.delete(ownKey(tenantId, row.workflowId));
  }
  return { defsDeleted, ownershipRows: owned.length };
}

/** ADR 0473 (grade-data D4) — every ownership row grouped by workflowId, for
 *  the transient-GC's legal-hold check (one full list per retention tick, over
 *  a store bounded by authored-workflow volume — never a hot path). */
export async function allOwnershipByWorkflow(): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  for (const row of await store.list()) {
    const tenants = map.get(row.workflowId) ?? [];
    tenants.push(row.tenantId);
    map.set(row.workflowId, tenants);
  }
  return map;
}

/** True iff SOME tenant has authored `workflowId` (2026-07 vuln-scan M7). Lets a
 *  read distinguish a tenant-authored def (owner-only) from an UN-owned public
 *  fixture / premade template (openwop-app.uppercase, tmpl.*), which stay public.
 *  Small table + infrequent read, so the full scan (matching
 *  `removeOwnershipByWorkflowId`) is acceptable. */
export async function isAuthoredByAnyTenant(workflowId: string): Promise<boolean> {
  return (await store.list()).some((r) => r.workflowId === workflowId);
}

/** Every workflowId owned by SOME tenant, materialized in ONE scan — so a
 *  listing can partition the (host-global) registry into "authored by a tenant"
 *  vs BUILT-IN without paying an O(rows) ownership scan per id. */
export async function authoredWorkflowIds(): Promise<Set<string>> {
  return new Set((await store.list()).map((r) => r.workflowId));
}

/** A workflowId is a BUILT-IN when it is registered on this host yet owned by
 *  NO tenant — the host's own system / example / premade-template definitions
 *  (registered at boot via `registerWorkflow` with no ownership row). Built-ins
 *  are readable + extensible by every tenant (a `get` grounds a revision on
 *  them), but an authoring WRITE must never overwrite one — doing so would
 *  poison a shared definition for every tenant (the ADR 0440 P4 hole the
 *  `isWriteProtected` route guard closes). This is the authz layer's read of the
 *  registry it sits over — a point lookup, never a run resolution. */
export async function isBuiltinWorkflowId(workflowId: string): Promise<boolean> {
  // ADR 0703 D5 — BOTH host registries. This asked only `getRegisteredWorkflowAsync`
  // (the raw registry), and chain-backed definitions live in `chainBackedWorkflows`'
  // own one. So the ADR 0701/0703 pin-site drains made their workflows invisible HERE
  // too, not just to the route guard: `workflowAuthorService.ts:257` uses this to 409
  // an overwrite of a host built-in, so the AI workflow AUTHOR could overwrite
  // `openwop-app.scheduled-chat.turn` / `openwop-app.channel.turn`.
  //
  // Found by sweeping every reader of the raw registry after the route-guard hole
  // (D4) — one predicate was fixed and this was the second. The lane's own comment
  // above D4's fix warns about exactly this asymmetry: "curation was enforced on the
  // doors a HUMAN uses and skipped on the doors a MODEL uses".
  if (!(await getRegisteredWorkflowAsync(workflowId)) && !getChainBackedWorkflow(workflowId)) return false;
  return !(await isAuthoredByAnyTenant(workflowId));
}

/**
 * Whether `workflowId` is owned by SOME tenant OTHER than `tenantId` (ADR 0440
 * P4). Short-circuits on the first foreign owner instead of materializing the
 * whole list — the authz guards call this on the write hot path (the 1.5s
 * autosave), so it must not pay an O(all-ownership-rows) scan when it can stop
 * at the first hit.
 */
export async function isAuthoredByOtherTenant(tenantId: string, workflowId: string): Promise<boolean> {
  for (const r of await store.list()) {
    if (r.workflowId === workflowId && r.tenantId !== tenantId) return true;
  }
  return false;
}

/** Drop the ownership record (after the registry definition is deleted). */
/** ADR 0371 P4 (the ADR 0369 GC) — drop EVERY tenant's ownership row for a
 *  definition the GC is hard-deleting (rare, small: runs only for archived
 *  transient defs with zero remaining runs). */
export async function removeOwnershipByWorkflowId(workflowId: string): Promise<number> {
  let removed = 0;
  for (const r of await store.list()) {
    if (r.workflowId === workflowId && (await store.delete(r.key))) removed += 1;
  }
  return removed;
}

export async function removeOwnership(tenantId: string, workflowId: string): Promise<boolean> {
  return store.delete(ownKey(tenantId, workflowId));
}

// ADR 0499 — a workflow node may pin a BYOK ref in `config.credentialRef`
// (executor/types.ts). Migrated here from the hand-kept list in
// `routes/adminVault.ts` so it rides the same registry as every other holder.
// Bounded by the tenant's OWN authored workflows via the ownership index, so
// this is a point-lookup per owned id, not a registry scan.
registerCredentialRefConsumer({
  id: 'workflow:node-config',
  async describe(tenantId, ref) {
    const out: string[] = [];
    for (const row of await listOwned(tenantId)) {
      const def = getRegisteredWorkflow(row.workflowId);
      if (!def) continue;
      for (const node of def.nodes ?? []) {
        // `config` is `Record<string, unknown>`, so the member read is already
        // `unknown` — no cast needed to narrow it.
        if (node.config?.credentialRef === ref) {
          out.push(`workflow \`${row.name}\` node \`${node.nodeId}\``);
        }
      }
    }
    return out;
  },
});
