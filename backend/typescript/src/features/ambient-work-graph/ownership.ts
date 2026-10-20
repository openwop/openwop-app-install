/**
 * ADR 0930 D1/D2 (+ the closing-grade corrections C1/C2) — whose work a run is, for the
 * work graph.
 *
 * "You've done this N times" is said to one person about runs THEY started, so every
 * run is reduced to an OWNER KEY before it is clustered, and a reader sees only the rows
 * under their own key. Both sides go through this module so the daemon writes the key
 * the route reads.
 *
 * A run counts only when it carries the RFC 0165 owner STAMP (`run.metadata.owner`,
 * minted from the authenticated caller at creation — `POST /runs`, the authoring and
 * eval doors). Its key is the stamp's principal, in every tenant:
 *
 *   - C1 (grade-code AWG2CD-1): an earlier draft put every run in a personal workspace
 *     under one `personal` key. A personal workspace can have members, so its owner read
 *     a member's patterns. There is no tenant-wide bucket anywhere now.
 *   - C2 (AWG2CD-2): `runOwner`'s legacy `actingUserId` fallback is NOT used. The
 *     scheduler, the assistant loops and other host lanes stamp `actingUserId` on runs
 *     nobody started by hand, so the fallback would count an hourly cron as "you did
 *     this 24 times". An unstamped run is never counted (pre-stamp history, before
 *     2026-09-02, is the stated cost).
 *
 * Also excluded (null): key-driven (`workload`) and anonymous owners; forks, redrives,
 * delegated child runs and eval runs (re-executions or parts of other work); and any run
 * carrying a host attribution block (`schedule`, `heartbeat`, `kanban`, `approval`), in
 * case a future lane stamps an owner onto automated work.
 */
import type { Request } from 'express';
import type { RunRecord } from '../../types.js';
import { isLegacySubject, opaquePrincipal, runOwner } from '../../host/runOwner.js';
import { callerSubject } from '../../host/requestSubject.js';

/** Host-written blocks that mark a run as fired by automation, not started by hand. */
const AUTOMATION_KEYS = ['schedule', 'heartbeat', 'kanban', 'approval', 'eval', 'redriveOf', 'parentRunId'] as const;

/** The owner key a run is mined under, or null when it is not a person's manual work. */
export function runOwnerKey(run: Pick<RunRecord, 'tenantId' | 'metadata' | 'parentRunId'>): string | null {
  // A fork (`:fork` always sets `parentRunId` beside `forkMode`) and a delegated child.
  if (run.parentRunId !== undefined) return null;
  const md = run.metadata ?? {};
  for (const k of AUTOMATION_KEYS) if (md[k] !== undefined) return null;
  // C2 — no stamp, no person. `runOwner` reads an unstamped (or inconsistent) run back
  // with the §B.3 LEGACY subject, whatever `actingUserId` says, so that subject is the test.
  const owner = runOwner(run);
  if (!owner?.principal || !owner.subject || isLegacySubject(owner.subject)) return null;
  if (owner.principalKind === 'anonymous' || owner.subject.kind === 'anonymous' || owner.subject.kind === 'workload') return null;
  return owner.principal;
}

/** The caller's owner key: the same opaque projection of the session subject the stamp
 *  was minted from. Null when the request carries no person. */
export function callerOwnerKey(req: Request): string | null {
  const subject = callerSubject(req);
  return subject ? opaquePrincipal(subject) : null;
}
