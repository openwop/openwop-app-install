/**
 * The `coaching` capability — core-agent level, activated per named agent
 * (ADR 0442 P1). Mirrors `features/assistant/capability.ts`.
 *
 * **Architecture law (David):** nothing may be unique to a named agent in
 * source. KickBot's guide behavior (daily-plan coordination, next-step
 * explanation, recovery help — PRD §6.8) is NOT fused to `roleKey ===
 * 'kicktodo-guide'`; it is this CORE capability, which any agent activates via
 * `AgentProfile.capabilities`. The runtime that reads it (P2 daily-coach
 * presentation, P5 specialist dispatch) resolves the coaching agent by THIS
 * capability — never by `roleKey`.
 *
 * Resolution is over host primitives (roster + profile) so this carries no
 * cross-feature import; it does not re-use the assistant resolver (that would
 * make kicktodo-core depend up into the assistant feature — ADR 0001).
 */
import { listRoster, type RosterEntry } from '../../host/rosterService.js';
import { getAgentProfile } from '../../host/agentProfileService.js';
import type { AgentCapabilityId } from '../../types.js';

export const COACHING_CAPABILITY: AgentCapabilityId = 'coaching';

/** Deterministic primary when several agents hold the capability (replay-stable:
 *  earliest `createdAt`, then `rosterId`). */
function primaryOf(entries: RosterEntry[]): RosterEntry {
  return [...entries].sort(
    (a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.rosterId < b.rosterId ? -1 : 1),
  )[0]!;
}

/** Every roster agent in the tenant whose profile has the coaching capability. */
export async function listCoachingAgents(tenantId: string): Promise<RosterEntry[]> {
  const roster = await listRoster(tenantId);
  const out: RosterEntry[] = [];
  for (const entry of roster) {
    const profile = await getAgentProfile(tenantId, entry.rosterId);
    if (profile?.capabilities?.includes(COACHING_CAPABILITY)) out.push(entry);
  }
  return out;
}

/** Read-only: the tenant's canonical coaching agent, or null. Pure capability
 *  resolution — no `roleKey`, no creation. */
export async function findCoachingAgent(tenantId: string): Promise<RosterEntry | null> {
  const capable = await listCoachingAgents(tenantId);
  return capable.length ? primaryOf(capable) : null;
}
