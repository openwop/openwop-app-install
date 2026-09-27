/**
 * AGMEM-1 (ADR 0587 §5) — the subject-authorization predicate for a
 * caller-supplied `memoryRef`.
 *
 * THE DEFECT this closes. `routes/memory.ts` took `memoryRef` straight off the
 * query string and applied nothing but the global `authMiddleware`. A subject
 * scope is the totally-predictable `` `${kind}:${id}` `` (`subject.ts:36-38`), so
 * ANY authenticated member of a tenant — including one with zero org memberships
 * and therefore zero scopes — could issue
 * `GET …/memory?memoryRef=user:<victimUserId>` and read another person's curated
 * notes and turn summaries, or `?memoryRef=agent:<agentId>` for any agent's
 * private memory. `DELETE` was equally open. The route's own docblock said
 * *"Tenant-scoped from `req.tenantId` … never the query/body"* — true about the
 * TENANT and silent about the SUBJECT — and the SPA client repeated the same
 * reassurance.
 *
 * ONE HELPER, EVERY CALLER. The two sibling doors onto the SAME rows already
 * gated correctly, each with a different predicate because each pins its subject
 * by construction: `features/profile-memory/routes.ts` pins it to
 * `resolveCallerUser`, and `features/agent-knowledge/routes.ts` requires an
 * owned agent plus `requireTenantScope`. This module does not re-implement
 * either — it calls the SAME functions (`resolveCallerUser`, `getRosterEntry`,
 * `requireTenantScope`), so there is exactly one definition of "may this caller
 * reach this subject" and this route is no longer the odd one out.
 *
 * CORRECTED (review finding F3). The first cut of this file made that claim while
 * the `agent:` arm called `resolveEffectiveAccess(tenantId, { subject })` — NOT
 * what the sibling door calls. Three concrete consequences, all now closed:
 *
 *   1. WRONG PRIMITIVE. `resolveEffectiveAccess({ subject })` is org-scoped and
 *      FIRST-MATCH; its own docblock at `accessControlService.ts:1228` says it
 *      "is the wrong tool" for a surface that is not org-scoped, because a
 *      subject that is `viewer` in org-A and `editor` in org-B resolves to
 *      whichever membership the store returned first (non-deterministic). Memory
 *      refs are not org-scoped. `requireTenantScope` resolves the tenant-wide
 *      UNION instead.
 *   2. A FAIL-OPEN ARM. `{ subject: undefined }` does not take the member branch
 *      at all (the guard is `opts.subject !== undefined`), so it fell through to
 *      `accessControlService.ts:1298` — the tenant-owner branch — and returned
 *      OWNER_SCOPES. The old docblock said "FAIL-CLOSED by construction: the
 *      switch has no default-allow arm", which was true of the switch here and
 *      false of the predicate it delegated to. Unreachable today (only
 *      `middleware/auth.ts:716` calls `next()` with no principal, on public paths
 *      this is not one of) — but nothing asserted that, and an unasserted
 *      reachability argument is how the arm gets re-reached later.
 *      `requireTenantScope` throws 403 when `callerSubject` is absent.
 *   3. A GATE WITH NO EXIT. The WILDCARD OPERATOR principal (env API key / admin
 *      token / conformance harness) has no member row in any tenant, so it got
 *      `403 Missing required scope: workspace:read` — a scope it can never
 *      obtain, because obtaining it means a member row nothing creates for an
 *      operator token. MEASURED, not argued: 403 before, 200 after, pinned by
 *      `test/memory-endpoint.test.ts` § F3(c). `requireTenantScope` carries the
 *      documented `principal.tenants.includes('*')` short-circuit for exactly
 *      this, which is the second reason to call it rather than re-derive it.
 *
 *      SCOPED DOWN FROM THE REVIEW'S CLAIM, which also predicted this for a solo
 *      user in their own personal workspace. MEASURED FALSE on the signed-in
 *      path: a `/test/login` cookie session resolves `basis=member` with 29
 *      scopes, because ADR 0025 auto-provisioning gives a personal workspace a
 *      personal org AND an owner membership. That case returned 200 under BOTH
 *      predicates. `requireTenantScope`'s `isOwnPersonalWorkspace` short-circuit
 *      is still the right belt-and-braces (it holds when membership resolution
 *      is unavailable), but it is not what was broken, and
 *      `test/memory-ref-access-allow.test.ts` labels its personal-workspace case
 *      ANTI-ROT rather than claiming it witnesses this fix.
 *
 * WHAT THIS STILL REFUSES, deliberately: a TENANT-SCOPED (non-wildcard) API-key
 * principal has no member row and no personal workspace, so it 403s. That is not
 * an oversight of this module — it is `requireTenantScope`'s behaviour, shared
 * verbatim with the sibling agent-knowledge door. If that principal should have
 * an exit, it needs one decision in `requireTenantScope`, not a second opinion
 * here; a divergence is precisely the defect this file exists to close.
 *
 * FAIL-CLOSED: the switch has no default-allow arm (an unrecognised scope shape
 * reaches the final `else`, which permits only the tenant's own demo namespace),
 * AND the `agent:` arm's predicate is now fail-closed too.
 *
 * @see docs/adr/0587-memory-trust-provenance-and-erasure.md
 */
