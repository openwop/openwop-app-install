/**
 * ADR 0775 P3 (`ARWF-7`) — the dispatch policy for AUTONOMOUS runs of a roster
 * agent: a run that no person started (a schedule slot, a scheduled chat, a
 * follow-up the agent set itself, an approved proposal).
 *
 * Before this, roster `enabled:false` stopped only the heartbeat, "check now" and
 * the kanban trigger; every scheduler lane kept dispatching a paused agent, which
 * is the "agent keeps running after I turned it off" failure. Those lanes now ask
 * here. User-initiated chat is NOT routed through this (a person talking to an
 * agent is a test pane, ADR 0775 P3), and an id that is not a roster agent is
 * allowed: the gate is about the roster's switch, nothing else.
 *
 * The roster row is read fresh (`getRosterEntry`), never from the 30 s reverse
 * cache in `agentIdentity`, so a pause takes effect on the next fire.
 */
import { resolveAgentIdentity } from './agentIdentity.js';
import { getRosterEntry, type RosterEntry } from './rosterService.js';
import { getAgentProfile } from './agentProfileService.js';
import { resolveAgentPolicy } from './agentPolicyResolver.js';

export type AutonomousDispatchVerdict =
  | { allowed: true; entry?: RosterEntry }
  | { allowed: false; reason: 'agent-paused' | 'policy-denied'; rosterId: string }
  /** The workflow is on the agent's `hitl` list: propose it, never run it directly. */
  | { allowed: false; reason: 'needs-approval'; entry: RosterEntry };

/**
 * Whether `ref` (a rosterId or a registry agentId) may run autonomously in
 * `tenantId`, and, when `actionClass` (the workflowId about to run) is given,
 * whether the agent's EXPLICIT per-workflow rules allow it.
 *
 * ADR 0775 P3b (user decision 2026-10-15, "explicit rules only"): on these lanes
 * only the two rules a person wrote down for a named workflow apply, through the
 * same `resolveAgentPolicy` the heartbeat uses: `permissions.never` → refused,
 * `hitl` → proposed for approval. The autonomy LEVEL, the `withinPolicyActions`
 * allowlist and the connection-readiness hold stay heartbeat-only: they govern
 * what an agent picks up by itself, and a person who created a schedule already
 * authorized it.
 */
export async function autonomousDispatchVerdict(tenantId: string, ref: string, actionClass?: string): Promise<AutonomousDispatchVerdict> {
  const identity = await resolveAgentIdentity(tenantId, ref, { allowReverseScan: true });
  if (!identity.rosterId) return { allowed: true };
  const entry = await getRosterEntry(tenantId, identity.rosterId);
  if (!entry) return { allowed: true };
  if (!entry.enabled) return { allowed: false, reason: 'agent-paused', rosterId: entry.rosterId };
  if (actionClass !== undefined) {
    const { reason } = resolveAgentPolicy({ profile: await getAgentProfile(tenantId, entry.rosterId), actionClass });
    if (reason === 'permissions.never') return { allowed: false, reason: 'policy-denied', rosterId: entry.rosterId };
    if (reason === 'hitl') return { allowed: false, reason: 'needs-approval', entry };
  }
  return { allowed: true, entry };
}

/** The agent a scheduled job runs as, in precedence order: the roster member it is
 *  bound to, its agent id, then the agent its run inputs name (`configurable.agentId`,
 *  which the agent-runner node reads). `undefined` = the job runs no agent. */
export function jobAgentRef(job: {
  rosterId?: string;
  agentId?: string;
  configurable?: Record<string, unknown>;
}): string | undefined {
  if (job.rosterId) return job.rosterId;
  if (job.agentId) return job.agentId;
  const fromRun = job.configurable?.agentId;
  return typeof fromRun === 'string' && fromRun !== '' ? fromRun : undefined;
}
