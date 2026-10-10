/**
 * ADR 0770 D1 — the workflow write authority, shared by the workflow write
 * routes (`routes/workflows.ts`) and the workflow collab ticket
 * (`host/collab/workflowCollabResource.ts`), whose room derive also registers
 * the head. One predicate so the two cannot disagree about who may write.
 */

import type { Request } from 'express';
import { OpenwopError } from '../types.js';
import { tenantOf, callerSubject, personalTenantOf, isPersonalTenantId } from './requestSubject.js';
import { credentialAuthority, keyDeclarationPermits, tenantOwnerScopes } from './protocolAuthorization.js';
import { assertTenantScope } from './accessControlService.js';
import { isConfiguredOperatorIssuerFor } from './delegatedSubject.js';

/**
 * ADR 0770 D1 (`WBWF-3`) — the ONE write gate for every workflow write verb:
 * the caller must hold `workspace:write` in the ACTIVE tenant. Before it, a
 * viewer in a shared workspace could create, overwrite, delete, archive,
 * publish and roll back its workflows — these routes checked only `tenantOf`
 * and ownership.
 *
 * Classified by PROVENANCE (`credentialAuthority`, ADR 0601 C4), the way
 * `authorizeContent` and the MCP lane do, never by the principal id string:
 * `requireTenantScope` alone refuses every `owk_` key (its principal id is
 * `apikey:<id>`, which matches no member row) and every tenant-pinned env key —
 * and the CLI drives these routes with both (architect B1).
 *
 * Enforced unconditionally: `/v1/host/openwop-app/*` is non-normative, so there
 * is no advertisement to keep honest (the CRM-6 / ADR 0627 D3 posture). Runs
 * BEFORE the ownership lookup: the refusal does not depend on the id, so it
 * leaks nothing about which ids exist.
 */
export async function requireWorkflowWrite(req: Request): Promise<void> {
  return requireWorkflowScope(req, 'workspace:write');
}

/**
 * ADR 0773 D2 — the READ twin of {@link requireWorkflowWrite}: the same
 * provenance classification, asking for `workspace:read`. The builder-pair
 * context route uses it (a viewer may pair read-only, ADR 0773 A6).
 */
export async function requireWorkflowRead(req: Request): Promise<void> {
  return requireWorkflowScope(req, 'workspace:read');
}

/**
 * ADR 0773 A5 — the SCOPE-SHAPED form of the same gate, for callers that hold a
 * tool scope rather than an HTTP request (chat-time agent tools). A tool always
 * acts for a HUMAN acting user (it has no `owk_` key or tenant-owner credential
 * to classify), so it reduces to the subject branch of the request gate:
 * `assertTenantScope` with the personal-tenant owner short-circuit. Returns a
 * boolean — a tool reports a refusal, it does not throw one.
 *
 * Host-owned, not feature-local, because ADR 0770 P2 (`WBWF-17`) needs exactly
 * this check for every AI write lane — ADR 0822 D1 wires it into the model
 * write doors (the Architect's `persist`, the in-run `persistDraft`,
 * `compose-and-run` when a person is behind the turn, and `POST
 * …/workflow-author/draft` via the request twin) and D5 into approving a
 * composed-workflow proposal. `propose` itself is deliberately NOT gated: it
 * only creates a request, which that approval check decides.
 * `apikey:<id>` actors resolve through their issuer inside `assertTenantScope`
 * (ADR 0795 D1); `bearer:<8>` operator keys take the branch below.
 */
export async function hasWorkflowScope(
  who: { tenantId: string; actingUserId?: string | undefined; personalTenant?: string | undefined },
  scope: 'workspace:read' | 'workspace:write',
): Promise<boolean> {
  if (!who.actingUserId) return false;
  // ADR 0822 D1 (architect B2) — an operator env key's run is stamped with its
  // `bearer:<8>` principal as the actor (`features/workflow-author/routes.ts`), which
  // no member row can match. While that key is still configured it is the
  // tenant's own principal — the reading `credentialAuthority` gives the request
  // lane (ADR 0601 C4) — so a run the route admitted is not refused mid-run.
  // BOUND to this tenant (grade-code WFAC-17): a key configured for tenant A is
  // nobody in tenant B, and a run actor has no delegation row to say so.
  if (isConfiguredOperatorIssuerFor(who.actingUserId, who.tenantId)) {
    return (await tenantOwnerScopes(who.tenantId)).includes(scope);
  }
  try {
    await assertTenantScope(who.tenantId, who.actingUserId, scope, {
      ...(who.personalTenant !== undefined ? { personalTenant: who.personalTenant } : {}),
    });
    return true;
  } catch (err) {
    if (err instanceof OpenwopError && err.httpStatus === 403) return false;
    throw err;
  }
}

async function requireWorkflowScope(req: Request, scope: 'workspace:read' | 'workspace:write'): Promise<void> {
  const refuse = (): never => {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope });
  };
  if (req.principal?.tenants?.includes('*') === true) return; // wildcard operator
  const tenantId = tenantOf(req);
  const personalTenant = personalTenantOf(req);
  const authority = req.principal
    ? credentialAuthority(req.principal, callerSubject(req))
    : { source: 'subject' as const, subject: callerSubject(req) };
  if (authority.source === 'tenant-owner') {
    if ((await tenantOwnerScopes(tenantId)).includes(scope)) return;
    return refuse();
  }
  if (req.principal?.auth?.kind === 'api-key') {
    // An `owk_` key: its DECLARED scopes bound it, and its ISSUER is the subject.
    if (!keyDeclarationPermits(req.principal.auth.scopes, scope)) return refuse();
    // The key is pinned at mint to its issuer's ACTIVE tenant, and a personal
    // tenant is single-principal by construction (`isPersonalTenantId`), so a key
    // living in one was minted by that workspace's implicit owner.
    if (isPersonalTenantId(tenantId)) return;
  }
  await assertTenantScope(tenantId, authority.subject, scope, {
    ...(personalTenant !== undefined ? { personalTenant } : {}),
  });
}

/**
 * ADR 0822 D1 — the throwing form of {@link hasWorkflowScope} for the MODEL write
 * doors (the Architect's `persist`, the in-run `persistDraft`,
 * `compose-and-run`). One refusal, one message: it names the role problem and
 * the remedy, so an agent relaying it tells a person something they can act on.
 * A run or turn with no acting user is refused too (the ADR 0775 D7 posture) —
 * a model writing workflows with nobody accountable is the case this exists for.
 */
export async function assertModelWorkflowWrite(who: {
  tenantId: string;
  actingUserId?: string | undefined;
  personalTenant?: string | undefined;
}): Promise<void> {
  if (await hasWorkflowScope(who, 'workspace:write')) return;
  throw new OpenwopError(
    'forbidden_scope',
    who.actingUserId
      ? 'You can view this workspace but not change its workflows. An Editor can — ask a workspace admin for edit access.'
      : 'Changing a workflow needs a signed-in person behind the request, and this one has none.',
    403,
    { requiredScope: 'workspace:write' },
  );
}
