/**
 * ADR 1132 (#5969) — a workflow definition FOR a client is read and used only by
 * people who may act in that client.
 *
 * An instantiated chain freezes its params into the stored definition (RFC 0013
 * Path A), so a definition can hold a client's own content. `GET …/workflows`
 * listed every owned definition in the tenant and `GET /workflows/:id` refused
 * only other tenants, so a member of client A read client B's frozen params.
 *
 * The stamp is `WorkflowOwnershipRecord.clientOrgId` (set-once, see
 * `workflowOwnership.ts`). The floor is `clientOrgGate`, the same one runs use
 * (ADR 1121): unstamped definitions are unchanged; the tenant-level grants pass
 * every client; anyone else needs the site's scope IN the client org —
 * `workspace:read` to list or read, `workspace:write` to change, `runs:create`
 * to launch. A refusal is the definition's own 404, and lists drop it.
 */
import type { Request } from 'express';
import { OpenwopError } from '../types.js';
import { assertRunOrgScope, getMember, getOrg, isWorkspaceRootMembership, listTenantMembers, resolveEffectiveAccess, type Scope } from './accessControlService.js';
import { decideProtocolAuthorization } from './protocolAuthorization.js';
import { runClientOrgOf } from './runClientOrg.js';
import { actingMemberId } from './actingAccess.js';
import { callerSubject, isOwnPersonalWorkspace, tenantOf } from './requestSubject.js';
import { clientOrgGate, hasTenantWideClientAccess } from './clientOrgGate.js';
import { getOwned, type WorkflowOwnershipRecord } from './workflowOwnership.js';

/** Decide, once per request, which owned definitions the caller may use with `scope`. */
export function workflowClientReader(req: Request, tenantId: string = tenantOf(req), scope: Scope = 'workspace:read'): (row: Pick<WorkflowOwnershipRecord, 'clientOrgId'> | null | undefined) => Promise<boolean> {
  const mayActIn = clientOrgGate(req, tenantId, scope);
  return async (row) => (row?.clientOrgId === undefined ? true : mayActIn(row.clientOrgId));
}

/** Drop the owned rows whose client the caller may not read, keeping order. */
export async function filterClientReadableWorkflows<T extends Pick<WorkflowOwnershipRecord, 'clientOrgId'>>(req: Request, rows: readonly T[], tenantId: string = tenantOf(req)): Promise<T[]> {
  const may = workflowClientReader(req, tenantId);
  const out: T[] = [];
  for (const r of rows) if (await may(r)) out.push(r);
  return out;
}

/** The by-id floor: throws `workflow_not_found` (404, the route's own answer for
 *  an unknown id) when this tenant's definition is for a client the caller may
 *  not use with `scope`. An id this tenant does not own passes through (shared,
 *  built-in and public definitions are not client content). */
export async function assertWorkflowClientAccess(req: Request, workflowId: string, scope: Scope = 'workspace:read', tenantId: string = tenantOf(req)): Promise<void> {
  const row = await getOwned(tenantId, workflowId);
  if (!(await workflowClientReader(req, tenantId, scope)(row))) {
    throw new OpenwopError('workflow_not_found', 'workflow not found', 404, { workflowId });
  }
}

/** ADR 1132 D4 — the client a definition is for, read by run dispatch to stamp
 *  the runs it launches. `undefined` when unowned or unstamped. */
export async function workflowClientOrgOf(tenantId: string, workflowId: string): Promise<string | undefined> {
  return (await getOwned(tenantId, workflowId).catch(() => null))?.clientOrgId;
}

/**
 * ADR 1132 D1 — the client a NEW definition from this request must be stamped
 * with. Order:
 *  1. `x-openwop-act-as` naming a member of a non-root org → that org;
 *  2. else a caller with no workspace-root membership whose memberships that
 *     hold `writeScope` are in exactly ONE client org → that org; several →
 *     `400 client_required` unless `explicit` names one of them;
 *  3. else (a root member, a tenant-level grant, a personal workspace) no
 *     forced client: `explicit` if given, else none.
 * An `explicit` org that is not a non-root org of this tenant, that the caller
 * cannot write in, or that disagrees with a derived context, is the uniform 404.
 */
