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

/**
 * Inverse of {@link levelForSpecLevel} (ADR 0101). `roster.autonomyLevel` is the
 * single autonomy source of truth (owned by the Edit-details modal, read by the
 * heartbeat); the profile's `specLevel` is derived from it so the two can never
 * disagree. `review` has two spec levels (`draft-only`, `recommend`); we keep an
 * existing review-class `specLevel` when it already maps to `review`, else default
 * to `recommend`.
 */
export function specLevelForLevel(level: RosterLevel, existing?: SpecLevel): SpecLevel {
  switch (level) {
    case 'guided':
      return 'execute-with-approval';
    case 'auto':
      return 'autonomous-within-policy';
    case 'review':
      return existing === 'draft-only' ? 'draft-only' : 'recommend';
  }
}

/**
 * Keep a standing agent's profile autonomy in lockstep with `roster.autonomyLevel`
 * (ADR 0101). Called when the roster level changes (the Edit-details modal) so the
 * stored `profile.autonomy.{level,specLevel}` — read by the assistant + knowledge
 * enforcement seams — never goes stale. No-op when no profile exists or the level
 * already matches. Tenant-guarded (fail-closed cross-tenant).
 */
export async function syncAgentProfileAutonomy(
  tenantId: string,
  profileId: string,
  level: RosterLevel,
): Promise<void> {
  const existing = await getAgentProfile(tenantId, profileId);
  if (!existing || existing.autonomy.level === level) return;
  const specLevel = specLevelForLevel(level, existing.autonomy.specLevel);
  await profiles.put({
    ...existing,
    autonomy: { ...existing.autonomy, level, specLevel },
    updatedAt: nowIso(),
  });
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

/**
 * Resolve a standing agent's tool `permissions` for the ADR 0102 per-tool gate.
 * Only a STANDING (roster) agent carries a profile, and its `rosterId` IS its
 * dispatchable `agentId` (the `host:<slug>` form) — so a `host:`-prefixed agentId
 * keys the profile directly. A pack/manifest agent (no `host:` prefix) has no
 * profile ⇒ `undefined`, leaving the per-tool gate correctly ungated. Tenant-
 * scoped + fail-closed (a foreign / unknown / deleted agent ⇒ `undefined`).
 */
export async function resolveAgentToolPermissions(
  tenantId: string,
  agentId: string,
): Promise<AgentProfile['permissions'] | undefined> {
  if (!agentId.startsWith('host:')) return undefined;
  const profile = await getAgentProfile(tenantId, agentId);
  return profile?.permissions;
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
  // `capabilities`, `knowledge`, and `twin` are owned by OTHER subsystems
  // (capability activation, the ADR 0038 knowledge curator, ADR 0044 twin grants),
  // not the governance/profile editor. A full-replace PUT from that editor doesn't
  // resend them — so PRESERVE the prior values when the input omits them, or a
  // profile edit would silently wipe an agent's activated capabilities / knowledge
  // bindings / twin link (ADR 0101 data-preservation).
  const profile: AgentProfile = {
    profileId,
    tenantId,
    roleKey: input.roleKey,
    ...(input.capabilities !== undefined
      ? { capabilities: input.capabilities }
      : prior?.capabilities !== undefined ? { capabilities: prior.capabilities } : {}),
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
    ...(input.knowledge !== undefined
      ? { knowledge: input.knowledge }
      : prior?.knowledge !== undefined ? { knowledge: prior.knowledge } : {}),
    ...(prior?.twin !== undefined ? { twin: prior.twin } : {}),
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

/** Set or clear the digital-twin LINK on an agent's profile (ADR 0044) — `twin`
 *  set ⇒ this agent is a twin of that user; `null` ⇒ unlinked. Creates a minimal
 *  profile from `init` if none exists. The link grants NO memory access by itself
 *  (a user-issued `TwinGrant` is the authorization — `twinService`). Tenant-scoped. */
export async function setAgentTwin(
  tenantId: string,
  profileId: string,
  twin: AgentProfile['twin'] | null,
  init: { roleKey: string; autonomy: AgentProfileInput['autonomy'] },
): Promise<AgentProfile> {
  let existing = await getAgentProfile(tenantId, profileId);
  if (!existing) existing = await upsertAgentProfile(tenantId, profileId, init);
  const updated: AgentProfile = { ...existing, updatedAt: nowIso() };
  if (twin) updated.twin = twin; else delete updated.twin;
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

/**
 * One-shot backfill (ADR 0102): ensure every EXISTING profile that already
 * carries a tool `permissions` allowlist also permits the given read tokens
 * (the host's builtin tool namespaces), so flipping the per-tool gate on doesn't
 * block legitimate builtin tool calls. Adds only the MISSING tokens to
 * `permissions.read` (idempotent set-union — safe under concurrent migration
 * runners + a no-op on re-run). Profiles with NO `permissions` block stay
 * ungated (untouched). Returns the number of profiles updated.
 */
export async function backfillProfileReadPermissions(readTokens: readonly string[]): Promise<number> {
  const all = await profiles.list();
  let updated = 0;
  for (const p of all) {
    if (!p.permissions) continue;
    const read = p.permissions.read ?? [];
    const missing = readTokens.filter((tok) => !read.includes(tok));
    if (missing.length === 0) continue;
    await profiles.put({
      ...p,
      permissions: { ...p.permissions, read: [...read, ...missing] },
      updatedAt: nowIso(),
    });
    updated += 1;
  }
  return updated;
}

/** Test-only: drop all profiles. */
export async function __resetAgentProfileStore(): Promise<void> {
  await profiles.__clear();
}