import type { Request } from 'express';
import { OpenwopError } from '../types.js';
import { resolveCallerUser } from '../features/users/usersGuards.js';
import { getRosterEntry } from './rosterService.js';
import type { Scope } from './accessControlService.js';
import { requireTenantScope } from '../features/featureRoute.js';
import { MEMORY_DEMO_REF } from './inMemorySurfaces.js';

/** Read vs write — an agent's memory needs `workspace:write` to be DELETED. */
export type MemoryRefAccessMode = 'read' | 'write';

const tenantOf = (req: Request): string => req.tenantId ?? 'default';

/**
 * Throw unless the caller may address `memoryRef` in this tenant.
 *
 *   `user:<id>`   — MUST be the caller's own userId. A person's memory is theirs;
 *                   there is no tenant-admin read path here, and adding one would
 *                   need its own decision (and an audit trail this route has none of).
 *   `agent:<id>`  — the agent must exist in THIS tenant (a generic 404, never an
 *                   existence leak across tenants — the `requireOwnedAgent` shape)
 *                   AND the caller must hold `workspace:read` / `workspace:write`.
 *   anything else — only the tenant's own demo namespace (`MEMORY_DEMO_REF`),
 *                   which is what the inspector page actually reads.
 */
export async function assertMemoryRefAccess(req: Request, memoryRef: string, mode: MemoryRefAccessMode): Promise<void> {
  const tenantId = tenantOf(req);
  const m = /^(user|agent):(.+)$/.exec(memoryRef);

  if (m && m[1] === 'user') {
    // The same predicate the profile-memory door pins its subject with. A
    // principal with NO user identity (an API key) can never own a `user:` scope,
    // so its throw is folded into the same 404 rather than surfacing as a 401 on
    // an already-authenticated request — the global authMiddleware has already
    // rejected genuinely-unauthenticated callers before this runs.
    let callerUserId: string | undefined;
    try {
      callerUserId = (await resolveCallerUser(req)).userId;
    } catch {
      callerUserId = undefined;
    }
    if (!callerUserId || callerUserId !== m[2]) {
      // 404, not 403: a 403 would confirm that this person's memory scope exists.
      throw new OpenwopError('not_found', 'Memory not found.', 404, { memoryRef });
    }
    return;
  }

  if (m && m[1] === 'agent') {
    const entry = await getRosterEntry(tenantId, m[2]!);
    if (!entry) {
      throw new OpenwopError('not_found', 'Agent not found.', 404, { id: m[2] });
    }
    const scope: Scope = mode === 'write' ? 'workspace:write' : 'workspace:read';
    // THE SAME CALL the sibling agent-knowledge door makes — not an equivalent
    // one. See the "CORRECTED (review finding F3)" block in the file header for
    // what the previous `resolveEffectiveAccess({ subject })` got wrong and why
    // this is the only version of the predicate that may exist.
    await requireTenantScope(req, scope);
    return;
  }

  // Everything else — including `project:<id>`, which has its OWN gated door at
  // `features/projects/routes.ts` and must not gain an ungated second one here.
  if (memoryRef !== MEMORY_DEMO_REF) {
    throw new OpenwopError('not_found', 'Memory not found.', 404, { memoryRef });
  }
}
