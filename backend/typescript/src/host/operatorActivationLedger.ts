/**
 * ADR 0910 D1/D4 — the `kicktodo-operator` activation ledger and its USE-TIME test.
 *
 * Kept apart from `operatorAccess.ts` (activation, revocation, sweep, notices) so
 * the authority resolver in `accessControlService.ts` can read it without an
 * import cycle: this module depends only on persistence and the allowlist.
 *
 * One row per (workspace, person): the CURRENT activation. Authority is decided
 * here on every resolution — expiry, revocation and de-listing all take effect at
 * the next request, and no decision waits for the sweep (D4).
 */
import { DurableCollection } from './hostExtPersistence.js';
import { isListedSuperadminTenant } from './superadmin.js';
import { createLogger } from '../observability/logger.js';
import type { Scope } from './accessControlService.js';

const log = createLogger('host.operatorActivationLedger');

/** ADR 0910 D1 — the activation-only role. NOT a `BuiltInRoleId`: it is never
 *  admitted to a member or group row (the role validators only know built-in and
 *  custom ids), and `scopesForRoles` ignores it, so a standing, non-expiring grant
 *  cannot be minted through the roster at all. Scopes are EXACTLY these two. */
export const KICKTODO_OPERATOR_ROLE = {
  id: 'kicktodo-operator',
  name: 'KickTodo operator',
  description: 'Just-in-time, time-boxed KickTodo authoring, publication and AI-key administration for an eligible superadmin. Granted only by activation.',
  scopes: ['host:kicktodo:manage', 'host:byok:manage'] as Scope[],
  builtIn: true as const,
  activationOnly: true as const,
};

export interface OperatorActivation {
  activationId: string;
  workspaceId: string;
  /** The member subject (`User.userId`) the activation is for. */
  subject: string;
  /** CORRECTION to ADR 0910 D4 — the PERSONAL tenant whose allowlist entry made
   *  the person eligible. A member subject (`user:<hash(tenant:principal)>`) is
   *  not the personal tenant id the allowlist holds (`user:<hash(iss:sub)>`), so
   *  re-checking eligibility needs THIS id, recorded at activation. */
  eligibilityTenant: string;
  justification: string;
  activatedAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokedBy?: string;
}

export const operatorActivations = new DurableCollection<OperatorActivation>(
  'workspace-operator-activation',
  (a) => `${a.workspaceId}::${a.subject}`,
  undefined,
  (a) => a.workspaceId,
);

/** D4's exact liveness test, shared by the resolver and the self-approval predicate. */
export function isActivationLive(a: OperatorActivation | null | undefined, nowMs = Date.now()): a is OperatorActivation {
  return Boolean(a)
    && !a!.revokedAt
    && Date.parse(a!.expiresAt) > nowMs
    && isListedSuperadminTenant(a!.eligibilityTenant); // eligibility re-read at USE time
}

/** The live activation for (workspace, subject), or null. A read error is ABSENT
 *  (fail-closed, RFC 0049 §C). The caller still checks root membership. */
export async function liveOperatorActivation(workspaceId: string, subject: string): Promise<OperatorActivation | null> {
  try {
    const a = await operatorActivations.get(`${workspaceId}::${subject}`);
    return isActivationLive(a) ? a : null;
  } catch (err) {
    log.error('operator activation read failed — treating as absent', { workspaceId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
