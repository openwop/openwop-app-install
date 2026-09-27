/**
 * ADR 0379 Phase 1 — the ONE tenant-visibility rule for registry agents.
 *
 * Before this module, two route files each hand-rolled `visibleTo` (they had
 * already drifted on wildcard handling) and three binding surfaces (scheduled
 * chats, channel membership) resolved agents with NO tenant gate at all —
 * letting a tenant bind ANOTHER tenant's `user.*` agent by id. Every consumer
 * of "can this tenant see/use this agent?" now delegates here, so the rule
 * cannot drift and cannot be forgotten on a new resolve call site.
 *
 * The rule: pack agents (no `ownerTenant`) are global; a user-authored agent
 * is visible only to its owning tenant; the explicit `'*'` wildcard is the
 * admin escape hatch (callers pass it only from a wildcard-principal path,
 * never from a plain session — see routes/agents.ts `tenantForInventory`).
 */

import { getAgentRegistry, type ResolvedAgentManifest } from '../executor/agentRegistry.js';

export function agentVisibleToTenant(a: ResolvedAgentManifest, tenant: string | undefined): boolean {
  if (!a.ownerTenant) return true;
  if (tenant === '*') return true;
  return a.ownerTenant === tenant;
}

/** Fail-closed resolve: null for both "doesn't exist" and "exists but belongs
 *  to another tenant", so callers cannot distinguish the two (no existence
 *  oracle) and cannot accidentally use a cross-tenant manifest.
 *  ADR 0379 P2: the registry itself is (tenant, agentId)-keyed for user
 *  agents, so the tenant rides the resolve; the visibility check remains for
 *  the pack-agent (global) case and the explicit '*' admin wildcard, which
 *  scans the full list (rare admin path — the composite key has no owner to
 *  try). */
export async function resolveAgentForTenant(agentId: string, tenant: string | undefined): Promise<ResolvedAgentManifest | null> {
  if (tenant === '*') {
    const reg = getAgentRegistry();
    const pack = await reg.resolve(agentId); // tenant-less ⇒ pack agents only
    if (pack) return pack;
    // Grade-pass fix: post-ADR-0379 the same `user.<slug>` id can belong to
    // MANY tenants — an arbitrary-pick here would let the wildcard dispatch
    // path run an arbitrary tenant's systemPrompt. Resolve only when the id is
    // UNAMBIGUOUS; an ambiguous id is null (the caller must name a tenant).
    const matches = reg.list().filter((a) => a.agentId === agentId);
    return matches.length === 1 ? matches[0]! : null;
  }
  const a = await getAgentRegistry().resolve(agentId, tenant);
  return a && agentVisibleToTenant(a, tenant) ? a : null;
}
