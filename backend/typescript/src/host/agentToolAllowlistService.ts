/**
 * Agent tool-allowlist override — host extension (ADR 0104).
 *
 * A super-admin-set, per-(tenant, agentId) FULL-REPLACE override of an agent's
 * RFC 0003 `toolAllowlist`, applied at the model-offering dispatch chokepoints
 * (`runAgentDispatchLive` + the chat tool-loop) so an operator can grant or revoke
 * an agent's tools WITHOUT editing + redeploying a (signed) pack. The agent's
 * ADVERTISED manifest is unchanged — this is host-local dispatch policy, not a
 * manifest mutation (so no OpenWOP RFC; see the ADR § "Honesty / wire").
 *
 * Sibling to `resolveAgentToolPermissions` (ADR 0102, agentProfileService): that
 * gates per-tool EXECUTION (entitlement); this gates per-tool OFFERING (which tools
 * the model is shown). Distinct layers — this module owns offering.
 *
 * Persistence rides the existing `DurableCollection` seam (no new store — ADR 0031
 * precedent), keyed `${tenantId}:${agentId}` so a GLOBAL pack agent's override never
 * leaks across tenants. Unlike `resolveAgentToolPermissions`, there is deliberately
 * NO `host:`-only guard: the override MUST resolve for pack agentIds too (e.g.
 * `feature.assistant.agents.chief-of-staff`, which is exactly the first consumer —
 * granting the Chief of Staff a tool). Cross-tenant reads fail closed.
 *
 * @see docs/adr/0104-superadmin-agent-toolallowlist-editor.md
 * @see src/host/agentProfileService.ts — the sibling per-(tenant,agentId) tool policy
 */

import { DurableCollection } from './hostExtPersistence.js';

export interface AgentToolAllowlistOverride {
  /** `${tenantId}:${agentId}` — the DurableCollection key (tenant-prefixed so a
   *  global pack agent's override is per-tenant). */
  overrideId: string;
  tenantId: string;
  agentId: string;
  /** FULL replacement set (`openwop:<typeId>` ids). `[]` = "this agent gets no tools". */
  toolAllowlist: string[];
  /** Operator rationale (audit). */
  note?: string;
  updatedBy: string;
  updatedAt: string;
}

const overrides = new DurableCollection<AgentToolAllowlistOverride>(
  'agent-toolallowlist-override',
  (o) => o.overrideId,
);

const keyOf = (tenantId: string, agentId: string): string => `${tenantId}:${agentId}`;
const nowIso = (): string => new Date().toISOString();

/**
 * The effective override tool list for `(tenantId, agentId)`, or `undefined` when
 * none is set — the caller then falls back to the agent's manifest `toolAllowlist`.
 * Fail-closed cross-tenant. This is the hot-path read used at dispatch.
 */
export async function resolveAgentToolAllowlistOverride(tenantId: string, agentId: string): Promise<string[] | undefined> {
  const row = await overrides.get(keyOf(tenantId, agentId));
  if (!row || row.tenantId !== tenantId) return undefined;
  return row.toolAllowlist;
}

/** The full override record (admin read), or `null`. Fail-closed cross-tenant. */
export async function getAgentToolAllowlistOverride(tenantId: string, agentId: string): Promise<AgentToolAllowlistOverride | null> {
  const row = await overrides.get(keyOf(tenantId, agentId));
  return row && row.tenantId === tenantId ? row : null;
}

/** Every override set in `tenantId` (admin list view). Tenant-equality-filtered so a
 *  prefix over-match (a tenant id that is a prefix of another) can never leak. */
export async function listAgentToolAllowlistOverrides(tenantId: string): Promise<AgentToolAllowlistOverride[]> {
  return (await overrides.listForTenant(tenantId)).filter((o) => o.tenantId === tenantId);
}

/** Create-or-replace the override for `(tenantId, agentId)` — full-replace semantics. */
export async function upsertAgentToolAllowlistOverride(
  tenantId: string,
  agentId: string,
  input: { toolAllowlist: string[]; note?: string; updatedBy: string },
): Promise<AgentToolAllowlistOverride> {
  const row: AgentToolAllowlistOverride = {
    overrideId: keyOf(tenantId, agentId),
    tenantId,
    agentId,
    toolAllowlist: [...input.toolAllowlist],
    ...(input.note ? { note: input.note } : {}),
    updatedBy: input.updatedBy,
    updatedAt: nowIso(),
  };
  await overrides.put(row);
  return row;
}

/** Clear the override (revert the agent to its manifest allowlist). Returns `false`
 *  when no override existed. Fail-closed cross-tenant. */
export async function clearAgentToolAllowlistOverride(tenantId: string, agentId: string): Promise<boolean> {
  if (!(await getAgentToolAllowlistOverride(tenantId, agentId))) return false;
  await overrides.delete(keyOf(tenantId, agentId));
  return true;
}

/** Test-only: drop all overrides. */
export async function __resetAgentToolAllowlistOverrides(): Promise<void> {
  await overrides.__clear();
}
