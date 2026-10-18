/**
 * ADR 0896 D1/D2 — who may change a mission contract, and which changes are legal.
 * ONE home for both lanes: the REST routes and the `draft-contract` agent tool call
 * these, so the tool can never be looser than its route (CLAUDE.md exchange rule).
 *
 *  - EDIT (draft, PUT, the agent's draft): `workspace:write` in the tenant (ADR 0136
 *    §8, the ADR 0879 D1 Viewer rule — and what refuses a removed member), plus the
 *    conversation's owner when it has one. An ownerless conversation stays editable by
 *    any visible writer (the ADR 0132 scope-PUT precedent): a draft governs nothing.
 *  - DECIDE (approve, reject): `workspace:write` AND the principal the conversation's
 *    tools act as — `toolAuthorityHolds(actor, owner)`, the predicate the per-tool
 *    approvals route uses (ADR 0834 D3). On an OWNERLESS conversation nobody holds
 *    that, so a tenant admin (`host:members:manage`, the ADR 0879 D4 manager of last
 *    resort) decides; "nobody" would make an approved mission permanent.
 *
 * @see docs/adr/0896-intent-ledger-approval-authority.md
 */
import { OpenwopError } from '../../types.js';
import { assertTenantScope } from '../../host/accessControlService.js';
import { toolAuthorityHolds } from '../../host/conversationVisibility.js';
import type { ConversationMeta } from '../../host/conversationStore.js';
import type { IntentLedgerStatus } from './types.js';

/** Whether a subject holds a tenant scope — `assertTenantScope`, the ONE predicate,
 *  read as a boolean. `ctx` carries the request facts the route lane threads
 *  (`requireTenantScope`) and the tool lane reads from its scope. */
export async function holdsTenantScope(
  tenantId: string,
  subject: string | undefined,
  scope: 'workspace:write' | 'host:members:manage',
  ctx: { personalTenant?: string; wildcardOperator?: boolean },
): Promise<boolean> {
  try { await assertTenantScope(tenantId, subject, scope, ctx); return true; }
  catch (err) { if (err instanceof OpenwopError && err.code === 'forbidden_scope') return false; throw err; }
}

export interface LedgerAuthority { mayEdit: boolean; mayDecide: boolean }

/** What `actor` may do with this conversation's mission. Visibility is checked by the
 *  caller first (an invisible conversation is a 404, never a 403). `actor` is the
 *  `req.userId ?? principalId` spelling on BOTH lanes — the key `ownerUserId` was
 *  stamped with, the run's `actingUserId`, and `callerSubject(req)`. */
export async function ledgerAuthorityOf(
  tenantId: string,
  meta: ConversationMeta,
  actor: string | undefined,
  ctx: { personalTenant?: string; wildcardOperator?: boolean },
): Promise<LedgerAuthority> {
  if (!actor || !(await holdsTenantScope(tenantId, actor, 'workspace:write', ctx))) return { mayEdit: false, mayDecide: false };
  if (meta.ownerUserId) {
    const isOwner = toolAuthorityHolds(actor, meta.ownerUserId);
    return { mayEdit: isOwner, mayDecide: isOwner };
  }
  return { mayEdit: true, mayDecide: await holdsTenantScope(tenantId, actor, 'host:members:manage', ctx) };
}

/** ADR 0896 D1 — the legal transitions. Anything else is a 409: an approved mission is
 *  revoked (reject) before it is redrafted, and only a draft is approved. */
const LEGAL: Record<'draft' | 'approved' | 'rejected', readonly (IntentLedgerStatus | 'none')[]> = {
  draft: ['none', 'draft', 'rejected', 'expired'],
  approved: ['draft'],
  rejected: ['draft', 'approved'],
};

export function assertTransition(from: IntentLedgerStatus | undefined, to: 'draft' | 'approved' | 'rejected'): void {
  const f = from ?? 'none';
  if (LEGAL[to].includes(f)) return;
  const message = to === 'draft'
    ? 'An approved mission governs this conversation — revoke it before drafting a new one.'
    : `A ${f} mission cannot be ${to === 'approved' ? 'approved' : 'rejected'}.`;
  throw new OpenwopError('conflict', message, 409, { reason: 'illegal_transition', from: f, to });
}

/** ADR 0896 D1 — the 409 every lost compare-and-swap or stale revision returns. */
export function ledgerChanged(): OpenwopError {
  return new OpenwopError('conflict', 'This mission changed since you reviewed it — review it again.', 409, { reason: 'ledger_changed' });
}
