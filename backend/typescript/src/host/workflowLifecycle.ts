/**
 * ADR 0369 — transient ("dynamic") workflow lifecycle.
 *
 * Lifecycle facts ride `definition.metadata.lifecycle` (the schema's metadata
 * extension point — the stored `wfreg:` row stays the definition JSON, and the
 * stamp travels with export/import). This module is the ONE reader + the ONE
 * visibility rule: every catalog LIST filters through `catalogVisible`, while
 * by-id RESOLUTION never does — runs re-resolve their definition by
 * `workflowId` at replay/`:fork` (no per-run snapshot), so an archived or
 * transient definition must stay resolvable forever. Archive, never dispose.
 */

import type { WorkflowDefinition } from '../executor/types.js';

export interface WorkflowLifecycle {
  /** Generated per-task (builder draft, agent-composed DAG, recorded tour):
   *  catalog-hidden from birth until PROMOTED (the flag cleared). */
  transient?: boolean;
  /** Producer id — `'workflow-author'`, `'agent:<id>'`, `'guided-tours.recorder'`. */
  generatedBy?: string;
  /** ISO timestamp — set on archive; absent ⇒ live. */
  archivedAt?: string;
}

/** Safe reader — malformed/absent metadata reads as the empty lifecycle. */
export function lifecycleOf(def: WorkflowDefinition): WorkflowLifecycle {
  const raw = (def.metadata as Record<string, unknown> | undefined)?.lifecycle;
  if (!raw || typeof raw !== 'object') return {};
  const l = raw as Record<string, unknown>;
  return {
    ...(l.transient === true ? { transient: true } : {}),
    ...(typeof l.generatedBy === 'string' && l.generatedBy ? { generatedBy: l.generatedBy } : {}),
    ...(typeof l.archivedAt === 'string' && l.archivedAt ? { archivedAt: l.archivedAt } : {}),
  };
}

/**
 * ADR 0595 (`WFAWF-7`) — the SERVER-AUTHORED lifecycle stamp.
 *
 * `validateWorkflowDefinition` passes `metadata` through wholesale with only an
 * is-object check, and `lifecycleOf` reads `metadata.lifecycle` out of it. On any
 * lane whose definition body comes from a MODEL, that made visibility
 * model-writable: a model could persist `lifecycle.archivedAt` and mint a
 * born-archived (catalog-hidden) workflow while the tool truthfully reported
 * success — the inverse of the lane's law, and a dishonest success.
 *
 * This is the ONE place that decides. It DISCARDS whatever lifecycle the
 * candidate carried and replaces it with the host's, so a caller cannot merge
 * into it either (`withLifecycle` alone would have merged onto the model's
 * block, which is the same hole one layer down).
 *
 * `undefined` members REMOVE the field, matching `withLifecycle`'s contract.
 */
export function withHostLifecycle(def: WorkflowDefinition, lifecycle: WorkflowLifecycle): WorkflowDefinition {
  const metadata = { ...(def.metadata as Record<string, unknown> | undefined) };
  delete metadata.lifecycle; // discard the caller's, whatever it was
  const next: Record<string, unknown> = {};
  if (lifecycle.transient === true) next.transient = true;
  if (lifecycle.generatedBy) next.generatedBy = lifecycle.generatedBy;
  if (lifecycle.archivedAt) next.archivedAt = lifecycle.archivedAt;
  if (Object.keys(next).length > 0) metadata.lifecycle = next;
  return { ...def, metadata } as WorkflowDefinition;
}

export interface CatalogVisibilityOpts {
  /** Include archived definitions (admin/debug + integrity checks only). */
  includeArchived?: boolean;
  /** Include unpromoted transient definitions (builder-session + integrity only). */
  includeTransient?: boolean;
}

/** The single visibility rule every catalog list applies. */
export function catalogVisible(def: WorkflowDefinition, opts: CatalogVisibilityOpts = {}): boolean {
  const l = lifecycleOf(def);
  if (l.archivedAt && !opts.includeArchived) return false;
  if (l.transient && !opts.includeTransient) return false;
  return true;
}

/** Return a copy of `def` with the given lifecycle fields merged (undefined
 *  values REMOVE the field — how promote clears `transient` and unarchive
 *  clears `archivedAt`). Never mutates the input. */
export function withLifecycle(
  def: WorkflowDefinition,
  patch: { [K in keyof WorkflowLifecycle]: WorkflowLifecycle[K] | undefined },
): WorkflowDefinition {
  const next: Record<string, unknown> = { ...lifecycleOf(def) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  const metadata = { ...(def.metadata as Record<string, unknown> | undefined) };
  if (Object.keys(next).length === 0) delete metadata.lifecycle;
  else metadata.lifecycle = next;
  return { ...def, metadata } as WorkflowDefinition;
}
