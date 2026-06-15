/**
 * The `assistant` capability — core-agent level, activated per named agent.
 *
 * **Architecture law (David, 2026-06-13):** nothing may be unique to a named
 * agent in source. The operating-rhythm capability (structured memory graph +
 * perception loops + action drafting/approval, ADR 0023) historically embodied
 * by the Chief of Staff (Iris) was *fused* to `roleKey === 'chief-of-staff'`
 * (`chiefOfStaff.ts ensureChiefOfStaff`, the loops, the action-approval
 * attribution) — a violation. It now lives here as a CORE capability that any
 * agent activates via `AgentProfile.capabilities` (ADR 0031). Iris is just an
 * agent with it activated; Executive Operations is another. There is no "Iris's
 * graph," only the tenant work-graph any capability-activated agent operates on.
 *
 * The runtime (loops/approvals) resolves the acting/writing agent by this
 * capability — NEVER by `roleKey`.
 */

import { listRoster, type RosterEntry } from '../../host/rosterService.js';
import { ensureSeededAgentByRole, findSeededAgentByRole } from '../../host/exampleDataSeed.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { getAgentProfile, activateAgentCapability } from '../../host/agentProfileService.js';
import type { AgentCapabilityId } from '../../types.js';

/** The operating-rhythm capability id (memory graph + loops + action drafting). */
export const ASSISTANT_CAPABILITY: AgentCapabilityId = 'assistant';

/**
 * The demo seed's DEFAULT holder of the assistant capability — a BOOTSTRAP
 * default only, for back-compat self-heal on tenants seeded before the
 * capability flag existed (and before the T2.A seed sets it declaratively).
 * It is NOT a runtime gate: resolution below is purely capability-driven; this
 * constant is used solely to ensure+activate a default holder when a tenant has
 * no capability-activated agent yet. Once every seed/tenant carries the flag in
 * data, this fallback is dead and can be removed.
 */
const DEFAULT_ASSISTANT_SEED_ROLE = 'chief-of-staff';

/** Deterministic primary pick when several agents have the capability (stable
 *  across runs for replay safety): earliest `createdAt`, then `rosterId`. */
function primaryOf(entries: RosterEntry[]): RosterEntry {
  return [...entries].sort(
    (a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.rosterId < b.rosterId ? -1 : 1),
  )[0]!;
}

/** Every roster agent in the tenant whose profile has `capability` activated. */
export async function listCapabilityAgents(
  tenantId: string,
  capability: AgentCapabilityId,
): Promise<RosterEntry[]> {
  const roster = await listRoster(tenantId);
  const out: RosterEntry[] = [];
  for (const entry of roster) {
    const profile = await getAgentProfile(tenantId, entry.rosterId);
    if (profile?.capabilities?.includes(capability)) out.push(entry);
  }
  return out;
}

/** Read-only: the tenant's canonical assistant-capability agent, or null. Pure
 *  capability resolution — no `roleKey`, no creation. */
export async function findAssistantAgent(tenantId: string): Promise<RosterEntry | null> {
  const capable = await listCapabilityAgents(tenantId, ASSISTANT_CAPABILITY);
  return capable.length ? primaryOf(capable) : null;
}

/**
 * The agent the assistant runtime attributes a loop/approval to: the canonical
 * capability-activated agent. If none exists yet (a tenant seeded before the
 * flag), bootstrap the default holder and self-heal its profile to carry the
 * capability — so subsequent resolution is pure-capability. Throws only if the
 * default seed spec is missing (a build/seed misconfiguration).
 */
export async function ensureAssistantAgent(tenantId: string): Promise<RosterEntry> {
  const existing = await findAssistantAgent(tenantId);
  if (existing) return existing;

  // Back-compat bootstrap: ensure the default holder exists, then ACTIVATE the
  // capability on its profile (data), so the very next resolution is by
  // capability — not by this fallback.
  const entry = await ensureSeededAgentByRole(tenantId, hostExtStorage(), DEFAULT_ASSISTANT_SEED_ROLE);
  if (!entry) {
    throw Object.assign(
      new Error(`no '${DEFAULT_ASSISTANT_SEED_ROLE}' agent spec to bootstrap the assistant capability`),
      { code: 'assistant_capability_bootstrap_missing' },
    );
  }
  await activateAgentCapability(tenantId, entry.rosterId, ASSISTANT_CAPABILITY, {
    roleKey: entry.roleKey ?? DEFAULT_ASSISTANT_SEED_ROLE,
    autonomy: { specLevel: 'recommend' },
  });
  return entry;
}

/** True if this roster entry has the assistant capability activated. */
export async function agentHasAssistantCapability(tenantId: string, rosterId: string): Promise<boolean> {
  const profile = await getAgentProfile(tenantId, rosterId);
  return Boolean(profile?.capabilities?.includes(ASSISTANT_CAPABILITY));
}

// Back-compat: a read-only lookup that does not bootstrap (used by tests +
// surfaces that only want to know if an assistant agent already exists).
export { findSeededAgentByRole as __findSeededAgentByRole };
