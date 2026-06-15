/**
 * Agent profile — host extension (non-normative).
 *
 * The reference implementation of ADR 0031's `agentProfile`: a host-local,
 * tenant-scoped record carrying the full "enterprise digital work twin"
 * property set (config parameters, permissions, HITL/escalation, channels,
 * admin controls, risk/compliance, required connections, metrics, and the
 * four-level autonomy model) for a standing agent.
 *
 * Persistence rides the existing `DurableCollection` seam — NO new database,
 * table family, or store (ADR 0031 §1). The collection is read-through (every
 * read/write hits storage), keyed by `profileId` = the owning `rosterId`
 * (standing agents) or `agentId` (definition-level). Tenant isolation lives at
 * this service + the route layer, mirroring `host/rosterService.ts`.
 *
 * Explicitly NOT a field on the RFC 0003 agent manifest: product config no
 * OpenWOP client needs stays host-local under `/v1/host/openwop-app/*`
 * (ARCHITECTURE.md "do not fork the protocol"). Therefore no OpenWOP RFC.
 *
 * @see docs/adr/0031-agent-profile-and-seeding.md
 * @see src/host/rosterService.ts — the patterns this mirrors
 */

import type { AgentProfile } from '../types.js';
import { DurableCollection } from './hostExtPersistence.js';

const profiles = new DurableCollection<AgentProfile>('agent-profile', (p) => p.profileId);

function nowIso(): string {
  return new Date().toISOString();
}

type SpecLevel = AgentProfile['autonomy']['specLevel'];
type RosterLevel = AgentProfile['autonomy']['level'];

/**
 * ADR 0031 autonomy mapping (four-level spec → three-level roster). Used to
 * DERIVE the enforced `level` from `specLevel` when the level is not set
 * explicitly. `specLevel` is provenance/display; `level` is enforcement.
 *
 * | spec `specLevel`          | roster `level` |
 * |---------------------------|----------------|
 * | draft-only                | review         |
 * | recommend                 | review         |
 * | execute-with-approval     | guided         |
 * | autonomous-within-policy  | auto           |
 */
export function levelForSpecLevel(specLevel: SpecLevel): RosterLevel {
  switch (specLevel) {
    case 'draft-only':
    case 'recommend':
      return 'review';
    case 'execute-with-approval':
      return 'guided';
    case 'autonomous-within-policy':
      return 'auto';
  }
}

/** Input to {@link upsertAgentProfile}. `autonomy.level` is optional — when
 *  omitted it is derived from `autonomy.specLevel` via {@link levelForSpecLevel}. */
export interface AgentProfileInput {
  roleKey: string;
  /** Core capabilities to ACTIVATE on this agent (e.g. `['assistant']`). The
   *  runtime gates capability behavior on this, never on `roleKey`. */
  capabilities?: AgentProfile['capabilities'];
  department?: AgentProfile['department'];
  configParameters?: Record<string, unknown>;
  permissions?: AgentProfile['permissions'];
  hitl?: string[];
  escalation?: AgentProfile['escalation'];
  channels?: AgentProfile['channels'];
  adminControls?: string[];
  riskCompliance?: string[];
  requiredConnections?: string[];
  metrics?: string[];
  /** Per-agent knowledge & memory bindings (ADR 0038 — additive). */
  knowledge?: AgentProfile['knowledge'];
  autonomy: {
    level?: RosterLevel;
    specLevel: SpecLevel;
    withinPolicyActions?: string[];
  };
}

/** Read one profile, scoped to `tenantId`. Returns `null` when the profile is
 *  absent OR owned by a different tenant (fail-closed cross-tenant read). */
export async function getAgentProfile(tenantId: string, profileId: string): Promise<AgentProfile | null> {
  const profile = await profiles.get(profileId);
  if (!profile || profile.tenantId !== tenantId) return null;
  return profile;
}

/** Create-or-replace a profile for `profileId` under `tenantId`. Preserves the
 *  original `createdAt` on update; always bumps `updatedAt`. The enforced
 *  autonomy `level` is derived from `specLevel` when not explicitly provided. */
