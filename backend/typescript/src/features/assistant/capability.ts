/**
 * The `assistant` capability — core-agent level, activated per named agent.
 *
 * **Architecture law (David, 2026-06-13):** nothing may be unique to a named
 * agent in source. The operating-rhythm capability (structured memory graph +
 * perception loops + action drafting/approval, ADR 0023) historically embodied
 * by the Chief of Staff (Iris) was *fused* to `roleKey === 'chief-of-staff'`
 * (`ensureAssistantAgent` (this module), the loops, the action-approval
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
import { createLogger } from '../../observability/logger.js';
import { OpenwopError, type AgentCapabilityId } from '../../types.js';

const log = createLogger('features.assistant.capability');

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
    // COS-13 — a bootstrap failure is where "draft an action" / "enable a loop"
    // 500s on a white-label install with no seedable agent (COS-15); it must
    // never be silent.
    log.error('assistant_capability_bootstrap_failed', { tenantId, roleKey: DEFAULT_ASSISTANT_SEED_ROLE });
    // COS-15 — a TYPED refusal, not a bare Error. This is the shape a white-label
    // install hits: seeding is capability-gated under the enterprise posture, so
    // `ensureSeededAgentByRole` returns null and every attempt to draft an action
    // (`enqueueActionWithApproval`) or enable a loop (`loops.ts enableLoop`) reached
    // the generic handler as an opaque 500 with no operator guidance. An
    // `OpenwopError` with a 409 (`conflict`) status bubbles through the HTTP lane
    // as a typed envelope naming the remedy — matching how the agent-tool lane
    // already degrades gracefully (`agentTools.ts` reads `e.code`). `conflict` is a
    // real member of `OpenwopErrorCode` (the tracker's suggested `failed_precondition`
    // is not — same substitution the COS-5 fix made): the workspace state (no
    // seedable/activated assistant agent) conflicts with the requested action.
    throw new OpenwopError(
      'conflict',
      `No assistant-capability agent exists for this workspace and no '${DEFAULT_ASSISTANT_SEED_ROLE}' agent could be seeded to bootstrap one. Activate the 'assistant' capability on a roster agent (or seed one) before drafting actions or enabling loops.`,
      409,
      { capability: ASSISTANT_CAPABILITY, roleKey: DEFAULT_ASSISTANT_SEED_ROLE },
    );
  }
  await activateAgentCapability(tenantId, entry.rosterId, ASSISTANT_CAPABILITY, {
    roleKey: entry.roleKey ?? DEFAULT_ASSISTANT_SEED_ROLE,
    autonomy: { specLevel: 'recommend' },
  });
  return entry;
}

// ADR 0662 D4 — `agentHasAssistantCapability` was DELETED here (zero callers).
//
// It read like a permission gate and was not one. Per ADR 0023 §Correction the
// capability's runtime contract is agent RESOLUTION — "the runtime (loops/approvals)
// resolves the acting/writing agent by this capability, never by `roleKey`" — and that
// mechanism is `findAssistantAgent` / `listCapabilityAgents` below, consumed by
// `actionApproval.ts` and `loops.ts`. It is wired and load-bearing.
//
// Wiring the deleted predicate as a gate (this ADR's first draft) would have been
// BREAKING: the read lane's caller is a human, so there is no rosterId to test; the tool
// lane already has its ADR 0458 parity gate with reads failing empty; and it would have
// revoked reads for exactly the white-label tenants documented above as having no
// seedable agent. A predicate that reads like a gate and is not one is worse than none,
// because the next reader trusts it.

// Back-compat: a read-only lookup that does not bootstrap (used by tests +
// surfaces that only want to know if an assistant agent already exists).
export { findSeededAgentByRole as __findSeededAgentByRole };
