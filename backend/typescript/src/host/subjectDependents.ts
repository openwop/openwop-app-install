/**
 * Subject-dependents seam (ADR 0839 D2) — rows ANOTHER feature owns under a
 * Subject, purged when that Subject is deleted.
 *
 * A project's own cascade (board, schedules, memory, KB binding) lives in
 * `deleteProject`. What it could not reach were rows other features write with
 * `ownerSubject = project:<id>`: canvases, priority lists (and their boards), the
 * team ledger, documents. Every door to those rows asks the project for access,
 * so once the project row was gone they were refused to everyone, admins
 * included, and only tenant teardown removed them.
 *
 * Deliberately NOT the lifecycle-seam contract (`canvasLifecycle.ts` and its
 * siblings fire AFTER the row is gone and swallow errors). That order is wrong
 * here: a dependent's own gate needs the project to EXIST, so a purge that runs
 * after the row delete and fails would strand its rows for good. These run
 * BEFORE the owner row is deleted, and a failure PROPAGATES so the owner
 * survives and the delete can be retried.
 *
 * Contract for a registrant:
 *  - list inside `tenantId` only, then match the owner Subject exactly — never
 *    by id alone across tenants;
 *  - delete through the feature's own single-owner delete (its cascade, its
 *    tenant check), never a raw store delete;
 *  - be idempotent: a retry after a partial failure must converge.
 *
 * Keyed registration (a repeat boot overwrites), dispatched by `subject.kind`.
 */

import type { Subject } from './subject.js';
import { OpenwopError } from '../types.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.subjectDependents');

export interface SubjectDependent {
  /** How many rows `purge` would delete now. */
  count(tenantId: string, subject: Subject): Promise<number>;
  /** Delete them; returns how many this call deleted. Throws on failure. */
  purge(tenantId: string, subject: Subject): Promise<number>;
}

const registry = new Map<string, Map<string, SubjectDependent>>();

/** Register the rows `key` owns under subjects of `kind` (called at boot by the owning feature). */
export function registerSubjectDependent(kind: Subject['kind'], key: string, dep: SubjectDependent): void {
  let byKey = registry.get(kind);
  if (!byKey) { byKey = new Map(); registry.set(kind, byKey); }
  byKey.set(key, dep);
}

/** The registered dependent keys for `kind` (ratchet + diagnostics). */
export function listSubjectDependentKeys(kind: Subject['kind']): string[] {
  return [...(registry.get(kind)?.keys() ?? [])].sort();
}

/** Per-key counts of what a delete of `subject` would take with it. */
export async function countSubjectDependents(tenantId: string, subject: Subject): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [key, dep] of registry.get(subject.kind) ?? []) out[key] = await dep.count(tenantId, subject);
  return out;
}

/** Purge every registered dependent of `subject`. Sequential, and the first
 *  failure propagates — the caller must not delete the owner row after a throw. */
export async function purgeSubjectDependents(tenantId: string, subject: Subject): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [key, dep] of registry.get(subject.kind) ?? []) {
    try {
      out[key] = await dep.purge(tenantId, subject);
    } catch (err) {
      // Name the dependent that failed and what already went, so a 500 on a delete is
      // diagnosable and a retry's counts can be reconciled.
      log.error('subject_dependents_purge_failed', {
        tenantId, kind: subject.kind, subjectId: subject.id, dependent: key, purgedSoFar: out,
        error: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof OpenwopError) throw err;
      throw new OpenwopError('internal_error', `Could not delete the ${key} that belong to this ${subject.kind}; nothing else was deleted — try again.`, 500, { dependent: key, purgedSoFar: out });
    }
  }
  return out;
}

/** Test-only: replace (or remove, with `undefined`) one registration; returns the previous
 *  one so the caller can restore it. Lets a test reproduce rows stranded before a
 *  registrant existed. */
export function __swapSubjectDependentForTest(kind: Subject['kind'], key: string, dep: SubjectDependent | undefined): SubjectDependent | undefined {
  const byKey = registry.get(kind) ?? new Map<string, SubjectDependent>();
  registry.set(kind, byKey);
  const prev = byKey.get(key);
  if (dep) byKey.set(key, dep); else byKey.delete(key);
  return prev;
}