export async function resolveInstantiateClient(req: Request, explicit: string | undefined, writeScope: Scope = 'workspace:write'): Promise<string | undefined> {
  const tenantId = tenantOf(req);
  const refuse = (): never => { throw new OpenwopError('not_found', 'Client not found.', 404, { field: 'clientOrgId' }); };
  const isClientOrg = async (orgId: string): Promise<boolean> => {
    const org = await getOrg(orgId);
    return Boolean(org && org.tenantId === tenantId && orgId !== tenantId);
  };

  let derived: string | undefined;
  const actAs = actingMemberId(req);
  if (actAs) {
    const m = await getMember(actAs);
    if (m && m.tenantId === tenantId && !isWorkspaceRootMembership(m)) derived = m.orgId;
  }
  if (derived === undefined && !isOwnPersonalWorkspace(req) && !(await hasTenantWideClientAccess(req, tenantId))) {
    const subject = callerSubject(req);
    if (subject) {
      const mine = (await listTenantMembers(tenantId)).filter((m) => m.subject === subject);
      const atRoot = mine.some((m) => isWorkspaceRootMembership(m));
      if (!atRoot) {
        const writable: string[] = [];
        for (const m of mine) {
          if (writable.includes(m.orgId) || !(await isClientOrg(m.orgId))) continue;
          const access = await resolveEffectiveAccess(tenantId, { subject, orgId: m.orgId });
          if (access.scopes.includes(writeScope)) writable.push(m.orgId);
        }
        if (writable.length === 1) derived = writable[0];
        else if (writable.length > 1) {
          if (explicit === undefined) throw new OpenwopError('validation_error', 'Choose which client this workflow is for.', 400, { field: 'clientOrgId', reason: 'client_required' });
          if (!writable.includes(explicit)) refuse();
          return explicit;
        }
      }
    }
  }

  if (explicit !== undefined) {
    if (derived !== undefined && explicit !== derived) refuse();
    if (!(await isClientOrg(explicit))) refuse();
    if (!(await clientOrgGate(req, tenantId, writeScope)(explicit))) refuse();
    return explicit;
  }
  return derived;
}

/**
 * ADR 1132 D5 — {@link workflowClientReader} for a lane with no request: an agent
 * tool or feature surface inside a run or chat turn. Narrows only.
 *  - The run's person: its actor, else the member who caused an actorless run
 *    (`orgScopeSubject`, read as a cause). An admin of the tenant passes every
 *    client, as on the request lane; anyone else needs `workspace:read` in the
 *    client org (`assertRunOrgScope`).
 *  - No person at all (a schedule, a trigger): unstamped definitions, plus the
 *    run's OWN client (its ADR 1121 stamp), nothing else. A deliberate narrowing
 *    of ADR 0830's tenant-trusted actorless default: the content here is another
 *    client's, and tenant trust is not enough for it.
 */
export function workflowClientReaderForScope(scope: { tenantId: string; actingUserId?: string | undefined; orgScopeSubject?: string | undefined; runId?: string | undefined }): (row: Pick<WorkflowOwnershipRecord, 'clientOrgId'> | null | undefined) => Promise<boolean> {
  const subject = scope.actingUserId ?? scope.orgScopeSubject;
  const cause = scope.actingUserId === undefined && scope.orgScopeSubject !== undefined;
  let admin: Promise<boolean> | undefined;
  let runClient: Promise<string | undefined> | undefined;
  const decided = new Map<string, Promise<boolean>>();
  return async (row) => {
    const orgId = row?.clientOrgId;
    if (orgId === undefined) return true;
    if (subject === undefined) {
      runClient ??= scope.runId
        ? runClientOrgOf(scope.tenantId, scope.runId).then((s) => (s && 'orgId' in s ? s.orgId : undefined))
        : Promise.resolve(undefined);
      return (await runClient) === orgId;
    }
    admin ??= decideProtocolAuthorization(scope.tenantId, subject, 'host:members:manage').then((d) => d.allowed, () => false);
    if (await admin) return true;
    let p = decided.get(orgId);
    if (!p) {
      p = assertRunOrgScope(scope.tenantId, subject, orgId, 'workspace:read', { cause }).then(
        () => true,
        (err: unknown) => {
          if (err instanceof OpenwopError && (err.code === 'not_found' || err.code === 'forbidden_scope')) return false;
          throw err;
        },
      );
      decided.set(orgId, p);
    }
    return p;
  };
}
