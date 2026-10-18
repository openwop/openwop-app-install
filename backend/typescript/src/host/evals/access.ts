/**
 * ADR 0889 post-merge review H1 + M3 — the ONE access predicate for agent evals.
 *
 * The `evals` toggle (ADR 0820 §8.2, Governance bundle) gates "the AI judge… the
 * part that spends". Until this module it was enforced only by the SPA: the
 * host-extension routes, the `POST /runs {mode:"eval"}` branch, the chat tools
 * and the resume sweep all ran with it off, so a plan without `evals` could
 * still create suites and spend judge calls. Every one of those surfaces now
 * calls a function below, and a tool calls the SAME function as its route
 * (CLAUDE.md: a tool shares its route's access predicate).
 *
 * `resolveOne` is the access resolver (toggle AND plan, ADR 0819 §1), fail-closed:
 * a resolver throw is "unavailable", never "enabled".
 */
import { OpenwopError } from '../../types.js';
import { resolveOne } from '../featureToggles/service.js';
import type { ResolvedAssignment } from '../featureToggles/types.js';
import { assertTenantScope, type Scope } from '../accessControlService.js';

export const AGENT_EVALS_FEATURE_ID = 'evals';

export type AgentEvalsRefusal = 'feature_disabled' | 'not_entitled' | 'feature_unavailable';

export interface AgentEvalsSubject {
  tenantId: string;
  userId?: string;
}

async function access(subject: AgentEvalsSubject): Promise<ResolvedAssignment | null> {
  return resolveOne(AGENT_EVALS_FEATURE_ID, {
    tenantId: subject.tenantId,
    ...(subject.userId ? { userId: subject.userId } : {}),
  }).catch(() => null);
}

/** `null` when agent evals may run for this subject, else why not. */
export async function agentEvalsRefusal(subject: AgentEvalsSubject): Promise<AgentEvalsRefusal | null> {
  const a = await access(subject);
  if (a?.enabled) return null;
  if (a?.blockedBy === 'plan') return 'not_entitled';
  if (a === null || a.blockedBy === 'unresolved') return 'feature_unavailable';
  return 'feature_disabled';
}

const MESSAGES: Record<AgentEvalsRefusal, string> = {
  feature_disabled: 'Agent evals are not enabled for this workspace.',
  not_entitled: 'Agent evals are not included in this workspace\'s plan.',
  feature_unavailable: 'Agent evals could not be checked right now; try again shortly.',
};

/** Throws the typed refusal (403, or 503 when the resolver faulted). */
export async function requireAgentEvalsEnabled(subject: AgentEvalsSubject): Promise<void> {
  const refusal = await agentEvalsRefusal(subject);
  if (refusal === null) return;
  throw new OpenwopError(
    'forbidden',
    MESSAGES[refusal],
    refusal === 'feature_unavailable' ? 503 : 403,
    { feature: AGENT_EVALS_FEATURE_ID, reason: refusal },
  );
}

/** The tool-side form: the same predicate, returned as the tool's typed error. */
export async function agentEvalsToolRefusal(subject: AgentEvalsSubject): Promise<{ error: AgentEvalsRefusal; message: string } | null> {
  const refusal = await agentEvalsRefusal(subject);
  return refusal === null ? null : { error: refusal, message: MESSAGES[refusal] };
}

/**
 * M3 — the chat tools' gate: the feature check above PLUS the tenant scope the
 * matching route requires (`workspace:read` for the read tools, `workspace:write`
 * for `run`, the scope every suite/capture write route requires). Uses the
 * Request-free `assertTenantScope`, the predicate `requireTenantScope` wraps, so
 * a tool cannot be laxer than its route. `null` = allowed.
 */
export async function agentEvalsToolGate(
  scope: { tenantId: string; actingUserId?: string; personalTenant?: string },
  needed: Scope,
): Promise<{ error: string; message: string } | null> {
  const refusal = await agentEvalsToolRefusal({ tenantId: scope.tenantId, ...(scope.actingUserId ? { userId: scope.actingUserId } : {}) });
  if (refusal) return refusal;
  try {
    await assertTenantScope(scope.tenantId, scope.actingUserId, needed, scope.personalTenant ? { personalTenant: scope.personalTenant } : {});
    return null;
  } catch (err) {
    if (err instanceof OpenwopError) return { error: err.code, message: err.message };
    throw err;
  }
}
