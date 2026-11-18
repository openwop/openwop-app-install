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
import { assertOrgScope, membershipDefinesPresence, type Scope } from './accessControlService.js';
import { decideProtocolAuthorization } from './protocolAuthorization.js';
import { callerSubject, isPersonalTenantId, tenantOf } from './requestSubject.js';
import { runClientStamp } from './runClientOrg.js';
import { clientOrgGate, hasTenantWideClientAccess } from './clientOrgGate.js';
import { runProjectReader } from './runProjectAccess.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.runClientAccess');

/** Decide, once per request, which client runs in `tenantId` the caller may
 *  read. One membership resolve per distinct client org, cached for the request. */
/** The ONE run-read decision, shared by the request reader and the person reader
 *  (ADR 1140) so the two cannot drift: the client stamp first (an unreadable
 *  stamp needs a tenant-level grant), then the ADR 1133 project check behind the
 *  same grants. `mayActIn` must include the tenant-level grants itself. */
async function decideRunRead(
  metadata: Record<string, unknown> | undefined,
  deps: { tenantWide: () => Promise<boolean>; mayActIn: (orgId: string) => Promise<boolean>; projectOk: (metadata: Record<string, unknown> | undefined) => Promise<boolean> },
): Promise<boolean> {
  const stamp = runClientStamp(metadata);
  if (stamp !== undefined) {
    // An unreadable or self-contradicting stamp: the tenant-level grants only.
    if (!(await ('refused' in stamp ? deps.tenantWide() : deps.mayActIn(stamp.orgId)))) return false;
  }
  // ADR 1133 — and the project the run is working on, after the client check and
  // behind the same tenant-wide grants. Derived, never stamped (runProjectAccess.ts).
  if (!(await deps.projectOk(metadata))) return deps.tenantWide();
  return true;
}

/** Decide, once per request, which client runs in `tenantId` the caller may
 *  read. One membership resolve per distinct client org, cached for the request. */
export async function runClientReader(req: Request, tenantId: string = tenantOf(req), scope: Scope = 'runs:read'): Promise<(run: Pick<RunRecord, 'metadata'>) => Promise<boolean>> {
  // ADR 1132 — the floor itself is `clientOrgGate`, shared with workflow definitions.
  const mayActIn = clientOrgGate(req, tenantId, scope);
  let tenantWide: Promise<boolean> | undefined;
  const deps = {
    tenantWide: () => (tenantWide ??= hasTenantWideClientAccess(req, tenantId)),
    mayActIn,
    projectOk: runProjectReader(tenantId, callerSubject(req)),
  };
  return (run) => decideRunRead(run.metadata as Record<string, unknown> | undefined, deps);
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

/**
 * ADR 1140 (#5951) — {@link runClientReader}'s rule for a PERSON with no request:
 * may `userId` open this run? Used when a run's request is addressed (the
 * interrupt notification and its SLA reminders), so nobody is asked about a run
 * whose page answers them `run_not_found`. Keyed on the same id the run doors
 * key on (`callerSubject(req)`, the userId). The tenant-level grants are the
 * request rule's, less the two a person cannot carry without a request (a
 * wildcard principal, and "this is my own personal workspace", which a personal
 * tenant answers by construction, so a personal tenant is never filtered).
 */
export function runUserReader(run: Pick<RunRecord, 'tenantId' | 'metadata'>): (userId: string) => Promise<boolean> {
  const tenantId = run.tenantId;
  if (isPersonalTenantId(tenantId) || !membershipDefinesPresence(tenantId)) return async () => true;
  const metadata = run.metadata as Record<string, unknown> | undefined;
  return (userId) => {
    let admin: Promise<boolean> | undefined;
    const tenantWide = (): Promise<boolean> =>
      (admin ??= decideProtocolAuthorization(tenantId, userId, 'host:members:manage').then((d) => d.allowed, () => false));
    const mayActIn = async (orgId: string): Promise<boolean> => {
      if (await tenantWide()) return true;
      return assertOrgScope(tenantId, userId, orgId, 'runs:read').then(
        () => true,
        (err: unknown) => {
          if (err instanceof OpenwopError && (err.code === 'not_found' || err.code === 'forbidden_scope')) return false;
          throw err; // a storage error is not "you may not": surface it
        },
      );
    };
    return decideRunRead(metadata, { tenantWide, mayActIn, projectOk: runProjectReader(tenantId, userId) });
  };
}

let userReaderFor: typeof runUserReader = runUserReader;
/** Test seam: replace the person reader (undefined restores it). */
export function __setRunUserReaderForTest(f: typeof runUserReader | undefined): void {
  userReaderFor = f ?? runUserReader;
}

/** Split addressed recipients into those who may open the run and those who may
 *  not. Fails closed PER RECIPIENT: a read that throws (a storage error) counts
 *  that one person as unreadable and is logged, so one failed check never
 *  silences the request for everyone else or skips the operators' notice. */
export async function splitRunReaders(run: Pick<RunRecord, 'tenantId' | 'metadata'>, userIds: readonly string[]): Promise<{ readers: string[]; unreadable: string[] }> {
  const may = userReaderFor(run);
  const readers: string[] = [];
  const unreadable: string[] = [];
  for (const u of userIds) {
    let ok = false;
    try {
      ok = await may(u);
    } catch (err) {
      log.warn('run_recipient_read_check_failed', { tenantId: run.tenantId, code: err instanceof OpenwopError ? err.code : 'error' });
    }
    (ok ? readers : unreadable).push(u);
  }
  return { readers, unreadable };
}
