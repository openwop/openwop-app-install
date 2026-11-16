/**
 * ADR 1121 / ADR 1132 — the ONE client-org floor a request answers to, for
 * anything that is FOR a client: a run (ADR 1121) or a workflow definition
 * (ADR 1132). Lifted out of `runClientAccess.ts` so the two resources cannot
 * drift.
 *
 * The rule, decided once per request:
 *  - the tenant-level grants of the #4543 payload rule pass every client:
 *    a wildcard principal, the caller's own personal workspace, a tenant where
 *    membership does not define presence, and a tenant admin
 *    (`host:members:manage`). That is `runPayloadAccess`, reused;
 *  - anyone else needs `scope` IN the client org (`assertOrgScope`), resolved
 *    live: one membership resolve per distinct org, cached for the request.
 * Both are lazy: a caller who never meets a stamped resource pays nothing.
 */
import type { Request } from 'express';
import { OpenwopError } from '../types.js';
import { assertOrgScope, type Scope } from './accessControlService.js';
import { callerSubject, tenantOf } from './requestSubject.js';
import { runPayloadAccess } from './runPayloadAccess.js';

/** `(clientOrgId) => may this request act on that client with `scope`?` */
export function clientOrgGate(req: Request, tenantId: string = tenantOf(req), scope: Scope): (orgId: string) => Promise<boolean> {
  const subject = callerSubject(req);
  let tenantWide: Promise<boolean> | undefined;
  const decided = new Map<string, Promise<boolean>>();
  return async (orgId) => {
    tenantWide ??= runPayloadAccess(req, tenantId).then((a) => a.all);
    if (await tenantWide) return true;
    let p = decided.get(orgId);
    if (!p) {
      p = subject === undefined
        ? Promise.resolve(false)
        : assertOrgScope(tenantId, subject, orgId, scope).then(
            () => true,
            (err: unknown) => {
              if (err instanceof OpenwopError && (err.code === 'not_found' || err.code === 'forbidden_scope')) return false;
              throw err; // a storage error is not "you may not": surface it
            },
          );
      decided.set(orgId, p);
    }
    return p;
  };
}

/** Whether the tenant-level grants apply to this request (no org is needed). */
export async function hasTenantWideClientAccess(req: Request, tenantId: string = tenantOf(req)): Promise<boolean> {
  return (await runPayloadAccess(req, tenantId)).all;
}