export async function upsertAgentProfile(
  tenantId: string,
  profileId: string,
  input: AgentProfileInput,
): Promise<AgentProfile> {
  const existing = await profiles.get(profileId);
  // Defensive: never let an upsert silently re-own another tenant's profile.
  const prior = existing && existing.tenantId === tenantId ? existing : undefined;
  const now = nowIso();
  const level = input.autonomy.level ?? levelForSpecLevel(input.autonomy.specLevel);
  const profile: AgentProfile = {
    profileId,
    tenantId,
    roleKey: input.roleKey,
    ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
    ...(input.department !== undefined ? { department: input.department } : {}),
    ...(input.configParameters !== undefined ? { configParameters: input.configParameters } : {}),
    ...(input.permissions !== undefined ? { permissions: input.permissions } : {}),
    ...(input.hitl !== undefined ? { hitl: input.hitl } : {}),
    ...(input.escalation !== undefined ? { escalation: input.escalation } : {}),
    ...(input.channels !== undefined ? { channels: input.channels } : {}),
    ...(input.adminControls !== undefined ? { adminControls: input.adminControls } : {}),
    ...(input.riskCompliance !== undefined ? { riskCompliance: input.riskCompliance } : {}),
    ...(input.requiredConnections !== undefined ? { requiredConnections: input.requiredConnections } : {}),
    ...(input.metrics !== undefined ? { metrics: input.metrics } : {}),
    ...(input.knowledge !== undefined ? { knowledge: input.knowledge } : {}),
    autonomy: {
      level,
      specLevel: input.autonomy.specLevel,
      ...(input.autonomy.withinPolicyActions !== undefined
        ? { withinPolicyActions: input.autonomy.withinPolicyActions }
        : {}),
    },
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
  };
  await profiles.put(profile);
  return profile;
}

/**
 * Activate a core capability on an agent's profile (idempotent). Merges into an
 * existing profile (preserving every other field); if no profile exists yet,
 * creates a minimal one from `init` carrying the capability. The runtime gates
 * capability behavior on `profile.capabilities`, so this is how a capability is
 * turned on per named agent — never via `roleKey`.
 */
export async function activateAgentCapability(
  tenantId: string,
  profileId: string,
  capability: NonNullable<AgentProfile['capabilities']>[number],
  init: { roleKey: string; autonomy: AgentProfileInput['autonomy'] },
): Promise<AgentProfile> {
  const existing = await getAgentProfile(tenantId, profileId);
  if (existing) {
    if ((existing.capabilities ?? []).includes(capability)) return existing;
    const updated: AgentProfile = {
      ...existing,
      capabilities: [...(existing.capabilities ?? []), capability],
      updatedAt: nowIso(),
    };
    await profiles.put(updated);
    return updated;
  }
  return upsertAgentProfile(tenantId, profileId, { ...init, capabilities: [capability] });
}

/**
 * Merge a `knowledge` binding patch into an agent's profile (ADR 0038),
 * idempotently activating the `knowledge` capability at the same time. Used by
 * the `agent-knowledge` feature's curation service to bind/unbind a collection
 * or toggle `memoryWritable` WITHOUT requiring the caller to re-send the whole
 * profile. Fail-closed cross-tenant: a profile owned by another tenant is not
 * found → a fresh minimal profile is created under the CALLER's tenant. When no
 * profile exists yet, a minimal one is created from `init`.
 *
 * `patch` is shallow-merged onto the existing `knowledge` block; an explicit
 * `undefined` field in `patch` is ignored (use the dedicated array operations in
 * the feature service to remove a collection id).
 */
export async function setAgentKnowledge(
  tenantId: string,
  profileId: string,
  patch: NonNullable<AgentProfile['knowledge']>,
  init: { roleKey: string; autonomy: AgentProfileInput['autonomy'] },
): Promise<AgentProfile> {
  const existing = await getAgentProfile(tenantId, profileId);
  if (!existing) {
    return upsertAgentProfile(tenantId, profileId, {
      ...init,
      capabilities: ['knowledge'],
      knowledge: patch,
    });
  }
  const merged: NonNullable<AgentProfile['knowledge']> = { ...(existing.knowledge ?? {}), ...patch };
  const capabilities = (existing.capabilities ?? []).includes('knowledge')
    ? existing.capabilities
    : [...(existing.capabilities ?? []), 'knowledge' as const];
  const updated: AgentProfile = {
    ...existing,
    ...(capabilities !== undefined ? { capabilities } : {}),
    knowledge: merged,
    updatedAt: nowIso(),
  };
  await profiles.put(updated);
  return updated;
}

/** Delete an agent's profile (incl. its capability activations + ADR 0038
 *  knowledge bindings, which live on the profile). Tenant-guarded (fail-closed:
 *  a cross-tenant profile is not deleted). Used by the roster cascade so a
 *  removed agent's profile + bindings don't orphan. Returns true when removed. */
export async function deleteAgentProfile(tenantId: string, profileId: string): Promise<boolean> {
  const existing = await profiles.get(profileId);
  if (!existing || existing.tenantId !== tenantId) return false;
  return profiles.delete(profileId);
}

/** Test-only: drop all profiles. */
export async function __resetAgentProfileStore(): Promise<void> {
  await profiles.__clear();
}
