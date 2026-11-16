/**
 * Issue #5929 item 1 (ADR 1121) — a run FOR a client is read only by people who
 * may read that client.
 *
 * `runs:read` is protocol authority: the union of a subject's scopes across
 * every org membership in the tenant (`resolveSubjectScopesUnion`). So a member
 * of client org A held it tenant-wide, and the run reads (`runAccess.ts`) and
 * `GET /runs` checked only the scope and the tenant. Client org B's runs (their
 * events, inputs and source text) were readable by A's members.
 *
 * The rule, decided once per request:
 *   - a run that names no client (`runClientStamp` is undefined) is unchanged;
 *   - the tenant-level grants of the #4543 payload rule read every run: a
 *     wildcard principal, the caller's own personal workspace, a tenant where
 *     membership does not define presence, and an admin of the tenant
 *     (`host:members:manage`). That is {@link runPayloadAccess}, reused so the
 *     two rules cannot drift;
 *   - anyone else needs `runs:read` IN the run's client org (a mutation: its
 *     own scope there), resolved live
 *     (`assertOrgScope`). A member removed from the client loses its runs,
 *     including the ones they started;
 *   - a stamp that cannot be read, or two stamps naming different orgs, is
 *     readable by the tenant-level grants only. It fails closed.
 *
 * ADR 1133 adds one more question, after the client one and behind the same
 * tenant-level grants: a run a PRIVATE project is working on is read only by that
 * project's people (`runProjectAccess.ts`, derived from the run's attribution,
 * never stamped).
 *
 * A refused run is reported as absent (`run_not_found`, 404), the same
 * no-existence-leak posture as the tenant check, and is dropped from lists.
 */
import type { Request } from 'express';
import type { RunRecord } from '../types.js';
import { OpenwopError } from '../types.js';
import type { Scope } from './accessControlService.js';
import { callerSubject, tenantOf } from './requestSubject.js';
import { runClientStamp } from './runClientOrg.js';
import { clientOrgGate, hasTenantWideClientAccess } from './clientOrgGate.js';
import { runProjectReader } from './runProjectAccess.js';

/** Decide, once per request, which client runs in `tenantId` the caller may
 *  read. One membership resolve per distinct client org, cached for the request. */
export async function runClientReader(req: Request, tenantId: string = tenantOf(req), scope: Scope = 'runs:read'): Promise<(run: Pick<RunRecord, 'metadata'>) => Promise<boolean>> {
  // ADR 1132 — the floor itself is `clientOrgGate`, shared with workflow definitions.
  const mayActIn = clientOrgGate(req, tenantId, scope);
  let tenantWide: Promise<boolean> | undefined;
  const clientOk = async (run: Pick<RunRecord, 'metadata'>): Promise<boolean> => {
    const stamp = runClientStamp(run.metadata as Record<string, unknown> | undefined);
    if (stamp === undefined) return true;
    if ('refused' in stamp) {
      // An unreadable or self-contradicting stamp: the tenant-level grants only.
      tenantWide ??= hasTenantWideClientAccess(req, tenantId);
      return tenantWide;
    }
    return mayActIn(stamp.orgId);
  };
  // ADR 1133 — and the project the run is working on, after the client check and
  // behind the same tenant-wide grants. Derived, never stamped (runProjectAccess.ts).
  const projectOk = runProjectReader(tenantId, callerSubject(req));
  return async (run) => {
    if (!(await clientOk(run))) return false;
    if (!(await projectOk(run.metadata as Record<string, unknown> | undefined))) {
      tenantWide ??= hasTenantWideClientAccess(req, tenantId);
      return tenantWide;
    }
    return true;
  };
}

/** {@link runClientReader} for ONE run: throws `run_not_found` (404) when the
 *  caller may not read the client the run is for. A mutation passes its own
 *  scope (`runs:cancel`, `runs:create`), which the caller must then hold in the
 *  client org, not just somewhere in the tenant. */
export async function assertRunClientReadable(req: Request, run: Pick<RunRecord, 'runId' | 'tenantId' | 'metadata'>, scope: Scope = 'runs:read'): Promise<void> {
  if (!(await (await runClientReader(req, run.tenantId, scope))(run))) {
    throw new OpenwopError('run_not_found', `run ${run.runId} not found`, 404);
  }
}

/** Drop the runs the caller may not read the client of, keeping order. */
export async function filterClientReadableRuns<T extends Pick<RunRecord, 'tenantId' | 'metadata'>>(req: Request, runs: readonly T[]): Promise<T[]> {
  const readers = new Map<string, (run: Pick<RunRecord, 'metadata'>) => Promise<boolean>>();
  const out: T[] = [];
  for (const r of runs) {
    let read = readers.get(r.tenantId);
    if (!read) {
      read = await runClientReader(req, r.tenantId);
      readers.set(r.tenantId, read);
    }
    if (await read(r)) out.push(r);
  }
  return out;
}
